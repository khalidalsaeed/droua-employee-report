#!/usr/bin/env node
/* عيّنة كشف رواتب مُعقَّمة — تُبنى بالكود لا تُنسخ من مستند حقيقي.
   =========================================================================
   لماذا مُعقَّمة: الكشف الحقيقي يحمل أسماء عشرة أشخاص ورواتبهم الفعلية.
   وضعه في Git يعني حفظ ذلك في التاريخ للأبد ولكل من يستنسخ المستودع.
   فالسياسة المعتمدة: لا مستند أصلي ولا بيان هوية حقيقي داخل المستودع —
   لا أرقام إقامة ولا IBAN ولا أرقام حسابات ولا مبالغ تربط بشخص.

   ما تحافظ عليه العيّنة حرفيًا من بنية الكشف الحقيقي (كشف نظام جسر)،
   لأن هذه البنية هي بالضبط ما يقرؤه lib/payroll/sheetRoster.js:

     · المستند RTL، فعناصر الصفّ مرتّبة بصريًا: أقصى اليسار (x أصغر) هو
       صافي الراتب، وأقصى اليمين (x أكبر) هو رقم الموظف في جسر.
     · اثنا عشر عمودًا نقديًا لكل صفّ موظف، عند الإحداثيات الأفقية نفسها.
     · رقم جسر آخر عنصر أفقيًا — وهو ما يميّز صفّ الموظف من صفّ
       الإجماليات الذي يخلو منه.
     · الاسم يخرج محرفًا محرفًا بترتيب بصري معكوس، تمامًا كما تُخرجه
       الخطوط المُجزّأة في الكشف الحقيقي — فتُختبر nameHintFrom على
       الظاهرة نفسها لا على نصّ متّصل مريح.
     · صفّ إجماليات باثني عشر عمودًا نقديًا وبلا رقم موظف.
     · صفّ تكملة اسمٍ فاض عن سطره (بلا أي عمود نقدي) — موجود في الكشف
       الحقيقي، وأي قارئ يعدّه صفَّ موظف يُنتج موظفًا وهميًا.
     · صفوف ترويسة وتذييل بلا أعمدة نقدية سليمة.

   وما غُيّر: كل هوية وكل مبلغ. الأسماء لاتينية بلا معنى، وأرقام جسر
   11–20 (الحقيقية 49–85)، وأرقام ضمان 900–909 (الحقيقية في المدى 5xx،
   فلا يمكن لصفٍّ من هذه العيّنة أن يشير إلى موظف حقيقي حتى بالخطأ).

   وما حُفظ منطقًا لا قيمةً: حسابُ الصفّ الحقيقي نفسه
     الإجمالي = الأساسي + البدل + بدل إضافي
     الصافي   = الإجمالي + الوقت الإضافي − الخصميات
   وكل الإجماليات تُجمع من الصفوف لا تُكتب بيدٍ، فالعيّنة لا يمكن أن
   تخرج غير متوافقة مع نفسها.

   والأهمّ: موظف واحد صافيه ينتهي بـ.08 — ‏3,412.08 — كي تبقى حالة فرق
   الثماني هللات (المسير .08 والتحويل .00) قابلة للاختبار من أول يوم،
   بلا استعمال راتب أي شخص حقيقي: قيمة الرقم لا تهمّ، الذي يهمّ أن
   الكسر موجود.

   التوليد:  node test/fixtures/payroll-sheet.js --write
             يكتب payroll-sheet-sanitized.pdf بجانب هذا الملفّ. */

/* الإحداثيات الأفقية للأعمدة الاثني عشر، منقولة كما هي من قياس الكشف
   الحقيقي. ترتيبها هنا من اليسار إلى اليمين — أي من الصافي إلى الأساسي. */
const COLUMN_X = [53, 143, 395, 482, 587, 644, 697, 747, 801, 864, 905, 962];
const JISR_X = 1137; // آخر عنصر أفقيًا — هذا ما يجعله رقم الموظف
const NAME_START_X = 1091; // أول محرف من الاسم، ثم يتنازل
const NAME_STEP_X = 7;

const FIRST_ROW_Y = 682;
const ROW_STEP_Y = 22;

/* عشرة موظفين وهميين. المبالغ مُختلقة بالكامل ومتوافقة حسابيًا. */
const ROSTER = [
  { jisrNo: "11", eid: "900", name: "ALPHA ONE", basic: 2200.0, allowance: 500.0, extra: 150.0, overtime: 562.08, deduction: 0.0 },
  { jisrNo: "12", eid: "901", name: "BETA TWO", basic: 1800.0, allowance: 450.0, extra: 100.0, overtime: 0.0, deduction: 25.4 },
  { jisrNo: "13", eid: "902", name: "GAMMA THREE", basic: 1700.0, allowance: 400.0, extra: 0.0, overtime: 0.0, deduction: 0.0 },
  { jisrNo: "14", eid: "903", name: "DELTA FOUR", basic: 1900.0, allowance: 420.0, extra: 80.0, overtime: 175.5, deduction: 0.0 },
  { jisrNo: "15", eid: "904", name: "EPSILON FIVE", basic: 1650.0, allowance: 400.0, extra: 0.0, overtime: 0.0, deduction: 0.0 },
  { jisrNo: "16", eid: "905", name: "ZETA SIX", basic: 1750.0, allowance: 430.0, extra: 120.0, overtime: 0.0, deduction: 310.75 },
  { jisrNo: "17", eid: "906", name: "ETA SEVEN", basic: 1600.0, allowance: 400.0, extra: 0.0, overtime: 90.0, deduction: 0.0 },
  { jisrNo: "18", eid: "907", name: "THETA EIGHT", basic: 2000.0, allowance: 480.0, extra: 0.0, overtime: 0.0, deduction: 0.0 },
  { jisrNo: "19", eid: "908", name: "IOTA NINE", basic: 1550.0, allowance: 380.0, extra: 0.0, overtime: 0.0, deduction: 145.6 },
  { jisrNo: "20", eid: "909", name: "KAPPA TEN", basic: 1880.0, allowance: 460.0, extra: 60.0, overtime: 240.0, deduction: 0.0 },
];

const round2 = (n) => Math.round(n * 100) / 100;
const grossOf = (r) => round2(r.basic + r.allowance + r.extra);
const netOf = (r) => round2(grossOf(r) + r.overtime - r.deduction);

/* بالفاصلة الألفية ومنزلتين — نفس صيغة الكشف، وهي ما يتعرّف عليه isMoney. */
const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* الأعمدة الاثنا عشر لصفّ موظف، من اليسار إلى اليمين.
   العمودان 644 و697 يحملان الوقت الإضافي مرّتين، و395/482/587 أعمدة
   خصمٍ فرعية يحمل أحدها المجموع — كما في الكشف الحقيقي حرفيًا. */
function cellsFor(r) {
  const gross = grossOf(r);
  return [
    netOf(r), r.deduction, r.deduction, 0.0, 0.0,
    r.overtime, r.overtime, gross, r.extra, 0.0,
    r.allowance, r.basic,
  ];
}

function totalsCells() {
  const sum = (fn) => round2(ROSTER.reduce((a, r) => a + fn(r), 0));
  return [
    sum(netOf), sum((r) => r.deduction), sum((r) => r.deduction), 0.0, 0.0,
    sum((r) => r.overtime), sum((r) => r.overtime), sum(grossOf), sum((r) => r.extra), 0.0,
    sum((r) => r.allowance), sum((r) => r.basic),
  ];
}

const TOTAL_NET = round2(ROSTER.reduce((a, r) => a + netOf(r), 0));

/* ─── كاتب PDF أدنى ما يكفي ───
   لا اعتمادية جديدة: pdf-lib لم يُعتمد بعد، وpdfmake يبني تخطيطًا لا
   يمنحنا التحكّم بإحداثي كل عنصر — وهو بالضبط ما تحتاجه العيّنة.
   لذلك تُكتب بنية PDF مباشرة: كل عنصر نصّي بمصفوفة Tm صريحة، فيصل إلى
   pdfjs بالإحداثي المقصود حرفيًا. الخطّ Helvetica قياسي بلا تضمين. */

const escapeText = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);

function textOp(x, y, s, size) {
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapeText(s)}) Tj ET`;
}

/* الاسم محرفًا محرفًا بترتيب بصري معكوس: أول محرف عند أكبر x ثم يتنازل.
   فيصل إلى القارئ مبعثرًا كما في الكشف الحقيقي، وnameHintFrom — التي
   تجمع بترتيب x ثم تعكس — تُعيد تركيبه. */
function nameOps(name, y) {
  const ops = [];
  [...name].forEach((ch, i) => {
    if (ch === " ") return;
    ops.push(textOp(NAME_START_X - i * NAME_STEP_X, y, ch, 7));
  });
  return ops;
}

function buildContentStream() {
  const ops = [];

  // ترويسة: نصّ بلا أعمدة نقدية سليمة، يجب أن يُتخطّى
  ops.push(textOp(28, 792, "JISR SYSTEM - SANITIZED SAMPLE", 9));
  ops.push(textOp(48, 777, "2026-08-02", 8));
  ops.push(textOp(532, 770, "PAYROLL SHEET", 9));
  ops.push(textOp(568, 750, "2026", 8));
  // صفّ عناوين الأعمدة — عناوين لا أرقام
  COLUMN_X.forEach((x, i) => ops.push(textOp(x, 716, `COL${i + 1}`, 6)));
  ops.push(textOp(JISR_X, 716, "NO", 6));

  let y = FIRST_ROW_Y;
  ROSTER.forEach((r, idx) => {
    cellsFor(r).forEach((v, i) => ops.push(textOp(COLUMN_X[i], y, money(v), 7)));
    ops.push(...nameOps(r.name, y));
    /* رقم جسر آخر عنصر أفقيًا. مكتوب بلا فاصلة ولا منزلتين، فلا يُعدّ
       عمودًا نقديًا — وهذا هو الفرق الذي يقوم عليه القارئ. */
    ops.push(textOp(JISR_X, y, r.jisrNo, 7));

    /* صفّ تكملة اسم بعد الموظف الثالث: بلا أي عمود نقدي. موجود في الكشف
       الحقيقي حين يفيض الاسم عن سطره. */
    if (idx === 3) {
      y -= 12;
      ops.push(...nameOps("CONT", y));
    }
    y -= ROW_STEP_Y;
  });

  /* صفّ الإجماليات: اثنا عشر عمودًا نقديًا وبلا رقم موظف إطلاقًا. */
  const totalsY = y;
  totalsCells().forEach((v, i) => ops.push(textOp(COLUMN_X[i] - 10, totalsY, money(v), 7)));

  /* تذييل بأرقام ملحقة بنقطتين — «0.00 :» ليست مبلغًا لأن isMoney تطابق
     النصّ كاملًا. موجودة في الكشف الحقيقي، وقارئ متسامح يعدّها عمودًا. */
  ops.push(textOp(257, totalsY - 29, `${money(0)} :`, 7));
  ops.push(textOp(688, totalsY - 29, `${money(TOTAL_NET)} :`, 7));
  ops.push(textOp(60, totalsY - 60, "SANITIZED FIXTURE - NO REAL PERSON OR AMOUNT", 7));

  return ops.join("\n");
}

function buildSanitizedSheet() {
  const content = buildContentStream();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 842] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

if (require.main === module) {
  if (!process.argv.includes("--write")) {
    console.log(`صافي الإجماليات: ${money(TOTAL_NET)}`);
    for (const r of ROSTER) console.log(`  جسر ${r.jisrNo} → ضمان ${r.eid}  ${money(netOf(r))}  ${r.name}`);
    console.log("\nأضف ‎--write لكتابة الملفّ.");
  } else {
    const fs = require("node:fs");
    const path = require("node:path");
    const out = path.join(__dirname, "payroll-sheet-sanitized.pdf");
    fs.writeFileSync(out, buildSanitizedSheet());
    console.log(`كُتب ${out} (${fs.statSync(out).size} بايت) — صافي الإجماليات ${money(TOTAL_NET)}`);
  }
}

module.exports = { ROSTER, TOTAL_NET, buildSanitizedSheet, netOf, grossOf, money, COLUMN_X, JISR_X };
