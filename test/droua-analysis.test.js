const test = require("node:test");
const assert = require("node:assert/strict");

const csvParser = require("../lib/droua/parsers/csv");
const parsers = require("../lib/droua/parsers");
const { compare, RULES, FIELD_SOURCES } = require("../lib/droua/compare");
const findings = require("../lib/droua/findings");
const analyze = require("../lib/droua/analyze");
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
  for (const format of ["pdf"]) {
    assert.equal(parsers.available(format), false);
    assert.throws(() => parsers.parse({ format, kind: "full", bytes: Buffer.from("x") }),
      (err) => err.code === "parser_unavailable");
  }
  for (const format of ["csv", "xls", "xlsx"]) assert.equal(parsers.available(format), true, format);
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

/* ══ المصادر الغائبة: لا تُخمَّن ولا يُسكت عنها ══════════════════════════

   الحالة الواقعية التي بُني لها هذا: شهرٌ سابق بلا مسير كاش مستقلّ عندنا.
   وغيابُ الملفّ **معلومةٌ مفقودة عن الماضي** لا خللٌ في الرواتب — فلا
   يجوز أن يُقرأ صفرًا في الكاش، ولا أن يُخرج «مستحقٌّ بلا صرف» لكل من
   صُرف له كاشًا، ولا أن يُعلن «تغيّر الحساب» لمن لم يكن حسابُه معروفًا
   أصلًا. */

test("المقارنة: كل قاعدة تُعلن مصادرها، والمُعلَن نوعٌ معروف", () => {
  const KINDS = ["full", "transfer", "cash", "employees"];
  for (const r of RULES) {
    if (!r.needs) continue;
    for (const key of Object.keys(r.needs)) {
      assert.ok(["current", "previous", "previousAny"].includes(key), `${r.id}: ${key}`);
      for (const kind of r.needs[key]) assert.ok(KINDS.includes(kind), `${r.id}: ${kind}`);
    }
    if (r.scope === "within_month") {
      assert.ok(!r.needs.previous && !r.needs.previousAny,
        `${r.id}: قاعدةٌ داخل الشهر لا تطلب مصدرًا من السابق`);
    }
  }
});

test("المصدر الغائب: غياب كاش السابق لا يُنتج ملاحظةً واحدة كاذبة", () => {
  const previous = monthDocs(fx.consistentMonth());
  previous.cash = null;                    // لا مسير كاش مستقلّ للشهر السابق
  const current = monthDocs(fx.consistentMonth());

  const { findings: out, notEvaluable } = compare({ docs: current, previousDocs: previous });

  /* الشهران متطابقان تمامًا: أي ملاحظة هنا اختُرعت من العدم. */
  assert.deepEqual(out.map((f) => `${f.rule}:${f.employeeRef || ""}`), [],
    "غيابُ ملفٍّ تاريخيّ ليس خللًا في الرواتب");
  assert.equal(rule(out, "missing_in_split").length, 0);

  /* ولا يُبلَّغ عن نقصٍ لا أثر له: مسير السابق **الكامل** يحمل مبالغ كل
     موظّف — من صُرف له كاشًا ومن حُوِّل له — فلا قاعدةَ مقارنةٍ واحدة
     تحتاج ملفّ الكاش التاريخيّ. وإعلانُ «تعذّر التقييم» هنا إنذارٌ كاذب
     في الاتّجاه الآخر: يوهم بفجوةٍ في التغطية لا وجود لها. */
  assert.deepEqual(notEvaluable, [], "لا قاعدةَ مقارنةٍ تستند إلى كاش السابق");
});

test("المصدر الغائب: شهرٌ بلا كاش يُقيَّم داخليًّا بما توفّر ويُعلن ما تعذّر", () => {
  /* وحين يُحلَّل ذلك الشهر **نفسه** يتغيّر الحكم: قواعد «الكامل = التحويل
     + الكاش» تحتاج الطرفين، فتُعلَن غير مُقيَّمة بدل أن تُقرأ صفرًا. */
  const month = monthDocs(fx.consistentMonth());
  month.cash = null;
  const { applied, notEvaluable } = compare({ docs: month, previousDocs: null });
  const stalled = notEvaluable.map((e) => e.rule).sort();
  assert.deepEqual(stalled,
    ["extra_in_split", "method_vs_channel", "missing_in_split", "net_mismatch", "paid_twice", "totals_mismatch"],
    "ما يحتاج طرفَي الصرف وحده يتوقّف");
  for (const id of stalled) assert.ok(!applied.includes(id), `${id}: لا يُحسب مطبَّقًا`);
  /* وما لا يحتاجه يُطبَّق: النقص لا يعطّل الشهر كلّه. */
  assert.ok(applied.includes("not_in_payroll") && applied.includes("duplicate_emp_no"));
});

test("المصدر الغائب: كاش الشهر الجاري لا يُقرأ صفرًا", () => {
  const month = monthDocs(fx.consistentMonth());
  month.cash = null;
  const { findings: out, notEvaluable } = compare({ docs: month, previousDocs: null });
  assert.equal(rule(out, "missing_in_split").length, 0, "«1003» يُصرف كاشًا — وملفّه غائبٌ لا صفر");
  assert.equal(rule(out, "totals_mismatch").length, 0, "ولا يُجمع مجموعٌ ينقصه طرف");
  assert.ok(notEvaluable.some((e) => e.rule === "missing_in_split"));
});

test("المصدر الغائب: تغيّر الحساب لا يُعلَن حين لا مصدر تاريخيّ له", () => {
  /* الحساب يعيش في «التحويل» و«قائمة الموظفين». فبغيابهما معًا في السابق
     تصير المقارنة فراغًا بفراغ — وإعلانُ «لم يتغيّر» كذبٌ كإعلان تغيّره. */
  const previous = monthDocs(fx.consistentMonth());
  previous.transfer = null;
  previous.employees = null;
  const current = monthDocs(fx.consistentMonth({ ibans: { 1001: "SA1111111111111111111111" } }));

  const { findings: out, notEvaluable } = compare({ docs: current, previousDocs: previous });
  assert.equal(rule(out, "iban_changed").length, 0, "لا مصدر تاريخيّ للحساب");
  assert.equal(rule(out, "bank_changed").length, 0);
  const stalled = notEvaluable.map((e) => e.rule);
  assert.ok(stalled.includes("iban_changed") && stalled.includes("bank_changed"));

  /* وحين يتوفّر أحدهما — القائمة وحدها — تُقيَّم القاعدة وتُصيب. */
  const withList = monthDocs(fx.consistentMonth());
  withList.transfer = null;
  const { findings: out2, notEvaluable: none } = compare({ docs: current, previousDocs: withList });
  assert.equal(rule(out2, "iban_changed").length, 1, "قائمةُ الموظفين وحدها تكفي مصدرًا");
  assert.equal(none.filter((e) => e.rule === "iban_changed").length, 0);
});

test("المصدر الغائب: «لا شهر سابق» تخطٍّ لا نقصُ مصدر", () => {
  const { skipped, notEvaluable } = compare({ docs: monthDocs(fx.consistentMonth()), previousDocs: null });
  assert.ok(skipped.length > 0, "قواعد المقارنة تُتخطّى في أول شهر");
  assert.deepEqual(notEvaluable, [], "وليس ذلك نقصَ مصدرٍ يُبلَّغ عنه");
});

test("المصدر الغائب: ملاحظةٌ واحدة لكل مصدر تسرد قواعده", () => {
  const month = monthDocs(fx.consistentMonth());
  month.cash = null;
  const { notEvaluable } = compare({ docs: month, previousDocs: null });

  const out = analyze.notEvaluableFindings(notEvaluable, null);
  assert.equal(out.length, 1, "مصدرٌ واحد ناقص ⇒ ملاحظةٌ واحدة لا واحدة لكل قاعدة");
  assert.equal(out[0].rule, "not_evaluable");
  assert.equal(out[0].scope, "within_month");
  assert.equal(out[0].field, "current:cash");
  /* والقواعد المعطَّلة كلّها مسمّاة — بالعربية لمن يقرأ، وبالمعرّف لمن
     يحسب. فالوصفُ للإنسان و`currentValue` للواجهة. */
  for (const entry of notEvaluable) {
    assert.match(out[0].description, new RegExp(analyze.RULE_LABELS[entry.rule]), entry.rule);
    assert.match(out[0].currentValue, new RegExp(entry.rule), entry.rule);
  }
  assert.equal(out[0].delta, notEvaluable.length, "العدد يطابق ما تعطّل فعلًا");

  /* والبصمة على المصدر لا على عدد القواعد: تحليلٌ ثانٍ يُحدِّث ولا يُنشئ. */
  const again = analyze.notEvaluableFindings(
    [...notEvaluable, { rule: "z_extra", scope: "within_month", missing: [{ month: "current", kind: "cash" }] }],
    null);
  assert.equal(findings.normalize({ ...out[0], severity: "info" }).fingerprint,
    findings.normalize({ ...again[0], severity: "info" }).fingerprint);
});

/* ── العمود الغائب: الصفر الصامت ──
   الحالة الواقعية: مسير التحويل عندنا كشفُ مبالغ مقسومٌ بالقناة، **بلا
   عمود حساب ولا عمود بنك**. فقاعدةٌ تقارن الحساب تمرّ على الجميع فلا تجد
   ما تقارنه وتُخرج صفرًا — يُقرأ «لا مخالفة» ومعناه «لم يُفحص شيء». */

test("العمود الغائب: كل قاعدة تُعلن حقلها من مصدرٍ معروف", () => {
  for (const r of RULES) {
    if (!r.needsField) continue;
    for (const key of Object.keys(r.needsField)) {
      assert.ok(["current", "previous"].includes(key), `${r.id}: ${key}`);
      for (const spec of r.needsField[key]) {
        assert.ok(FIELD_SOURCES.includes(spec.doc), `${r.id}: مصدرٌ مجهول ${spec.doc}`);
        assert.equal(typeof spec.field, "string", `${r.id}: حقلٌ بلا اسم`);
      }
      if (key === "previous") assert.equal(r.scope, "vs_previous", r.id);
    }
  }
});

test("العمود الغائب: مسير تحويلٍ بلا عمود حساب لا يُخرج صفرًا صامتًا", () => {
  const month = fx.consistentMonth();
  /* مسير تحويل واقعيّ: رقمٌ واسمٌ وصافٍ — ولا عمود حساب. */
  month.transfer = fx.csv(["رقم الموظف", "الاسم", "الصافي"],
    [["1001", "أ", 9000], ["1002", "ب", 7500], ["1004", "د", 8200]]);
  const { applied, notEvaluable, findings: out } = compare({ docs: monthDocs(month), previousDocs: null });

  assert.equal(rule(out, "iban_vs_list").length, 0);
  assert.ok(!applied.includes("iban_vs_list"), "ولا تُحسب مطبَّقة: صفرُها لا يعني سلامة");
  const gap = notEvaluable.find((e) => e.rule === "iban_vs_list");
  assert.ok(gap, "بل يُعلَن أن الحقل غائب");
  assert.deepEqual(gap.missing, [{ month: "current", doc: "transfer", field: "iban4" }]);
});

test("العمود الغائب: عمودٌ موجودٌ فارغٌ في كل صفّ كعمودٍ غائب", () => {
  const month = fx.consistentMonth();
  month.transfer = fx.csv(["رقم الموظف", "الاسم", "الايبان", "الصافي"],
    [["1001", "أ", "", 9000], ["1002", "ب", "", 7500], ["1004", "د", "", 8200]]);
  const { notEvaluable } = compare({ docs: monthDocs(month), previousDocs: null });
  assert.ok(notEvaluable.some((e) => e.rule === "iban_vs_list"),
    "عمودٌ لا قيمة فيه لا يُثبت أكثر ممّا يُثبت غيابُه");
});

test("العمود الغائب: الآليّة ليست شاملة — الحقل المتوفّر يُقيَّم ويُصيب", () => {
  /* وإلّا لكانت «تعذّر التقييم» بابًا يُسكِت القواعد كلّها. */
  const month = fx.consistentMonth({ ibans: { 1001: "SA9999999999999999990000" } });
  /* الحساب في القائمة لا في مسير التحويل: نُبقيه في التحويل ليُقارَن. */
  const { applied, notEvaluable, findings: out } = compare({ docs: monthDocs(month), previousDocs: null });
  assert.ok(applied.includes("iban_vs_list"));
  assert.equal(notEvaluable.filter((e) => e.rule === "iban_vs_list").length, 0);
  assert.ok(applied.includes("method_vs_channel"), "طريقة الصرف متوفّرة في القائمة");
});

test("العمود الغائب: تغيّر البنك يتوقّف حين لا عمود بنك في الشهرين", () => {
  const strip = (month) => {
    const docs = monthDocs(month);
    for (const kind of ["transfer", "employees"]) {
      for (const row of docs[kind].rows) row.bank = null;
    }
    return docs;
  };
  const { applied, notEvaluable, findings: out } =
    compare({ docs: strip(fx.consistentMonth()), previousDocs: strip(fx.consistentMonth()) });
  assert.equal(rule(out, "bank_changed").length, 0);
  assert.ok(!applied.includes("bank_changed"));
  const gap = notEvaluable.find((e) => e.rule === "bank_changed");
  assert.ok(gap && gap.missing.every((m) => m.doc === "merged" && m.field === "bank"));
  /* وتغيّرُ الحساب يبقى مُقيَّمًا: نقصُ حقلٍ لا يجرّ حقلًا آخر معه. */
  assert.ok(applied.includes("iban_changed"));
});

test("القارئ: «إسم البنك» عمودٌ يُقرأ بنكًا لا مجهولًا", () => {
  /* قائمةُ موظفي بعض الشهور تحمله وبعضها لا — وبلا مرادفه تصير مقارنةُ
     البنك فراغًا بفراغ. */
  const doc = parse("employees", "الرقم الوظيفي,الاسم,إسم البنك\n1001,أ,مصرفٌ تجريبيّ\n");
  assert.equal(doc.meta.mapping.bank, "إسم البنك");
  assert.equal(doc.rows[0].bank, "مصرفٌ تجريبيّ");
  assert.deepEqual(doc.meta.unknownColumns, []);
});

test("المصدر الغائب: مجموع التغطية لا يُضاعف قاعدةً عطّلها مصدران", () => {
  /* شريط التغطية يجمع `delta`. فلو نُسبت القاعدة الواحدة إلى مصدرين
     لصار المجموع أكبر من عدد القواعد نفسها — ولأُبلغ المستخدم بنقصٍ
     أوسع من الواقع، وهو كذبٌ في الاتّجاه المعاكس. */
  const twoSources = [
    { rule: "iban_changed", scope: "vs_previous",
      missing: [{ month: "previous", kind: "cash" }, { month: "current", doc: "merged", field: "bank" }] },
    { rule: "bank_changed", scope: "vs_previous", missing: [{ month: "previous", kind: "cash" }] },
  ];
  const out = analyze.notEvaluableFindings(twoSources, "2026-07");
  assert.equal(out.length, 2, "ملاحظةٌ لكل مصدرٍ ناقص — ليُرى أثر كلٍّ منهما");
  assert.equal(out.reduce((t, f) => t + f.delta, 0), 2, "وقاعدتان اثنتان لا ثلاث");
  /* ومع ذلك تُذكر القاعدة في ملاحظتَي مصدرَيها معًا: العدّ شيء والعرض آخر. */
  assert.ok(out.every((f) => /iban_changed/.test(f.currentValue)));
});

test("المصدر الغائب: العدد في delta لا في نصٍّ قابلٍ للاقتطاع", () => {
  /* عمود القيمة يُقتطع عند 120 محرفًا. فقائمةُ معرّفاتٍ طويلة تفقد
     أواخرها — ومن يعدّها من النصّ يحسب النقص أصغر ممّا هو. */
  const many = RULES.map((r) => r.id).map((id) => (
    { rule: id, scope: "within_month", missing: [{ month: "current", kind: "cash" }] }));
  const raw = analyze.notEvaluableFindings(many, null)[0];
  assert.equal(raw.delta, RULES.length);
  const stored = findings.normalize({ ...raw });
  assert.ok(stored.currentValue.length < raw.currentValue.length, "النصّ اقتُطع فعلًا");
  assert.equal(stored.delta, RULES.length, "والعدد نجا كاملًا");
});

test("المصدر الغائب: الشهر السابق مذكورٌ باسمه في الملاحظة", () => {
  const out = analyze.notEvaluableFindings(
    [{ rule: "iban_changed", scope: "vs_previous", missing: [{ month: "previous", kind: "employees|transfer" }] }],
    "2026-07");
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "warn", "نقصُ السابق تحذير — ولا `file_missing` يغطّيه");
  assert.match(out[0].title, /2026-07/, "الشهر المقصود مذكور — لا «السابق» مجرّدة");
  assert.match(out[0].title, / أو /, "«أيٌّ من المصدرين» لا «كلاهما»");
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

  /* حسابٌ يخالف القائمة: التحويل بحسابٍ غير المسجَّل. */
  const wrongIban = fx.consistentMonth();
  wrongIban.transfer = fx.transferCsv([
    { empNo: "1001", name: "أ", iban: "SA9999999999999999990000", net: 9000 },
    { empNo: "1002", name: "ب", iban: fx.EMPLOYEES[1].iban, net: 7500 },
    { empNo: "1004", name: "د", iban: fx.EMPLOYEES[3].iban, net: 8200 },
  ]);
  for (const f of compare({ docs: monthDocs(wrongIban), previousDocs: null }).findings) covered.add(f.rule);

  /* قناةٌ تخالف المسجَّل، وتحويلٌ بلا حسابٍ في القائمة. */
  const channel = fx.consistentMonth({ methods: { 1003: "بنك" } });
  for (const f of compare({ docs: monthDocs(channel), previousDocs: null }).findings) covered.add(f.rule);
  const noIban = fx.consistentMonth({ ibans: { 1001: "" } });
  for (const f of compare({ docs: monthDocs(noIban), previousDocs: null }).findings) covered.add(f.rule);

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

/* ══ قناة الصرف: القائمة مقابل الواقع ══════════════════════════════════ */

test("المقارنة: صُرف بقناةٍ غير المسجَّلة له", () => {
  /* في مسيراتٍ حقيقية لا يحمل ملفّ الرواتب عمود حساب أصلًا — والقناة
     المعتمدة تعيش في قائمة الموظفين وحدها. فمقارنتها بالواقع هي الطريق
     الوحيد لكشف صرفٍ نقديّ لمن اعتُمد له تحويل. */
  const month = fx.consistentMonth({ methods: { 1003: "بنك" } });
  const { findings: out } = compare({ docs: monthDocs(month), previousDocs: null });
  const found = rule(out, "method_vs_channel");
  assert.equal(found.length, 1, JSON.stringify(out.map((f) => f.rule)));
  assert.equal(found[0].employeeRef, "1003", "مُسجَّل «بنك» ومصروفٌ كاش");
  assert.equal(found[0].severity, "warn");

  /* وشهرٌ متّسق لا يُنتج شيئًا: القناة المسجَّلة تطابق الواقع. */
  assert.equal(rule(compare({ docs: monthDocs(fx.consistentMonth()), previousDocs: null }).findings,
    "method_vs_channel").length, 0);
});

test("المقارنة: تحويلٌ بنكيّ بلا حسابٍ مسجَّل", () => {
  const month = fx.consistentMonth({ ibans: { 1001: "" } });
  const { findings: out } = compare({ docs: monthDocs(month), previousDocs: null });
  const found = rule(out, "bank_without_account");
  assert.equal(found.length, 1);
  assert.equal(found[0].employeeRef, "1001");
  assert.match(found[0].description, /لن يُكتشف/);
});

test("المقارنة: الحساب يُقرأ من قائمة الموظفين حين لا يحمله المسير", () => {
  /* وهذا هو الواقع: ملفّ التحويل بلا عمود حساب. فبلا السقوط إلى القائمة
     تصير مقارنةُ الحساب بين شهرين مقارنةَ فراغٍ بفراغ — صفر ملاحظات. */
  const strip = (month) => ({ ...month, transfer: fx.transferCsv([
    { empNo: "1001", name: "أ", iban: "", net: 9000 },
    { empNo: "1002", name: "ب", iban: "", net: 7500 },
    { empNo: "1004", name: "د", iban: "", net: 8200 },
  ]) });
  const previous = monthDocs(strip(fx.consistentMonth()));
  const current = monthDocs(strip(fx.consistentMonth({ ibans: { 1001: "SA9999999999999999991234" } })));
  const merged = require("../lib/droua/compare").mergeSplit(current);
  assert.equal(merged.get("1001").iban4, "1234", "الحساب جاء من القائمة");

  const { findings: out } = compare({ docs: current, previousDocs: previous });
  const changed = rule(out, "iban_changed");
  assert.equal(changed.length, 1, JSON.stringify(out.map((f) => f.rule)));
  assert.equal(changed[0].severity, "critical");
});

test("المقارنة: توحيد تسمية قناة الصرف", () => {
  const { channelOf } = require("../lib/droua/compare");
  for (const v of ["بنك", "تحويل", "حوالة بنكية", "Bank", "transfer"]) assert.equal(channelOf(v), "bank", v);
  for (const v of ["نقد", "كاش", "Cash", "نقدا"]) assert.equal(channelOf(v), "cash", v);
  for (const v of ["", null, "غير محدد", "أخرى"]) assert.equal(channelOf(v), null, String(v));
});
