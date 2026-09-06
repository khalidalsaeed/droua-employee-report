const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { makeFakeSql } = require("./helpers/fake-sql");
const { normalizeJisr, F_JISR, F_EID, F_NAME } = require("../lib/data/employees");
const { similarity, foldArabic, validate, apply } = require("../scripts/set-jisr-numbers.js");

/* حقل «رقم جسر»: التطبيع والتفرّد والتوافق مع السجلّات القائمة.
   =========================================================================
   الحقل يعيش داخل data (JSONB) فلا عمود جديد ولا هجرة، والسجلّات الحالية
   لا تحمله. أخطر ما يمكن أن يقع هنا شيئان: أن يُنسب رقم إلى موظفَين،
   وأن يتسبّب إدخال الحقل في مساس بالرقم الوظيفي أو بحقل قائم. */

/* ── التطبيع ── */

test("الأصفار البادئة والمسافات لا تُنتج موظفًا «غير موجود»", () => {
  for (const v of ["49", " 49 ", "049", "0049", "\t49\n"]) {
    assert.equal(normalizeJisr(v), "49", `${JSON.stringify(v)} يجب أن يُطبَّع إلى 49`);
  }
});

test("الفراغ بكل صوره يعني «غير مربوط»", () => {
  for (const v of ["", "   ", null, undefined]) assert.equal(normalizeJisr(v), null);
});

test("الصفر قيمة لا فراغ، ولا يُطابق رقمًا آخر", () => {
  assert.equal(normalizeJisr("0"), "0");
  assert.equal(normalizeJisr("00"), "0");
  assert.notEqual(normalizeJisr("0"), normalizeJisr("49"));
});

test("أرقام مختلفة تبقى مختلفة بعد التطبيع", () => {
  const keys = ["49", "55", "56", "59", "60", "63", "70", "71", "82", "85"].map(normalizeJisr);
  assert.equal(new Set(keys).size, 10, "لا يجوز أن يتصادم رقمان");
});

/* ── التفرّد على مستوى الخادم ── */

function loadEmployeesWithFakeDb(rows) {
  const dbPath = require.resolve("../lib/db");
  const empPath = require.resolve("../lib/data/employees");
  const calls = [];
  const sql = makeFakeSql((call) => {
    calls.push(call);
    /* الاستعلام الحقيقي يختار data->>'اسم العامل' AS name — تُحاكى صورة
       الصفّ كما تصل من Postgres لا الكائن الداخلي للعيّنة. */
    if (/FROM employees\s+WHERE data->>/.test(call.text)) {
      return rows.filter((r) => r.jisr).map((r) => ({ eid: r.eid, name: r.data[F_NAME], jisr: r.jisr }));
    }
    if (/SELECT data FROM employees WHERE eid =/.test(call.text)) {
      const found = rows.find((r) => String(r.eid) === String(call.values[0]));
      return found ? [{ data: found.data }] : [];
    }
    if (/UPDATE employees/.test(call.text)) return [{ data: { ...rows[0].data } }];
    return [];
  });
  const original = Module._load;
  for (const p of [dbPath, empPath]) delete require.cache[p];
  Module._load = function (request, parent, isMain) {
    if (parent && /lib[\\/]data[\\/]employees\.js$/.test(parent.filename) && request === "../db") {
      return { getSql: () => sql };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const mod = require("../lib/data/employees");
    return { mod, sql, calls, restore: () => { Module._load = original; delete require.cache[empPath]; } };
  } catch (err) {
    Module._load = original;
    throw err;
  }
}

const EMP = (eid, name, jisr) => ({
  eid, jisr,
  data: { [F_EID]: eid, [F_NAME]: name, "رقم الإقامة": "2593650357", ...(jisr ? { [F_JISR]: jisr } : {}) },
});

test("رقم مستعمل عند موظف آخر يُرفض، والرسالة تسمّي المتعارض", async () => {
  const h = loadEmployeesWithFakeDb([EMP("506", "شكيب ميا", "49"), EMP("504", "لامين مولا", null)]);
  try {
    await assert.rejects(
      () => h.mod.update("504", { [F_JISR]: "49" }),
      (err) => {
        assert.match(err.message, /مستعمل بالفعل/);
        assert.match(err.message, /شكيب ميا/, "تسمّي الموظف المتعارض");
        assert.match(err.message, /506/);
        return true;
      }
    );
    assert.equal(h.sql.matching(/UPDATE employees/).length, 0, "لا كتابة عند التعارض");
  } finally { h.restore(); }
});

test("الصورة المُطبَّعة تحكم: «049» يتعارض مع «49»", async () => {
  const h = loadEmployeesWithFakeDb([EMP("506", "شكيب ميا", "49"), EMP("504", "لامين مولا", null)]);
  try {
    await assert.rejects(() => h.mod.update("504", { [F_JISR]: "049" }), /مستعمل بالفعل/);
  } finally { h.restore(); }
});

test("إعادة الرقم نفسه إلى صاحبه تمرّ", async () => {
  const h = loadEmployeesWithFakeDb([EMP("506", "شكيب ميا", "49")]);
  try {
    await h.mod.update("506", { [F_JISR]: "49" });
    assert.equal(h.sql.matching(/UPDATE employees/).length, 1);
  } finally { h.restore(); }
});

/* ── التوافق مع السجلّات القائمة ── */

test("سجلّ بلا الحقل يُقرأ ويُحدَّث كما هو", async () => {
  const h = loadEmployeesWithFakeDb([EMP("500", "شميم", null)]);
  try {
    const before = await h.mod.get("500");
    assert.equal(before[F_JISR], undefined, "الحقل غائب لا فارغ");
    assert.equal(before[F_EID], "500");
    await h.mod.update("500", { "المهنة": "عامل" });
    assert.equal(h.sql.matching(/UPDATE employees/).length, 1, "التحديث يعمل بلا الحقل");
  } finally { h.restore(); }
});

test("تحديث حقل آخر لا يفحص «رقم جسر» ولا يخترعه", async () => {
  const h = loadEmployeesWithFakeDb([EMP("500", "شميم", null), EMP("506", "شكيب ميا", "49")]);
  try {
    await h.mod.update("500", { "المهنة": "عامل تحميل" });
    const lookups = h.sql.matching(/WHERE data->>.* IS NOT NULL/);
    assert.equal(lookups.length, 0, "لا استعلام تفرّد حين لا يُذكر الحقل");
    const write = h.sql.matching(/UPDATE employees/)[0];
    assert.ok(!/رقم جسر/.test(String(write.values[0])), "لا يُضاف المفتاح إلى سجلّ لا يحمله");
  } finally { h.restore(); }
});

test("إدخال رقم جسر لا يمسّ الرقم الوظيفي ولا اسم العامل", async () => {
  const h = loadEmployeesWithFakeDb([EMP("506", "شكيب ميا", null)]);
  try {
    await h.mod.update("506", { [F_JISR]: "49" });
    const merged = JSON.parse(h.sql.matching(/UPDATE employees/)[0].values[0]);
    assert.equal(merged[F_EID], "506", "الرقم الوظيفي كما هو");
    assert.equal(merged[F_NAME], "شكيب ميا");
    assert.equal(merged[F_JISR], "49");
    assert.equal(merged["رقم الإقامة"], "2593650357", "الحقول الأخرى سليمة");
  } finally { h.restore(); }
});

/* ── الاقتراح بالاسم: عرض لا ربط ── */

test("طيّ الاسم العربي يقارب الصيغ المختلفة", () => {
  assert.equal(foldArabic("الأمين مولا"), foldArabic("الامين مولا"));
  assert.equal(similarity("شكيب مياه", "شكيب ميا"), 1);
  assert.equal(similarity("ساجر احمد", "ساجر"), 1);
  assert.ok(similarity("شكيب مياه", "ساجر") < 0.5, "اسمان مختلفان لا يتقاربان");
});

/* ── التحقّق قبل الكتابة ── */

const PLATFORM = [
  { [F_EID]: "500", [F_NAME]: "شميم" },
  { [F_EID]: "504", [F_NAME]: "لامين مولا" },
  { [F_EID]: "506", [F_NAME]: "شكيب ميا" },
];
const depsFor = (employees, written) => ({
  listEmployees: async () => employees,
  updateEmployee: async (eid, patch) => { written.push({ eid, patch }); },
});

test("سطر بلا رقم وظيفي (ما زال null) يوقف كل شيء", async () => {
  const written = [];
  const r = await apply([{ "رقم جسر": "49", "الرقم الوظيفي": null }], depsFor(PLATFORM, written), {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /ما زال null/);
  assert.equal(written.length, 0);
});

test("رقم جسر مكرّر داخل الملف يُرفض", async () => {
  const written = [];
  const r = await apply([
    { "رقم جسر": "49", "الرقم الوظيفي": "506" },
    { "رقم جسر": "049", "الرقم الوظيفي": "504" },
  ], depsFor(PLATFORM, written), {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /مكرّر داخل الملف/.test(e)));
  assert.equal(written.length, 0, "خطأ واحد يمنع كل الكتابات لا سطره وحده");
});

test("رقم مملوك لموظف آخر يُرفض حتى مع --overwrite", async () => {
  const withHolder = [...PLATFORM, { [F_EID]: "509", [F_NAME]: "مد هلال", [F_JISR]: "49" }];
  const written = [];
  const r = await apply([{ "رقم جسر": "49", "الرقم الوظيفي": "506" }], depsFor(withHolder, written), { overwrite: true });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /مستعمل للموظف/);
  assert.equal(written.length, 0);
});

test("استبدال رقم قائم يحتاج --overwrite", async () => {
  const withOld = PLATFORM.map((e) => (e[F_EID] === "506" ? { ...e, [F_JISR]: "12" } : e));
  const blocked = await apply([{ "رقم جسر": "49", "الرقم الوظيفي": "506" }], depsFor(withOld, []), {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors[0], /--overwrite/);

  const written = [];
  const allowed = await apply([{ "رقم جسر": "49", "الرقم الوظيفي": "506" }], depsFor(withOld, written), { overwrite: true });
  assert.equal(allowed.ok, true);
  assert.deepEqual(written, [{ eid: "506", patch: { [F_JISR]: "49" } }]);
});

test("--dry-run يعرض الخطّة ولا يكتب", async () => {
  const written = [];
  const r = await apply([{ "رقم جسر": "49", "الرقم الوظيفي": "506" }], depsFor(PLATFORM, written), { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.plan[0].action, "إضافة");
  assert.equal(written.length, 0, "معاينة تعني صفر كتابة");
});

test("الكتابة تمسّ «رقم جسر» وحده", async () => {
  const written = [];
  const r = await apply([
    { "رقم جسر": "49", "الرقم الوظيفي": "506" },
    { "رقم جسر": "71", "الرقم الوظيفي": "500" },
  ], depsFor(PLATFORM, written), {});
  assert.equal(r.ok, true);
  assert.equal(r.written, 2);
  for (const w of written) {
    assert.deepEqual(Object.keys(w.patch), [F_JISR], "لا حقل آخر في أي تعديل");
  }
});

test("رقم وظيفي غير موجود يُرفض", async () => {
  const r = await validate([{ "رقم جسر": "49", "الرقم الوظيفي": "999" }], { listEmployees: async () => PLATFORM }, {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /لا موظف بالرقم الوظيفي 999/);
});
