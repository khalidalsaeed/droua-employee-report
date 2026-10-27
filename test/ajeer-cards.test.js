const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const Module = require("node:module");
const QRCode = require("qrcode");
const jsQRmodule = require("jsqr");

const jsQR = jsQRmodule.default || jsQRmodule;
const { extractQrTextFromPdf, extractQrImageFromPdf, extractQrCompositeFromPdf } = require("../lib/pdf/qrFromPdf");
const view = require("../lib/ajeer/permitView");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* بطاقات تصاريح أجير. لا تصريح حقيقي هنا: الـPDF مبنيّ اصطناعيًّا بالبنية
   التي يُصدرها أجير (mPDF) — رمز QR صورةً RGB سوداء بالكامل، ونمطه في قناع
   ناعم (SMask) رماديّ، وجداول بخطوط أفقية. الرابط والرقم مخترعان. */

const OFFICIAL = "https://ajeer.qiwa.sa/notice-verification/TEST.eyJpZCI6IjAwMDAwMDEifQ.sig";

function qrMask(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size, scale = 3, w = size * scale; // حافّة إلى حافّة، كما في التصريح
  const alpha = Buffer.alloc(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    alpha[y * w + x] = qr.modules.get(Math.floor(x / scale), Math.floor(y / scale)) ? 255 : 0;
  }
  return { w, alpha };
}

function buildPermit({ qrText = OFFICIAL, smask = true } = {}) {
  const { w, alpha } = qrMask(qrText);
  const objs = [];
  const add = (body, stream) => { objs.push({ body, stream }); return objs.length; };
  let xobj;
  if (smask) {
    const maskData = zlib.deflateSync(alpha);
    const black = zlib.deflateSync(Buffer.alloc(w * w * 3, 0));
    const m = add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${w} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${maskData.length} >>`, maskData);
    xobj = add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${w} /SMask ${m} 0 R /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${black.length} >>`, black);
  } else {
    const gray = Buffer.from(alpha.map((a) => 255 - a));
    const data = zlib.deflateSync(gray);
    xobj = add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${w} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`, data);
  }
  /* صفحة A4: الرمز أعلى اليسار، وجداول بخطوط أفقية حتى ~55٪، ثم فقرات. */
  const lines = [];
  for (let y = 700; y >= 380; y -= 32) lines.push(`50 ${y} m 545 ${y} l S`);
  const content = Buffer.from([
    "q 80 0 0 80 60 700 cm /Im1 Do Q",
    "0.6 G 1 w", ...lines,
    "0 g", ...Array.from({ length: 6 }, (_, i) => `60 ${330 - i * 18} 200 6 re f 300 ${330 - i * 18} 200 6 re f`),
  ].join("\n"), "latin1");
  const c = add(`<< /Length ${content.length} >>`, content);
  const pagesId = objs.length + 2;
  const page = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${c} 0 R /Resources << /XObject << /Im1 ${xobj} 0 R >> >> >>`);
  add(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
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

/* ─── استخراج الرمز الأصلي ─── */

test("الرمز: يُركَّب من الصورة وقناعها كما يظهر في الصفحة، ويُقرأ بلا قلب", () => {
  const pdf = buildPermit();
  const qr = extractQrCompositeFromPdf(pdf);
  assert.ok(qr);
  assert.equal(qr.text, OFFICIAL);
  /* زاوية الرمز مربّع تحديد داكن — في المرسوم لا في السالب. */
  assert.deepEqual([...qr.rgba.slice(0, 4)], [0, 0, 0, 255]);
  const asDrawn = jsQR(qr.rgba, qr.width, qr.height, { inversionAttempts: "dontInvert" });
  jsQR(new Uint8ClampedArray(4), 1, 1, { inversionAttempts: "attemptBoth" });
  assert.equal(asDrawn && asDrawn.data, OFFICIAL);
});

test("الرمز: لا يغيّر سلوك استخراج رفع أجير القائم (خيارات jsQR المشتركة)", () => {
  const pdf = buildPermit();
  assert.equal(extractQrTextFromPdf(pdf), OFFICIAL);
  extractQrCompositeFromPdf(pdf);
  /* القناع وحده سالب الرمز؛ الرفع القائم يقرؤه لأن jsQR يجرّب القلب. لو
     تسرّب dontInvert إلى الإعدادات المشتركة لانكسر هذا بصمت. */
  assert.equal(extractQrTextFromPdf(pdf), OFFICIAL);
  assert.ok(extractQrImageFromPdf(pdf));
});

test("الرمز: صورة بلا قناع تُقبل فقط إن قُرئت كما هي مرسومة", () => {
  const qr = extractQrCompositeFromPdf(buildPermit({ smask: false }));
  assert.ok(qr);
  assert.equal(qr.text, OFFICIAL);
});

test("PNG الرمز: بكسلات الأصل كما هي + هامش أبيض، ويعيد الرابط الرسمي نفسه", () => {
  const pdf = buildPermit();
  const out = view.originalQrPng(pdf, OFFICIAL);
  assert.ok(out.png, out.error);
  assert.equal(out.text, OFFICIAL);
  const back = view.decodeOwnPng(out.png);
  const src = extractQrCompositeFromPdf(pdf);
  const { pad, size } = out.moduleBox;
  assert.equal(size, src.width);
  for (let y = 0; y < src.height; y += 7) for (let x = 0; x < src.width; x += 5) {
    assert.equal(back.rgba[((y + pad) * back.width + x + pad) * 4], src.rgba[(y * src.width + x) * 4]);
  }
  assert.equal(back.rgba[0], 255, "الهامش أبيض");
  const decoded = jsQR(back.rgba, back.width, back.height);
  assert.equal(decoded.data, OFFICIAL);
});

test("PNG الرمز: يُرفض إن لم يكن رابط أجير الرسمي أو خالف المحفوظ عند الرفع", () => {
  assert.equal(view.originalQrPng(buildPermit({ qrText: "https://evil.example/ajeer.qiwa.sa/x" })).error, "not_official");
  assert.equal(view.originalQrPng(buildPermit({ qrText: "http://ajeer.qiwa.sa/x" })).error, "not_official");
  assert.equal(view.originalQrPng(buildPermit(), OFFICIAL + "x").error, "mismatch");
  assert.equal(view.originalQrPng(Buffer.from("%PDF-1.4\n%%EOF")).error, "no_qr");
  assert.ok(view.originalQrPng(buildPermit(), null).png, "سجلّ قديم بلا qr_text: يكفي الرابط الرسمي");
});

/* ─── جلب الملفّ ─── */

test("الجلب: روابط Vercel Blob بـhttps فقط", () => {
  assert.equal(view.isTrustedPermitUrl("https://abc.public.blob.vercel-storage.com/ajeer-permits/TQ1/x.pdf"), true);
  for (const bad of [
    "http://abc.public.blob.vercel-storage.com/x.pdf",
    "https://blob.vercel-storage.com.evil.com/x.pdf",
    "https://evil.com/abc.public.blob.vercel-storage.com/x.pdf",
    "https://user:pw@abc.public.blob.vercel-storage.com/x.pdf",
    "https://abc.public.blob.vercel-storage.com:8443/x.pdf",
    "https://169.254.169.254/latest", "/api/files/qr?permit=1", "", null, 42,
  ]) assert.equal(view.isTrustedPermitUrl(bad), false, String(bad));
});

test("الجلب: لا طلب لرابط غير موثوق، ولا تحويل، ويُرفض غير الـPDF والكبير", async () => {
  const calls = [];
  const fake = (body, headers = {}) => async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, headers: { get: (k) => headers[k.toLowerCase()] || null }, arrayBuffer: async () => body };
  };
  assert.equal(await view.fetchPermitPdf("https://evil.com/x.pdf", fake(Buffer.from("%PDF-"))), null);
  assert.equal(calls.length, 0);
  const url = "https://abc.public.blob.vercel-storage.com/x.pdf";
  const pdf = buildPermit();
  assert.ok((await view.fetchPermitPdf(url, fake(pdf))).equals(pdf));
  assert.equal(calls[0].opts.redirect, "error");
  assert.equal(await view.fetchPermitPdf(url, fake(Buffer.from("<html>"))), null);
  assert.equal(await view.fetchPermitPdf(url, fake(pdf, { "content-length": String(30 * 1024 * 1024) })), null);
});

/* ─── وجه التصريح ─── */

test("وجه التصريح: الصفحة الأصلية مرسومة، مقصوصة أسفل آخر خطّ جدول", async () => {
  const pdf = buildPermit();
  const card = await view.renderPermitFace(pdf);
  const full = await view.renderPermitFace(pdf, { full: true });
  assert.equal(full.cropped, false);
  assert.equal(card.cropped, true);
  assert.ok(card.width < full.width && card.width > full.width * 0.8, `${card.width}/${full.width}`);
  assert.ok(card.height < full.height * 0.62 && card.height > full.height * 0.4, `${card.height}/${full.height}`);
  assert.deepEqual([...card.png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(""), "PNG");
  assert.equal(full.width, Math.round(595 * view.FACE_SCALE));
});

test("القصّ: بلا خطوط أفقية تُعرض الصفحة كاملة", () => {
  const w = 100, h = 140;
  const blank = new Uint8ClampedArray(w * h * 4).fill(255);
  assert.equal(view.tableBottom(blank, w, h), -1);
  /* سطر نصّ متقطّع لا يُعدّ خطّ جدول. */
  for (let x = 0; x < w; x++) if (x % 9 > 2) { const i = (80 * w + x) * 4; blank[i] = blank[i + 1] = blank[i + 2] = 0; }
  assert.equal(view.tableBottom(blank, w, h), -1);
});

/* ─── نقطتا الخادم ─── */

const PROJECT_ROOT = ROOT + path.sep;
const AUTH_ID = require.resolve("../lib/auth/requireAuth");
const REGISTRY_ID = require.resolve("../lib/data/registry");

async function withApp(permits, fn) {
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const fetched = [];
  const pdfs = new Map(permits.map((p) => [p.file, p._pdf]));
  global.fetch = async (url, opts) => {
    fetched.push(url);
    const body = pdfs.get(url);
    return { ok: !!body, headers: { get: () => null }, arrayBuffer: async () => body };
  };
  const clear = () => Object.keys(require.cache).forEach((k) => {
    if (k.startsWith(PROJECT_ROOT) && !k.includes("node_modules")) delete require.cache[k];
  });
  clear();
  Module._load = function (request, parent, isMain) {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (err) { /* يمرّ */ }
    if (resolved === AUTH_ID) return { requireUser: async (req) => req._user || null };
    if (resolved === REGISTRY_ID) {
      return { getResource: (name) => {
        assert.equal(name, "permits");
        return { get: async (no) => { const p = permits.find((x) => x.permit === no); return p ? { ...p, _pdf: undefined } : null; } };
      } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await fn({ handler: require("../api/app"), fetched });
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
    clear();
  }
}

async function call(handler, action, query, user, headers = {}) {
  const out = { statusCode: 0, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; },
    status(c) { out.statusCode = c; return res; },
    json(p) { out.body = p; return res; },
    writeHead(c, h) { out.statusCode = c; for (const [k, v] of Object.entries(h || {})) out.headers[k.toLowerCase()] = v; return res; },
    end(p) { if (p !== undefined) out.body = p; return res; },
  };
  await handler({ method: "GET", query: { kind: "api", apiPath: `files/${action}`, ...query }, headers, _user: user }, res);
  return out;
}

const VIEWER = { id: "u1", role: "hr", status: "active", permissions: ["ajeer:view"] };
const NOBODY = { id: "u2", role: "hr", status: "active", permissions: [] };
const FILE = "https://abc.public.blob.vercel-storage.com/ajeer-permits/TQ0000001/1-permit.pdf";

test("الخادم: 401 بلا جلسة، 403 بلا ajeer:view — قبل أي جلب", async () => {
  await withApp([{ permit: "TQ0000001", file: FILE, qrText: OFFICIAL, _pdf: buildPermit() }], async ({ handler, fetched }) => {
    for (const a of ["ajeer-permit-face", "ajeer-permit-qr"]) {
      assert.equal((await call(handler, a, { permit: "TQ0000001" }, null)).statusCode, 401);
      assert.equal((await call(handler, a, { permit: "TQ0000001" }, NOBODY)).statusCode, 403);
    }
    assert.equal(fetched.length, 0);
  });
});

test("الخادم: الرمز الأصلي private، بلا رابط الملفّ، ويعيد الرابط الرسمي", async () => {
  await withApp([{ permit: "TQ0000001", file: FILE, qrText: OFFICIAL, _pdf: buildPermit() }], async ({ handler, fetched }) => {
    const out = await call(handler, "ajeer-permit-qr", { permit: "TQ0000001" }, VIEWER);
    assert.equal(out.statusCode, 200);
    assert.equal(out.headers["content-type"], "image/png");
    assert.match(out.headers["cache-control"], /^private\b/);
    assert.equal(out.headers["x-content-type-options"], "nosniff");
    assert.doesNotMatch(JSON.stringify(out.headers), /blob\.vercel-storage|ajeer\.qiwa/);
    const img = view.decodeOwnPng(out.body);
    assert.equal(jsQR(img.rgba, img.width, img.height).data, OFFICIAL);
    /* 304 بالـETag، والنسخة الثانية من الذاكرة بلا جلب جديد. */
    const again = await call(handler, "ajeer-permit-qr", { permit: "TQ0000001" }, VIEWER, { "if-none-match": out.headers.etag });
    assert.equal(again.statusCode, 304);
    await call(handler, "ajeer-permit-qr", { permit: "TQ0000001" }, VIEWER);
    assert.equal(fetched.length, 1);
    const dl = await call(handler, "ajeer-permit-qr", { permit: "TQ0000001", download: "1" }, VIEWER);
    assert.match(dl.headers["content-disposition"], /^attachment; filename="ajeer-TQ0000001-QR\.png"$/);
  });
});

test("الخادم: رمز يخالف المحفوظ عند الرفع لا يُرسَل (422)", async () => {
  await withApp([{ permit: "TQ0000002", file: FILE.replace("1-", "2-"), qrText: OFFICIAL + "-old", _pdf: buildPermit() }], async ({ handler }) => {
    const out = await call(handler, "ajeer-permit-qr", { permit: "TQ0000002" }, VIEWER);
    assert.equal(out.statusCode, 422);
    assert.equal(out.body.reason, "mismatch");
  });
});

test("الخادم: تصريح بلا ملف أو برابط غير موثوق 404 بلا جلب", async () => {
  const permits = [
    { permit: "TQ0000003", file: null, qrText: null },
    { permit: "TQ0000004", file: "https://evil.example/x.pdf", qrText: OFFICIAL, _pdf: buildPermit() },
  ];
  await withApp(permits, async ({ handler, fetched }) => {
    assert.equal((await call(handler, "ajeer-permit-face", { permit: "TQ0000003" }, VIEWER)).statusCode, 404);
    assert.equal((await call(handler, "ajeer-permit-qr", { permit: "TQ0000004" }, VIEWER)).statusCode, 404);
    assert.equal((await call(handler, "ajeer-permit-qr", { permit: "NOPE" }, VIEWER)).statusCode, 404);
    assert.equal((await call(handler, "ajeer-permit-qr", {}, VIEWER)).statusCode, 400);
    assert.equal(fetched.length, 0);
  });
});

test("الخادم: وجه التصريح PNG خاصّ، والصفحة الكاملة بـfull=1", async () => {
  await withApp([{ permit: "TQ0000001", file: FILE, qrText: OFFICIAL, _pdf: buildPermit() }], async ({ handler }) => {
    const card = await call(handler, "ajeer-permit-face", { permit: "TQ0000001" }, VIEWER);
    const full = await call(handler, "ajeer-permit-face", { permit: "TQ0000001", full: "1" }, VIEWER);
    assert.equal(card.statusCode, 200);
    assert.equal(full.statusCode, 200);
    assert.match(card.headers["cache-control"], /^private\b/);
    assert.notEqual(card.headers.etag, full.headers.etag);
    assert.ok(full.body.readUInt32BE(20) > card.body.readUInt32BE(20), "الكاملة أطول");
  });
});

/* ─── الواجهة ─── */

test("الواجهة: البطاقة تعرض الصفحة الأصلية والبيانات وزرّ «عرض الباركود» من الملفّ", () => {
  const html = read("app-shell.html");
  const card = html.slice(html.indexOf("function ajeerCard"), html.indexOf("function renderAjeer"));
  assert.match(card, /ajeerFaceUrl\(p\)/);
  assert.match(card, /ajeerQrUrl\(p\)/);
  assert.match(card, /عرض الباركود/);
  for (const label of ["رقم التصريح", "حالة التصريح", "تاريخ الانتهاء", "الأيام المتبقية"]) assert.match(card, new RegExp(label));
  assert.match(html.slice(html.indexOf("function ajeerPerson"), html.indexOf("function ajeerMatches")), /F\.job/, "المهنة من سجلّ الموظف");
  assert.doesNotMatch(card, /p\.qr\b|\/api\/files\/qr/, "لا رمز مولَّد في البطاقة");
  assert.match(html, /<link rel="stylesheet" href="\/ajeer-cards\.css\?v=1">/);
});

test("الواجهة: نافذة الباركود بالنصوص المطلوبة وبالرمز الأصلي", () => {
  const html = read("app-shell.html");
  const modal = html.slice(html.indexOf("function openAjeerQr"), html.indexOf("function openAjeerDoc"));
  assert.match(modal, /الباركود الخاص بتصريح الموظف/);
  assert.match(modal, /امسح الباركود للاطلاع على تصريح الموظف/);
  assert.match(modal, /ajeerQrUrl\(p\)/);
  assert.match(modal, /who\.name/);
  assert.match(modal, /who\.role/);
  assert.match(modal, /p\.permit/);
  assert.doesNotMatch(modal, /QRCode|\/api\/files\/qr/);
});

test("الواجهة: فلتر الحالة يطابق خيارات القائمة كلّها", () => {
  const html = read("app-shell.html");
  const opts = [...html.match(/ajeerStatus\.innerHTML=`([^`]+)`/)[1].matchAll(/value="(\w*)"/g)].map((m) => m[1]).filter(Boolean);
  const fn = html.match(/function ajeerFilterKey\(st\)\{[^\n]+\}/)[0];
  const ajeerFilterKey = new Function(`${fn}; return ajeerFilterKey;`)();
  const produced = new Set(["expired", "today", "warn2", "warn5", "ok"].map((key) => ajeerFilterKey({ key })));
  for (const o of opts) assert.ok(produced.has(o), `الخيار ${o} لا يطابق أي تصريح`);
});

test("الشبكة: بطاقة واحدة على الجوال وحتى أربع على الشاشة العريضة، بلا تمدّد أفقي", () => {
  const css = read("ajeer-cards.css");
  assert.match(css, /\.aj-grid\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /@media\(min-width:960px\)\{\.aj-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:1240px\)\{\.aj-grid\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /base64|https?:\/\//);
});

test("لا ملفّات تصاريح جديدة في المستودع، ولا base64 في الشيفرة الجديدة", () => {
  const { execSync } = require("node:child_process");
  const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n");
  const pdfs = tracked.filter((f) => /\.pdf$/i.test(f) && /permit|ajeer|TQ\d/i.test(f));
  /* الخمسة القديمة في permits/ سابقة لهذه الميزة؛ لا يُضاف عليها شيء. */
  assert.ok(pdfs.every((f) => /^permits\/TQ62117\d\d\.pdf$/.test(f)), pdfs.join(","));
  assert.ok(pdfs.length <= 5);
  assert.ok(tracked.filter((f) => /^permits\//.test(f)).length <= 10, "لا صور تصاريح جديدة");
  for (const f of ["lib/ajeer/permitView.js", "ajeer-cards.css"]) assert.doesNotMatch(read(f), /data:image|base64,|[A-Za-z0-9+/]{200,}/);
});
