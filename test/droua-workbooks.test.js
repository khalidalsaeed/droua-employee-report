const test = require("node:test");
const assert = require("node:assert/strict");

const xls = require("../lib/droua/parsers/xls");
const xlsx = require("../lib/droua/parsers/xlsx");
const parsers = require("../lib/droua/parsers");
const csv = require("../lib/droua/parsers/csv");
const { buildXlsx, buildXls } = require("./helpers/workbook-builder");

/* ─── قارئا Excel ───────────────────────────────────────────────────────
   =========================================================================
   المصنّفات هنا **مبنيّة في الاختبار** لا محفوظة في المستودع: ملفّ ثنائيّ
   مخزَّن لا يقول ما الذي يختبره، ولا يمكن تعديله لاختبار حالة. والبنّاء
   يجعل كل حالةٍ صريحة.

   ⛔ ولا بيان حقيقيّ: أسماء مخترعة وأرقام مؤلَّفة.

   وأخطر ثلاث حالات في هاتين الصيغتين:
     ① خليّة غائبة في منتصف صفّ — قارئٌ يقرأ بالتسلسل يُزيح الأعمدة كلَّها
       بعدها، فتُقرأ أرقامٌ صحيحة في أعمدة خاطئة وتبدو سليمة تمامًا.
     ② نصّ يمتدّ على CONTINUE — من يتجاهل بايت السمات الجديد يقرأ بقيّة
       النصّ العربيّ بترميز لاتينيّ فيخرج حروفًا مبعثرة.
     ③ صفّ مجاميع في آخر المسير — يُعدّ موظّفًا راتبه مجموع الجميع. */

const HEADER = ["رقم الموظف", "اسم الموظف", "الراتب الاساسي", "بدل سكن",
  "اجمالي الخصميات", "صافي الراتب"];
const SAMPLE = [
  HEADER,
  ["1001", "موظّف تجريبيّ", 9000, 500, 200, 9300],
  ["1002", "موظّفة تجريبية", 7500, 0, 0, 7500],
  ["", "", 16500, 500, 200, 16800],   // صفّ مجاميع
];

const shapes = [
  ["xlsx", (rows, o) => buildXlsx(rows, o), xlsx, "xlsx"],
  ["xls", (rows, o) => buildXls(rows, o), xls, "xls"],
  ["xls بجدول نصوص ممتدّ", (rows, o) => buildXls(rows, { ...o, splitSst: true }), xls, "xls"],
];

for (const [label, build, reader, format] of shapes) {
  test(`${label}: يقرأ الصفوف ويطبّع الأرقام ويتخطّى صفّ المجاميع`, () => {
    const doc = reader.parse({ kind: "full", bytes: build(SAMPLE) });
    assert.equal(doc.meta.source, format);
    assert.equal(doc.meta.rowCount, 2, JSON.stringify(doc.meta.warnings));
    assert.equal(doc.meta.skippedRows, 1);
    assert.match(doc.meta.warnings.join(" "), /صفّ مجاميع/);

    assert.equal(doc.rows[0].empNo, "1001");
    assert.equal(doc.rows[0].name, "موظّف تجريبيّ", "النصّ العربيّ يخرج سليمًا");
    assert.equal(doc.rows[0].basic, 9000);
    assert.equal(doc.rows[0].allowances, 500);
    assert.equal(doc.rows[0].deductions, 200);
    assert.equal(doc.rows[0].net, 9300);
    assert.equal(doc.rows[1].net, 7500);
    assert.equal(doc.meta.needsManualReview, false);
  });

  test(`${label}: خليّة غائبة في منتصف الصفّ لا تُزيح الأعمدة`, () => {
    /* أخطر عطلٍ ممكن هنا: أرقامٌ صحيحة في أعمدة خاطئة. */
    const rows = [HEADER, ["1003", "بلا بدل", 6000, null, 100, 5900]];
    const doc = reader.parse({ kind: "full", bytes: build(rows) });
    assert.equal(doc.rows.length, 1);
    assert.equal(doc.rows[0].basic, 6000);
    assert.equal(doc.rows[0].allowances, 0, "الفراغ صفرٌ في مكانه لا إزاحة");
    assert.equal(doc.rows[0].deductions, 100);
    assert.equal(doc.rows[0].net, 5900);
  });

  test(`${label}: ترويسة بعد صفّ عنوان تُلتقط`, () => {
    /* ملفّات حقيقية تبدأ بعنوان أو تاريخ قبل الجدول. */
    const rows = [["تقرير الرواتب"], [], ...SAMPLE];
    const doc = reader.parse({ kind: "full", bytes: build(rows) });
    assert.equal(doc.meta.headerRow, 3, "الترويسة عند الصفّ الثالث");
    assert.equal(doc.meta.rowCount, 2);
    assert.equal(doc.rows[0].empNo, "1001");
  });

  test(`${label}: عبر واجهة القرّاء الموحّدة`, () => {
    assert.equal(parsers.available(format), true);
    const doc = parsers.parse({ format, kind: "full", bytes: build(SAMPLE) });
    assert.equal(doc.rows.length, 2);
  });
}

test("xlsx: الورقة ذات الجدول تُختار لا الأولى", () => {
  const bytes = buildXlsx(null, { sheets: [
    { name: "تعليمات", rows: [["يرجى تعبئة الجدول"], ["ثمّ الإرسال"]] },
    { name: "البيانات", rows: SAMPLE },
  ] });
  const doc = xlsx.parse({ kind: "full", bytes });
  assert.equal(doc.meta.sheet, "البيانات");
  assert.equal(doc.meta.rowCount, 2);
});

test("xls: أرقام RK الكسرية تُفكّ صحيحة", () => {
  /* RK يحشر العدد في 32 بت — إمّا صحيحًا أو نصفَ double، وبتٌّ يعني
     «مقسومٌ على مئة». وخطأ فكّه يُنتج مبالغ أكبر مئة مرّة. */
  assert.equal(xls.decodeRk(0x00000002 | (100 << 2)), 100);
  assert.equal(xls.decodeRk(0x00000003 | (12345 << 2)), 123.45);
  const double = xls.decodeRk(0x40590000);          // 100.0 كنصف double
  assert.ok(Math.abs(double - 100) < 1e-9, String(double));
});

test("الصيغ: ما لا قارئ له يُعلن عجزه ولا يخمّن", () => {
  assert.equal(parsers.available("pdf"), false);
  assert.throws(() => parsers.parse({ format: "pdf", kind: "full", bytes: Buffer.from("%PDF-1.7") }),
    (err) => err.code === "parser_unavailable");
});

test("الصيغ: ملفّ تالف يفشل بوضوح ولا يُخرج صفوفًا مخترعة", () => {
  for (const [format, reader] of [["xlsx", xlsx], ["xls", xls]]) {
    assert.throws(() => reader.parse({ kind: "full", bytes: Buffer.from("هذا ليس مصنّفًا") }),
      (err) => err instanceof Error, format);
  }
});

test("الأعمدة المركَّبة: بدلات وخصميات مفصَّلة تُجمع، والمُعلَن يسبق المجموع", () => {
  /* مسيرات حقيقية تفصّل البدل إلى «بدل سكن» و«بدل مواصلات»… والخصم إلى
     «تاخير» و«غياب»… ولا تُدرَج أسماء بعينها: البادئة تكفي. */
  const detailed = [
    ["رقم الموظف", "اسم الموظف", "الراتب الاساسي", "بدل سكن", "بدل مواصلات",
     "بدل إعاشة", "تاخير", "غياب", "التامينات الاجتماعية", "صافي الراتب"],
    ["1001", "أ", 9000, 1000, 500, 300, 50, 100, 450, 10200],
  ];
  const doc = csv.parse({ kind: "full", bytes: Buffer.from(detailed.map((r) => r.join(",")).join("\n")) });
  assert.equal(doc.rows[0].allowances, 1800, "1000 + 500 + 300");
  assert.equal(doc.rows[0].deductions, 600, "50 + 100 + 450");
  assert.match(doc.meta.mapping.allowanceParts, /بدل سكن \+ بدل مواصلات \+ بدل إعاشة/);
  assert.match(doc.meta.mapping.deductionParts, /تاخير \+ غياب/);
  assert.deepEqual(doc.meta.unknownColumns, [], "لا عمود يضيع في التفصيل");

  /* وعمودٌ لم يُدرَج اسمُه صراحةً يُفهم ببادئته. */
  const novel = [
    ["رقم الموظف", "الراتب الاساسي", "بدل انتداب ميدانيّ", "خصم تأخير جديد", "صافي الراتب"],
    ["1002", 5000, 700, 200, 5500],
  ];
  const doc2 = csv.parse({ kind: "full", bytes: Buffer.from(novel.map((r) => r.join(",")).join("\n")) });
  assert.equal(doc2.rows[0].allowances, 700, "«بدل …» بدلٌ ولو لم يُدرَج");
  assert.equal(doc2.rows[0].deductions, 200, "«خصم …» خصمٌ ولو لم يُدرَج");

  /* والمجموع المُعلَن يسبق جمع الأجزاء حين يوجد الاثنان. */
  const both = [
    ["رقم الموظف", "الراتب الاساسي", "بدل سكن", "اجمالي البدلات", "صافي الراتب"],
    ["1003", 5000, 700, 999, 5999],
  ];
  const doc3 = csv.parse({ kind: "full", bytes: Buffer.from(both.map((r) => r.join(",")).join("\n")) });
  assert.equal(doc3.rows[0].allowances, 999, "المُعلَن يفوز");
});

test("الهوية: رقم الهوية يُتعرَّف عليه ولا يُحتفظ منه إلا بأربع خانات", () => {
  const rows = [
    ["الرقم الوظيفي", "الاسم", "رقم الهوية/الإقامة", "رقم الآيبان", "الحالة"],
    ["1001", "أ", "1234567890", "SA0380000000608010167519", "نشط"],
  ];
  const doc = csv.parse({ kind: "employees", bytes: Buffer.from(rows.map((r) => r.join(",")).join("\n")) });
  assert.equal(doc.rows[0].idLast4, "7890");
  assert.equal(doc.rows[0].iban4, "7519");
  const blob = JSON.stringify(doc);
  assert.ok(!blob.includes("1234567890"), "رقم الهوية الكامل لا يغادر القارئ");
  assert.ok(!blob.includes("SA0380000000608010167519"), "ولا رقم الحساب الكامل");
  assert.deepEqual(doc.meta.unknownColumns, [], "وعمود الهوية معروف لا مجهول");
});
