const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { makeFakeSql } = require("./helpers/fake-sql");
const { normalizeJisr, F_JISR, F_DAMANAH, F_NAME } = require("../lib/data/employees");
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
  data: { [F_DAMANAH]: eid, [F_NAME]: name, "رقم الإقامة": "2593650357", ...(jisr ? { [F_JISR]: jisr } : {}) },
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
    assert.equal(before[F_DAMANAH], "500");
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

test("إدخال رقم جسر لا يمسّ رقم ضمان ولا اسم العامل", async () => {
  const h = loadEmployeesWithFakeDb([EMP("506", "شكيب ميا", null)]);
  try {
    await h.mod.update("506", { [F_JISR]: "49" });
    const merged = JSON.parse(h.sql.matching(/UPDATE employees/)[0].values[0]);
    assert.equal(merged[F_DAMANAH], "506", "رقم ضمان كما هو");
    assert.equal(merged[F_NAME], "شكيب ميا");
    assert.equal(merged[F_JISR], "49");
    assert.equal(merged["رقم الإقامة"], "2593650357", "الحقول الأخرى سليمة");
  } finally { h.restore(); }
});

/* ── الاقتراح بالاسم: عرض لا ربط ── */

/* التغطية الكاملة للمطابقة بالكلمات في test/jisr-name-match.test.js —
   هذا فحص سلامة رقيق يثبت أن الاقتراح ما زال موصولًا بها. */
test("الاقتراح بالاسم يقارب الصيغ المختلفة ويفرّق المختلفة", () => {
  assert.equal(foldArabic("الأمين مولا"), foldArabic("الامين مولا"));
  assert.ok(similarity("شكيب مياه", "شكيب ميا") >= 0.95, "بادئة ناقصة تبقى مرشّحًا قويًا");
  assert.equal(similarity("ساجر احمد", "ساجر"), 1, "اسم مختصر لا يُعاقَب على نقصه");
  assert.equal(similarity("شكيب مياه", "ساجر"), 0, "اسمان مختلفان لا يتقاربان إطلاقًا");
});

/* ── التحقّق قبل الكتابة ── */

const PLATFORM = [
  { [F_DAMANAH]: "500", [F_NAME]: "شميم" },
  { [F_DAMANAH]: "504", [F_NAME]: "لامين مولا" },
  { [F_DAMANAH]: "506", [F_NAME]: "شكيب ميا" },
];
const depsFor = (employees, written) => ({
  listEmployees: async () => employees,
  updateEmployee: async (eid, patch) => { written.push({ eid, patch }); },
});

test("سطر بلا رقم ضمان (ما زال null) يوقف كل شيء", async () => {
  const written = [];
  const r = await apply([{ "رقم جسر": "49", "رقم ضمان": null }], depsFor(PLATFORM, written), {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /ما زال null/);
  assert.equal(written.length, 0);
});

test("رقم جسر مكرّر داخل الملف يُرفض", async () => {
  const written = [];
  const r = await apply([
    { "رقم جسر": "49", "رقم ضمان": "506" },
    { "رقم جسر": "049", "رقم ضمان": "504" },
  ], depsFor(PLATFORM, written), {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /مكرّر داخل الملف/.test(e)));
  assert.equal(written.length, 0, "خطأ واحد يمنع كل الكتابات لا سطره وحده");
});

test("رقم مملوك لموظف آخر يُرفض حتى مع --overwrite", async () => {
  const withHolder = [...PLATFORM, { [F_DAMANAH]: "509", [F_NAME]: "مد هلال", [F_JISR]: "49" }];
  const written = [];
  const r = await apply([{ "رقم جسر": "49", "رقم ضمان": "506" }], depsFor(withHolder, written), { overwrite: true });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /مستعمل للموظف/);
  assert.equal(written.length, 0);
});

test("استبدال رقم قائم يحتاج --overwrite", async () => {
  const withOld = PLATFORM.map((e) => (e[F_DAMANAH] === "506" ? { ...e, [F_JISR]: "12" } : e));
  const blocked = await apply([{ "رقم جسر": "49", "رقم ضمان": "506" }], depsFor(withOld, []), {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors[0], /--overwrite/);

  const written = [];
  const allowed = await apply([{ "رقم جسر": "49", "رقم ضمان": "506" }], depsFor(withOld, written), { overwrite: true });
  assert.equal(allowed.ok, true);
  assert.deepEqual(written, [{ eid: "506", patch: { [F_JISR]: "49" } }]);
});

test("--dry-run يعرض الخطّة ولا يكتب", async () => {
  const written = [];
  const r = await apply([{ "رقم جسر": "49", "رقم ضمان": "506" }], depsFor(PLATFORM, written), { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.plan[0].action, "إضافة");
  assert.equal(written.length, 0, "معاينة تعني صفر كتابة");
});

test("الكتابة تمسّ «رقم جسر» وحده", async () => {
  const written = [];
  const r = await apply([
    { "رقم جسر": "49", "رقم ضمان": "506" },
    { "رقم جسر": "71", "رقم ضمان": "500" },
  ], depsFor(PLATFORM, written), {});
  assert.equal(r.ok, true);
  assert.equal(r.written, 2);
  for (const w of written) {
    assert.deepEqual(Object.keys(w.patch), [F_JISR], "لا حقل آخر في أي تعديل");
  }
});

test("رقم ضمان غير موجود يُرفض", async () => {
  const r = await validate([{ "رقم جسر": "49", "رقم ضمان": "999" }], { listEmployees: async () => PLATFORM }, {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /لا موظف برقم ضمان 999/);
});

/* ── التسمية والقفل في الواجهة ──
   الحارس هنا على ملفّات HTML/JS مباشرةً: التسمية العامّة «الرقم الوظيفي»
   هي ما سبّب اللبس بين نظامين، ورجوعها إلى شاشة أو تقرير انحدارٌ صامت لا
   يكشفه أي اختبار يقيس السلوك. */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const USER_FACING = [
  "app-shell.html", "expiring-shell.html", "tickets-shell.html",
  "payroll-detail-shell.html", "lib/reports/reportPdf.js", "lib/reports/reportData.js",
];

test("لا تسمية «الرقم الوظيفي» في أي شاشة أو تقرير", () => {
  for (const file of USER_FACING) {
    const src = read(file);
    /* المفتاح المخزَّن يبقى كما هو داخل lib/، لكن هذه الملفّات لا تلمسه:
       تصل إليه عبر F.damanah / F_DAMANAH. فأي ظهور نصّي هنا تسمية معروضة. */
    assert.ok(!src.includes("الرقم الوظيفي"), `${file} ما زال يعرض «الرقم الوظيفي» — استبدلها بـ«رقم ضمان»`);
  }
});

test("مفتاح التخزين لم يتغيّر — لا هجرة بيانات", () => {
  assert.equal(F_DAMANAH, "الرقم الوظيفي", "القيمة المخزَّنة في JSONB تبقى كما هي");
  assert.equal(read("doc-status.js").includes('damanah:"الرقم الوظيفي"'), true);
});

test("الرقمان يظهران معًا في صفحة المسير", () => {
  const src = read("payroll-detail-shell.html");
  assert.match(src, /رقم ضمان/, "رقم ضمان معروض");
  assert.match(src, /رقم جسر/, "ورقم جسر بجانبه");
  assert.match(src, /emp\.jisrNo/, "من طبقة البيانات لا مكتوبًا بيد");
});

/* الحقل مقفول بطبقتين قائمتين: disabled على المُدخَل، واستثناؤه من
   الـpatch. الثانية هي الحاسمة — الأولى وحدها يتجاوزها أي تعديل في
   أدوات المتصفّح. */
test("رقم ضمان مقفول بعد الإنشاء، ومعه تلميح يشرح السبب", () => {
  const src = read("app-shell.html");
  assert.match(src, /isEdit&&spec\.key==="damanah"/, "disabled على الحقل عند التعديل");
  assert.match(src, /if\(isEdit && spec\.key==="damanah"\) continue;/, "ويُستثنى من الـpatch");
  assert.match(src, /لا يُعدّل بعد إنشاء السجل لأنه مرتبط بسجلات أخرى/, "والتلميح معروض");
  assert.match(src, /spec\.hint\?/, "والتلميح يُرسم فعلًا لا يُخزَّن فقط");
});

/* ── تطابق قيد القاعدة مع منطق التطبيق ──
   =========================================================================
   حماية التطبيق وحدها لا تكفي: كتابة SQL مباشرة أو سباق بين طلبين
   يتجاوزانها. والفهرس لا ينفع إن بُني على القيمة الخام — عندها يرى "49"
   و"049" مدخلين مختلفين فيقبلهما لموظفَين، بينما التطبيق يعدّهما الرقم
   نفسه. فيصير للمنصّة تعريفان متضاربان لهوية واحدة.

   لا Postgres في هذه الاختبارات، فتُحاكى دلالة تعبير الفهرس حرفيًا
   وتُقارن بـnormalizeJisr على جدول مدخلات. الغرض إثبات أنهما لا
   يفترقان، وأن أي تعديل على أحدهما وحده يُسقط الاختبار. */

const { JISR_NORMALIZE_SQL } = require("../scripts/setup-jisr-number.js");

/* محاكاة regexp_replace(btrim(x), '^0+(?=[0-9])', '') — النمط نفسه
   والدلالة نفسها: الاستبدال غير عام والنمط مثبَّت على البداية. */
function simulatePostgresNormalize(raw) {
  const trimmed = String(raw === undefined || raw === null ? "" : raw).trim();
  return trimmed.replace(/^0+(?=[0-9])/, "");
}

test("الفهرس مبنيّ على الصورة المُطبَّعة لا على القيمة الخام", () => {
  const indexSql = require("../scripts/setup-jisr-number.js").STATEMENTS[0].sql;
  assert.match(indexSql, /CREATE UNIQUE INDEX/);
  assert.ok(indexSql.includes(JISR_NORMALIZE_SQL), "تعبير التطبيع داخل الفهرس نفسه");
  assert.match(JISR_NORMALIZE_SQL, /regexp_replace/, "تطبيع لا قيمة خام");
  assert.match(JISR_NORMALIZE_SQL, /\^0\+\(\?=\[0-9\]\)/, "حذف الأصفار البادئة قبل رقم فقط");
  assert.match(JISR_NORMALIZE_SQL, /btrim/, "مع تشذيب المسافات");
  /* فهرسٌ على data->>'رقم جسر' وحده هو العطل الذي نحرس منه. */
  assert.ok(!/\(\(data->>'رقم جسر'\)\)/.test(indexSql), "لا فهرس على القيمة الخام");
});

test("القيد يرفض 49 و049 كرقمين لموظفين مختلفين", () => {
  /* مفتاحا الفهرس متطابقان ⇒ INSERT الثاني يخرق UNIQUE ويُرفض. */
  assert.equal(simulatePostgresNormalize("049"), simulatePostgresNormalize("49"));
  assert.equal(simulatePostgresNormalize("049"), "49");
  /* والتطبيق يقول الشيء نفسه — تعريف واحد لا اثنان. */
  assert.equal(normalizeJisr("049"), normalizeJisr("49"));
  assert.equal(normalizeJisr("049"), simulatePostgresNormalize("049"));
});

test("تعبير الفهرس و normalizeJisr لا يفترقان على أي مدخل", () => {
  const inputs = [
    "49", "049", "0049", "00049", " 49 ", "\t049\n",
    "0", "00", "000", "1", "10", "100", "0100",
    "9999", "085", "85", "506", "0506",
    "A49", "0A", "49A", "", "   ",
  ];
  for (const v of inputs) {
    const app = normalizeJisr(v);
    const db = simulatePostgresNormalize(v);
    /* التطبيق يُرجع null للفارغ، والقاعدة تستثنيه بشرط WHERE — فيُقارَن
       غير الفارغ وحده، وهو ما يدخل الفهرس فعلًا. */
    if (app === null) {
      assert.equal(db, "", `${JSON.stringify(v)}: فارغ في الطرفين`);
    } else {
      assert.equal(db, app, `${JSON.stringify(v)}: القاعدة «${db}» ≠ التطبيق «${app}»`);
    }
  }
});

/* بدون النظرة الأمامية يُحذف الصفر من "0A" في القاعدة ولا يُحذف في
   التطبيق — فيفترق التعريفان في حالة لا يكشفها مدخل رقمي. */
test("النظرة الأمامية تمنع افتراق التعريفين على مدخل غير رقمي", () => {
  assert.equal(normalizeJisr("0A"), "0A");
  assert.equal(simulatePostgresNormalize("0A"), "0A");
  const naive = "0A".replace(/^0+/, "");
  assert.notEqual(naive, normalizeJisr("0A"), "التطبيع الساذج كان سيفترق هنا");
});

test("أرقام مختلفة تبقى مفاتيح مختلفة في الفهرس", () => {
  const keys = ["49", "55", "56", "59", "60", "63", "70", "71", "82", "085"]
    .map(simulatePostgresNormalize);
  assert.equal(new Set(keys).size, 10, "عشرة مفاتيح متمايزة");
  assert.ok(keys.includes("85"), "«085» يدخل الفهرس بمفتاح «85»");
});

test("الفهرس جزئيّ: غير المربوطين لا يتعارضون", () => {
  const indexSql = require("../scripts/setup-jisr-number.js").STATEMENTS[0].sql;
  assert.match(indexSql, /WHERE .*IS NOT NULL/);
  assert.match(indexSql, /btrim\(data->>'رقم جسر'\) <> ''/);
});

test("سكربت الفهرس لا يحمل عبارة إسقاط ولا تعديل بيانات", () => {
  const { STATEMENTS } = require("../scripts/setup-jisr-number.js");
  const all = STATEMENTS.map((s) => s.sql).join(" ");
  for (const verb of ["DROP", "DELETE", "TRUNCATE", "UPDATE", "INSERT", "ALTER TABLE"]) {
    assert.ok(!new RegExp(verb).test(all), `يجب ألّا تظهر ${verb}`);
  }
});
