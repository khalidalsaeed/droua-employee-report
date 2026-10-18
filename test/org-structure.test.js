const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getResource } = require("../lib/data/registry");
const source = require("../lib/org/source");
const importer = require("../scripts/import-org-xlsx");
const migration = require("../scripts/setup-org-manager");
const { assertManagerAssignable } = require("../lib/org/managerGuard");
const { buildXlsx } = require("./helpers/workbook-builder");

const ROOT = path.join(__dirname, "..");

/* مورد الهيكل، ومولّد اللقطة، والهجرة المقترحة وحارسها. */

test("المورد: مسجَّل ومحروس بصلاحية سجلّ الموظفين", () => {
  const mod = getResource("org-structure");
  assert.ok(mod);
  assert.equal(mod.section, "employees");
});

test("المورد: يُرجع صفوف اللقطة كما هي مع اسم المصدر", async () => {
  const items = await getResource("org-structure").list();
  assert.equal(items.length, source.ROWS.length);
  assert.equal(items[0].source, source.SOURCE_NAME);
  const { source: _s, ...rest } = items[0];
  assert.deepEqual(rest, source.ROWS[0]);
});

test("المورد: الكتابة مرفوضة كلها", async () => {
  const mod = getResource("org-structure");
  for (const fn of ["create", "update", "remove"]) await assert.rejects(() => mod[fn]({}), /للقراءة فقط/);
});

test("اللقطة: الأعمدة السبعة وحدها، بلا حقل مخترع", () => {
  const allowed = new Set(["row", ...Object.values(importer.COLUMNS)]);
  for (const r of source.ROWS) for (const k of Object.keys(r)) assert.ok(allowed.has(k), `حقل غير متوقّع: ${k}`);
});

test("المولّد: يقرأ صفّ العناوين الثاني ويحفظ الإملاء كما هو", () => {
  // ⛔ بيانات مصنوعة
  const bytes = buildXlsx([
    ["المعلومات الوظيفية", null, null, null, null, "التفاصيل الأساسية", null],
    ["حالة الموظف", "القسم", "الموقع", "المدير المباشر", "البريد الإلكتروني", "الاسم كاملاً باللغة الانجليزية", "الاسم كاملاً باللغة العربية"],
    ["نشط", "ادارة الاختبار", "فرع س", "مدير س", "a@example.test", "TEST ONE", "اختبار واحد"],
    [null, null, null, null, null, null, null],
    ["نشط", "إدارة الاختبار", "فرع ص", null, null, "TEST TWO", "اختبار اثنان"],
  ]);
  const rows = importer.extract(bytes);
  assert.equal(rows.length, 2, "الصفّ الفارغ يُتجاهل");
  assert.deepEqual(rows[0], { row: 3, status: "نشط", department: "ادارة الاختبار", location: "فرع س", managerName: "مدير س",
    email: "a@example.test", nameEn: "TEST ONE", nameAr: "اختبار واحد" });
  assert.equal(rows[1].department, "إدارة الاختبار", "لا تصحيح إملائي");
  assert.equal(rows[1].managerName, null);
});

test("المولّد: عمود ناقص يوقف التوليد", () => {
  const bytes = buildXlsx([["حالة الموظف", "القسم", "المدير المباشر"], ["نشط", "س", "م"]]);
  assert.throws(() => importer.extract(bytes), /الموقع/);
});

test("المولّد: ما يكتبه يُقرأ كما هو", () => {
  const out = importer.render([{ row: 3, nameAr: "أ" }], "ملف.xlsx");
  const mod = { exports: {} };
  new Function("module", out)(mod);
  assert.deepEqual(mod.exports.ROWS, [{ row: 3, nameAr: "أ" }]);
  assert.equal(mod.exports.SOURCE_NAME, "ملف.xlsx");
});

test("الهجرة: عمود مرجعي ذاتي، وقيد المدير نفسه، ومُشغّل الحلقات", () => {
  const all = migration.STATEMENTS.map((s) => s.sql).join("\n");
  assert.match(all, /ADD COLUMN IF NOT EXISTS manager_eid TEXT NULL\s+REFERENCES employees\(eid\) ON UPDATE CASCADE ON DELETE SET NULL/);
  assert.match(all, /CHECK \(manager_eid IS NULL OR manager_eid <> eid\)/);
  assert.match(all, /CREATE TRIGGER trg_employees_manager_cycle\s+BEFORE INSERT OR UPDATE OF manager_eid, eid ON employees/);
  assert.match(all, /RAISE EXCEPTION 'manager_cycle/);
  assert.doesNotMatch(all, /\b(DROP TABLE|DELETE FROM|TRUNCATE|UPDATE employees SET)\b/i, "لا تمسّ بيانات قائمة");
});

test("الهجرة: الرجوع يزيل كل ما أضافته بالترتيب العكسي", () => {
  const rb = migration.ROLLBACK.map((s) => s.sql).join("\n");
  for (const what of [/DROP TRIGGER IF EXISTS trg_employees_manager_cycle/, /DROP FUNCTION IF EXISTS employees_reject_manager_cycle/,
    /DROP INDEX IF EXISTS idx_employees_manager_eid/, /DROP CONSTRAINT IF EXISTS employees_manager_not_self/, /DROP COLUMN IF EXISTS manager_eid/]) {
    assert.match(rb, what);
  }
  const order = migration.ROLLBACK.map((s) => s.sql);
  assert.ok(order.findIndex((s) => /TRIGGER/.test(s)) < order.findIndex((s) => /DROP COLUMN/.test(s)));
});

test("الهجرة: run ينفّذ العبارات بالترتيب عبر sql.query", async () => {
  const seen = [];
  const n = await migration.run({ query: async (s) => seen.push(s) }, migration.STATEMENTS);
  assert.equal(n, migration.STATEMENTS.length);
  assert.deepEqual(seen, migration.STATEMENTS.map((s) => s.sql));
});

test("الهجرة غير مُطبَّقة: لا شيفرة في المنصّة تقرأ العمود بعد", () => {
  const employees = fs.readFileSync(path.join(ROOT, "lib/data/employees.js"), "utf8");
  assert.doesNotMatch(employees, /manager_eid|managerGuard/);
});

/* الحارس: sql مصنوع يُرجع حواف الحالة الحالية */
const fakeSql = (rows) => async () => rows;

test("الحارس: يرفض المدير نفسه والحلقات والمدير غير الموجود", async () => {
  const sql = fakeSql([{ eid: "500", manager_eid: null }, { eid: "501", manager_eid: "500" }, { eid: "502", manager_eid: "501" }]);
  await assert.rejects(() => assertManagerAssignable(sql, "500", "500"), (e) => e.code === "self_manager");
  await assert.rejects(() => assertManagerAssignable(sql, "500", "501"), (e) => e.code === "cycle");
  await assert.rejects(() => assertManagerAssignable(sql, "500", "502"), (e) => e.code === "cycle");
  await assert.rejects(() => assertManagerAssignable(sql, "500", "999"), (e) => e.code === "missing_manager");
  await assertManagerAssignable(sql, "502", "500");
  await assertManagerAssignable(sql, "502", "");
});
