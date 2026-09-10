#!/usr/bin/env node
/* توسعةُ القسم: ملفّ العمل الإضافي، وقاسمُ ساعة الموظّف، وإجازاتُ الشهر.
   =========================================================================
   على نمط setup-droua-files.js: كل عبارة **آمنة التكرار**، ولا تحذف شيئًا
   ولا تمسّ صفًّا قائمًا. تشغيلها مرّتين لا يفعل شيئًا في الثانية.

   والعبارة الأولى وحدها تُعدّل جدولًا قائمًا — توسيعُ قيد `kind`. وتوسيعُ
   قيدٍ لا يُبطل صفًّا: كل ما كان مقبولًا يبقى مقبولًا. ومع ذلك تُنفَّذ داخل
   شرطٍ يفحص القيد أوّلًا، فلا تُسقط قيدًا وتُعيده بلا داعٍ على قاعدةٍ حيّة.

   التشغيل:   node scripts/setup-droua-overtime.js
   المعاينة:  node scripts/setup-droua-overtime.js --dry-run */

const STATEMENTS = [
  {
    label: "توسيع قيد kind ليقبل ملفّ العمل الإضافي",
    sql: `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'droua_payroll_files'::regclass
             AND conname  = 'droua_payroll_files_kind_check'
             AND pg_get_constraintdef(oid) LIKE '%overtime%'
        ) THEN
          ALTER TABLE droua_payroll_files
            DROP CONSTRAINT IF EXISTS droua_payroll_files_kind_check;
          ALTER TABLE droua_payroll_files
            ADD CONSTRAINT droua_payroll_files_kind_check
            CHECK (kind IN ('cash', 'full', 'transfer', 'employees', 'overtime'));
        END IF;
      END $$`,
  },
  {
    label: "جدول droua_employee_settings — قاسم ساعة العمل الإضافي",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_employee_settings (
        -- الرقم الوظيفيّ مفتاحًا: هو المفتاح الوحيد الثابت بين الملفّات،
        -- ولا اسم هنا ولا هويّة ولا حساب — إعدادٌ لا سجلُّ موظفين.
        emp_no            text PRIMARY KEY CHECK (
                            char_length(emp_no) BETWEEN 1 AND 32
                            AND emp_no !~ '[[:space:]]'),

        -- ثمانٍ أو عشر، لا ثالث لهما ولا استنتاج. وعمود «الساعات المقرّرة»
        -- في ملفّ العمل الإضافي **ليس** مصدرًا لهذا: يحمل 0 و8 و10 و11
        -- و12 في العيّنة الواحدة، فهو واقعُ يومٍ لا سياسةُ موظّف.
        overtime_divisor  smallint NOT NULL CHECK (overtime_divisor IN (8, 10)),

        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        uuid
      )`,
  },
  {
    label: "جدول droua_run_leaves — إجازات الشهر",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_run_leaves (
        id         uuid PRIMARY KEY,
        -- لكل شهرٍ إجازاتُه: الإجازة واقعةٌ في شهرٍ بعينه لا سمةٌ دائمة
        -- للموظّف. وحذفُ الشهر يمحوها معه.
        run_id     uuid NOT NULL REFERENCES droua_payroll_runs (id) ON DELETE CASCADE,
        emp_no     text NOT NULL CHECK (
                     char_length(emp_no) BETWEEN 1 AND 32
                     AND emp_no !~ '[[:space:]]'),
        -- فترةٌ مغلقة الطرفين. والقيد في القاعدة لا في التطبيق: فترةٌ
        -- مقلوبة تُسكت غيابًا لا تفسّره، وهو أسوأ ما قد تفعله هذه الميزة.
        start_date date NOT NULL,
        end_date   date NOT NULL CHECK (end_date >= start_date),
        note       text CHECK (note IS NULL OR char_length(note) <= 500),
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid
      )`,
  },
  {
    label: "فهرس droua_run_leaves على الشهر",
    sql: `
      CREATE INDEX IF NOT EXISTS droua_run_leaves_run_idx
        ON droua_run_leaves (run_id)`,
  },
];

async function run(sql, { onProgress } = {}) {
  for (const s of STATEMENTS) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return STATEMENTS.length;
}

async function main() {
  if (process.argv.includes("--dry-run")) {
    console.log("— معاينة فقط، بلا اتّصال بالقاعدة —\n");
    for (const s of STATEMENTS) console.log(`▸ ${s.label}\n${s.sql.trim()}\n`);
    console.log(`المجموع: ${STATEMENTS.length} عبارة.`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مضبوط. شغّله بـ--env-file=.env.local");
    process.exitCode = 1;
    return;
  }
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const count = await run(sql, { onProgress: (s) => console.log(`✅ ${s.label}`) });
  console.log(`\nتمّت ${count} عبارة.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("فشلت التوسعة:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, run };
