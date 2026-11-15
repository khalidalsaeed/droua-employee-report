/* ملفّات تحويل **مصنوعة** للاختبار — ⛔ لا بيان حقيقي.
   أسماء مخترعة، وآيبانات مولَّدة بخانات رقابية صحيحة على أرقام حسابات
   متسلسلة لا تخصّ أحدًا. */

const path = require("path");
const { buildXlsx } = require("./workbook-builder");

function mod97(digits) {
  let r = 0;
  for (const d of digits) r = (r * 10 + Number(d)) % 97;
  return r;
}
/* آيبان سعودي صالح: SA + خانتان رقابيتان + رمز بنك (2) + 18 خانة. */
function fakeIban(n, bank = "80") {
  const bban = bank + String(n).padStart(18, "0");
  const numeric = bban + "2810" + "00"; // S=28 A=10
  const check = String(98 - mod97(numeric)).padStart(2, "0");
  return `SA${check}${bban}`;
}

/* موظفو مسير مصنوع. expected بالهللة. */
const EMPLOYEES = [
  { eid: "901", jisrNo: "11", name: "سالم عبدالله القحطاني", iban: fakeIban(1001), expected: 450000 },
  { eid: "902", jisrNo: "12", name: "Ahmed Raza Khan", iban: fakeIban(1002), expected: 380050 },
  { eid: "903", jisrNo: "13", name: "محمد يوسف الشمري", iban: fakeIban(1003), expected: 520000 },
  { eid: "904", jisrNo: "14", name: "Rahul Kumar Singh", iban: fakeIban(1004), expected: 300000 },
  { eid: "905", jisrNo: "15", name: "فهد ناصر الدوسري", iban: fakeIban(1005), expected: 610000 },
];

const HEADER = ["اسم المستفيد", "رقم الآيبان", "المبلغ", "رقم المرجع", "تاريخ التحويل", "البنك"];
const row = (name, iban, amount, ref, date = "2026-11-02", bank = "بنك تجريبي") => [name, iban, amount, ref, date, bank];

function csv(rows) {
  return Buffer.from("﻿" + rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\r\n"), "utf8");
}

function xlsx(rows) {
  return buildXlsx(rows);
}

/* PDF بطبقة نصّ عبر pdfmake (اعتماد قائم). بخطّ Roboto الافتراضي غير
   متاح هنا، فنستعمل خطّ المشروع. النصوص لاتينية/أرقام كي تبقى القراءة
   حتمية. */
async function pdf(rows, { scanned = false } = {}) {
  const PdfPrinter = require("pdfmake/src/printer");
  const font = path.join(__dirname, "..", "..", "assets", "fonts", "thmanyah-sans-400.ttf");
  const printer = new PdfPrinter({ T: { normal: font, bold: font, italics: font, bolditalics: font } });
  const content = scanned
    ? [{ canvas: [{ type: "rect", x: 0, y: 0, w: 400, h: 300, color: "#dddddd" }] }]
    : [{ text: "Payroll transfer report", margin: [0, 0, 0, 10] },
       { table: { body: pad(rows) }, layout: "noBorders" }];
  const doc = printer.createPdfKitDocument({ defaultStyle: { font: "T", fontSize: 8 }, pageOrientation: "landscape", content });
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/* pdfmake يشترط صفوفًا متساوية الطول. */
function pad(rows) {
  const w = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r.map((c) => String(c)), ...Array(w - r.length).fill("")]);
}

const PDF_HEADER = ["Beneficiary Name", "IBAN", "Amount", "Reference", "Value Date", "Bank"];

module.exports = { fakeIban, EMPLOYEES, HEADER, PDF_HEADER, row, csv, xlsx, pdf };
