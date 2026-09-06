const test = require("node:test");
const assert = require("node:assert/strict");

const {
  similarity, foldArabic, nameTokens, tokenMatch, assignOneToOne,
  DECIDED_MIN_SCORE, DECIDED_MIN_MARGIN,
} = require("../scripts/set-jisr-numbers.js");

/* مطابقة أسماء كشف جسر بسجلّ الموظفين.
   =========================================================================
   الأسماء في المصدرين لا تتطابق حرفيًا: الكشف يُخرج «مد شهيد الاسلام»
   والسجلّ يحمل «محمد شيدال اسلام»، والكشف «شميم حسين» والسجلّ «شميم».
   النسخة الأولى قاست اشتراك الحروف بلا ترتيب فتزاحمت أسماءٌ لا صلة
   بينها، وخرجت ثلاثة صفوف «غامضة» صحيحُها بيّن لعين بشرية.

   البيانات هنا ليست مصنوعة: أرقام جسر وأسماؤه من كشف الرواتب الحقيقي في
   المستودع (payroll/2026-07.pdf)، وأرقام ضمان وأسماؤها من لقطة سجلّ
   الموظفين. فما يُقاس هو الحالة التي أخفقت فعلًا. */

/* الكشف: رقم جسر + الاسم كما يُعاد بناؤه من إحداثيات حروف الـPDF. */
const SHEET = [
  { jisrNo: "49", nameHint: "شكيب مياه" },
  { jisrNo: "55", nameHint: "الأمين مولا" },
  { jisrNo: "56", nameHint: "مد توفيق" },
  { jisrNo: "59", nameHint: "مد فرهاد علي شاركير" },
  { jisrNo: "60", nameHint: "راسل ديوان راسل" },
  { jisrNo: "63", nameHint: "مد طيف الرحمن شهاب" },
  { jisrNo: "70", nameHint: "مد شهيد الاسلام" },
  { jisrNo: "71", nameHint: "شميم حسين" },
  { jisrNo: "82", nameHint: "مد هلال مد الدين" },
  { jisrNo: "85", nameHint: "ساجر احمد" },
];

/* السجلّ: رقم ضمان + الاسم. أربعة أسماء تبدأ بـ«مد» — وهو منشأ التزاحم. */
const EMPLOYEES = [
  { eid: "500", name: "شميم" },
  { eid: "501", name: "مد طيف ال رحمن شهاب" },
  { eid: "502", name: "مد تفيق مد حسن" },
  { eid: "503", name: "راسل ديوان" },
  { eid: "504", name: "لامين مولا" },
  { eid: "505", name: "محمد شيدال اسلام" },
  { eid: "506", name: "شكيب ميا" },
  { eid: "507", name: "مد فرهاد علي شاركر" },
  { eid: "508", name: "ساجر" },
  { eid: "509", name: "مد هلال مد الدين" },
];

const assign = () => assignOneToOne(SHEET, EMPLOYEES, (r) => r.nameHint);
const byJisr = (results, jisrNo) => results.find((r) => r.row.jisrNo === jisrNo);

/* ── الثلاثة التي أخفقت ── */

test("انحدار: 63 «مد طيف الرحمن شهاب» → 501", () => {
  const r = byJisr(assign(), "63");
  assert.equal(r.employee && r.employee.eid, "501");
  assert.equal(r.decided, true);
  /* أل التعريف هي ما حسمته: «الرحمن» في الكشف مقابل «ال رحمن» في السجلّ. */
  assert.equal(similarity("مد طيف الرحمن شهاب", "مد طيف ال رحمن شهاب"), 1);
});

test("انحدار: 70 «مد شهيد الاسلام» → 505", () => {
  const r = byJisr(assign(), "70");
  assert.equal(r.employee && r.employee.eid, "505");
  assert.equal(r.decided, true);
  /* «محمد» ↔ «مد» تطبيعًا على مستوى الكلمة. */
  assert.ok(similarity("مد شهيد الاسلام", "محمد شيدال اسلام") > similarity("مد شهيد الاسلام", "مد طيف ال رحمن شهاب"));
});

test("انحدار: 71 «شميم حسين» → 500", () => {
  const r = byJisr(assign(), "71");
  assert.equal(r.employee && r.employee.eid, "500");
  assert.equal(r.decided, true);
  /* الاسم المختصر لا يُعاقَب على نقصه. */
  assert.equal(similarity("شميم حسين", "شميم"), 1);
  assert.ok(similarity("شميم حسين", "شميم") > similarity("شميم حسين", "مد تفيق مد حسن"));
});

/* ── التفرّد: القاعدة التي طُلبت صراحةً ── */

test("لا رقم ضمان مُسنَد لأكثر من رقم جسر", () => {
  const eids = assign().filter((r) => r.employee).map((r) => r.employee.eid);
  assert.equal(new Set(eids).size, eids.length, "تكرار رقم ضمان يعني موظفًا مرّتين وآخر غائبًا");
});

test("العشرة كلها محسومة على البيانات الحقيقية", () => {
  const results = assign();
  const undecided = results.filter((r) => !r.decided).map((r) => r.row.jisrNo);
  assert.deepEqual(undecided, [], `بقي غير محسوم: ${undecided.join(", ")}`);
  assert.deepEqual(
    results.map((r) => [r.row.jisrNo, r.employee.eid]),
    [["49","506"],["55","504"],["56","502"],["59","507"],["60","503"],
     ["63","501"],["70","505"],["71","500"],["82","509"],["85","508"]]
  );
});

/* التخصيص عالميّ لا صفٌّ صفًّا: لو اختار كلٌّ أفضلَه وحده لتكرّر رقم. */
test("التخصيص يفضّل المجموع الأعلى لا الجشع الأعمى", () => {
  /* اسمان يتزاحمان على مرشّح واحد؛ الأمثل أن يأخذ كلٌّ نظيره الحقيقي. */
  const rows = [{ jisrNo: "1", nameHint: "مد هلال مد الدين" }, { jisrNo: "2", nameHint: "مد طيف الرحمن شهاب" }];
  const emps = [{ eid: "509", name: "مد هلال مد الدين" }, { eid: "501", name: "مد طيف ال رحمن شهاب" }];
  const res = assignOneToOne(rows, emps, (r) => r.nameHint);
  assert.equal(res[0].employee.eid, "509");
  assert.equal(res[1].employee.eid, "501");
});

/* ── لا تخمين إجباري ── */

test("اسم لا نظير له يبقى «غير محسوم» بلا رقم ضمان", () => {
  const rows = [{ jisrNo: "999", nameHint: "عبد الله سالم القحطاني" }];
  const res = assignOneToOne(rows, EMPLOYEES, (r) => r.nameHint);
  assert.equal(res[0].decided, false);
  assert.equal(res[0].employee, null, "لا يُملأ بأقرب موجود");
});

test("صفوف أكثر من الموظفين: الزائد غير محسوم لا مُسنَد بالقوّة", () => {
  const rows = [{ jisrNo: "1", nameHint: "شميم حسين" }, { jisrNo: "2", nameHint: "شميم حسين" }];
  const res = assignOneToOne(rows, [{ eid: "500", name: "شميم" }], (r) => r.nameHint);
  const decided = res.filter((r) => r.employee);
  assert.equal(decided.length, 1, "رقم ضمان واحد لا يُسنَد لصفّين");
});

test("العتبتان معلَنتان ومعقولتان", () => {
  assert.ok(DECIDED_MIN_SCORE > 0.5 && DECIDED_MIN_SCORE <= 0.7);
  assert.ok(DECIDED_MIN_MARGIN >= 0.15);
});

/* ── التطبيع: لا \b على العربية ── */

test("التقسيم على المسافات لا على حدود ASCII", () => {
  /* \bمحمد\b لا يطابق شيئًا في نصّ عربي — هذا العطل بعينه أبقى 70 غامضًا. */
  assert.deepEqual(nameTokens("محمد شيدال اسلام"), ["مد", "شيدال", "اسلام"]);
  assert.deepEqual(nameTokens("مد طيف ال رحمن شهاب"), ["مد", "طيف", "رحمن", "شهاب"]);
  assert.deepEqual(nameTokens("مد شهيد الاسلام"), ["مد", "شهيد", "اسلام"]);
});

test("طيّ صور الهمزة والتاء المربوطة", () => {
  assert.equal(foldArabic("الأمين"), foldArabic("الامين"));
  assert.equal(foldArabic("مياة"), foldArabic("مياه"));
  assert.ok(similarity("الأمين مولا", "لامين مولا") >= 0.9);
});

test("أل التعريف لا تُحذف من كلمة قصيرة فتُشوَّه", () => {
  assert.deepEqual(nameTokens("الي"), ["الي"], "ثلاثة أحرف تبقى كما هي");
  assert.deepEqual(nameTokens("الاسلام"), ["اسلام"]);
});

test("تقارب الكلمة يشترط عتبة: الضعيف صفر لا درجة صغيرة", () => {
  assert.equal(tokenMatch("مد", "مد"), 1);
  assert.equal(tokenMatch("شميم", "شميم حسين".split(" ")[0]), 1);
  assert.ok(tokenMatch("شاركر", "شاركير") >= 0.7, "اختلاف إملائي يُقبل");
  assert.equal(tokenMatch("شكيب", "ساجر"), 0, "كلمتان مختلفتان لا تُعطيان درجة");
});

test("اسم فارغ أو بلا حروف عربية درجته صفر", () => {
  for (const v of ["", "   ", null, undefined, "12345", "abc"]) {
    assert.equal(similarity(v, "شميم"), 0);
    assert.equal(similarity("شميم", v), 0);
  }
});
