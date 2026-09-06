#!/usr/bin/env node
/* الفهرس الفريد الجزئي على «رقم جسر».
   =========================================================================
   الحاجز الصلب لمنع حمل موظفَين رقم جسر واحد. التحقّق في
   lib/data/employees.js يعطي رسالة مفهومة تسمّي المتعارض، لكنه منطق
   تطبيق: كتابة SQL مباشرة أو سباق بين طلبين يتجاوزانه. الفهرس لا.

   جزئيّ عمدًا: الشرط WHERE يستثني السجلّات بلا الحقل أو بقيمة فارغة،
   فعشرات الموظفين غير المربوطين لا يتعارضون بعضهم مع بعض على NULL.

   الفهرس يُبنى على القيمة كما هي لا على صورتها المُطبَّعة: Postgres لا
   يعرف قاعدة التطبيع، والمنع الحاسم لـ"49" مقابل "049" يقع في طبقة
   التطبيق. الفهرس يمنع التكرار الحرفي — وهو الحالة الواقعية.

   آمن وقابل لإعادة التشغيل. لا يحذف ولا يعدّل بيانات.

   التشغيل:   node scripts/setup-jisr-number.js
   المعاينة:  node scripts/setup-jisr-number.js --dry-run */

const STATEMENTS = [
  {
    label: "فهرس فريد جزئي على data->>'رقم جسر'",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_jisr_no
        ON employees ((data->>'رقم جسر'))
        WHERE data->>'رقم جسر' IS NOT NULL AND btrim(data->>'رقم جسر') <> ''`,
  },
];

/* نفس شكل scripts/setup-payroll-monthly.js: sql.query ينفّذ فعلًا،
   بينما sql.unsafe تبني وصفًا ولا ترسل شيئًا. */
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
    for (const s of STATEMENTS) console.log(`${s.label}:\n${s.sql.trim()}\n`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  try {
    await run(getSql(), { onProgress: (s) => console.log(`${s.label} ... تم`) });
  } catch (err) {
    const message = (err && err.message) || String(err);
    if (/duplicate key|already exists/i.test(message)) {
      console.error("\nفشل بناء الفهرس: يوجد بالفعل رقم جسر مكرّر بين الموظفين.");
      console.error("افحص أولًا (قراءة محضة):");
      console.error("  SELECT data->>'رقم جسر' AS jisr, count(*) FROM employees");
      console.error("   WHERE btrim(coalesce(data->>'رقم جسر','')) <> '' GROUP BY 1 HAVING count(*) > 1;");
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log("\nاكتملت التهيئة. لم تُمسّ أي بيانات.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشلت التهيئة:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, run };
