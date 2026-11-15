/* تصريح أجير اصطناعي للاختبارات والمعاينة المحلية — لا بيانات حقيقية.
   =========================================================================
   مبنيّ بـpdfmake (اعتمادية قائمة) بتخطيط تصريح أجير نفسه: العنوان، ورقم
   التصريح أعلى اليسار فوق «امسح للتحقق»، وكل قيمة يسار عنوانها على السطر
   نفسه، ورمز QR صورةً سوداء نمطُها في قناع شفافية (SMask) كما يُصدرها أجير.
   الأسماء والأرقام والروابط مخترعة. */
const path = require("path");
const QRCode = require("qrcode");

const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");
const FONTS = {
  Thmanyah: {
    normal: path.join(FONT_DIR, "thmanyah-sans-400.ttf"),
    bold: path.join(FONT_DIR, "thmanyah-sans-700.ttf"),
    italics: path.join(FONT_DIR, "thmanyah-sans-400.ttf"),
    bolditalics: path.join(FONT_DIR, "thmanyah-sans-700.ttf"),
  },
};

const officialQr = (permitNo) => `https://ajeer.qiwa.sa/notice-verification/TEST-${permitNo}.eyJ0ZXN0Ijp0cnVlfQ.sig`;

/* PNG أسود بشفافية: نمط الرمز في قناة ألفا (يُصبح SMask في الـPDF). */
async function qrPngDataUrl(text) {
  const png = await QRCode.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 0, scale: 3, color: { dark: "#000000ff", light: "#00000000" } });
  return `data:image/png;base64,${png.toString("base64")}`;
}

/* PAGE: A4 595×842pt. pdfmake يقيس من الأعلى، فالسطر y (من الأسفل) = 842 − top. */
async function buildAjeerPermit(o = {}) {
  const p = {
    permitNo: "TQ9900001",
    name: "TEST WORKER ONE",
    occupation: "عامل تحميل وتنزيل",
    nationality: "بنجلاديشي",
    idNumber: "2999000001",
    startDate: "2026-11-02",
    endDate: "2026-12-02",
    title: "تصريح أجير – تعاقد أجير",
    ...o,
  };
  if (p.qrText === undefined) p.qrText = officialQr(p.permitNo);
  const PdfPrinter = require("pdfmake/src/printer");
  const printer = new PdfPrinter(FONTS);
  const { arLine } = require("../../lib/reports/arabicText");
  const at = (text, x, top, size) => ({ text: /[\u0600-\u06FF]/.test(String(text)) ? arLine(String(text)) : String(text), absolutePosition: { x, y: top }, fontSize: size || 9 });
  const rows = [];
  const row = (top, value, valueX, label, labelX) => {
    if (value != null) rows.push(at(value, valueX, top));
    rows.push(at(label, labelX, top));
  };
  if (p.title) rows.push(at(p.title, 203, 70, 13));
  if (p.permitNo) rows.push(at(p.permitNo, 75, 92, 9));
  rows.push(at("امسح للتحقق", 79, 102, 7));
  rows.push(at("بيانات العامل", 281, 205, 10));
  row(228, p.occupation, 108, "المهنة", 278);
  row(228, p.name, 377, "اسم العامل", 505);
  row(247, p.nationality, 138, "الجنسية", 272);
  row(247, p.idNumber, 374, "رقم الهوية / الإقامة", 476);
  rows.push(at("بيانات التصريح", 279, 377, 10));
  row(418, p.endDate, 131, "تاريخ نهاية التصريح", 234);
  row(418, p.startDate, 378, "تاريخ بداية التصريح", 482);
  const content = [...rows];
  if (p.qrText) content.push({ image: await qrPngDataUrl(p.qrText), width: 66, absolutePosition: { x: 70, y: 18 } });
  const doc = printer.createPdfKitDocument({
    pageSize: "A4", pageMargins: [0, 0, 0, 0], defaultStyle: { font: "Thmanyah" }, content,
    info: { title: "synthetic-ajeer-permit" },
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

module.exports = { buildAjeerPermit, officialQr };
