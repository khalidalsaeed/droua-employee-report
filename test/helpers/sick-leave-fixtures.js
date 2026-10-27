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

/* ─── أشكال PDF من مولّدات أخرى ─── */

const zlib = require("node:zlib");

/* PDF 1.5 بأسلوب مولّدات الجوال: الكائنات داخل Object Stream، وجدول الإحالة
   xref stream مضغوط، والمحتوى FlateDecode، والخطّ Helvetica القياسي. */
function makeMobileStylePdf(fields = {}) {
  const f = { ...DEFAULT, ...fields };
  const lines = [
    "Sick Leave Report",
    `Leave ID ${f.leaveId}`,
    `Leave Duration ${f.days} day ( ${f.start} to ${f.end} )`,
    `Admission Date ${f.start}`,
    `Discharge Date ${f.end}`,
    `Name ${f.name}`,
    `National ID / Iqama ${f.idNumber}`,
  ];
  /* كل سطر: العنوان عنصر والقيمة عنصر على السطر نفسه، كما في التقرير. */
  const esc = (t) => t.replace(/[\\()]/g, (c) => "\\" + c);
  let y = 780;
  const ops = [];
  const labels = ["Leave ID", "Leave Duration", "Admission Date", "Discharge Date", "Name", "National ID / Iqama"];
  for (const l of lines) {
    const label = labels.find((x) => l.startsWith(x + " "));
    if (label) {
      ops.push(`BT /F1 10 Tf 40 ${y} Td (${esc(label)}) Tj ET`);
      ops.push(`BT /F1 10 Tf 200 ${y} Td (${esc(l.slice(label.length + 1))}) Tj ET`);
    } else ops.push(`BT /F1 14 Tf 40 ${y} Td (${esc(l)}) Tj ET`);
    y -= 22;
  }
  const content = zlib.deflateSync(Buffer.from(ops.join("\n"), "latin1"));
  const inObjStm = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  };
  const ids = Object.keys(inObjStm).map(Number);
  let header = "", body = "";
  for (const id of ids) { header += `${id} ${body.length} `; body += inObjStm[id] + "\n"; }
  const objStm = zlib.deflateSync(Buffer.from(header + body, "latin1"));

  const parts = [Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let pos = parts[0].length;
  const offsets = {};
  const push = (id, dict, stream) => {
    offsets[id] = pos;
    const b = Buffer.concat([Buffer.from(`${id} 0 obj\n${dict}\nstream\n`, "latin1"), stream, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    parts.push(b); pos += b.length;
  };
  push(4, `<< /Length ${content.length} /Filter /FlateDecode >>`, content);
  push(6, `<< /Type /ObjStm /N ${ids.length} /First ${header.length} /Length ${objStm.length} /Filter /FlateDecode >>`, objStm);
  /* xref stream: W [1 4 2] — النوع 1 = إزاحة، النوع 2 = داخل Object Stream. */
  const rows = [];
  const row = (t, a, b) => { const r = Buffer.alloc(7); r[0] = t; r.writeUInt32BE(a, 1); r.writeUInt16BE(b, 5); rows.push(r); };
  row(0, 0, 65535);
  for (let id = 1; id <= 7; id++) {
    if (id === 4 || id === 6) row(1, offsets[id], 0);
    else if (id === 7) row(1, pos, 0);
    else row(2, 6, ids.indexOf(id));
  }
  const xref = zlib.deflateSync(Buffer.concat(rows));
  const xrefStart = pos;
  parts.push(Buffer.from(`7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Length ${xref.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), xref,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefStart}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/* تحديث متراكم (incremental update): مراجعة ثانية تُلحَق بآخر الملفّ بجدول
   xref وtrailer يحيل إلى السابق بـ/Prev — كما يفعل أي محرّر يحفظ تعديلًا. */
function appendIncrementalUpdate(pdf) {
  const text = pdf.toString("latin1");
  const prev = Number((text.match(/startxref\s+(\d+)\s+%%EOF\s*$/) || [])[1]);
  const size = Number((text.match(/\/Size\s+(\d+)/g) || []).pop().match(/\d+/)[0]);
  const root = text.match(/\/Root\s+(\d+\s+\d+\s+R)/)[1];
  const id = size;
  const obj = `${id} 0 obj\n<< /Producer (Mobile Editor) /ModDate (D:20261018120000) >>\nendobj\n`;
  const objOffset = pdf.length;
  const xrefOffset = objOffset + obj.length;
  const tail = `xref\n0 1\n0000000000 65535 f \n${id} 1\n${String(objOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${id + 1} /Root ${root} /Info ${id} 0 R /Prev ${prev} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(obj + tail, "latin1")]);
}

module.exports.makeMobileStylePdf = makeMobileStylePdf;
module.exports.appendIncrementalUpdate = appendIncrementalUpdate;
