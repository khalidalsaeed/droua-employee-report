#!/usr/bin/env node
/* دليل الموظفين الموحَّد: staff_directory، وربط employee_travel به.
   =========================================================================
   من الحالة القائمة (employee_travel.employee_eid → employees.eid) إلى:
     employee_travel.staff_id → staff_directory.id   (ذروة وأجير معًا)

   كل ما يكتبه السكربت يجري في معاملة واحدة (sql.transaction): إمّا يكتمل
   كلّه أو لا يتغيّر شيء. ولا يحذف بيانات: كل رحلة قائمة تُنقل أوّلًا —
   يُجسَّد لموظف أجير صاحبها صفٌّ في الدليل، ويُملأ staff_id منه — ثم يُفرض
   NOT NULL؛ فلو بقيت رحلة بلا ربط فشلت المعاملة كلها قبل حذف العمود القديم.

   يكتشف الحالة قبل التنفيذ ويختار العبارات وفقها، فإعادة تشغيله بعد النجاح
   لا تفعل شيئًا. طُبِّق على القاعدة المشتركة في 2026-11-03.

   التشغيل:   node scripts/migrate-staff-directory.js --dry-run   (الخطة فقط، قراءة)
              node scripts/migrate-staff-directory.js --apply
   التراجع:   node scripts/migrate-staff-directory.js --rollback --dry-run
              node scripts/migrate-staff-directory.js --rollback --apply
              يُرفض إن وُجدت رحلات لموظفي ذروة (لا مكان لها في البنية القديمة)
              ما لم يُمرَّر --drop-droua-trips صراحةً. */

const CREATE = [
  {
    label: "جدول staff_directory",
    sql: `
      CREATE TABLE IF NOT EXISTS staff_directory (
        id                  bigserial PRIMARY KEY,
        source_type         text NOT NULL CHECK (source_type IN ('droua', 'ajeer')),
        -- أجير فقط: employees.eid. SET NULL لا RESTRICT: حذف الموظف من السجلّ
        -- لا يُمنع، وتبقى رحلاته في سجلّها التاريخي بلقطة اسمه أدناه.
        source_employee_eid text REFERENCES employees(eid) ON UPDATE CASCADE ON DELETE SET NULL,
        -- ذروة: رقم الموظف في تقرير ذروة. أجير: فارغ (الرقم هو eid).
        employee_number     text,
        -- ذروة: من التقرير. أجير: لقطة من employees تحفظ السجلّ إن حُذف الموظف.
        name                text NOT NULL,
        job_title           text,
        department          text,
        -- أرقام فقط. لموظفي ذروة، للمطابقة ومنع التكرار؛ أجير يُقرأ من employees.
        identity_number     text,
        active              boolean NOT NULL DEFAULT true,
        -- دفعة الاستيراد التي أنشأت الصفّ — للتتبّع والتراجع عن استيراد بعينه.
        import_batch        text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT staff_directory_droua_no_eid CHECK (source_type <> 'droua' OR source_employee_eid IS NULL),
        CONSTRAINT staff_directory_name_len     CHECK (char_length(name) BETWEEN 1 AND 200),
        CONSTRAINT staff_directory_number_len   CHECK (employee_number IS NULL OR char_length(employee_number) <= 40),
        CONSTRAINT staff_directory_job_len      CHECK (job_title IS NULL OR char_length(job_title) <= 120),
        CONSTRAINT staff_directory_dept_len     CHECK (department IS NULL OR char_length(department) <= 120),
        CONSTRAINT staff_directory_identity_fmt CHECK (identity_number IS NULL OR identity_number ~ '^[0-9]{6,15}$')
      )`,
  },
  {
    label: "فريد: صفّ واحد لكل موظف أجير",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_directory_employee ON staff_directory (source_employee_eid) WHERE source_employee_eid IS NOT NULL`,
  },
  {
    label: "فريد: رقم موظف ذروة",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_directory_number ON staff_directory (employee_number) WHERE source_type = 'droua' AND employee_number IS NOT NULL`,
  },
  {
    label: "فريد: هوية موظف ذروة",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_directory_identity ON staff_directory (identity_number) WHERE source_type = 'droua' AND identity_number IS NOT NULL`,
  },
  {
    label: "عمود employee_travel.staff_id",
    /* RESTRICT: شخص له رحلات لا يُحذف من الدليل — يُعطَّل (active=false). */
    sql: `ALTER TABLE employee_travel ADD COLUMN IF NOT EXISTS staff_id bigint REFERENCES staff_directory(id) ON UPDATE CASCADE ON DELETE RESTRICT`,
  },
];

/* نقل الرحلات القائمة — فقط ما دام العمود القديم موجودًا. */
const BACKFILL = [
  {
    label: "تجسيد صفوف أجير لأصحاب الرحلات القائمة",
    sql: `
      INSERT INTO staff_directory (source_type, source_employee_eid, name, job_title)
      SELECT 'ajeer', e.eid, COALESCE(NULLIF(e.data->>'اسم العامل', ''), e.name), NULLIF(e.data->>'المهنة', '')
        FROM employees e
       WHERE e.eid IN (SELECT employee_eid FROM employee_travel WHERE staff_id IS NULL)
      ON CONFLICT (source_employee_eid) WHERE source_employee_eid IS NOT NULL DO NOTHING`,
  },
  {
    label: "ربط الرحلات القائمة بالدليل",
    sql: `
      UPDATE employee_travel t SET staff_id = d.id
        FROM staff_directory d
       WHERE t.staff_id IS NULL AND d.source_employee_eid = t.employee_eid`,
  },
];

const FINALIZE = [
  { label: "staff_id إلزامي", sql: `ALTER TABLE employee_travel ALTER COLUMN staff_id SET NOT NULL` },
  { label: "فهرس الرحلات لكل شخص", sql: `CREATE INDEX IF NOT EXISTS idx_employee_travel_staff ON employee_travel (staff_id, start_date DESC)` },
];

const DROP_OLD = [
  /* يُسقط معه قيده الأجنبي وفهرسه idx_employee_travel_employee. */
  { label: "حذف العمود القديم employee_travel.employee_eid", sql: `ALTER TABLE employee_travel DROP COLUMN IF EXISTS employee_eid` },
];

async function inspect(sql) {
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'employee_travel'`;
  const has = new Set(cols.map((c) => c.column_name));
  const dir = (await sql`SELECT to_regclass('public.staff_directory')::text AS t`)[0].t;
  const trips = has.size ? (await sql`SELECT count(*)::int AS n FROM employee_travel`)[0].n : 0;
  return { travelExists: has.size > 0, hasEmployeeEid: has.has("employee_eid"), hasStaffId: has.has("staff_id"), directoryExists: !!dir, trips };
}

function plan(state) {
  if (!state.travelExists) throw new Error("employee_travel غير موجود — شغّل scripts/setup-staff-travel.js أوّلًا");
  const steps = [...CREATE];
  if (state.hasEmployeeEid) steps.push(...BACKFILL);
  steps.push(...FINALIZE);
  if (state.hasEmployeeEid) steps.push(...DROP_OLD);
  return steps;
}

async function run(sql, steps) {
  /* معاملة واحدة: neon يرسلها دفعةً ويلغيها كاملةً عند أوّل خطأ. */
  await sql.transaction(steps.map((s) => sql.query(s.sql)));
  return steps.length;
}

const ROLLBACK = [
  { label: "إعادة العمود employee_travel.employee_eid", sql: `ALTER TABLE employee_travel ADD COLUMN IF NOT EXISTS employee_eid text` },
  {
    label: "تعبئته من الدليل (أجير)",
    sql: `UPDATE employee_travel t SET employee_eid = d.source_employee_eid FROM staff_directory d WHERE d.id = t.staff_id AND d.source_employee_eid IS NOT NULL`,
  },
  { label: "employee_eid إلزامي", sql: `ALTER TABLE employee_travel ALTER COLUMN employee_eid SET NOT NULL` },
  {
    label: "إعادة القيد الأجنبي RESTRICT",
    sql: `ALTER TABLE employee_travel ADD CONSTRAINT employee_travel_employee_eid_fkey FOREIGN KEY (employee_eid) REFERENCES employees(eid) ON UPDATE CASCADE ON DELETE RESTRICT`,
  },
  { label: "إعادة الفهرس", sql: `CREATE INDEX IF NOT EXISTS idx_employee_travel_employee ON employee_travel (employee_eid, start_date DESC)` },
  { label: "حذف employee_travel.staff_id", sql: `ALTER TABLE employee_travel DROP COLUMN IF EXISTS staff_id` },
  { label: "حذف staff_directory", sql: `DROP TABLE IF EXISTS staff_directory` },
];
const DROP_UNMAPPABLE = {
  label: "حذف رحلات لا مكان لها في البنية القديمة (ذروة / أجير محذوف)",
  sql: `DELETE FROM employee_travel t USING staff_directory d WHERE d.id = t.staff_id AND d.source_employee_eid IS NULL`,
};

async function unmappableTrips(sql) {
  return (await sql`SELECT count(*)::int AS n FROM employee_travel t JOIN staff_directory d ON d.id = t.staff_id WHERE d.source_employee_eid IS NULL`)[0].n;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  const sql = getSql();
  const state = await inspect(sql);
  console.log("الحالة:", JSON.stringify(state));

  let steps;
  if (rollback) {
    if (!state.directoryExists || !state.hasStaffId) { console.log("لا شيء للتراجع عنه."); return; }
    const bad = await unmappableTrips(sql);
    steps = [...ROLLBACK];
    if (bad) {
      if (!process.argv.includes("--drop-droua-trips")) {
        console.error(`يوجد ${bad} رحلة لا مكان لها في البنية القديمة (موظفو ذروة أو أجير محذوف). التراجع مرفوض.`);
        console.error("صدّرها أو احذفها يدويًا أوّلًا، أو مرّر --drop-droua-trips صراحةً.");
        process.exitCode = 1;
        return;
      }
      steps.unshift(DROP_UNMAPPABLE);
    }
  } else {
    if (state.directoryExists && state.hasStaffId && !state.hasEmployeeEid) { console.log("مُطبَّقة مسبقًا — لا شيء لتنفيذه."); return; }
    steps = plan(state);
  }

  for (const s of steps) console.log(`${apply ? "تنفيذ" : "خطة"}: ${s.label}`);
  if (!apply) { console.log("\n— معاينة فقط. أضف --apply للتنفيذ في معاملة واحدة. —"); return; }
  await run(sql, steps);
  console.log("بعد:", JSON.stringify(await inspect(sql)));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل — لم يتغيّر شيء (معاملة واحدة):", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { CREATE, BACKFILL, FINALIZE, DROP_OLD, ROLLBACK, DROP_UNMAPPABLE, inspect, plan, run };
