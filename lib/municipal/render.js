/* رسم وجه الشهادة الأصلي وصورة رمزها الأصلية — لسكربت الاستيراد وحده.
   =========================================================================
   وجه البطاقة: الصفحة الأولى من ملفّ الأمانة نفسه مرسومةً كما هي بـpdf.js
   (شعار الأمانة، الصورة، الرمز، النصوص) — لا إعادة تركيب ولا نسخة
   اصطناعية. disableFontFace يجعل pdf.js يرسم مسارات الحروف من الخطّ المضمَّن
   مباشرةً، فلا يعتمد على خطوط النظام.

   الرمز: صورة QR المضمَّنة في الملفّ بكسلًا ببكسل (lib/pdf/qrFromPdf.js)،
   مرمَّزة PNG بلا أي إعادة توليد. نصّها يُقرأ منها ويجب أن يطابق ما قُرئ من
   الملفّ، وإلا لا تُعتمد.

   الأدوات: pdfjs-dist (اعتمادية قائمة) و@napi-rs/canvas (اعتماديتها
   الاختيارية، مثبّتة معها). لا تُحمَّل في الدالّة الخادمة: api/app.js لا
   يستدعي هذا الملفّ، فلا تدخل حزمتها. */

const jsQRmodule = require("jsqr");
const { extractQrImageFromPdf } = require("../pdf/qrFromPdf");

const jsQR = jsQRmodule.default || jsQRmodule;
const CARD_SCALE = 4; // 151×238pt → ~605×950px: واضح على الشاشات عالية الكثافة

function canvasLib() {
  try {
    return require("@napi-rs/canvas");
  } catch (err) {
    throw new Error("@napi-rs/canvas غير مثبّت — شغّل npm ci (يأتي مع pdfjs-dist)");
  }
}

async function renderCardFace(pdfBuffer) {
  const { createCanvas } = canvasLib();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: CARD_SCALE });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return { png: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height, rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  } finally {
    await task.destroy();
  }
}

/* صورة الرمز الأصلية PNG، ومعها النصّ المقروء منها بعد الترميز للتحقّق.
   الصورة في الملفّ بلا هامش هادئ (حافّة إلى حافّة)، والكاميرا تحتاجه؛
   فيُضاف إطار أبيض حولها فقط — بكسلات الرمز نفسها كما هي بلا أي تعديل. */
const QUIET_RATIO = 0.08;

function originalQrPng(pdfBuffer) {
  const found = extractQrImageFromPdf(pdfBuffer);
  if (!found) return null;
  const { createCanvas } = canvasLib();
  const pad = Math.round(Math.max(found.width, found.height) * QUIET_RATIO);
  const w = found.width + pad * 2, h = found.height + pad * 2;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const img = ctx.createImageData(found.width, found.height);
  img.data.set(found.rgba);
  ctx.putImageData(img, pad, pad);
  const png = canvas.toBuffer("image/png");
  /* ذهابًا وإيابًا: ما يُخزَّن يجب أن يُقرأ إلى النصّ نفسه حرفيًا،
     وبكسلات الرمز داخل الإطار يجب أن تطابق الأصل بايتًا ببايت. */
  const inner = ctx.getImageData(pad, pad, found.width, found.height).data;
  const identical = Buffer.from(inner.buffer, inner.byteOffset, inner.byteLength).equals(Buffer.from(found.rgba.buffer, found.rgba.byteOffset, found.rgba.byteLength));
  const decoded = jsQR(new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data), w, h);
  return { png, text: found.text, roundTrip: decoded ? decoded.data.trim() : null, pixelsIdentical: identical };
}

/* هل يُقرأ رمز وجه البطاقة المرسوم إلى النصّ نفسه؟ فحص إضافي للرسم. */
function decodeFromRgba(rgba, width, height) {
  const r = jsQR(new Uint8ClampedArray(rgba), width, height);
  return r ? r.data.trim() : null;
}

module.exports = { renderCardFace, originalQrPng, decodeFromRgba, CARD_SCALE };
