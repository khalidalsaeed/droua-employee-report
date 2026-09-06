/* قاعدة بيانات مُزيَّفة بواجهة neon نفسها: دالّة قوالب موسومة.
   =========================================================================
   الغرض اختبار حواجز عدم التكرار وعزل صفوف الموظفين بلا Postgres — وهي
   المنطق الذي يستحقّ الاختبار فعلًا، لا قدرة القاعدة على تنفيذ SQL.

   كل نداء يُسجَّل نصًّا وقيمًا، والردّ يُقرّره `respond` الذي يمرّره
   الاختبار. هكذا يمكن محاكاة «فاز بالصفّ» و«خسر السباق» بالتحكّم في
   الصفوف المُرجَعة لا بمحاكاة تزامن حقيقي. */

function makeFakeSql(respond) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    const call = { text, values };
    calls.push(call);
    const rows = respond ? respond(call, calls) : [];
    return Promise.resolve(rows || []);
  };
  /* lib/data/payrollRuns.js يستعمل sql.unsafe لأسماء الأعمدة. */
  sql.unsafe = (s) => s;
  sql.calls = calls;
  /* أدوات بحث للاختبارات. */
  sql.matching = (re) => calls.filter((c) => re.test(c.text));
  return sql;
}

module.exports = { makeFakeSql };
