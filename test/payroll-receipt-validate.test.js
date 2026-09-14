const test = require("node:test");
const assert = require("node:assert/strict");

const V = require("../scripts/validate-receipt-linking");
const M = require("../lib/payroll/receiptMatch");

/* سكربت التحقّق المحلّي — تاسك أجير.
   =========================================================================
   يُختبر منطقه كما يُختبر أي منطق: عطلٌ في العرض يمحو أثر قياس سليم،
   وقد انهار تقرير الـbackfill يومًا بعد عمل صحيح تمامًا. والأهمّ أن
   ضمانتيه الأساسيتين — «SELECT فقط» و«لا PII في المخرج» — ضمانتا سلامة
   لا راحة: خرقُ أيّهما يُلحق ضررًا لا يُسترجَع.

   والبيانات هنا مُختلَقة، ومبنيّة لتشبه الحقيقي في الشكل وحده. */

const BANK_A = "SANITIZED NATIONAL BANK";
const BANK_B = "SANITIZED GULF BANK";

const emp = (eid, extra) => ({ "الرقم الوظيفي": String(eid), ...extra });

/* ═══ ① حاجز القراءة فقط ═══ */

test("selectOnly يقبل استعلامي السكربت ويرفض كل كتابة", () => {
  /* برهان العضّ: الاستعلامان المُستعملان فعلًا يمرّان — فالحاجز مطبَّق
     على ما يصل إلى السلك لا على أمثلة في اختبار. */
  assert.equal(V.selectOnly(V.Q_EMPLOYEES), V.Q_EMPLOYEES);
  assert.equal(V.selectOnly(V.Q_RUN_EIDS), V.Q_RUN_EIDS);

  const rejected = [
    "UPDATE employees SET data = '{}'",
    "DELETE FROM payroll_receipts",
    "INSERT INTO employees (eid) VALUES ('1')",
    "DROP TABLE employees",
    "ALTER TABLE employees ADD COLUMN x text",
    "CREATE TABLE t (id int)",
    "TRUNCATE employees",
    /* يبدأ بـSELECT ومع ذلك يكتب — النمط الإيجابي وحده كان سيمرّره. */
    "SELECT 1; DROP TABLE employees",
    "SELECT * FROM employees; DELETE FROM employees",
    /* وCTE كاتب لا يبدأ بـSELECT أصلًا — النمط السلبي وحده كان سيمرّره
       لو خلا من كلمة كتابة، والإيجابي يمسكه هنا. */
    "WITH x AS (DELETE FROM employees RETURNING *) SELECT * FROM x",
    "",
    "   ",
  ];
  for (const q of rejected) {
    assert.throws(() => V.selectOnly(q), `يجب رفض: ${q.slice(0, 30)}`);
  }
});

test("readEmployees لا يُصدر إلا استعلامات SELECT", async () => {
  const issued = [];
  const sql = {
    query: async (text, params) => {
      issued.push(text);
      if (/FROM employees/.test(text)) {
        return [
          { data: emp(900, { IBAN: "SA9100010001000100010001" }) },
          { data: emp(901, { "رقم الحساب": "990000000000001", "اسم البنك": BANK_A }) },
          { data: emp(902, {}) },
        ];
      }
      assert.deepEqual(params, ["2026-08"], "المسير يُمرَّر معاملًا لا يُدمج نصًّا");
      return [{ employee_eid: "900" }, { employee_eid: "901" }];
    },
  };

  const all = await V.readEmployees(sql, null);
  assert.equal(all.employees.length, 3, "بلا مسير: كل الموظفين");

  const scoped = await V.readEmployees(sql, "2026-08");
  assert.deepEqual(scoped.employees.map((e) => e["الرقم الوظيفي"]), ["900", "901"],
    "مع مسير: أصحاب صفوف إثباته وحدهم");

  assert.equal(issued.length, 3);
  for (const q of issued) assert.match(q, /^SELECT\b/, "كل استعلام صدر SELECT");
});

/* ═══ ② القياسات ═══ */

test("coverage يعدّ الحقول وما يهمّ عمليًا منها", () => {
  const c = V.coverage([
    emp(900, { IBAN: "SA9100010001000100010001", "اسم البنك": BANK_A }),
    emp(901, { "رقم الحساب": "990000000000001", "اسم البنك": BANK_A }),
    /* حسابٌ بلا بنك: لا يربط إيصالًا واحدًا مهما صحّت القاعدة. */
    emp(902, { "رقم الحساب": "990000000000002" }),
    /* فراغٌ ليس قيمة. */
    emp(903, { "رقم الحساب": "   ", "اسم البنك": "" }),
    emp(904, {}),
  ]);
  assert.equal(c.employees, 5);
  assert.equal(c.with_iban, 1);
  assert.equal(c.with_account, 2, "الفراغ لا يُعدّ حسابًا");
  assert.equal(c.with_bank, 2);
  assert.equal(c.account_without_bank, 1);
  assert.equal(c.no_identifier, 2, "903 و904 بلا معرّف بنكي");
});

test("uniqueness يفصل ازدواج الرقم الخام عن ازدواج الزوج", () => {
  /* الرقم نفسه عند موظفين ببنكين مختلفين: هذا بالضبط ما كانت القاعدة
     الخام ستربطه اعتباطًا، والزوج يفرّقه. */
  const u = V.uniqueness(M.indexEmployees([
    emp(900, { "رقم الحساب": "990000000000001", "اسم البنك": BANK_A }),
    emp(901, { "رقم الحساب": "990000000000001", "اسم البنك": BANK_B }),
    emp(902, { "رقم الحساب": "990000000000002", "اسم البنك": BANK_A }),
    emp(903, { "رقم الحساب": "990000000000002", "اسم البنك": BANK_A }),
    emp(904, { IBAN: "SA9100010001000100010001" }),
  ]));
  assert.equal(u.distinct_raw_accounts, 2);
  assert.equal(u.raw_account_shared_by_more_than_one, 2, "الرقمان كلاهما مشترك خامًا");
  assert.equal(u.distinct_account_bank_pairs, 3);
  assert.equal(u.account_bank_shared_by_more_than_one, 1, "وزوجٌ واحد فقط يبقى ملتبسًا");
  assert.equal(u.distinct_iban, 1);
  assert.equal(u.iban_shared_by_more_than_one, 0);
});

/* ═══ ③ تقرير الربط ═══ */

const employees = [
  emp(900, { IBAN: "SA9100010001000100010001", "اسم البنك": BANK_A }),
  emp(901, { "رقم الحساب": "990000000000001", "اسم البنك": BANK_A }),
  emp(902, { "رقم الحساب": "990000000000002" }),
  emp(903, { "رقم الحساب": "990000000000003", "اسم البنك": BANK_A }),
  emp(904, { "رقم الحساب": "990000000000003", "اسم البنك": BANK_A }),
];

test("linkReport يفصل مسار الآيبان عن مسار الحساب ويعدّ الأسباب", () => {
  const index = M.indexEmployees(employees);
  const r = V.linkReport([
    { extIban: "SA9100010001000100010001", extBank: BANK_A },        // linked
    { extIban: "SA9900009999999999999999", extBank: BANK_A },        // iban_no_owner
    { extAccount: "990000000000001", extBank: BANK_A },              // linked
    { extAccount: "990000000000001", extBank: BANK_B },              // bank_mismatch
    { extAccount: "990000000000001" },                               // receipt_bank_missing
    { extAccount: "990000000000002", extBank: BANK_A },              // record_bank_missing
    { extAccount: "990000000000003", extBank: BANK_A },              // ambiguous
    { extAccount: "880000000000999", extBank: BANK_A },              // account_no_owner
    {},                                                              // unreadable
  ], employees, index);

  assert.deepEqual(r.iban, { receipts: 2, uniquely_linked: 1, ambiguous: 0, unlinked: 1 });
  assert.deepEqual(r.account, { receipts: 6, uniquely_linked: 1, ambiguous: 1, unlinked: 4 });
  assert.equal(r.unreadable, 1);
  assert.equal(r.reasons.bank_mismatch, 1);
  assert.equal(r.reasons.receipt_bank_missing, 1);
  assert.equal(r.reasons.record_bank_missing, 1);
  assert.equal(r.reasons.account_no_owner, 1);
  assert.equal(r.reasons.iban_no_owner, 1);
  assert.equal(r.reasons.account_bank_multiple_owners, 1);
  assert.equal(r.reasons.no_identifier, 1);

  /* المجموع يطابق المُدخَل — فلا إيصال يسقط من التقرير بصمت. */
  assert.equal(r.iban.receipts + r.account.receipts + r.unreadable, 9);
});

test("إشارة المرادف تُرصَد من المسارين ولا تُرصَد بلا سبب", () => {
  const index = M.indexEmployees(employees);
  const r = V.linkReport([
    /* مسار الحساب: تعارضٌ منع ربطًا. */
    { extAccount: "990000000000001", extBank: BANK_B },
    { extAccount: "990000000000001", extBank: BANK_B },
    /* مسار الآيبان: الموظف مؤكَّد، فالصيغتان للبنك نفسه يقينًا. */
    { extIban: "SA9100010001000100010001", extBank: BANK_B },
    /* واتفاقٌ في الصيغة ليس إشارة. */
    { extIban: "SA9100010001000100010001", extBank: BANK_A },
    /* واختلافُ كتابةٍ وحده ليس إشارة — التطبيع يبتلعه. */
    { extIban: "SA9100010001000100010001", extBank: "  sanitized-national  BANK. " },
  ], employees, index);

  const pairs = [...r.aliasPairs.values()];
  assert.equal(pairs.length, 2, "إشارتان: واحدة لكل مسار");
  const acc = pairs.find((p) => p.source === "account_path");
  const iban = pairs.find((p) => p.source === "iban_path_confirmed");
  assert.equal(acc.count, 2, "تكرار الصيغة يُجمَع لا يُكرَّر");
  assert.equal(iban.count, 1);
});

/* ═══ ④ التسميات الوهمية ═══ */

test("labeller ثابت، ويمنح الصيغة الواحدة تسمية واحدة", () => {
  const label = V.labeller();
  const a = label("BANKONE");
  assert.equal(label("BANKONE"), a, "الصيغة نفسها تسميتها نفسها");
  const b = label("BANKTWO");
  assert.notEqual(b, a);
  assert.match(a, /^bank_form_[A-Z]+$/);
  assert.equal(V.labeller()("BANKONE"), a, "والترتيب وحده يقرّر — لا عشوائية");
  assert.equal(label(""), "(none)");
});

/* ═══ ⑤ الضمانة الكبرى: لا PII في المخرج ═══ */

test("المخرج لا يحمل اسمًا ولا آيبانًا ولا حسابًا ولا اسم بنك", () => {
  /* البيانات هنا مُختلَقة لكنها بموضع الحقيقي: لو تسرّب أيّها إلى
     المخرج لتسرّب نظيره الحقيقي عند التشغيل. */
  const SECRETS = [
    "SA9100010001000100010001", "SA9900009999999999999999",
    "990000000000001", "990000000000002", "990000000000003",
    BANK_A, BANK_B, "SANITIZED", "NATIONAL", "GULF",
    "EMPLOYEE NAME ONE", "9123456789",
  ];
  const staff = [
    emp(900, { IBAN: "SA9100010001000100010001", "اسم البنك": BANK_A,
               "اسم المستفيد (كما في البنك)": "EMPLOYEE NAME ONE",
               /* يبدأ بـ9 لا بـ2: الإقامة السعودية تبدأ بـ2، فحاجز
                  test/no-real-data.js يرفض 2\d{9} — وقد رفض هذا السطر
                  فعلًا حين كُتب بـ2، فالسياسة محروسة بالكود لا بالنيّة. */
               "رقم الإقامة": "9123456789" }),
    emp(901, { "رقم الحساب": "990000000000001", "اسم البنك": BANK_A }),
  ];
  const index = M.indexEmployees(staff);
  const receipts = [
    { extIban: "SA9100010001000100010001", extBank: BANK_B, extBeneficiary: "EMPLOYEE NAME ONE" },
    { extAccount: "990000000000001", extBank: BANK_B, extBeneficiary: "EMPLOYEE NAME ONE" },
  ];

  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    V.print(
      V.coverage(staff), V.uniqueness(index),
      V.linkReport(receipts, staff, index),
      { scope: "اختبار", files: 2, failed: [] },
      false
    );
  } finally { console.log = real; }

  const out = lines.join("\n");
  assert.ok(out.length > 0, "طُبع شيء فعلًا — وإلّا مرّ الاختبار على مخرج فارغ");
  for (const s of SECRETS) {
    assert.ok(!out.includes(s), `تسرّب إلى المخرج: ${s.slice(0, 6)}…`);
  }
  /* وما يجب أن يظهر: التسميات الوهمية والأعداد. */
  assert.match(out, /bank_alias_needed:/);
  assert.match(out, /bank_form_[A-Z]+ -> bank_form_[A-Z]+ : count \d+/);
  assert.match(out, /account\+bank uniquely linked: \d+/);
});

test("‎--show-banks وحده يكشف الصيغ، وهو مُطفأ افتراضًا", () => {
  const staff = [emp(901, { "رقم الحساب": "990000000000001", "اسم البنك": BANK_A })];
  const index = M.indexEmployees(staff);
  const link = V.linkReport([{ extAccount: "990000000000001", extBank: BANK_B }], staff, index);

  const run = (show) => {
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { V.print(V.coverage(staff), V.uniqueness(index), link, { scope: "t", files: 1, failed: [] }, show); }
    finally { console.log = real; }
    return lines.join("\n");
  };

  assert.ok(!run(false).includes("GULF"), "مُطفأ: لا اسم بنك");
  assert.ok(run(true).includes("GULF"), "ومُشعَلًا يكشف — للعين المحلّية وحدها");
});

/* ═══ ⑥ تشخيص account_no_owner ═══
   =========================================================================
   السبب واحد وأصوله أربعة مختلفة العلاج. وكل اختبار هنا يبني الأصل
   بعينه ويؤكّد أن التشخيص يسمّيه — فخلطُ أصلين يُرسل الإنسان إلى
   السجلّ الخطأ. */

const ANB = "ARAB NATIONAL BANK";
const ANB_AR = "البنك العربي الوطني";

/* مسير من موظفين: الأول مربوط دائمًا، والثاني هو المجهول الذي
   يُعرَف بالإقصاء. */
const payroll = (second) => [
  emp(900, { "رقم الحساب": "990000000000001", "اسم البنك": ANB_AR,
             "اسم المستفيد (كما في البنك)": "ALPHA BETA" }),
  { "الرقم الوظيفي": "901", ...second },
];
const linkedReceipt = { extAccount: "990000000000001", extBank: ANB, extBeneficiary: "ALPHA BETA" };
const orphan = (account, beneficiary) => ({
  extAccount: account, extBank: ANB, extBeneficiary: beneficiary || "GAMMA DELTA",
});

const diagnose = (second, orphanReceipt) => {
  const staff = payroll(second);
  return V.diagnoseAccountNoOwner(
    [linkedReceipt, orphanReceipt], staff, M.indexEmployees(staff)
  );
};

test("سجلّ بلا حساب ولا آيبان ⇒ missing_employee_account", () => {
  const d = diagnose({ "اسم البنك": ANB_AR }, orphan("990000000000777"));
  assert.equal(d.account_no_owner_count, 1);
  assert.equal(d.corresponding_employee_identified_by_elimination, "yes");
  assert.equal(d.corresponding_payroll_employee_has_identifier, "no");
  assert.equal(d.employee_record_has_account, "no");
  assert.equal(d.employee_record_has_iban, "no");
  assert.equal(d.employee_record_has_bank, "yes");
  assert.equal(d.likely_reason, "missing_employee_account");
});

test("أصفار بادئة ⇒ receipt_account_format_difference", () => {
  /* الرقم نفسه بصيغتين: التطابق الخام يفشل، والمطابقة الضعيفة تكشفه. */
  const d = diagnose(
    { "رقم الحساب": "00990000000000777", "اسم البنك": ANB_AR },
    orphan("990000000000777")
  );
  assert.equal(d.receipt_account_matches_any_record_raw, "no", "خامًا لا يطابق — وإلّا لما كان السبب هذا");
  assert.equal(d.receipt_account_loose_match, "leading_zeros");
  assert.equal(d.likely_reason, "receipt_account_format_difference");
});

test("الحساب داخل الآيبان ⇒ فرق صيغة أيضًا", () => {
  const d = diagnose(
    { IBAN: "SA9100990000000000777000", "اسم البنك": ANB_AR },
    orphan("990000000000777")
  );
  assert.equal(d.employee_record_has_iban, "yes");
  assert.equal(d.receipt_account_loose_match, "inside_iban");
  assert.equal(d.likely_reason, "receipt_account_format_difference");
});

test("فرق صيغة وسجلٌّ بلا بنك ⇒ missing_employee_bank_data أوّلًا", () => {
  /* نقص السجلّ يُحسم قبل الصيغة: إصلاح الصيغة وحده يُبقي الإيصال
     unlinked بسبب آخر، فتسميته «فرق صيغة» تُرسل الإنسان إلى علاج ناقص. */
  const d = diagnose({ "رقم الحساب": "00990000000000777" }, orphan("990000000000777"));
  assert.equal(d.employee_record_has_bank, "no");
  assert.equal(d.receipt_account_loose_match, "leading_zeros");
  assert.equal(d.likely_reason, "missing_employee_bank_data");
});

test("الرقم يقابل موظفًا آخر ⇒ receipt_belongs_to_other_employee", () => {
  const staff = [
    ...payroll({ "رقم الحساب": "990000000000002", "اسم البنك": ANB_AR }),
    /* موظف ثالث يحمل رقم الإيصال اليتيم بصيغة قريبة — وله إيصاله. */
    emp(902, { "رقم الحساب": "00990000000000777", "اسم البنك": ANB_AR }),
  ];
  /* 900 و902 مربوطان، فيبقى 901 وحده بلا إيصال — والإقصاء يحسم أن
     اليتيم له. ورقمه لا يقابل سجلّه بأي صيغة، ويقابل سجلّ 902 —
     فالإيصال لغير من ينسبه الإقصاء إليه. */
  const receipts = [
    linkedReceipt,
    { extAccount: "00990000000000777", extBank: ANB },
    orphan("990000000000777"),
  ];
  const d = V.diagnoseAccountNoOwner(receipts, staff, M.indexEmployees(staff));
  assert.equal(d.corresponding_employee_identified_by_elimination, "yes");
  assert.equal(d.receipt_account_loose_match, "none", "لا يقابل سجلّ صاحبه");
  assert.equal(d.receipt_account_loose_match_other_employee, "yes");
  assert.equal(d.likely_reason, "receipt_belongs_to_other_employee");
});

test("تعدّد الطرفين ⇒ unknown، ولا يُختار موظف تخمينًا", () => {
  const staff = payroll({ "رقم الحساب": "990000000000002", "اسم البنك": ANB_AR });
  /* إيصالان يتيمان وموظفان بلا ربط: الإقصاء لا يحسم. */
  const d = V.diagnoseAccountNoOwner(
    [orphan("990000000000777"), orphan("990000000000888")], staff, M.indexEmployees(staff)
  );
  assert.equal(d.account_no_owner_count, 2);
  assert.equal(d.corresponding_employee_identified_by_elimination, "no");
  assert.equal(d.likely_reason, "unknown");
  for (const k of ["corresponding_payroll_employee_has_identifier", "employee_record_has_account",
                   "employee_record_has_iban", "employee_record_has_bank"]) {
    assert.equal(d[k], "unknown", `${k} لا يُخمَّن`);
  }
});

test("اتّفاق الاسم يُعرَض yes/no ولا يُطبع الاسم", () => {
  const agree = diagnose(
    { "رقم الحساب": "00990000000000777", "اسم البنك": ANB_AR,
      "اسم المستفيد (كما في البنك)": "GAMMA DELTA" },
    orphan("990000000000777", "GAMMA DELTA")
  );
  assert.equal(agree.beneficiary_name_agrees_with_record, "yes");

  const disagree = diagnose(
    { "رقم الحساب": "00990000000000777", "اسم البنك": ANB_AR,
      "اسم المستفيد (كما في البنك)": "OMEGA SIGMA" },
    orphan("990000000000777", "GAMMA DELTA")
  );
  assert.equal(disagree.beneficiary_name_agrees_with_record, "no");

  const silent = diagnose({ "رقم الحساب": "00990000000000777", "اسم البنك": ANB_AR },
    orphan("990000000000777"));
  assert.equal(silent.beneficiary_name_agrees_with_record, "unknown", "بلا اسم في السجلّ لا حكم");

  /* وقيم التقرير كلّها yes/no/unknown أو عدد — لا نصّ حرّ يحمل بيانًا. */
  for (const v of Object.values(agree)) {
    assert.ok(typeof v === "number" || /^(yes|no|unknown|n\/a|none|exact_account|leading_zeros|substring_account|inside_iban|missing_employee_account|missing_employee_bank_data|receipt_account_format_difference|receipt_belongs_to_other_employee)$/.test(v),
      `قيمة غير مُعقَّمة: ${v}`);
  }
});

test("قسم ⑤ يُطبع بلا PII", () => {
  const SECRETS = ["ALPHA BETA", "GAMMA DELTA", "990000000000777", "990000000000001",
                   ANB, ANB_AR, "ARAB", "العربي"];
  const staff = payroll({ "رقم الحساب": "00990000000000777", "اسم البنك": ANB_AR,
                          "اسم المستفيد (كما في البنك)": "GAMMA DELTA" });
  const index = M.indexEmployees(staff);
  const receipts = [linkedReceipt, orphan("990000000000777")];
  const diag = V.diagnoseAccountNoOwner(receipts, staff, index);

  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    V.print(V.coverage(staff), V.uniqueness(index), V.linkReport(receipts, staff, index),
            { scope: "t", files: 2, failed: [] }, false, diag);
  } finally { console.log = real; }

  const out = lines.join("\n");
  assert.match(out, /account_no_owner_count: 1/, "القسم طُبع فعلًا");
  assert.match(out, /likely_reason: receipt_account_format_difference/);
  for (const s of SECRETS) assert.ok(!out.includes(s), `تسرّب: ${s.slice(0, 6)}…`);
});
