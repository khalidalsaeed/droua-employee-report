/* مشغّل عبارات التهيئة لسكربتات الوحدة.
   =========================================================================
   sql.query() هي واجهة تنفيذ نصٍّ كامل في @neondatabase/serverless.
   sql.unsafe() ليست دالّة تنفيذ — تُرجع وصفًا لا Promise، و await عليه
   يحلّ فورًا فتُطبع «تم» بلا أن يصل شيء إلى القاعدة (موثَّق في
   scripts/setup-payroll-monthly.js ويحرسه test/setup-script-executes). */

async function run(sql, statements, { onProgress } = {}) {
  for (const s of statements) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return statements.length;
}

async function main(statements, { name }) {
  if (process.argv.includes("--dry-run")) {
    console.log(`— معاينة فقط (${name})، بلا اتّصال بالقاعدة —\n`);
    for (const s of statements) console.log(`${s.label}:\n${s.sql.trim()}\n`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../../lib/db");
  const count = await run(getSql(), statements, { onProgress: (s) => console.log(`${s.label} ... تم`) });
  console.log(`\nاكتملت التهيئة (${count} عبارة). لم تُمسّ أي بيانات قائمة.`);
}

function runStatements(statements, opts) {
  main(statements, opts).catch((err) => {
    console.error("\nفشلت التهيئة:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { run, runStatements };
