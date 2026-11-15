/* شهادة صحية اصطناعية (بنية ملفّ الأمانة) للاختبارات والمعاينة المحلية.
   منقولة كما هي من test/municipal-cards.test.js لتُشارَك مع اختبارات التجديد.
   الأسماء والأرقام والروابط مخترعة — لا شهادة حقيقية. */
const zlib = require("node:zlib");
const QRCode = require("qrcode");

/* ─── خطّ TrueType أدنى: جدول cmap (صيغة 4) وحده ─── */
function makeFont(cps) {
  // gid = 10 + index
  const segs = cps.map((cp, i) => ({ start: cp, end: cp, delta: (10 + i - cp) & 0xffff }))
    .sort((a, b) => a.start - b.start);
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const n = segs.length;
  const sub = Buffer.alloc(16 + n * 8);
  sub.writeUInt16BE(4, 0); sub.writeUInt16BE(sub.length, 2); sub.writeUInt16BE(n * 2, 6);
  segs.forEach((s, i) => {
    sub.writeUInt16BE(s.end, 14 + i * 2);
    sub.writeUInt16BE(s.start, 16 + n * 2 + i * 2);
    sub.writeUInt16BE(s.delta, 16 + n * 4 + i * 2);
    sub.writeUInt16BE(0, 16 + n * 6 + i * 2);
  });
  const cmap = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]), sub]);
  const head = Buffer.alloc(12 + 16);
  head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(1, 4);
  head.write("cmap", 12, "latin1"); head.writeUInt32BE(28, 20); head.writeUInt32BE(cmap.length, 24);
  return Buffer.concat([head, cmap]);
}

/* نصّ منطقي → معرّفات الحروف بترتيب العرض (من اليسار)، كما في الشهادة. */
function glyphHex(text, cps) {
  return [...text].reverse().map((ch) => (10 + cps.indexOf(ch.codePointAt(0))).toString(16).padStart(4, "0")).join("");
}

function makeQrImage(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size, scale = 6, quiet = 4, w = (size + quiet * 2) * scale;
  const raw = Buffer.alloc(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet;
    const dark = mx >= 0 && my >= 0 && mx < size && my < size && qr.modules.get(mx, my);
    /* الخلفية بلون المفتاح (0,0,1) — يقرؤها مَن يتجاهل القناع سوداء. */
    const o = (y * w + x) * 3;
    raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = dark ? 0 : 1;
  }
  return { w, data: zlib.deflateSync(raw) };
}

function buildCertificate({ rows, qrText, jpeg, page2 }) {
  const allText = rows.flat().concat(page2 ? page2.flat() : []).filter((t) => !/^[\d/ -]+$/.test(t)).join("");
  const cps = [...new Set([...allText].map((c) => c.codePointAt(0)))];
  const font = zlib.deflateSync(makeFont(cps));
  const cell = (text) => /^[\d/ -]+$/.test(text)
    ? `q 0 0 80 13 re W n\nBT /F6 7.0 Tf 10 10 Td (${text}) Tj T* ET\nQ\n`
    : `q 0 0 80 13 re W n\n${text.split("\n").map((l) => `BT /F8 7.0 Tf 10 10 Td <${glyphHex(l, cps)}>Tj T* ET`).join("\n")}\nQ\n`;
  const content = (list) => list.map(([value, label]) => (value != null ? cell(value) : "") + cell(label)).join("");
  const qr = makeQrImage(qrText);

  const objs = [];
  const add = (body, stream) => { objs.push({ body, stream }); return objs.length; };
  const fontFile = add(`<< /Filter /FlateDecode /Length ${font.length} >>`, font);
  const desc = add(`<< /Type /FontDescriptor /FontName /ABCDEE+Test /FontFile2 ${fontFile} 0 R >>`);
  const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEE+Test /FontDescriptor ${desc} 0 R >>`);
  const f8 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEE+Test /Encoding /Identity-H /DescendantFonts [${cid} 0 R] >>`);
  const f6 = add(`<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEE+Latin /Encoding /WinAnsiEncoding >>`);
  const qrObj = add(`<< /Type /XObject /Subtype /Image /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Mask [0 0 0 0 1 1] /Width ${qr.w} /Height ${qr.w} /Length ${qr.data.length} >>`, qr.data);
  const imgObj = jpeg ? add(`<< /Type /XObject /Subtype /Image /BitsPerComponent 8 /Filter /DCTDecode /ColorSpace /DeviceRGB /Width 8 /Height 6 /Length ${jpeg.length} >>`, jpeg) : null;
  const c1 = Buffer.from(content(rows), "latin1");
  const c1o = add(`<< /Length ${c1.length} >>`, c1);
  const pagesId = objs.length + 1 + (page2 ? 3 : 1);
  const res = `/Font << /F6 ${f6} 0 R /F8 ${f8} 0 R >>`;
  const xo = `/XObject << /Im5 ${qrObj} 0 R${imgObj ? ` /Im4 ${imgObj} 0 R` : ""} >>`;
  const p1 = add(`<< /Type /Page /Parent ${pagesId} 0 R /Contents ${c1o} 0 R /Resources << ${xo} ${res} >> >>`);
  const kids = [p1];
  if (page2) {
    const c2 = Buffer.from(content(page2), "latin1");
    const c2o = add(`<< /Length ${c2.length} >>`, c2);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /Contents ${c2o} 0 R /Resources << ${res} >> >>`));
  }
  add(`<< /Type /Pages /Kids [ ${kids.map((k) => `${k} 0 R`).join(" ")} ] /Count ${kids.length} /MediaBox [0 0 151 238] >>`);

  /* جدول xref وكتالوج حقيقيان: يكفيان pdf.js لرسم الصفحة (التجديد يرسم
     وجه البطاقة)، ولا يغيّران شيئًا للمستخرِج الذي يقرأ الكائنات مباشرةً. */
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const parts = [Buffer.from("%PDF-1.3\n", "latin1")];
  const offsets = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(len);
    const chunk = [Buffer.from(`${i + 1} 0 obj\n${o.body}\n`, "latin1")];
    if (o.stream) chunk.push(Buffer.from("stream\n", "latin1"), o.stream, Buffer.from("\nendstream\n", "latin1"));
    chunk.push(Buffer.from("endobj\n", "latin1"));
    const b = Buffer.concat(chunk);
    parts.push(b);
    len += b.length;
  });
  const xref = ["xref", `0 ${objs.length + 1}`, "0000000000 65535 f "].concat(offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `)).join("\n");
  parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${len}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(40, 0x41), Buffer.from([0xff, 0xd9])]);
const QR_TEXT = "https://eservices.alriyadh.gov.sa/DownloadFile?ABC123";
const ROWS = [
  ["10001-1447", "رقم الشهادة"],
  ["أمانة مدينة الرياض", "مكان الاصدار"],
  ["19/07/1448", "نهاية الصلاحية"],
  ["سالم ﻣﺮاد", "الاسم"], // presentation forms: NFKC must fold them back
  ["2500000001", "رقم الهوية"],
  ["ذكر", "الجنس"],
  ["بنغلاديش", "الجنسية"],
];

/* صفوف الشهادة مع تغيير حقول بعينها: { certNo, expiryHijri, name, idNumber }. */
function rowsWith({ certNo, expiryHijri, name, idNumber, occupation } = {}) {
  const out = ROWS.map((r) => {
    if (certNo && r[1] === "رقم الشهادة") return [certNo, r[1]];
    if (expiryHijri && r[1] === "نهاية الصلاحية") return [expiryHijri, r[1]];
    if (name && r[1] === "الاسم") return [name, r[1]];
    if (idNumber && r[1] === "رقم الهوية") return [idNumber, r[1]];
    return r;
  });
  if (occupation) out.push([occupation, "المهنة"]);
  return out;
}

module.exports = { makeFont, glyphHex, makeQrImage, buildCertificate, rowsWith, JPEG, QR_TEXT, ROWS };
