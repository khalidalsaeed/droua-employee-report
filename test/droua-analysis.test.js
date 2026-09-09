const test = require("node:test");
const assert = require("node:assert/strict");

const csvParser = require("../lib/droua/parsers/csv");
const parsers = require("../lib/droua/parsers");
const { compare, RULES } = require("../lib/droua/compare");
const findings = require("../lib/droua/findings");
const fx = require("./helpers/payroll-fixtures");

/* ─── القراءة والمقارنة ─────────────────────────────────────────────────
   =========================================================================
   هاتان طبقتان **نقيّتان**: بايتات تدخل وجداول تخرج، ثمّ جداول تدخل
   وملاحظات تخرج. لا قاعدة ولا تخزين ولا وقت — فتُختبران بعيّنات مكتوبة في
   سطور، وهذا وحده ما يجعل قواعد المقارنة قابلة للمراجعة فعلًا.

   ⛔ وكل عيّنة هنا مصنوعة: أسماء مخترعة وحسابات لا تخصّ أحدًا. */

const parse = (kind, text) => csvParser.parse({ kind, bytes: Buffer.from(text, "utf8") });
const rule = (list, id) => list.filter((f) => f.rule === id);

/* ══ القارئ ═══════════════════════════════════════════════════════════ */

test("القارئ: يقرأ الأعمدة العربية ويطبّع الأرقام", () => {
  const doc = parse("full", fx.fullCsv([
    { empNo: "1001", name: "أحمد المثال", basic: 9000, allowances: 500, deductions: 200 },
  ]));
  assert.equal(doc.rows.length, 1);
  assert.deepEqual(doc.meta.warnings, []);
  const row = doc.rows[0];
  assert.equal(row.empNo, "1001");
  assert.equal(row.name, "أحمد المثال");
  assert.equal(row.net, 9300);
});

test("القارئ: BOM وCRLF وأرقام عربية وفواصل ألفيّة وأقواس سالبة", () => {
  const text = "﻿رقم الموظف,الاسم,الصافي\r\n"
    + "١٠٠٥,موظّف تجريبيّ,\"9,300.50\"\r\n"
    + "1006,آخر,(250)\r\n";
  const doc = parse("full", text);
  assert.equal(doc.rows[0].empNo, "1005", "الأرقام العربية تُطبَّع في المفتاح أيضًا");
  assert.equal(doc.rows[0].net, 9300.5);
  assert.equal(doc.rows[1].net, -250, "القوسان سالبٌ محاسبيّ");
});

test("القارئ: مرادفات الأعمدة تحتمل الهمزات والتاء المربوطة", () => {
  const doc = parse("employees", "الرقم الوظيفي,الأسم,الوظيفه,الحاله\n1001,أحمد,محاسب,نشط\n");
  assert.equal(doc.rows[0].empNo, "1001");
  assert.equal(doc.rows[0].name, "أحمد");
  assert.equal(doc.rows[0].jobTitle, "محاسب");
});

test("القارئ: لا يخرج رقم حساب كاملًا — آخر أربع خانات وحدها", () => {
  const doc = parse("transfer", fx.transferCsv([
    { empNo: "1001", name: "أحمد", iban: "SA0380000000608010167519", net: 9000 },
  ]));
  assert.equal(doc.rows[0].iban4, "7519");
  assert.equal(JSON.stringify(doc).includes("SA0380000000608010167519"), false,
    "الرقم الكامل لا يغادر الملفّ المشفَّر");
});

test("القارئ: عمودٌ مطلوب لم يُتعرَّف عليه يُنتج تحذيرًا لا صفرًا صامتًا", () => {
  const doc = parse("full", "كود,مسمى غامض\nx,y\n");
  assert.ok(doc.meta.warnings.some((w) => /empNo/.test(w)));
  assert.ok(doc.meta.warnings.some((w) => /net/.test(w)));
});

test("القارئ: التكرار داخل الملفّ يُبلَّغ", () => {
  const doc = parse("full", fx.fullCsv([
    { empNo: "1001", name: "أ", basic: 100 }, { empNo: "1001", name: "أ", basic: 100 },
  ]));
  assert.ok(doc.meta.warnings.some((w) => /مكرّر/.test(w)));
});

test("القارئ: الصيغ التي لا قارئ لها تُعلن ذلك ولا تخمّن", () => {
  for (const format of ["pdf", "xlsx", "xls"]) {
    assert.equal(parsers.available(format), false);
    assert.throws(() => parsers.parse({ format, kind: "full", bytes: Buffer.from("x") }),
      (err) => err.code === "parser_unavailable");
  }
  assert.equal(parsers.available("csv"), true);
  assert.throws(() => parsers.parse({ format: "docx", kind: "full", bytes: Buffer.from("x") }),
    (err) => err.code === "parser_unavailable");
});

/* ══ المقارنة داخل الشهر ══════════════════════════════════════════════ */

const monthDocs = (month) => ({
  full: parse("full", month.full),
  transfer: parse("transfer", month.transfer),
  cash: parse("cash", month.cash),
  employees: parse("employees", month.employees),
});

test("المقارنة: شهرٌ متّسق تمامًا لا يُنتج ملاحظة واحدة", () => {
  const { findings: out, applied } = compare({ docs: monthDocs(fx.consistentMonth()), previousDocs: null });
  assert.deepEqual(out, [], JSON.stringify(out.map((f) => f.rule)));
  assert.ok(applied.length >= 9, "قواعد الشهر كلّها طُبّقت");
});

test("المقارنة: مستحقٌّ في الكامل بلا صرف", () => {
  const month = fx.consistentMonth();
  /* يُنزع 1004 من التحويل — فيبقى في الكامل بلا طريقة صرف. */
  month.transfer = fx.transferCsv([
    { empNo: "1001", name: "أحمد المثال", iban: fx.EMPLOYEES[0].iban, net: 9000 },
    { empNo: "1002", name: "سارة التجريبية", iban: fx.EMPLOYEES[1].iban, net: 7500 },
  ]);
  const { findings: out } = compare({ docs: monthDocs(month), previousDocs: null });
  const missing = rule(out, "missing_in_split");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].employeeRef, "1004");
  assert.equal(missing[0].severity, "critical");
  assert.equal(rule(out, "totals_mismatch").length, 1, "والمجموع يختلّ معه");
});

test("المقارنة: مصروفٌ بلا سند، وصافٍ لا يطابق، ومجموعٌ يختلّ", () => {
  const month = fx.consistentMonth();
  month.cash = fx.cashCsv([
    { empNo: "1003", name: "خالد الوهمي", net: 6500 },   // أكثر ممّا في الكامل
    { empNo: "9999", name: "اسم غريب", net: 4000 },       // لا وجود له في الكامل
  ]);
  const { findings: out } = compare({ docs: monthDocs(month), previousDocs: null });
  assert.equal(rule(out, "extra_in_split")[0].employeeRef, "9999");
  const mismatch = rule(out, "net_mismatch")[0];
  assert.equal(mismatch.employeeRef, "1003");
  assert.equal(mismatch.delta, 500);
  assert.equal(rule(out, "totals_mismatch").length, 1);
});

test("المقارنة: حسابٌ يخالف القائمة، ومصروفٌ مرّتين، وصافٍ غير موجب", () => {
  const month = fx.consistentMonth({ salaries: { 1001: 9000, 1002: 7500, 1003: 6000, 1004: 0 } });
  month.transfer = fx.transferCsv([
    { empNo: "1001", name: "أحمد المثال", iban: "SA0380000000608010160000", net: 9000 },
    { empNo: "1002", name: "سارة التجريبية", iban: fx.EMPLOYEES[1].iban, net: 7500 },
    { empNo: "1003", name: "خالد الوهمي", iban: fx.EMPLOYEES[2].iban, net: 3000 },
    { empNo: "1004", name: "نورة الافتراضية", iban: fx.EMPLOYEES[3].iban, net: 0 },
  ]);
  month.cash = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 3000 }]);
  const { findings: out } = compare({ docs: monthDocs(month), previousDocs: null });

  const iban = rule(out, "iban_vs_list")[0];
  assert.equal(iban.employeeRef, "1001");
  assert.equal(iban.currentValue, "****0000");
  assert.ok(!JSON.stringify(out).includes("SA0380000000608010160000"), "لا رقم حساب كامل في المخرَج");
  assert.equal(rule(out, "paid_twice")[0].employeeRef, "1003");
  assert.equal(rule(out, "non_positive_net")[0].employeeRef, "1004");
});

test("المقارنة: من ليس على القائمة، ومن على القائمة بلا راتب", () => {
  const month = fx.consistentMonth({ salaries: { 1001: 9000, 1002: 7500, 1003: 6000 }, keepAll: true });
  month.employees = fx.employeesCsv([
    ...fx.EMPLOYEES.slice(1, 4),
    { empNo: "1009", name: "موقوف تجريبيّ", jobTitle: "—", status: "موقوف", iban: "SA1111111111111111111111" },
  ]);
  const { findings: out } = compare({ docs: monthDocs(month), previousDocs: null });
  assert.equal(rule(out, "not_in_employee_list")[0].employeeRef, "1001");
  assert.deepEqual(rule(out, "not_in_payroll").map((f) => f.employeeRef), ["1004"],
    "والموقوف لا يُتوقَّع له راتب فلا يُبلَّغ");
});

test("المقارنة: التكرار داخل ملفّ يُبلَّغ كملاحظة حرجة", () => {
  const month = fx.consistentMonth();
  month.full = fx.fullCsv([
    { empNo: "1001", name: "أحمد", basic: 9000 }, { empNo: "1001", name: "أحمد", basic: 9000 },
  ]);
  const { findings: out } = compare({ docs: monthDocs(month), previousDocs: null });
  const dup = rule(out, "duplicate_emp_no")[0];
  assert.equal(dup.employeeRef, "1001");
  assert.equal(dup.severity, "critical");
});

/* ══ المقارنة مع الشهر السابق ═════════════════════════════════════════ */

test("المقارنة مع السابق: تُتخطّى بلا شهرٍ سابق ويُعلَن تخطّيها", () => {
  const { findings: out, skipped } = compare({ docs: monthDocs(fx.consistentMonth()), previousDocs: null });
  assert.ok(skipped.includes("iban_changed"));
  assert.equal(out.filter((f) => f.scope === "vs_previous").length, 0);
});

test("المقارنة مع السابق: تغيّر الحساب حرجٌ، ويُقنَّع إلى أربع خانات", () => {
  const previous = monthDocs(fx.consistentMonth());
  const current = monthDocs(fx.consistentMonth({ ibans: { 1001: "SA9999999999999999991234" } }));
  const { findings: out } = compare({ docs: current, previousDocs: previous });
  const changed = rule(out, "iban_changed")[0];
  assert.equal(changed.employeeRef, "1001");
  assert.equal(changed.severity, "critical");
  assert.equal(changed.previousValue, "****7519");
  assert.equal(changed.currentValue, "****1234");
  assert.ok(!JSON.stringify(out).includes("SA9999999999999999991234"));
});

test("المقارنة مع السابق: شدّة تغيّر الصافي بالنسبة لا بالمبلغ", () => {
  const previous = monthDocs(fx.consistentMonth());
  const current = monthDocs(fx.consistentMonth({
    salaries: { 1001: 9200, 1002: 8500, 1003: 12000, 1004: 8200 },
  }));
  const { findings: out } = compare({ docs: current, previousDocs: previous });
  const by = new Map(rule(out, "net_changed").map((f) => [f.employeeRef, f]));
  assert.equal(by.get("1001").severity, "info", "2% تغيّرٌ عاديّ");
  assert.equal(by.get("1002").severity, "warn", "13% يستحقّ نظرة");
  assert.equal(by.get("1003").severity, "critical", "100% حرج");
  assert.equal(by.get("1003").delta, 6000);
  assert.equal(by.has("1004"), false, "ما لم يتغيّر لا يُبلَّغ");
});

test("المقارنة مع السابق: من دخل ومن خرج ومن تغيّرت استقطاعاته", () => {
  const previous = monthDocs(fx.consistentMonth());
  const current = monthDocs(fx.consistentMonth({
    salaries: { 1001: 9000, 1002: 7500, 1003: 6000, 1005: 5000 },
    deductions: { 1001: 300 },
  }));
  const { findings: out } = compare({ docs: current, previousDocs: previous });
  assert.deepEqual(rule(out, "new_employee").map((f) => f.employeeRef), ["1005"]);
  assert.deepEqual(rule(out, "removed_employee").map((f) => f.employeeRef), ["1004"]);
  assert.equal(rule(out, "deductions_changed")[0].employeeRef, "1001");
});

test("المقارنة: لكل قاعدة معرّف فريد ونطاق معروف", () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "معرّفات القواعد فريدة — البصمة تُبنى عليها");
  for (const r of RULES) {
    assert.ok(["within_month", "vs_previous"].includes(r.scope), r.id);
    assert.equal(typeof r.run, "function", r.id);
  }
});

/* ══ الملاحظات: البصمة والتقنيع ═══════════════════════════════════════ */

test("الملاحظات: البصمة على الهويّة لا على القيمة", () => {
  const base = { rule: "net_changed", scope: "vs_previous", employeeRef: "1001", field: "net" };
  assert.equal(findings.fingerprintOf(base), findings.fingerprintOf({ ...base }));
  assert.notEqual(findings.fingerprintOf(base), findings.fingerprintOf({ ...base, employeeRef: "1002" }));
  assert.notEqual(findings.fingerprintOf(base), findings.fingerprintOf({ ...base, field: "iban4" }));
  /* والقيمة ليست جزءًا منها: تغيّرُ الراتب بين تحليلين يُحدِّث لا يُنشئ. */
  const a = findings.normalize({ ...base, severity: "info", title: "t", currentValue: "100" });
  const b = findings.normalize({ ...base, severity: "info", title: "t", currentValue: "999" });
  assert.equal(a.fingerprint, b.fingerprint);
});

test("الملاحظات: أي رقم حساب كامل يُقنَّع قبل القاعدة", () => {
  const f = findings.normalize({
    rule: "r", scope: "within_month", severity: "warn", title: "SA0380000000608010167519",
    currentValue: "الحساب SA4420000001234567891234 تغيّر",
    description: "SA1010000009876543210987",
  });
  const text = JSON.stringify(f);
  assert.ok(!/SA\d{20,}/.test(text), text);
  assert.ok(text.includes("****7519") && text.includes("****1234") && text.includes("****0987"));
  assert.equal(findings.maskIban("لا حساب هنا"), "لا حساب هنا");
});

test("الملاحظات: مدخلٌ غير صالح يُردّ", () => {
  assert.throws(() => findings.normalize({ rule: "", scope: "within_month" }), /قاعدة/);
  assert.throws(() => findings.normalize({ rule: "r", scope: "x" }), /نطاق/);
  assert.throws(() => findings.normalize({ rule: "r", scope: "within_month", severity: "x" }), /شدّة/);
  assert.throws(() => findings.normalize({ rule: "r", scope: "within_month", delta: "كثير" }), /عددًا/);
});

/* ══ بقيّة قواعد المقارنة الشهرية ══════════════════════════════════════ */

test("المقارنة مع السابق: تغيّر الأساسيّ والبدلات مفصولان عن الصافي", () => {
  const previous = monthDocs(fx.consistentMonth());
  /* الأساسيّ ثابت والبدل ارتفع ⇒ بدلٌ لا زيادةَ راتب. */
  const current = monthDocs(fx.consistentMonth({ allowances: { 1001: 1500 } }));
  const { findings: out } = compare({ docs: current, previousDocs: previous });

  const allowance = rule(out, "allowances_changed")[0];
  assert.ok(allowance, JSON.stringify(out.map((f) => f.rule)));
  assert.equal(allowance.employeeRef, "1001");
  assert.equal(allowance.delta, 1500);
  assert.equal(allowance.severity, "info", "بدلٌ دون نصف الأساسيّ = معلومة");
  assert.equal(rule(out, "basic_changed").length, 0, "الأساسيّ لم يتغيّر");
  /* والصافي تغيّر معه — فتظهر ملاحظتان مستقلّتان لا واحدة. */
  assert.equal(rule(out, "net_changed")[0].employeeRef, "1001");
});

test("المقارنة مع السابق: بدلٌ يبتلع نصف الأساسيّ يرتفع إلى تنبيه", () => {
  const previous = monthDocs(fx.consistentMonth());
  const current = monthDocs(fx.consistentMonth({ allowances: { 1001: 6000 } }));
  const { findings: out } = compare({ docs: current, previousDocs: previous });
  assert.equal(rule(out, "allowances_changed")[0].severity, "warn");
});

test("المقارنة مع السابق: تغيّر الأساسيّ يُبلَّغ مستقلًّا", () => {
  const previous = monthDocs(fx.consistentMonth());
  const current = monthDocs(fx.consistentMonth({ salaries: { 1001: 11000, 1002: 7500, 1003: 6000, 1004: 8200 } }));
  const { findings: out } = compare({ docs: current, previousDocs: previous });
  const basic = rule(out, "basic_changed")[0];
  assert.equal(basic.employeeRef, "1001");
  assert.equal(basic.delta, 2000);
  assert.equal(basic.severity, "warn");
});

test("المقارنة: تغيّر البنك يُبلَّغ، ويُقرأ مع تغيّر الحساب حين يقعان معًا", () => {
  const previous = monthDocs(fx.consistentMonth());
  const current = monthDocs(fx.consistentMonth({
    ibans: { 1001: "SA9999999999999999991234" }, banks: { 1001: "بنك آخر تجريبيّ" },
  }));
  const { findings: out } = compare({ docs: current, previousDocs: previous });
  const bank = rule(out, "bank_changed")[0];
  assert.equal(bank.employeeRef, "1001");
  assert.equal(bank.currentValue, "بنك آخر تجريبيّ");
  assert.equal(rule(out, "iban_changed")[0].employeeRef, "1001", "والحساب معه — إشارتان متعاضدتان");
});

test("المقارنة: كل قاعدة في السجلّ لها اختبار يُشغّلها", () => {
  /* حارسٌ ضدّ قاعدةٍ تُضاف بلا اختبار: القواعد تُقاس بما تمسكه، وقاعدةٌ لا
     يُشغّلها شيء قد تكون معطوبة منذ يوم كتابتها. */
  const covered = new Set();
  const month = fx.consistentMonth();
  const broken = fx.consistentMonth({
    salaries: { 1001: 12000, 1002: 7500, 1003: 6000, 1005: 5000 },
    deductions: { 1001: 300 }, allowances: { 1002: 400 },
    ibans: { 1001: "SA9999999999999999991234" }, banks: { 1001: "بنك آخر" },
  });
  broken.cash = fx.cashCsv([
    { empNo: "1003", name: "خالد الوهمي", net: 6500 },
    { empNo: "9999", name: "غريب", net: 4000 },
    { empNo: "1002", name: "سارة التجريبية", net: 100 },
  ]);
  broken.employees = fx.employeesCsv(fx.EMPLOYEES.slice(1));
  const both = compare({ docs: monthDocs(broken), previousDocs: monthDocs(month) });
  for (const f of both.findings) covered.add(f.rule);

  /* الحالات التي تحتاج تركيبًا خاصًّا تُشغَّل منفردةً. */
  const dup = fx.consistentMonth();
  dup.full = fx.fullCsv([{ empNo: "1001", name: "أ", basic: 9000 }, { empNo: "1001", name: "أ", basic: 9000 }]);
  for (const f of compare({ docs: monthDocs(dup), previousDocs: null }).findings) covered.add(f.rule);

  const zero = fx.consistentMonth({ salaries: { 1001: 0 } });
  for (const f of compare({ docs: monthDocs(zero), previousDocs: null }).findings) covered.add(f.rule);

  /* مستحقٌّ بلا صرف: يُنزع من التحويل والكاش معًا. */
  const unpaid = fx.consistentMonth();
  unpaid.transfer = fx.transferCsv([{ empNo: "1001", name: "أحمد المثال", iban: fx.EMPLOYEES[0].iban, net: 9000 }]);
  unpaid.cash = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6000 }]);
  for (const f of compare({ docs: monthDocs(unpaid), previousDocs: null }).findings) covered.add(f.rule);

  /* حسابٌ يخالف القائمة: القائمة كاملة والتحويل بحسابٍ آخر. */
  const wrongIban = fx.consistentMonth({ ibans: { 1001: "SA9999999999999999990000" } });
  for (const f of compare({ docs: monthDocs(wrongIban), previousDocs: null }).findings) covered.add(f.rule);

  const uncovered = RULES.map((r) => r.id).filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, [], `قواعد بلا تغطية: ${uncovered.join(", ")}`);
});

/* ══ طبقة المطابقة والثقة ══════════════════════════════════════════════ */

test("المطابقة: يُعلن أي عمودٍ صار أي حقل", () => {
  const doc = parse("full", fx.fullCsv([{ empNo: "1", name: "أ", basic: 100, allowances: 0, deductions: 0 }]));
  assert.equal(doc.meta.mapping.net, "الصافي");
  assert.equal(doc.meta.mapping.empNo, "رقم الموظف");
  assert.deepEqual(doc.meta.unknownColumns, []);
  assert.equal(doc.meta.needsManualReview, false);
});

test("المطابقة: عمودٌ غير معروف يُعلَن ولا يُبتلع", () => {
  const doc = parse("full", "رقم الموظف,الصافي,ملاحظات المحاسب,القسم\n1,100,ok,مالية\n");
  assert.deepEqual(doc.meta.unknownColumns, ["ملاحظات المحاسب", "القسم"]);
  assert.equal(doc.meta.rowCount, 1, "والصفوف تُقرأ رغم ذلك");
});

test("الثقة: تنخفض بنقص الحقول، وتُرفع علم المراجعة اليدوية", () => {
  const rich = parse("transfer", fx.transferCsv([
    { empNo: "1", name: "أ", iban: "SA0380000000608010167519", net: 100 },
  ]));
  assert.ok(rich.meta.confidence >= 0.7, `ثقة ${rich.meta.confidence}`);
  assert.equal(rich.meta.needsManualReview, false);

  const poor = parse("full", "رقم الموظف,الصافي\n1,100\n");
  assert.ok(poor.meta.confidence < rich.meta.confidence);

  /* غياب عمودٍ **مطلوب** يرفع العلم مهما كثرت الأعمدة الأخرى. */
  const noNet = parse("full", "رقم الموظف,الاسم,الراتب الأساسي,البدلات,الاستقطاعات,البنك\n1,أ,100,0,0,بنك\n");
  assert.equal(noNet.meta.needsManualReview, true, "بلا «الصافي» لا تُنقذه بقيّة الأعمدة");

  const empty = parse("full", "");
  assert.equal(empty.meta.confidence, 0);
  assert.equal(empty.meta.needsManualReview, true);
});

test("الثقة: عمودان لحقلٍ واحد يُبلَّغان ويُؤخذ الأول", () => {
  const doc = parse("full", "رقم الموظف,الصافي,المستحق\n1,100,999\n");
  assert.equal(doc.rows[0].net, 100, "الأول يفوز");
  assert.ok(doc.meta.warnings.some((w) => /عمودان لحقلٍ واحد/.test(w)));
});

test("الثقة: كل نوعٍ يُقاس بما يحمله هو — لا بقائمةٍ واحدة للجميع", () => {
  /* الانحدار الذي أوجد هذا الاختبار: ملفّ الكاش السليم — رقمٌ واسمٌ وصافٍ
     لا غير — كان يُقاس على قائمةٍ تتوقّع بدلاتٍ وحسابات بنكية، فتهبط ثقته
     إلى 0.5 ويُرفع علم «يحتاج مراجعة» على ملفٍّ لا عيب فيه. */
  const month = fx.consistentMonth();
  for (const [kind, text] of Object.entries(month)) {
    const doc = parse(kind, text);
    assert.equal(doc.meta.needsManualReview, false,
      `${kind}: ثقة ${doc.meta.confidence} على ملفٍّ سليم`);
    assert.equal(doc.meta.confidence, 1, `${kind} يحمل كل ما يُتوقَّع منه`);
  }
});
