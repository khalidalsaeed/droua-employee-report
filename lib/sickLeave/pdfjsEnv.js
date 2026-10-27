/* ─── تهيئة pdfjs لقراءة النصّ فقط على Vercel ───
   =========================================================================
   pdfjs-dist (الإصدار legacy) ينشئ `new DOMMatrix()` عند تحميل الوحدة نفسها.
   في Node يحاول تعريفه من @napi-rs/canvas — اعتمادية اختيارية يُحمّلها
   pdfjs بـcreateRequire ديناميكيًا، فلا يتتبّعها مُجمِّع Vercel ولا تصل إلى
   الدالّة. النتيجة على Preview: `ReferenceError: DOMMatrix is not defined`
   قبل قراءة أي بايت — وكان يظهر للمستخدم «ملف تالف».

   قراءة طبقة النصّ لا ترسم شيئًا: DOMMatrix يلزم لوجوده عند التحميل فقط.
   فيُعرَّف هنا مصفوفةٌ ثنائية الأبعاد صحيحة رياضيًا (a..f) إن لم يوجد
   DOMMatrix، ولا يُستبدل أبدًا تعريفٌ قائم (canvas محلّيًا، أو المتصفّح). */

class DOMMatrix2D {
  constructor(init) {
    const m = Array.isArray(init) && init.length >= 6 ? init : [1, 0, 0, 1, 0, 0];
    [this.a, this.b, this.c, this.d, this.e, this.f] = m.map(Number);
  }
  get m11() { return this.a; } get m12() { return this.b; }
  get m21() { return this.c; } get m22() { return this.d; }
  get m41() { return this.e; } get m42() { return this.f; }
  get is2D() { return true; }
  get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
  multiplySelf(o) {
    const { a, b, c, d, e, f } = this;
    this.a = a * o.a + c * o.b; this.b = b * o.a + d * o.b;
    this.c = a * o.c + c * o.d; this.d = b * o.c + d * o.d;
    this.e = a * o.e + c * o.f + e; this.f = b * o.e + d * o.f + f;
    return this;
  }
  preMultiplySelf(o) { const r = new DOMMatrix2D([o.a, o.b, o.c, o.d, o.e, o.f]).multiplySelf(this); return Object.assign(this, r); }
  multiply(o) { return new DOMMatrix2D([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(o); }
  translateSelf(x = 0, y = 0) { return this.multiplySelf(new DOMMatrix2D([1, 0, 0, 1, x, y])); }
  translate(x, y) { return this.multiply(new DOMMatrix2D([1, 0, 0, 1, x || 0, y || 0])); }
  scaleSelf(sx = 1, sy = sx) { return this.multiplySelf(new DOMMatrix2D([sx, 0, 0, sy, 0, 0])); }
  scale(sx = 1, sy = sx) { return this.multiply(new DOMMatrix2D([sx, 0, 0, sy, 0, 0])); }
  invertSelf() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) { [this.a, this.b, this.c, this.d, this.e, this.f] = [NaN, NaN, NaN, NaN, NaN, NaN]; return this; }
    [this.a, this.b, this.c, this.d] = [d / det, -b / det, -c / det, a / det];
    [this.e, this.f] = [(c * f - d * e) / det, (b * e - a * f) / det];
    return this;
  }
  inverse() { return new DOMMatrix2D([this.a, this.b, this.c, this.d, this.e, this.f]).invertSelf(); }
  transformPoint(p = {}) {
    const x = p.x || 0, y = p.y || 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

let loading = null;

/* حيث يُحمَّل @napi-rs/canvas فعلًا (التطوير المحلّي) يتركه pdfjs يعرّف DOMMatrix
   بنفسه. التحميل لا مجرّد resolve: حزمة موجودة بثنائيّ لا يعمل تُعامَل كغائبة. */
function canvasAvailable() {
  try { require("@napi-rs/canvas"); return true; } catch { return false; }
}

/* يُحمّل pdfjs مرّة واحدة لكل نسخة دالّة.

   العامل (pdf.worker.mjs): في Node يشغّل pdfjs «عاملًا وهميًا» في الخيط نفسه
   بتحميل ملفّ العامل ديناميكيًا من مسار محسوب — فلا يتتبّعه مجمِّع Vercel،
   وعلى Preview كان: «Setting up fake worker failed: Cannot find module
   …/pdf.worker.mjs»، فلا يُقرأ أي نصّ. الاستيراد هنا بمسار ثابت (فيُضمَّن في
   الحزمة)، ويُسجَّل في globalThis.pdfjsWorker — وهو ما يفحصه pdfjs أوّلًا
   قبل البحث عن الملفّ. */
function loadPdfjs() {
  if (!loading) {
    if (typeof globalThis.DOMMatrix === "undefined" && !canvasAvailable()) globalThis.DOMMatrix = DOMMatrix2D;
    loading = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (!(globalThis.pdfjsWorker && globalThis.pdfjsWorker.WorkerMessageHandler)) {
        globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      }
      return pdfjs;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

module.exports = { loadPdfjs, DOMMatrix2D };
