/* بطاقات تصاريح أجير: صفحة التصريح الأصلية ورمزه الأصلي، من ملفّ التصريح نفسه.
   =========================================================================
   لا تخزين جديد ولا هجرة: ملفّ التصريح موجود أصلًا (ajeer_permits.file_url،
   يرفعه نموذج أجير القائم كما هو). الخادم يجلبه عند الطلب ويُخرج منه:

   - وجه التصريح: الصفحة الأولى مرسومةً بـpdf.js كما هي (شعار أجير والوزارة،
     الجداول، الرمز، الخطّ المضمَّن) — لا إعادة رسم. تُقصّ أسفلها عند آخر
     خطّ أفقيّ لجداول البيانات، فيبقى في البطاقة رأس التصريح وبياناته وتسقط
     الإقرارات العامّة؛ الصفحة كاملة متاحة بـ?full=1.
   - الرمز: صورة QR المضمَّنة في الملفّ بكسلًا ببكسل (مركّبةً على الأبيض كما
     تظهر في الصفحة — lib/pdf/qrFromPdf.js) + هامش أبيض حولها فقط. لا يُولَّد
     رمز جديد. ويُعتمد فقط إن قُرئ كما هو مرسوم إلى الرابط الرسمي نفسه
     (https://ajeer.qiwa.sa/…) المقروء من الملفّ، والمطابق لما حُفظ عند الرفع.

   الأمان: لا يُجلب إلا رابط https من متجر Vercel Blob (ما يكتبه رفع أجير)،
   بمهلة وحدّ حجم، ولا يُتبَع تحويل. لا رابط يخرج إلى المتصفّح من هنا: يطلب
   الصورتين برقم التصريح من نقطتين بصلاحية ajeer:view و Cache-Control: private.

   الأدوات: pdfjs-dist (قائمة، تستعملها الدالّة أصلًا) و@napi-rs/canvas
   (اعتماديّتها الاختيارية، مثبّتة معها) — تُحمَّلان كسولًا عند أول وجه فقط. */

const zlib = require("zlib");
const crypto = require("crypto");
const { looksLikePdf, extractQrCompositeFromPdf, decodeAsDrawn, LIMITS } = require("../pdf/qrFromPdf");

const OFFICIAL_QR = /^https:\/\/ajeer\.qiwa\.sa\/[^\s]+$/;
const FETCH_TIMEOUT_MS = 12000;
/* ×1.6 → ~952px عرضًا: واضح في بطاقة بعرض ~300px على شاشة كثافتها 3. */
const FACE_SCALE = 1.6;
const QUIET_RATIO = 0.08;

function isOfficialQr(text) {
  return typeof text === "string" && OFFICIAL_QR.test(text);
}

/* ما يكتبه uploadFile() فقط: https على *.blob.vercel-storage.com. */
function isTrustedPermitUrl(value) {
  if (typeof value !== "string" || !value) return false;
  let u;
  try { u = new URL(value); } catch { return false; }
  return u.protocol === "https:" && !u.username && !u.password && !u.port
    && /(^|\.)blob\.vercel-storage\.com$/i.test(u.hostname);
}

async function fetchPermitPdf(url, fetchImpl = fetch) {
  if (!isTrustedPermitUrl(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: "error", signal: ctrl.signal });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > LIMITS.maxPdfBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > LIMITS.maxPdfBytes || !looksLikePdf(buf)) return null;
    return buf;
  } catch (err) {
    console.error("permit pdf not fetched:", err && err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── PNG بلا اعتماديات (RGBA → PNG RGB، مرشّح None) ─── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = row + 1 + x * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
/* للتحقّق: يفكّ PNG أنتجه encodePng نفسه (RGB 8 بت، مرشّح None). */
function decodeOwnPng(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  let off = 8; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString("latin1", off + 4, off + 8);
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = y * (width * 3 + 1) + 1 + x * 3, d = (y * width + x) * 4;
    rgba[d] = raw[s]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s + 2]; rgba[d + 3] = 255;
  }
  return { width, height, rgba };
}

/* الرمز الأصلي PNG + التحقّق. expectedText: ما حُفظ عند الرفع (qr_text)،
   إن وُجد يجب أن يطابق. يعيد { png, text } أو { error }. */
function originalQrPng(pdfBuf, expectedText) {
  const found = extractQrCompositeFromPdf(pdfBuf);
  if (!found) return { error: "no_qr" };
  if (!isOfficialQr(found.text)) return { error: "not_official" };
  if (expectedText && String(expectedText).trim() !== found.text) return { error: "mismatch" };

  const pad = Math.round(Math.max(found.width, found.height) * QUIET_RATIO);
  const w = found.width + pad * 2, h = found.height + pad * 2;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < found.height; y++) {
    rgba.set(found.rgba.subarray(y * found.width * 4, (y + 1) * found.width * 4), ((y + pad) * w + pad) * 4);
  }
  const png = encodePng(rgba, w, h);

  /* ذهابًا وإيابًا على البايتات المرسَلة نفسها: بكسلات الرمز مطابقة للأصل،
     وتُقرأ كما هي مرسومة إلى الرابط الرسمي نفسه. */
  const back = decodeOwnPng(png);
  for (let y = 0; y < found.height; y++) for (let x = 0; x < found.width; x++) {
    const a = ((y + pad) * w + x + pad) * 4, b = (y * found.width + x) * 4;
    if (back.rgba[a] !== found.rgba[b] || back.rgba[a + 1] !== found.rgba[b + 1] || back.rgba[a + 2] !== found.rgba[b + 2]) {
      return { error: "pixels_changed" };
    }
  }
  if (decodeAsDrawn(back.rgba, back.width, back.height) !== found.text) return { error: "roundtrip_failed" };
  return { png, text: found.text, width: w, height: h, moduleBox: { pad, size: found.width } };
}

/* ─── وجه التصريح ─── */
function canvasLib() {
  return require("@napi-rs/canvas");
}

/* أسفل جداول البيانات: آخر خطّ أفقيّ متّصل يمتدّ على أكثر من نصف العرض بين
   40٪ و72٪ من الصفحة (حدّ جدول «بيانات التصريح»). سطور النصّ لا تُحسب لأن
   بين كلماتها فراغات. إن لم يوجد خطّ: الصفحة كلّها. */
function tableBottom(rgba, width, height) {
  let last = -1;
  for (let y = Math.floor(height * 0.4); y < Math.floor(height * 0.72); y++) {
    let run = 0, best = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      run = rgba[i] < 225 || rgba[i + 1] < 225 || rgba[i + 2] < 225 ? run + 1 : 0;
      if (run > best) best = run;
    }
    if (best > width * 0.55) last = y;
  }
  return last;
}

/* pdf.js في Node يشغّل «عاملًا وهميًا» يستورد pdf.worker.mjs بمسار يُحسب وقت
   التشغيل، فلا يراه متتبّع ملفّات Vercel ولا يدخل حزمة الدالّة («Setting up
   fake worker failed»). الاستيراد الصريح هنا يُدخله الحزمة، وتعيينه في
   globalThis.pdfjsWorker يجعل pdf.js يستعمله مباشرةً بلا بحث عن الملفّ. */
async function loadPdfjs() {
  if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/* أصغر مستطيل يحوي كل بكسل غير أبيض في الصفوف [0, rows). */
function contentBox(rgba, width, rows) {
  let x0 = width, y0 = rows, x1 = -1;
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (rgba[i] < 245 || rgba[i + 1] < 245 || rgba[i + 2] < 245) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y;
    }
  }
  return x1 < 0 ? { x0: 0, y0: 0, x1: width - 1 } : { x0, y0, x1 };
}

async function renderPermitFace(pdfBuf, { full = false } = {}) {
  const { createCanvas } = canvasLib();
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdfBuf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: FACE_SCALE });
    const W = Math.round(viewport.width), H = Math.round(viewport.height);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    if (full) return { png: canvas.toBuffer("image/png"), width: W, height: H, cropped: false };

    const rgba = ctx.getImageData(0, 0, W, H).data;
    const bottom = tableBottom(rgba, W, H);
    if (bottom < 0) return { png: canvas.toBuffer("image/png"), width: W, height: H, cropped: false };
    /* هوامش الورقة البيضاء حول المحتوى تُطرح أيضًا (مع حاشية صغيرة)، فيكبر
       نصّ التصريح في البطاقة دون أي تمديد أو إعادة رسم. */
    const box = contentBox(rgba, W, bottom + 1);
    const m = Math.round(W * 0.012);
    const x0 = Math.max(0, box.x0 - m), y0 = Math.max(0, box.y0 - m);
    const x1 = Math.min(W, box.x1 + m + 1), y1 = Math.min(H, bottom + m + 1);
    const out = createCanvas(x1 - x0, y1 - y0);
    out.getContext("2d").drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    return { png: out.toBuffer("image/png"), width: x1 - x0, height: y1 - y0, cropped: true };
  } finally {
    await task.destroy();
  }
}

/* ذاكرة مؤقّتة داخل النسخة: المفتاح بصمة رابط الملفّ + النوع. الرابط يتغيّر
   مع كل رفع (لاحقة عشوائية)، فاستبدال الملفّ يُسقط القديم تلقائيًا. */
const CACHE_MAX = 60;
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (v) { cache.delete(key); cache.set(key, v); }
  return v;
}
function cachePut(key, v) {
  cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
const fileTag = (url) => crypto.createHash("sha256").update(String(url)).digest("hex").slice(0, 20);

module.exports = {
  isTrustedPermitUrl, isOfficialQr, fetchPermitPdf, originalQrPng, renderPermitFace, tableBottom, contentBox,
  encodePng, decodeOwnPng, cacheGet, cachePut, fileTag, FACE_SCALE,
};
