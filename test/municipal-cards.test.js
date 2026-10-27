const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const QRCode = require("qrcode");

const { extractMunicipalCard, glyphCodepoints } = require("../lib/municipal/extractCard");
const { extractQrTextFromPdf, extractQrImageFromPdf } = require("../lib/pdf/qrFromPdf");
const cards = require("../lib/data/municipalCards");
const store = require("../lib/municipal/store");
const { matchCards } = require("../lib/municipal/match");
const { readCards, parseArgs } = require("../scripts/import-municipal-cards");
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

test("صورة الرمز الأصلية تُستخرج كما هي مع نصّها", () => {
  const pdf = buildCertificate({ rows: ROWS, qrText: QR_TEXT });
  const found = extractQrImageFromPdf(pdf);
  assert.equal(found.text, QR_TEXT);
  assert.equal(found.rgba.length, found.width * found.height * 4);
});

test("الرمز المخزَّن: بكسلات الأصل نفسها + هامش أبيض، ويُقرأ إلى الرابط نفسه", (t) => {
  let render;
  try { require("@napi-rs/canvas"); render = require("../lib/municipal/render"); } catch { t.skip("@napi-rs/canvas غير متاح"); return; }
  const qr = render.originalQrPng(buildCertificate({ rows: ROWS, qrText: QR_TEXT }));
  assert.equal(qr.pixelsIdentical, true);
  assert.equal(qr.roundTrip, QR_TEXT);
  assert.ok(qr.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
});

/* ─── المطابقة: رقم الإقامة → eid، بلا أسماء ─── */
const EMPLOYEES = [
  { eid: "501", iqama: "2500000001", name: "سالم مراد" },
  { eid: "502", iqama: "2500000002", name: "خالد" },
  { eid: "503", iqama: "2500000002", name: "خالد (مكرّر)" },
  { eid: "504", iqama: "2500000004", name: "سالم مراد" },
];
const card = (certNo, idNumber, name) => ({ certNo, idNumber, name });

test("المطابقة برقم الإقامة: matched / ambiguous / unmatched", () => {
  const { items, summary } = matchCards([
    card("1-1447", "2500000001", "سالم مراد"),
    card("2-1447", "2500000002", "خالد"),
    card("3-1447", "2599999999", "سالم مراد"), // الاسم مطابق لموظفَين — لا يكفي
  ], EMPLOYEES, {});
  assert.deepEqual(summary, { total: 3, matched: 1, ambiguous: 1, unmatched: 1 });
  assert.equal(items[0].eid, "501");
  assert.equal(items[1].status, "ambiguous");
  assert.deepEqual(items[1].candidates.map((e) => e.eid), ["502", "503"]);
  assert.equal(items[2].status, "unmatched");
});

test("التأكيد اليدوي يربط ambiguous بـeid موجود فقط", () => {
  const ok = matchCards([card("2-1447", "2500000002")], EMPLOYEES, { "2-1447": "503" });
  assert.equal(ok.items[0].status, "matched");
  assert.equal(ok.items[0].via, "assigned");
  const bad = matchCards([card("2-1447", "2500000002")], EMPLOYEES, { "2-1447": "999" });
  assert.equal(bad.items[0].status, "invalid_assignment");
  assert.equal(bad.items[0].eid, null);
});

test("بطاقتان لموظف واحد في الدفعة: الاثنتان ambiguous", () => {
  const r = matchCards([card("1-1447", "2500000001"), card("9-1447", "2500000001")], EMPLOYEES, {});
  assert.equal(r.summary.ambiguous, 2);
});

test("الاستيراد: الملفّ المكرّر والشهادة الأقدم للهوية نفسها لا يُعتمدان", () => {
  const older = buildCertificate({ rows: ROWS.map((r) => (r[1] === "نهاية الصلاحية" ? ["19/07/1447", r[1]] : r)), qrText: QR_TEXT });
  const newer = buildCertificate({ rows: ROWS, qrText: QR_TEXT });
  const rows = readCards([{ name: "a.pdf", bytes: older }, { name: "b.pdf", bytes: newer }, { name: "c.pdf", bytes: newer }]);
  assert.equal(rows[0].reason, "superseded_by_newer_certificate");
  assert.equal(rows[1].ok, true);
  assert.equal(rows[2].reason, "duplicate_file");
  assert.deepEqual(parseArgs(["dir", "--assign", "10001-1447=503", "--apply"]).assign, { "10001-1447": "503" });
  assert.throws(() => parseArgs(["dir", "--assign", "سالم=503"]));
});

/* ─── المتجر الخاصّ ─── */
const hex = (n, c) => c.repeat(n);
const ENTRY = {
  cardId: hex(16, "a"), employeeEid: "501", certificateNumber: "10001-1447", issuePlace: "أمانة مدينة الرياض",
  expiryDate: "2026-12-28", expiryHijri: "1448-07-19", nameOnCard: "سالم مراد", occupation: "عامل مخزن",
  cardKey: `municipal-cards/card/${hex(32, "b")}.png`, cardSha256: hex(64, "c"),
  qrKey: `municipal-cards/qr/${hex(32, "d")}.png`, qrSha256: hex(64, "e"), qrTarget: "https://secret.example/DownloadFile?X",
  sourceFileHash: hex(64, "f"), createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
};

test("الفهرس: المدخل الصالح يمرّ، والتالف يسقط", () => {
  assert.ok(store.validEntry(ENTRY));
  assert.equal(store.validEntry({ ...ENTRY, cardKey: "../../etc/passwd" }), null);
  assert.equal(store.validEntry({ ...ENTRY, employeeEid: "سالم" }), null);
  assert.equal(store.validEntry({ ...ENTRY, cardId: "x" }), null);
  const idx = store.parseIndex(JSON.stringify({ version: 1, cards: [ENTRY, { bad: true }] }));
  assert.equal(idx.cards.length, 1);
  assert.equal(store.entryById(idx, ENTRY.cardId).certificateNumber, "10001-1447");
  assert.equal(store.entryById(idx, "../x"), null);
});

/* يقبل دالّة متزامنة أو async، ولا يستعيد البيئة قبل أن تنتهي. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

test("المتجر: لا متجر أجير ولا المراجعة ولا الصور، ولا عمل بلا OIDC", () => {
  const base = { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_AJEER1_x", DROUA_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_AUDIT1_x", EMPLOYEE_PHOTOS_STORE_ID: "store_PHOTOS1", VERCEL_OIDC_TOKEN: null };
  withEnv({ ...base, MUNICIPAL_CARDS_STORE_ID: "store_AJEER1" }, () => assert.throws(() => store.credentials("t"), /أجير/));
  withEnv({ ...base, MUNICIPAL_CARDS_STORE_ID: "store_AUDIT1" }, () => assert.throws(() => store.credentials("t"), /المراجعة/));
  withEnv({ ...base, MUNICIPAL_CARDS_STORE_ID: "store_PHOTOS1" }, () => assert.throws(() => store.credentials("t"), /صور الموظفين/));
  withEnv({ ...base, MUNICIPAL_CARDS_STORE_ID: "store_CARDS1" }, () => {
    assert.throws(() => store.credentials(""), /OIDC/);
    assert.deepEqual(store.credentials("tok"), { storeId: "CARDS1", oidcToken: "tok" });
  });
  withEnv({ MUNICIPAL_CARDS_STORE_ID: null }, () => assert.equal(store.configured(), false));
});

test("المتجر: الكائن يُرفض إن خالفت بصمته الفهرس، ويُقرأ خاصًّا دائمًا", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("body")]);
  const calls = [];
  const fake = {
    get: async (key, opts) => { calls.push({ key, opts }); return { stream: [png] }; },
  };
  const id = require.resolve("@vercel/blob");
  const saved = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: fake };
  try {
    await withEnv({ MUNICIPAL_CARDS_STORE_ID: "store_CARDS1" }, async () => {
      const good = store.validEntry({ ...ENTRY, cardSha256: store.sha256hex(png) });
      assert.ok((await store.readObject(good, "card", "tok")).equals(png));
      await assert.rejects(store.readObject(store.validEntry(ENTRY), "card", "tok"), /بصمة/);
    });
  } finally {
    if (saved) require.cache[id] = saved; else delete require.cache[id];
  }
  assert.ok(calls.every((c) => c.opts.access === "private" && c.opts.oidcToken === "tok" && !c.opts.token));
});

/* ─── الخصوصية ─── */
test("JSON البطاقة لا يحمل مفاتيح التخزين ولا البصمات ولا رابط الرمز", () => {
  const item = cards.toItem(store.validEntry(ENTRY));
  const json = JSON.stringify(item);
  for (const secret of ["secret.example", "municipal-cards/", hex(64, "c"), hex(64, "f")]) assert.ok(!json.includes(secret), secret);
  assert.equal(item.employeeEid, "501");
  assert.equal(item.hasQr, true);
});

test("لا كتابة عبر /api/data — الاستيراد بالسكربت وحده", async () => {
  await assert.rejects(cards.create({}));
  await assert.rejects(cards.update("x", {}));
  await assert.rejects(cards.remove("x"));
});

test("لا ملفّ بطاقة ولا صورة ولا رابط رمز حقيقي في المستودع", () => {
  const { execSync } = require("node:child_process");
  const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n");
  /* permits/ و payroll/ سابقان لهذه الميزة ولا علاقة لهما بها. */
  assert.deepEqual(tracked.filter((f) => /\.pdf$/i.test(f) && !/^(permits|payroll)\//.test(f)), []);
  assert.deepEqual(tracked.filter((f) => /municipal/i.test(f) && /\.(png|jpe?g|webp|pdf|json)$/i.test(f)), []);
  const code = tracked.filter((f) => /\.(js|html|css|md|json)$/.test(f) && !f.startsWith("node_modules/") && f !== "package-lock.json");
  for (const f of code) assert.doesNotMatch(read(f), /eservices\.alriyadh\.gov\.sa\/DownloadFile\?[0-9A-F]{16}/, f);
});

test("الصلاحيات: municipal للعرض فقط، وFinance بلا وصول", () => {
  assert.deepEqual(SECTION_BY_KEY.municipal.actions, ["view"]);
  assert.ok(defaultPermissionsForRole("hr").includes("municipal:view"));
  assert.ok(defaultPermissionsForRole("viewer").includes("municipal:view"));
  assert.ok(!defaultPermissionsForRole("finance").includes("municipal:view"));
});

test("المسارات تفحص municipal:view وتقرأ من المتجر الخاصّ بـOIDC الطلب", () => {
  const app = read("api/app.js");
  const fn = (name) => app.slice(app.indexOf(`async function ${name}`), app.indexOf("\n}\n", app.indexOf(`async function ${name}`)));
  assert.match(fn("handleMunicipalCards"), /hasPermission\(actor, "municipal", "view"\)/);
  assert.match(fn("handleMunicipalCards"), /x-vercel-oidc-token/);
  assert.match(fn("filesMunicipalObject"), /hasPermission\(actor, "municipal", "view"\)/);
  assert.match(fn("filesMunicipalObject"), /private, max-age/);
  assert.doesNotMatch(app, /municipal-card"\)|upsertExtracted|uploadFile\([^)]*municipal/);
  /* الرسم لا يدخل الدالّة الخادمة. */
  assert.doesNotMatch(app, /municipal\/render|@napi-rs\/canvas/);
});

test("الواجهة: البطاقة الأصلية، الربط بـeid، ولا رابط رمز في المتصفّح", () => {
  const shell = read("app-shell.html");
  assert.match(shell, /municipalSec:"municipal"/);
  assert.match(shell, /<script src="\/municipal-cards\.js\?v=\d+"><\/script>/);
  assert.match(shell, /href="\/municipal-cards\.css\?v=\d+"/);
  assert.match(shell, /AdminUI\.can\("municipal","view"\)\) MunicipalCards\.mount/);
  const js = read("municipal-cards.js");
  assert.match(js, /\/api\/files\/municipal-card-image\?id=/);
  assert.match(js, /e\[o\.F\.damanah\]\) === String\(item\.employeeEid\)/);
  assert.doesNotMatch(js, /qrTarget|qrText/);
});
