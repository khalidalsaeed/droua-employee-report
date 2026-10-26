const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const QRCode = require("qrcode");

const { extractMunicipalCard, glyphCodepoints } = require("../lib/municipal/extractCard");
const { extractQrTextFromPdf } = require("../lib/pdf/qrFromPdf");
const cards = require("../lib/data/municipalCards");
const { SECTION_BY_KEY, defaultPermissionsForRole } = require("../lib/auth/permissions");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* البطاقات البلدية: المستخرِج، وحرّاس الخصوصية، والواجهة.
   لا شهادة حقيقية في المستودع (هو عامّ) ولا في هذه الاختبارات: الـPDF هنا
   مبنيّ اصطناعيًّا بالبنية نفسها التي تُصدرها الأمانة — خطّ Identity-H
   بجدول cmap يعيد النصّ، وخلايا قصّ (قيمة ثم عنوانها)، ورمز QR بقناع
   لوني، وصورة JPEG. الأسماء والأرقام مخترعة. */

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
  add(`<< /Type /Pages /Kids [ ${kids.map((k) => `${k} 0 R`).join(" ")} ] /Count ${kids.length} >>`);

  const parts = [Buffer.from("%PDF-1.3\n", "latin1")];
  objs.forEach((o, i) => {
    parts.push(Buffer.from(`${i + 1} 0 obj\n${o.body}\n`, "latin1"));
    if (o.stream) parts.push(Buffer.from("stream\n", "latin1"), o.stream, Buffer.from("\nendstream\n", "latin1"));
    parts.push(Buffer.from("endobj\n", "latin1"));
  });
  parts.push(Buffer.from("trailer\n<< >>\n%%EOF\n", "latin1"));
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

test("المستخرِج يقرأ كل حقول الشهادة ورمزها وصورتها", () => {
  const pdf = buildCertificate({ rows: [...ROWS, ["عامل مخزن", "المهنة"]], qrText: QR_TEXT, jpeg: JPEG });
  const r = extractMunicipalCard(pdf);
  assert.equal(r.ok, true, r.reason);
  const c = r.card;
  assert.equal(c.certNo, "10001-1447");
  assert.equal(c.idNumber, "2500000001");
  assert.equal(c.name, "سالم مراد");
  assert.equal(c.issuer, "أمانة مدينة الرياض");
  assert.equal(c.gender, "ذكر");
  assert.equal(c.nationality, "بنغلاديش");
  assert.equal(c.occupation, "عامل مخزن");
  assert.equal(c.expiryHijri, "1448-07-19");
  assert.equal(c.expiryDate, "2026-12-28"); // أم القرى
  assert.equal(c.qrText, QR_TEXT);
  assert.ok(Buffer.isBuffer(c.photo) && c.photo[0] === 0xff && c.photo[1] === 0xd8);
});

test("قيمة تلتفّ إلى الصفحة التالية تُجمع بسطورها", () => {
  const pdf = buildCertificate({ rows: ROWS, page2: [["عامل تنظيف مكاتب\nومنشآت", "المهنة"]], qrText: QR_TEXT });
  const r = extractMunicipalCard(pdf);
  assert.equal(r.ok, true);
  assert.equal(r.card.occupation, "عامل تنظيف مكاتب ومنشآت");
});

test("حقل غائب يُترك غائبًا ولا يكسر القراءة", () => {
  const pdf = buildCertificate({ rows: ROWS.filter((r) => r[1] !== "الجنسية"), qrText: QR_TEXT });
  const r = extractMunicipalCard(pdf);
  assert.equal(r.ok, true);
  assert.equal(r.card.nationality, undefined);
  assert.equal(r.card.photo, undefined);
});

test("ملفّ بلا رقم شهادة أو هوية يُرفض بسبب واضح", () => {
  const pdf = buildCertificate({ rows: ROWS.filter((r) => r[1] !== "رقم الهوية"), qrText: QR_TEXT });
  assert.equal(extractMunicipalCard(pdf).reason, "not_a_municipal_card");
  assert.equal(extractMunicipalCard(Buffer.from("hello")).reason, "not_pdf");
});

test("رمز QR بقناع لوني يُقرأ (كان يُقرأ أسود بالكامل)", () => {
  const pdf = buildCertificate({ rows: ROWS, qrText: QR_TEXT });
  assert.equal(extractQrTextFromPdf(pdf), QR_TEXT);
});

test("جدول cmap يُعكس إلى معرّف ← حرف", () => {
  const m = glyphCodepoints(makeFont([0x0627, 0xfee3]));
  assert.equal(m.get(10), 0x0627);
  assert.equal(m.get(11), 0xfee3);
});

/* ─── الخصوصية ─── */
test("JSON البطاقة لا يحمل رابط الرمز ولا الصورة", () => {
  const item = cards.toItem({
    cert_no: "10001-1447", id_number: "2500000001", qr_text: "https://secret", photo_b64: "AAAA",
    has_qr: true, has_photo: true, photo_sha256: "ab".repeat(32), expiry_date: "2026-12-28",
  });
  const json = JSON.stringify(item);
  assert.ok(!json.includes("secret") && !json.includes("AAAA"));
  assert.equal(item.hasQr, true);
  assert.equal(item.photoVersion.length, 12);
});

test("لا إنشاء ولا تعديل حرّ عبر /api/data — الرفع وحده يكتب", async () => {
  await assert.rejects(cards.create({ certNo: "1-1" }));
  await assert.rejects(cards.update("1-1", {}));
});

test("الصلاحيات: قسم municipal، وHR يرفع، والقارئ يعرض فقط", () => {
  assert.deepEqual(SECTION_BY_KEY.municipal.actions, ["view", "create", "delete"]);
  assert.ok(defaultPermissionsForRole("hr").includes("municipal:create"));
  assert.ok(defaultPermissionsForRole("viewer").includes("municipal:view"));
  assert.ok(!defaultPermissionsForRole("viewer").includes("municipal:create"));
  assert.ok(!defaultPermissionsForRole("finance").includes("municipal:view"));
});

test("مسارات الملفّات تفحص الصلاحية ولا تخزّن الملفّ", () => {
  const app = read("api/app.js");
  const fn = (name) => app.slice(app.indexOf(`async function ${name}`), app.indexOf("\n}\n", app.indexOf(`async function ${name}`)));
  assert.match(fn("filesMunicipalCard"), /hasPermission\(actor, "municipal", "create"\)/);
  assert.match(fn("filesMunicipalQr"), /hasPermission\(actor, "municipal", "view"\)/);
  assert.match(fn("filesMunicipalPhoto"), /hasPermission\(actor, "municipal", "view"\)/);
  assert.doesNotMatch(fn("filesMunicipalCard"), /uploadFile\(/);
  assert.match(fn("filesMunicipalQr"), /private/);
});

test("الواجهة: القسم بعد أجير، محروس، والسكربت والأنماط محمّلة", () => {
  const shell = read("app-shell.html");
  assert.match(shell, /municipalSec:"municipal"/);
  assert.match(shell, /<script src="\/municipal-cards\.js\?v=\d+"><\/script>/);
  assert.match(shell, /href="\/municipal-cards\.css\?v=\d+"/);
  assert.match(shell, /AdminUI\.can\("municipal","view"\)\) MunicipalCards\.mount/);
  const js = read("municipal-cards.js");
  assert.doesNotMatch(js, /qrText/); // نصّ الرمز لا يصل إلى المتصفّح
});
