const path = require("node:path");

/* ملفّات إجازة مرضية اصطناعية للاختبار — تُبنى في الذاكرة عند التشغيل ولا
   تُحفظ في المستودع. التخطيط يحاكي تقرير «صحة»: جدول من ثلاثة أعمدة (العنوان
   الإنجليزي، القيمة، العنوان العربي). الأسماء والأرقام مخترعة. */

const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");
const FONTS = { Thmanyah: { normal: path.join(FONT_DIR, "thmanyah-sans-400.ttf"), bold: path.join(FONT_DIR, "thmanyah-sans-700.ttf") } };

const DEFAULT = {
  leaveId: "GSL25091234567",
  idNumber: "2456789012",
  name: "AHMED MOHAMMED ALI",
  start: "15-09-2026",
  end: "17-09-2026",
  days: "3",
  issueDate: "15-09-2026",
  nationality: "Egypt",
  employer: "Test Trading Co",
  practitioner: "Dr. Sara Khalid",
  position: "Consultant",
  facility: "Test General Hospital",
};

function buildDoc(fields, opts = {}) {
  const f = { ...DEFAULT, ...fields };
  const row = (en, value, ar) => [{ text: en, bold: true }, { text: value == null ? "" : String(value) }, { text: ar }];
  const rows = [];
  if (f.leaveId != null) rows.push(row("Leave ID", f.leaveId, "رمز الإجازة"));
  if (f.start != null) rows.push(row("Leave Duration", `${f.days} day ( ${f.start} to ${f.end} )`, "مدة الإجازة"));
  if (f.start != null) rows.push(row("Admission Date", f.start, "تاريخ الدخول"));
  if (f.end != null) rows.push(row("Discharge Date", f.end, "تاريخ الخروج"));
  rows.push(row("Issue Date", f.issueDate, "تاريخ إصدار التقرير"));
  rows.push(row("Name", f.name, "الاسم"));
  if (f.idNumber != null) rows.push(row("National ID / Iqama", f.idNumber, "رقم الهوية / الإقامة"));
  rows.push(row("Nationality", f.nationality, "الجنسية"));
  rows.push(row("Employer", f.employer, "جهة العمل"));
  rows.push(row("Practitioner Name", f.practitioner, "اسم الممارس"));
  rows.push(row("Position", f.position, "المسمى الوظيفي"));
  const content = [];
  if (!opts.notSickLeave) content.push({ text: "Sick Leave Report", fontSize: 16, bold: true, margin: [0, 0, 0, 4] });
  content.push({ text: f.facility, margin: [0, 0, 0, 12] });
  if (opts.notSickLeave) content.push({ text: "Invoice 2026-118 for consulting services. Total due 4,500 SAR." });
  else content.push({ table: { widths: [130, "*", 120], body: rows } });
  return { content, defaultStyle: { font: "Thmanyah", fontSize: 10 } };
}

function makeSickLeavePdf(fields, opts) {
  const PdfPrinter = require("pdfmake/src/printer");
  const printer = new PdfPrinter(FONTS);
  const doc = printer.createPdfKitDocument(buildDoc(fields, opts));
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/* PDF صالح البنية بلا طبقة نصّ — يحاكي ملفًّا ممسوحًا ضوئيًا. */
function makeScannedPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>",
  ];
  const stream = "0 0 0 rg 50 50 100 100 re f";
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  offsets.push(out.length);
  out += `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  const xref = out.length;
  out += `xref\n0 5\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

module.exports = { makeSickLeavePdf, makeScannedPdf, DEFAULT };
