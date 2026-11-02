const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { neon } = require("@neondatabase/serverless");

const ROOT = path.join(__dirname, "..");
const dir = require("../lib/data/staffDirectory");
const mig = require("../scripts/migrate-staff-directory");
const imp = require("../scripts/import-staff-directory");
const { buildXlsx } = require("./helpers/workbook-builder");
const { readFirstSheet } = require("../scripts/import-org-xlsx");

/* الدليل الموحَّد: منع التكرار، والهجرة، والاستيراد. كل الأسماء والأرقام مُختلَقة. */

const AJEER = [
  { eid: "501", name: "لامين مولا", identity: "2400000501" },
  { eid: "502", name: "شكيب مياه", identity: "2400000502" },
  { eid: "503", name: "توأم الاسم", identity: "2400000503" },
  { eid: "504", name: "توأم الاسم", identity: "2400000504" },
];

/* ─── منع التكرار ─── */
test("الهوية مفتاح المطابقة القويّ: موظف أجير واحد = لا صفّ ذروة (يظهر مرّة واحدة كأجير)", () => {
  const [r] = dir.classifyImport([{ row: 2, number: "D-1", name: "Lamine Moula", job: "عامل", identity: "2400000501" }], { ajeer: AJEER });
  assert.equal(r.status, "ajeer");
  assert.equal(r.ajeerEid, "501");
});

test("الالتباس يُعرض للمراجعة لا يُخمَّن", () => {
  const ajeer = [...AJEER, { eid: "509", name: "آخر", identity: "2400000501" }];
  const out = dir.classifyImport([
    { row: 2, number: "D-1", name: "س", identity: "2400000501" },        // هوية تطابق اثنين
    { row: 3, number: "D-2", name: "شكيب مياه" },                       // بلا هوية والاسم يطابق أجير
    { row: 4, number: "D-3", name: "أ", identity: "1000000003" },
    { row: 5, number: "D-3", name: "ب", identity: "1000000004" },        // رقم مكرّر داخل الملف
    { row: 6, number: "D-6", name: "ج", identity: "1000000006" },
    { row: 7, number: "D-7", name: "د", identity: "1000000006" },        // هوية مكرّرة داخل الملف
    { row: 8, number: "D-8", name: "توأم الاسم" },                       // اسم يطابق اثنين
  ], { ajeer });
  assert.deepEqual(out.map((r) => r.status), ["review", "review", "review", "review", "review", "review", "review"]);
  assert.deepEqual(out[1].candidates, ["502"]);
  assert.deepEqual(out[6].candidates, ["503", "504"]);
});

test("جديد، وناقص، وإعادة الاستيراد لا تُنشئ صفًّا ثانيًا", () => {
  const existing = [{ id: "7", employeeNumber: "D-10", name: "نايف", job: "محاسب", department: "المالية", identity: "1000000010" }];
  const out = dir.classifyImport([
    { row: 2, number: "D-9", name: "ريم", job: "مديرة", identity: "١٠٠٠٠٠٠٠٠٩" },  // أرقام هندية تُطبَّع
    { row: 3, number: "D-11", name: "سارة" },                                     // بلا هوية ولا تطابق اسم
    { row: 4, number: "", name: "بلا رقم" },
    { row: 5, number: "D-10", name: "نايف", job: "محاسب", department: "المالية" },  // مطابق
    { row: 6, number: "D-99", name: "نايف", job: "محاسب أول", department: "المالية", identity: "1000000010" }, // نفس الهوية برقم آخر
  ], { ajeer: AJEER, existing });
  assert.deepEqual(out.map((r) => r.status), ["new", "new", "invalid", "unchanged", "update"]);
  assert.equal(out[0].identity, "1000000009");
  assert.equal(out[4].staffId, "7");
  /* الهوية والرقم يشيران إلى صفّين مختلفين: التباس. */
  const clash = dir.classifyImport([{ row: 2, number: "D-10", name: "x", identity: "1000000077" }],
    { existing: [...existing, { id: "8", employeeNumber: "D-77", name: "y", identity: "1000000077" }] });
  assert.equal(clash[0].status, "review");
});

test("قرار المراجعة (--assign) يحسم الالتباس صراحةً", () => {
  const rows = [{ row: 2, number: "D-2", name: "شكيب مياه" }, { row: 3, number: "D-3", name: "شكيب مياه" }, { row: 4, number: "D-4", name: "توأم الاسم" }];
  const out = dir.classifyImport(rows, { ajeer: AJEER, assign: { "D-2": "ajeer:502", "D-3": "new", "D-4": "skip" } });
  assert.deepEqual(out.map((r) => [r.status, r.ajeerEid]), [["ajeer", "502"], ["new", undefined], ["skip", undefined]]);
  assert.deepEqual(imp.parseAssign(["--assign=D-2=ajeer:502", "--assign= D-3 =new"]), { "D-2": "ajeer:502", "D-3": "new" });
  assert.throws(() => imp.parseAssign(["--assign=D-2=maybe"]), /غير صالحة/);
});

test("تطبيع الهوية: أرقام فقط، 6–15 رقمًا، وإلا لا هوية", () => {
  assert.equal(dir.normalizeIdentity(" 2400-000-501 "), "2400000501");
  assert.equal(dir.normalizeIdentity("۲۴۰۰۰۰۰۵۰۱"), "2400000501");
  assert.equal(dir.normalizeIdentity("12"), null);
  assert.equal(dir.normalizeIdentity(""), null);
  assert.equal(dir.mask("2400000501"), "••••••0501");
});

/* ─── الهجرة ─── */
test("الهجرة: الخطة تنقل الرحلات القائمة ثم تحذف العمود القديم — بهذا الترتيب", () => {
  const steps = mig.plan({ travelExists: true, hasEmployeeEid: true, hasStaffId: false, directoryExists: false, trips: 3 });
  const labels = steps.map((s) => s.label);
  const at = (re) => labels.findIndex((l) => re.test(l));
  assert.ok(at(/جدول staff_directory/) === 0);
  assert.ok(at(/تجسيد/) < at(/ربط الرحلات/));
  assert.ok(at(/ربط الرحلات/) < at(/staff_id إلزامي/));
  assert.ok(at(/staff_id إلزامي/) < at(/حذف العمود القديم/));
  assert.equal(at(/حذف العمود القديم/), labels.length - 1);
  /* بعد التطبيق: لا نقل ولا حذف. */
  const again = mig.plan({ travelExists: true, hasEmployeeEid: false, hasStaffId: true, directoryExists: true, trips: 3 }).map((s) => s.label);
  assert.ok(!again.some((l) => /تجسيد|ربط الرحلات|حذف العمود/.test(l)));
  assert.throws(() => mig.plan({ travelExists: false }), /setup-staff-travel/);
});

test("الهجرة: القيود — الدليل SET NULL لأجير، والرحلة RESTRICT على الدليل، وفرادة بلا تكرار", () => {
  const all = [...mig.CREATE, ...mig.BACKFILL, ...mig.FINALIZE].map((s) => s.sql).join("\n");
  assert.match(all, /source_employee_eid text REFERENCES employees\(eid\) ON UPDATE CASCADE ON DELETE SET NULL/);
  assert.match(all, /staff_id bigint REFERENCES staff_directory\(id\) ON UPDATE CASCADE ON DELETE RESTRICT/);
  assert.match(all, /CHECK \(source_type IN \('droua', 'ajeer'\)\)/);
  assert.match(all, /CHECK \(source_type <> 'droua' OR source_employee_eid IS NULL\)/);
  assert.match(all, /identity_number ~ '\^\[0-9\]\{6,15\}\$'/);
  for (const ix of ["uq_staff_directory_employee", "uq_staff_directory_number", "uq_staff_directory_identity", "idx_employee_travel_staff"]) assert.match(all, new RegExp(ix));
  /* لا حذف بيانات في المسار الأمامي — الحذف الوحيد عمودٌ بعد نقل محتواه. */
  assert.doesNotMatch(all, /DELETE FROM|DROP TABLE|audit_log/);
  assert.deepEqual(mig.DROP_OLD.map((s) => s.sql), ["ALTER TABLE employee_travel DROP COLUMN IF EXISTS employee_eid"]);
  /* التراجع يعيد البنية القديمة بقيدها RESTRICT، ولا يحذف الرحلات إلا بخيار صريح. */
  const rb = mig.ROLLBACK.map((s) => s.sql).join("\n");
  assert.match(rb, /REFERENCES employees\(eid\) ON UPDATE CASCADE ON DELETE RESTRICT/);
  assert.match(rb, /DROP TABLE IF EXISTS staff_directory$/m);
  assert.doesNotMatch(rb, /DELETE FROM/);
  assert.match(mig.DROP_UNMAPPABLE.sql, /DELETE FROM employee_travel/);
});

test("الهجرة: كل العبارات تصل في معاملة واحدة (طلب HTTP واحد) — لا نصف تطبيق", async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ results: body.queries.map(() => ({ command: "X", rowCount: 0, rows: [], fields: [] })) }) };
  };
  try {
    const sql = neon("postgresql://user:pass@ep-fake.us-east-2.aws.neon.tech/db");
    const steps = mig.plan({ travelExists: true, hasEmployeeEid: true });
    assert.equal(await mig.run(sql, steps), steps.length);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].queries.length, steps.length);
    assert.deepEqual(requests[0].queries.map((q) => q.query), steps.map((s) => s.sql));
  } finally { globalThis.fetch = original; }
});

/* ─── الاستيراد ─── */
test("الاستيراد: يقرأ تقرير xlsx بعناوين عربية ويتعرّف على الأعمدة والحالة", () => {
  const bytes = buildXlsx([
    ["تقرير قائمة الموظفين"],
    [],
    ["رقم الموظف", "الاسم كاملاً باللغة العربية", "المسمى الوظيفي", "القسم", "رقم الهوية/الإقامة", "حالة الموظف"],
    ["D-1", "خالد السعيد", "مدير الموارد البشرية", "الموارد البشرية", "1000000001", "نشط"],
    ["D-2", "ريم علي", "محاسبة", "المالية", "", "غير نشط"],
    [],
  ]);
  const { columns, rows } = imp.extract(readFirstSheet(bytes));
  assert.deepEqual(columns.sort(), ["department", "identity", "job", "name", "number", "status"]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { row: 4, number: "D-1", name: "خالد السعيد", job: "مدير الموارد البشرية", department: "الموارد البشرية", identity: "1000000001", active: true });
  assert.equal(rows[1].active, false);
  assert.equal(rows[1].identity, null);
});

test("الاستيراد: csv بعلامات اقتباس، وعناوين إنجليزية، وبلا عمود هوية", () => {
  const raw = imp.parseCsv('﻿Employee No,Name,Job Title\r\n7,"Al ""Amin"", Saeed",Driver\r\n8,Noor,\r\n');
  const { columns, rows } = imp.extract(raw);
  assert.deepEqual(columns.sort(), ["job", "name", "number"]);
  assert.deepEqual(rows.map((r) => [r.number, r.name, r.job]), [["7", 'Al "Amin", Saeed', "Driver"], ["8", "Noor", null]]);
  assert.throws(() => imp.extract(imp.parseCsv("a,b\n1,2\n")), /صفّ عناوين/);
});

test("الاستيراد: التقرير لا يُكتب داخل المستودع، والكتابة بدفعة معلَّمة", () => {
  assert.throws(() => imp.assertOutsideRepo(path.join(ROOT, "report.json")), /خارج المستودع/);
  assert.throws(() => imp.assertOutsideRepo(ROOT), /خارج المستودع/);
  assert.ok(imp.assertOutsideRepo(path.join(os.tmpdir(), "r.json")));
  const calls = [];
  const sql = (strings, ...values) => { calls.push({ text: strings.join("?"), values }); return {}; };
  const rows = [{ row: 2, active: true }, { row: 3, active: false }, { row: 4, active: true }];
  const result = [
    { row: 2, status: "new", number: "D-1", name: "أ", job: null, department: null, identity: "1000000001" },
    { row: 3, status: "update", staffId: "7", number: "D-2", name: "ب", job: "ج", department: null, identity: null },
    { row: 4, status: "ajeer", ajeerEid: "501" },
  ];
  const q = imp.writeQueries(sql, result, rows, "droua-2026-11");
  assert.equal(q.length, 2, "صفّ ajeer لا يُكتب");
  assert.match(calls[0].text, /INSERT INTO staff_directory/);
  assert.ok(calls[0].values.includes("droua-2026-11"));
  assert.match(calls[1].text, /UPDATE staff_directory/);
  assert.ok(calls[1].values.includes(false), "الحالة من التقرير (غير نشط)");
});

test("لا تقرير موظفين ولا هويات حقيقية في المستودع من هذه الميزة", () => {
  const { execSync } = require("node:child_process");
  const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n");
  assert.deepEqual(tracked.filter((f) => /staff|directory/i.test(f) && /\.(xlsx|xls|csv|json)$/i.test(f)), []);
  for (const f of ["lib/data/staffDirectory.js", "scripts/import-staff-directory.js", "scripts/migrate-staff-directory.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /\b[12]\d{9}\b/, f);
  }
});
