#!/usr/bin/env node
/* إنشاء جدول متابعة سفر موظفي ذروة (employee_travel) في Neon.
   =========================================================================
   ⚠️ لم يُشغَّل بعد — ينتظر اعتماد التصميم. لا يُشغَّل على قاعدة الإنتاج
   إلا بعد الموافقة الصريحة.

   الجدول بيانات تشغيلية فعلية (لا audit_log): رحلة لكل صفّ، وللموظف
   الواحد رحلات كثيرة (Employee → Many Travel Records). الربط بـ
   employees.eid — المعرّف نفسه الذي تربط به التذاكر والتصاريح.

   الحالة (مجدولة · قريب السفر · مسافر · عاد) لا تُخزَّن أبدًا: تُشتقّ من
   التواريخ عند كل عرض (staff-travel-status.js) كما تُشتقّ حالة الوثائق،
   فلا يمكن أن تتقادم.

   آمن وقابل لإعادة التشغيل: كل عبارة IF NOT EXISTS، ولا يحذف شيئًا ولا
   يعدّل جدولًا قائمًا ولا يلمس بيانات.

   التشغيل:   node scripts/setup-staff-travel.js
   المعاينة:  node scripts/setup-staff-travel.js --dry-run
              تطبع ما سيُنفَّذ ولا تتّصل بالقاعدة إطلاقًا.
   التراجع:   node scripts/setup-staff-travel.js --rollback --dry-run   (يعرض فقط)
              node scripts/setup-staff-travel.js --rollback --yes        (يحذف الجدول وكل رحلاته)
              لا يمسّ أي جدول آخر — الجدول طرفٌ لا يعتمد عليه شيء. */

const STATEMENTS = [
  {
    label: "جدول employee_travel",
    sql: `
      CREATE TABLE IF NOT EXISTS employee_travel (
        id                  bigserial PRIMARY KEY,
        -- employees.eid («الرقم الوظيفي»): text NOT NULL وعليه UNIQUE
        -- (employees_eid_key) — تحقّق منه على القاعدة قبل الهجرة.
        -- RESTRICT: سجلّ السفر تاريخيّ؛ حذف موظف له رحلات يُرفض ولا يمحوها
        -- ضمنًا. ON UPDATE CASCADE يُبقي الربط إن تغيّر الرقم الوظيفي.
        employee_eid        text NOT NULL REFERENCES employees(eid) ON UPDATE CASCADE ON DELETE RESTRICT,
        start_date          date NOT NULL,
        end_date            date NOT NULL,
        visa_expiry_date    date NOT NULL,
        visa_number         text,
        visa_type           text,
        destination         text,
        notes               text,
        -- تأكيد العودة الفعلية. بعد تاريخ النهاية: بلا تأكيد = «بانتظار
        -- تأكيد العودة»، ومعه = «عاد».
        return_confirmed_at timestamptz,
        return_confirmed_by text,
        -- نصّ بلا مفتاح أجنبي: حسابا الاحتياط في متغيّرات البيئة بلا صفّ في users.
        created_by          text,
        created_by_name     text,
        updated_by          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT employee_travel_dates_chk   CHECK (end_date >= start_date),
        CONSTRAINT employee_travel_visa_no_len CHECK (visa_number IS NULL OR char_length(visa_number) <= 40),
        CONSTRAINT employee_travel_visa_ty_len CHECK (visa_type IS NULL OR char_length(visa_type) <= 60),
        CONSTRAINT employee_travel_dest_len    CHECK (destination IS NULL OR char_length(destination) <= 120),
        CONSTRAINT employee_travel_notes_len   CHECK (notes IS NULL OR char_length(notes) <= 1000)
      )`,
  },
  {
    label: "فهرس الرحلات لكل موظف (الأحدث أولًا)",
    sql: `CREATE INDEX IF NOT EXISTS idx_employee_travel_employee ON employee_travel (employee_eid, start_date DESC)`,
  },
  {
    label: "فهرس تاريخ العودة",
    sql: `CREATE INDEX IF NOT EXISTS idx_employee_travel_end ON employee_travel (end_date)`,
  },
  {
    label: "فهرس انتهاء التأشيرة",
    sql: `CREATE INDEX IF NOT EXISTS idx_employee_travel_visa ON employee_travel (visa_expiry_date)`,
  },
];

const ROLLBACK = [
  { label: "حذف جدول employee_travel (وفهارسه معه)", sql: `DROP TABLE IF EXISTS employee_travel` },
];

async function run(sql, { onProgress, statements = STATEMENTS } = {}) {
  for (const s of statements) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return statements.length;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rollback = process.argv.includes("--rollback");
  const list = rollback ? ROLLBACK : STATEMENTS;
  if (dryRun) {
    console.log("— معاينة فقط، بلا اتّصال بالقاعدة —\n");
    for (const s of list) console.log(`${s.label}:\n${s.sql.trim()}\n`);
    return;
  }
  if (rollback && !process.argv.includes("--yes")) {
    console.error("التراجع يحذف كل الرحلات المسجّلة. أضف --yes للتأكيد، أو --dry-run للمعاينة.");
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  const count = await run(getSql(), {
    statements: list,
    onProgress: (s) => console.log(`${s.label} ... تم`),
  });
  console.log(`\nاكتمل (${count} عبارة).`);
}

/* لا يعمل عند الاستيراد — الاختبار يستورد STATEMENTS و run بلا تنفيذ. */
if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل التنفيذ:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, ROLLBACK, run };
