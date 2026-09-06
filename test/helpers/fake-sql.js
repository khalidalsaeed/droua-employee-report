/* قاعدة بيانات مُزيَّفة بواجهة neon نفسها: دالّة قوالب موسومة.
   =========================================================================
   الغرض اختبار حواجز عدم التكرار وعزل صفوف الموظفين بلا Postgres — وهي
   المنطق الذي يستحقّ الاختبار فعلًا، لا قدرة القاعدة على تنفيذ SQL.

   كل نداء يُسجَّل نصًّا وقيمًا، والردّ يُقرّره `respond` الذي يمرّره
   الاختبار. هكذا يمكن محاكاة «فاز بالصفّ» و«خسر السباق» بالتحكّم في
   الصفوف المُرجَعة لا بمحاكاة تزامن حقيقي. */

/* شظيّة SQL خام. neon يدمجها في نصّ الاستعلام لا يمرّرها معاملًا، وهذا
   ما تحاكيه: بلا ذلك يختفي «FROM payroll_transfer_proofs» من النصّ حين
   يأتي عبر sql.unsafe، فيعمى أي اختبار يفحص الجدول المستهدَف. */
class UnsafeFragment {
  constructor(sql) { this.sql = sql; }
  toString() { return this.sql; }
}

function makeFakeSql(respond) {
  const calls = [];
  const sql = (strings, ...values) => {
    /* الشظايا تُدمج نصًّا، وما عداها يصير معاملًا — كما يفعل المُشغّل. */
    let text = "";
    const params = [];
    strings.raw.forEach((chunk, i) => {
      text += chunk;
      if (i >= values.length) return;
      const v = values[i];
      if (v instanceof UnsafeFragment) { text += v.sql; return; }
      text += "?";
      params.push(v);
    });
    const call = { text: text.replace(/\s+/g, " ").trim(), values: params };
    calls.push(call);
    const rows = respond ? respond(call, calls) : [];
    return Promise.resolve(rows || []);
  };
  /* lib/data/payrollRuns.js يستعمل sql.unsafe لأسماء الأعمدة والربط. */
  sql.unsafe = (s) => new UnsafeFragment(s);
  sql.calls = calls;
  /* أدوات بحث للاختبارات. */
  sql.matching = (re) => calls.filter((c) => re.test(c.text));
  return sql;
}

module.exports = { makeFakeSql, UnsafeFragment };
