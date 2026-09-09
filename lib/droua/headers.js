/* ─── الردود والرؤوس ──────────────────────────────────────────────────
   =========================================================================
   ⚠️ قرار دقيق يسهل أن يُخطأ فيه: ردّ الـ404 **لا يحمل رؤوس الأمان**.

   يبدو أن إضافتها إلى كل استجابة تحسينٌ مجّانيّ — وهو عكس المطلوب هنا
   تمامًا. الـ404 يجب أن يكون **غير قابل للتمييز** عن ردّ المنصّة على مسار
   غير موجود. فلو حمل X-Robots-Tag و CSP بينما لا يحملهما 404 العاديّ،
   لصار الفرق في الرؤوس نفسه دليلًا على أن هنا شيئًا يُحرَس.

   فرؤوس الأمان تُطبَّق على الاستجابات المصرَّح بها وحدها — وهي التي لا
   يراها إلا صاحب الحساب. ولا خسارة أمنية: صفحة 404 بلا محتوى لا تُفهرَس
   ولا تُنفَّذ فيها شيفرة.

   الأشكال أدناه منسوخة حرفًا بحرف من api/app.js:
     صفحة غير موجودة : السطر 82  → res.status(404).end("Not found")  بلا رؤوس
     مسار API مجهول  : السطر 72  → { ok:false, error:"Not found" }
                        مع Cache-Control التي يضعها handleApi في أوّله
     غير مسجَّل (صفحة): 302 إلى /login.html مع NO_CACHE
     غير مسجَّل (API) : 401 { ok:false, error:"غير مسجّل الدخول" } */

const NO_CACHE = { "Cache-Control": "no-store, must-revalidate" };
const API_CACHE_CONTROL = "no-store, must-revalidate";

function notFoundPage(res) {
  res.status(404).end("Not found");
}

function notFoundApi(res) {
  res.setHeader("Cache-Control", API_CACHE_CONTROL);
  res.status(404).json({ ok: false, error: "Not found" });
}

function unauthenticatedPage(res) {
  res.writeHead(302, { Location: "/login.html", ...NO_CACHE });
  res.end();
}

function unauthenticatedApi(res) {
  res.setHeader("Cache-Control", API_CACHE_CONTROL);
  res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });
}

/* للاستجابات المصرَّح بها وحدها. */
function secureApi(res) {
  res.setHeader("Cache-Control", "no-store, private, max-age=0, must-revalidate");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

/* CSP بـnonce لا 'unsafe-inline': الصفحة مكتفية ذاتيًا (أنماطها وشيفرتها
   مضمَّنتان كي لا يظهر اسم أصلٍ خاصٍّ بالقسم في لوجّات الخادم)، والـnonce
   هو ما يسمح بذلك دون فتح الباب لأي سكربت آخر. */
function securePage(res, nonce) {
  secureApi(res);
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; ` +
      `connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
}

module.exports = { notFoundPage, notFoundApi, unauthenticatedPage, unauthenticatedApi, secureApi, securePage };
