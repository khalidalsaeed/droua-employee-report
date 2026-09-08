/* كاتب PDF أدنى ما يكفي — لبناء عيّنات مُعقَّمة بالكود.
   =========================================================================
   لماذا كاتب خاصّ ولا مكتبة: العيّنة يجب أن تُعيد بنية المستند الحقيقي
   حرفيًا — إحداثي كل عنصر نصّي كما قيسَ من المستند الأصلي. و pdfmake
   يبني تخطيطًا بقواعده لا بإحداثياتنا، و pdf-lib لم يُضَف إلى المشروع
   (ولن يُضاف قبل 2.4). فتُكتب بنية PDF مباشرةً: مصفوفة Tm صريحة لكل
   عنصر، فيصل إلى pdfjs بالإحداثي المقصود بالضبط.

   الخطّ Helvetica قياسي بلا تضمين — فالعيّنات لاتينية، وهو قرار معتمد:
   الحقول الحاسمة في الإيصال (IBAN · المبلغ · SAR · الاسم اللاتيني) كلّها
   غير عربية، والوسوم العربية تعزيزٌ لا أساس. فعيّنة لاتينية تغطّي ما
   يقوم عليه الربط، وتُبقي المستودع خاليًا من أي بيان هوية.

   مشترك بين payroll-sheet.js و receipts.js: نسختان من كاتب PDF
   تتباعدان، وأي تباعد يعني عيّنتين ببنيتين مختلفتين تُخفيان عطلًا. */

/* المحارف التي تحمل معنى في مجرى المحتوى وتحتاج هروبًا. */
const escapeText = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);

/* عنصر نصّي واحد بمصفوفة Tm صريحة — هي ما يقرؤه pdfjs في
   item.transform[4] و [5]. */
function textOp(x, y, s, size = 9) {
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapeText(s)}) Tj ET`;
}

/* يبني PDF من مصفوفة مجاري محتوى — مجرى لكل صفحة.
   الترقيم: 1 catalog · 2 pages · ثم (page, content) لكل صفحة · ثم الخطّ. */
function buildPdf(pageContents, { width = 595, height = 842 } = {}) {
  const n = pageContents.length;
  if (!n) throw new Error("لا صفحات");
  const fontObj = 3 + n * 2;
  const objects = new Array(fontObj);

  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${3 + i * 2} 0 R`);

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
  for (let i = 0; i < n; i++) {
    const pageObj = 3 + i * 2;
    objects[pageObj - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${pageObj + 1} 0 R >>`;
    const c = pageContents[i];
    objects[pageObj] = `<< /Length ${Buffer.byteLength(c, "latin1")} >>\nstream\n${c}\nendstream`;
  }
  objects[fontObj - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

module.exports = { buildPdf, textOp, escapeText };
