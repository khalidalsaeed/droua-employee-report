/* قراءة حقول تصريح أجير من ملفّه نفسه — على الخادم، بلا شبكة.
   =========================================================================
   ملفّات أجير (mPDF) تحمل طبقة نصّ سليمة، فتُقرأ بـpdf.js مباشرةً: كل عنوان
   («اسم العامل»، «رقم الهوية / الإقامة»، «تاريخ نهاية التصريح»…) وقيمته على
   السطر نفسه، والقيمة يسار عنوانها (الصفحة من اليمين لليسار). فالقيمة هي
   أقرب عنصر يسار العنوان في السطر نفسه — لا تخمين بالمواضع المطلقة.

   رقم التصريح مطبوع أعلى يسار الصفحة فوق «امسح للتحقق» (TQ…)، والرمز صورة
   QR مضمَّنة تُقرأ كما هي مرسومة (lib/pdf/qrFromPdf.js) ويجب أن تكون رابط
   التحقّق الرسمي https://ajeer.qiwa.sa/… — لا يُولَّد رمز ولا يُجلب الرابط.

   لا شيء يُخمَّن: حقل لا يحمله الملفّ يبقى غائبًا، والمُنادي يقرّر هل ما عاد
   يكفي. لا يرمي أبدًا: يعيد { ok, permit, reason }. */

const { looksLikePdf, extractQrCompositeFromPdf, LIMITS: QR_LIMITS } = require("../pdf/qrFromPdf");

const OFFICIAL_QR = /^https:\/\/ajeer\.qiwa\.sa\/[^\s]+$/;
const PERMIT_NO_RE = /^[A-Z]{2}\d{6,12}$/;
const ROW_TOLERANCE = 3;
const LIMITS = { maxBytes: QR_LIMITS.maxPdfBytes, maxField: 120 };

const DIGIT_MAP = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const westernDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => DIGIT_MAP[d]);

/* أشكال العرض العربية (ﺍﺳﻢ) تُطوى بـNFKC، ثم توحيد الهمزات والتاء والياء
   والمسافات، فيُطابَق العنوان أيًّا كان الخطّ الذي أخرجه. */
function normalize(s) {
  return westernDigits(String(s || "").normalize("NFKC"))
    .replace(/[ً-ٰ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/[ىئ]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}
/* للمطابقة: بلا مسافات. بعض الخطوط تُسقط المسافات أو تُقحمها داخل الكلمة
   («تصر يح»)، فيُقارَن العنوان بلا مسافات أصلًا. */
const squash = (s) => normalize(s).replace(/\s+/g, "");

const LABELS = {
  name: "اسم العامل",
  idNumber: "رقم الهويه / الاقامه",
  occupation: "المهنه",
  nationality: "الجنسيه",
  startDate: "تاريخ بدايه التصريح",
  endDate: "تاريخ نهايه التصريح",
};
const TITLE = "تصريح اجير";

async function loadPdfjs() {
  if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/* عناصر الصفحة الأولى: { text (مطبَّع), raw, x, y }. */
async function pageItems(buf) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    return tc.items
      .filter((it) => typeof it.str === "string" && it.str.trim())
      .map((it) => ({ raw: it.str.trim(), text: normalize(it.str), key: squash(it.str), x: it.transform[4], y: it.transform[5] }));
  } finally {
    await task.destroy();
  }
}

/* القيمة: أقرب عنصر يسار العنوان على السطر نفسه، ليس عنوانًا معروفًا. */
function valueLeftOf(items, label) {
  const known = new Set(Object.values(LABELS).map(squash));
  const lab = items.find((it) => it.key === squash(label));
  if (!lab) return null;
  const left = items
    .filter((it) => it !== lab && Math.abs(it.y - lab.y) <= ROW_TOLERANCE && it.x < lab.x && !known.has(it.key))
    .sort((a, b) => b.x - a.x);
  return left[0] ? left[0].raw.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, LIMITS.maxField) : null;
}

function isoDate(v) {
  const s = westernDigits(String(v || "")).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) || s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (!m) return null;
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  const t = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.getUTCDate() !== Number(d)) return null;
  return `${y}-${mo}-${d}`;
}

async function extractAjeerPermit(buf) {
  try {
    if (!looksLikePdf(buf)) return { ok: false, reason: "not_pdf" };
    if (buf.length > LIMITS.maxBytes) return { ok: false, reason: "too_large" };
    let items;
    try {
      items = await pageItems(buf);
    } catch (err) {
      return { ok: false, reason: "parse_failed" };
    }
    const isAjeer = items.some((it) => it.key.includes(squash(TITLE)));
    const permit = {};
    const permitNo = items.map((it) => it.raw.trim()).find((t) => PERMIT_NO_RE.test(t));
    if (permitNo) permit.permitNo = permitNo;
    for (const [key, label] of Object.entries(LABELS)) {
      const v = valueLeftOf(items, label);
      if (v) permit[key] = v;
    }
    if (permit.idNumber) {
      const digits = westernDigits(permit.idNumber).replace(/\D/g, "");
      if (/^\d{10}$/.test(digits)) permit.idNumber = digits; else delete permit.idNumber;
    }
    for (const k of ["startDate", "endDate"]) if (permit[k]) { const d = isoDate(permit[k]); if (d) permit[k] = d; else delete permit[k]; }

    const qr = extractQrCompositeFromPdf(buf);
    if (qr && qr.text) {
      permit.qrText = qr.text;
      permit.qrOfficial = OFFICIAL_QR.test(qr.text);
    }

    if (!isAjeer || !permit.permitNo) return { ok: false, reason: "not_an_ajeer_permit", permit };
    return { ok: true, permit };
  } catch (err) {
    return { ok: false, reason: "parse_failed" };
  }
}

module.exports = { extractAjeerPermit, normalize, squash, isoDate, OFFICIAL_QR, PERMIT_NO_RE };
