#!/usr/bin/env node
/* الفهرس الفريد الجزئي على «رقم جسر».
   =========================================================================
   الحاجز الصلب لمنع حمل موظفَين رقم جسر واحد. التحقّق في
   lib/data/employees.js يعطي رسالة مفهومة تسمّي المتعارض، لكنه منطق
   تطبيق: كتابة SQL مباشرة أو سباق بين طلبين يتجاوزانه. الفهرس لا.

   جزئيّ عمدًا: الشرط WHERE يستثني السجلّات بلا الحقل أو بقيمة فارغة،
   فعشرات الموظفين غير المربوطين لا يتعارضون بعضهم مع بعض على NULL.

   ويُبنى على الصورة المُطبَّعة لا على القيمة الخام. فهرسٌ على الخام يرى
   "49" و"049" مدخلين مختلفين فيقبلهما لموظفين اثنين — بينما التطبيق
   يعدّهما الرقم نفسه. عندها يصير للمنصّة تعريفان متضاربان لهوية واحدة،
   ويسقط الربط عند أول كشف يذكر الرقم بصورة غير التي خُزّن بها.

   التعبير هنا مطابق حرفيًا لـnormalizeJisr في lib/data/employees.js:
     JS        raw.trim().replace(/^0+(?=\d)/, "")
     Postgres  regexp_replace(btrim(...), '^0+(?=[0-9])', '')
   النظرة الأمامية (?=[0-9]) ليست زينة: بدونها يُحذف الصفر من "0A" في
   القاعدة ولا يُحذف في التطبيق، فيفترق التعريفان من جديد. و\d في
   JavaScript بلا راية u يطابق [0-9] وحدها، فالمجالان متطابقان.

   regexp_replace و btrim كلتاهما IMMUTABLE، وهو شرط فهرسة التعبير.

   آمن وقابل لإعادة التشغيل. لا يحذف ولا يعدّل بيانات.

   التشغيل:   node scripts/setup-jisr-number.js
   المعاينة:  node scripts/setup-jisr-number.js --dry-run */

/* التعبير المُطبِّع — مصدر واحد يستعمله الفهرس ويقارنه الاختبار
   بـnormalizeJisr، فلا يفترق التعريفان بتعديل أحدهما وحده. */
const JISR_NORMALIZE_SQL = `regexp_replace(btrim(data->>'رقم جسر'), '^0+(?=[0-9])', '')`;

/* اسم جديد لا اسم النسخة السابقة (idx_employees_jisr_no): مع
   IF NOT EXISTS كان فهرسٌ خامٌّ قائم سيبقى مكانه صامتًا ويُتخطّى إنشاء
   المُطبَّع — أي حماية ناقصة تبدو مكتملة. ولا يُحذف شيء هنا: هذا السكربت
   لا يحمل عبارة إسقاط واحدة. */
const STATEMENTS = [
  {
    label: "فهرس فريد جزئي على الصورة المُطبَّعة لـ«رقم جسر»",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_jisr_no_normalized
        ON employees ((${JISR_NORMALIZE_SQL}))
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
      console.error("\nفشل بناء الفهرس: رقمان يتطابقان بعد التطبيع عند موظفَين مختلفين");
      console.error("(مثل \"49\" و\"049\" — وهما الرقم نفسه في منطق التطبيق).");
      console.error("افحص أولًا (قراءة محضة، بالتطبيع نفسه):");
      console.error(`  SELECT ${JISR_NORMALIZE_SQL} AS jisr_normalized,`);
      console.error("         array_agg(eid) AS employees, count(*)");
      console.error("    FROM employees");
      console.error("   WHERE btrim(coalesce(data->>'رقم جسر','')) <> ''");
      console.error("   GROUP BY 1 HAVING count(*) > 1;");
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

module.exports = { STATEMENTS, run, JISR_NORMALIZE_SQL };
