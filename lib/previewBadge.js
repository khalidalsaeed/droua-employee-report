/* ─── علامة مؤقّتة: «نسخة مطابقة التحويلات» ───
   =========================================================================
   ⚠️ مؤقّتة — تُحذف قبل الدمج (احذف هذا الملفّ وسطر استدعائه في
   api/app.js:handlePage ومعهما test/preview-badge.test.js).

   لماذا: المشروع يبني معاينات لأكثر من فرع، والإنتاج على main أقدم، فكان
   «أيّ نسخة أرى؟» سؤالًا حقيقيًا. العلامة تُحقن من الخادم في كل صفحة يقدّمها
   handlePage (بعد الدخول)، فتُرى بالعين على الصفحة الرئيسية وقائمة المسير
   وصفحة الشهر، ومعها commit النشر.

   لا تظهر أبدًا في الإنتاج: VERCEL_ENV === "production" يُرجع الصفحة كما هي،
   ولو بقي الملفّ سهوًا بعد الدمج. */

const LABEL = "نسخة مطابقة التحويلات";

function shouldShow(env) {
  return String(env || "") === "preview";
}

function badgeHtml(commit) {
  const c = String(commit || "").replace(/[^0-9a-f]/gi, "").slice(0, 7) || "—";
  return `<div id="previewBadge" role="note" style="position:sticky;top:0;z-index:1000;`
    + `background:#7A3E00;color:#fff;font:600 13px/1.6 var(--sans,system-ui);text-align:center;`
    + `padding:6px 12px;letter-spacing:.01em">${LABEL} · معاينة · <span dir="ltr">${c}</span></div>`;
}

/* يُدرج العلامة بعد وسم <body> مباشرة. صفحةٌ بلا <body> تُرجع كما هي. */
function inject(html, { env, commit } = {}) {
  if (!shouldShow(env)) return html;
  return String(html).replace(/<body([^>]*)>/i, (m) => `${m}\n${badgeHtml(commit)}`);
}

module.exports = { inject, shouldShow, badgeHtml, LABEL };
