const test = require("node:test");
const assert = require("node:assert/strict");
const { neon } = require("@neondatabase/serverless");

const { STATEMENTS, run } = require("../scripts/setup-payroll-monthly.js");
const jisrSetup = require("../scripts/setup-jisr-number.js");

/* اختبار انحدار: سكربت التهيئة ينفّذ العبارات فعلًا لا يصفها.
   =========================================================================
   العطل الذي يحرسه هذا الملف كان `await sql.unsafe(s.sql)`. و
   sql.unsafe() في @neondatabase/serverless ليست دالّة تنفيذ: تُرجع كائن
   UnsafeRawSql وصفيًّا ({sql}) معدًّا للتضمين داخل قالب موسوم. وهو ليس
   Promise، فـ await عليه يحلّ فورًا بالكائن نفسه بلا أي اتصال بالقاعدة —
   والسكربت مع ذلك يطبع «تم» بعد كل عبارة ويخرج ناجحًا.

   ولهذا لا يكفي أن يعدّ الاختبار النداءات على كائن sql مُزيَّف: الشيفرة
   المعطوبة كانت *تنادي* sql.unsafe فعلًا، فكل مُزيَّف يعدّ النداءات كان
   سيمرّ. المقياس الوحيد الذي يعضّ هو ما يصل إلى السلك.

   لذلك يُستعمل هنا مُشغّل Neon الحقيقي بسلسلة اتصال صورية، ويُعترَض
   fetch العام: ما يُعدّ هو طلبات HTTP الخارجة ونصّ SQL داخل أجسامها. */

/* مُشغّل حقيقي + شبكة مُعترَضة. لا اتصال يخرج من العملية. */
function neonWithCapturedNetwork() {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    requests.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ command: "CREATE", rowCount: 0, rows: [], fields: [] }),
    };
  };
  return {
    sql: neon("postgresql://user:pass@ep-fake.us-east-2.aws.neon.tech/db"),
    requests,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

test("run() يُرسل عبارة SQL واحدة لكل عنصر — لا وصفًا يُرمى", async () => {
  const net = neonWithCapturedNetwork();
  try {
    const count = await run(net.sql);
    assert.equal(count, STATEMENTS.length);
    assert.equal(
      net.requests.length,
      STATEMENTS.length,
      `يجب أن تصل ${STATEMENTS.length} عبارات إلى القاعدة — وصل ${net.requests.length}. ` +
        "صفر تعني أن الشيفرة بنت UnsafeRawSql بدل أن تنفّذ."
    );
  } finally { net.restore(); }
});

test("نصّ كل عبارة يصل كما هو وبالترتيب", async () => {
  const net = neonWithCapturedNetwork();
  try {
    await run(net.sql);
    assert.deepEqual(
      net.requests.map((r) => r.query),
      STATEMENTS.map((s) => s.sql)
    );
    /* لا معاملات: هذه DDL ثابتة لا مدخلات مستخدم فيها. */
    for (const r of net.requests) assert.deepEqual(r.params, []);
  } finally { net.restore(); }
});

/* الحارس المباشر ضد العودة إلى الشكل المعطوب: كائن UnsafeRawSql ليس
   Promise، وهذه هي الخاصّية التي جعلت await يمرّ بلا تنفيذ. */
test("sql.unsafe() ليست دالّة تنفيذ — تُرجع وصفًا غير قابل للانتظار", async () => {
  const net = neonWithCapturedNetwork();
  try {
    const fragment = net.sql.unsafe("CREATE TABLE IF NOT EXISTS x (id int)");
    assert.equal(typeof fragment.then, "undefined", "ليست Promise");
    assert.equal(fragment.constructor.name, "UnsafeRawSql");
    await fragment;
    assert.equal(net.requests.length, 0, "انتظارها لا يُرسل شيئًا — هذا هو العطل الأصلي");
  } finally { net.restore(); }
});

/* فشل عبارة يجب أن ينتشر لا أن يُبتلع، وإلّا عاد النجاح الكاذب من باب آخر. */
test("فشل عبارة يوقف التشغيل ويرفع الخطأ", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 2) return { ok: false, status: 400, headers: new Map(), text: async () => "syntax error", json: async () => ({ message: "syntax error" }) };
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ command: "CREATE", rowCount: 0, rows: [], fields: [] }) };
  };
  try {
    const sql = neon("postgresql://user:pass@ep-fake.us-east-2.aws.neon.tech/db");
    await assert.rejects(() => run(sql));
    assert.equal(calls, 2, "توقّف عند العبارة الفاشلة ولم يُكمل");
  } finally { globalThis.fetch = originalFetch; }
});

/* سكربت الفهرس الجديد يمرّ بالحارس نفسه: العطل الذي كان (بناء وصف بدل
   تنفيذ) يتكرّر في أي سكربت تهيئة يُكتب لاحقًا ما لم يُقَس بالمقياس
   نفسه — ما يصل إلى السلك. */
test("سكربت فهرس رقم جسر ينفّذ فعلًا", async () => {
  const net = neonWithCapturedNetwork();
  try {
    const count = await jisrSetup.run(net.sql);
    assert.equal(count, jisrSetup.STATEMENTS.length);
    assert.equal(net.requests.length, jisrSetup.STATEMENTS.length, "صفر تعني وصفًا لا تنفيذًا");
    assert.deepEqual(net.requests.map((r) => r.query), jisrSetup.STATEMENTS.map((s) => s.sql));
  } finally { net.restore(); }
});

test("الفهرس فريد وجزئي: لا يتعارض غير المربوطين على NULL", () => {
  assert.equal(jisrSetup.STATEMENTS.length, 1);
  const sql = jisrSetup.STATEMENTS[0].sql;
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS/);
  assert.match(sql, /WHERE .*IS NOT NULL/, "شرط جزئي يستثني غير المربوطين");
  assert.match(sql, /btrim\(data->>'رقم جسر'\) <> ''/, "والقيمة الفارغة أيضًا");
  /* لا يمسّ عمودًا ولا يحذف: الحقل يعيش في data (JSONB). */
  for (const verb of ["DROP", "DELETE", "ALTER TABLE", "TRUNCATE", "UPDATE"]) {
    assert.ok(!new RegExp(verb).test(sql), `يجب ألّا تظهر ${verb}`);
  }
});

/* استيراد السكربت يجب ألّا يشغّله — وإلّا لمس الاختبار قاعدة حقيقية. */
test("الاستيراد لا ينفّذ السكربت", () => {
  assert.ok(Array.isArray(STATEMENTS) && STATEMENTS.length === 5);
  assert.equal(typeof run, "function");
  for (const s of STATEMENTS) {
    assert.equal(typeof s.label, "string");
    assert.match(s.sql, /IF NOT EXISTS/, "كل عبارة idempotent");
  }
});
