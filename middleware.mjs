import tokensPkg from "./lib/auth/tokens.js";
const { verify } = tokensPkg;

/* Every route runs through this except the Ajeer/expiration cron job, which
   is protected separately by its own CRON_SECRET bearer check and has no
   human session to check. Login itself, and the login page, must stay
   reachable or nobody could ever sign in. */
const PUBLIC_PATHS = new Set([
  "/login.html",
  "/api/auth/login",
  "/api/auth/logout",
  /* صفحة الدخول تُقدَّم لمن لا جلسة له، فكل ما تطلبه يجب أن يكون عامًا.
     كانت مكتفية ذاتيًا لأن الخطوط والأنماط كانت مضمّنة داخلها؛ بعد نقلهما
     إلى ملفات مشتركة صارا لازمين هنا وإلا ظهرت الصفحة بلا هوية بصرية. */
  "/ui.css",
  "/ui-theme.css",
  "/manifest.webmanifest",
]);

/* أصول ثابتة عامة تُطابَق بالبادئة. مقصورة على الخطوط والأيقونات عمدًا:
   لا يُفتح /assets/ كاملًا، ولا /permits/ ولا /payroll/ — فيها مستندات
   هوية وكشوف رواتب. */
const PUBLIC_PREFIXES = ["/assets/fonts/", "/assets/icons/"];

/* ما يلي البادئة يجب أن يكون اسم ملف بسيطًا ليس إلا.
   السبب: new URL() يطبّع "../" و "%2e%2e/" لكنه لا يطبّع الشرطة المرمّزة،
   فمسار مثل /assets/fonts/..%2f..%2fpermits/x.pdf يجتاز فحص البادئة كما
   هو، ثم قد يفكّه المخدّم الثابت فيصل إلى مستند محمي بلا جلسة. */
const SAFE_ASSET_NAME = /^[A-Za-z0-9._-]+$/;

function isPublicAsset(path) {
  const prefix = PUBLIC_PREFIXES.find((p) => path.startsWith(p));
  if (!prefix) return false;
  return SAFE_ASSET_NAME.test(path.slice(prefix.length));
}

export const config = {
  matcher: ["/((?!api/cron).*)"],
  runtime: "nodejs",
};

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const parts = header.split(";").map((s) => s.trim());
  const found = parts.find((s) => s.startsWith(name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

export default function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC_PATHS.has(path) || isPublicAsset(path)) return;

  const token = getCookie(request, "session");
  const payload = token ? verify(token) : null;
  if (payload) return;

  if (path.startsWith("/api/")) {
    return Response.json({ ok: false, error: "غير مسجّل الدخول" }, { status: 401 });
  }
  return Response.redirect(new URL("/login.html", request.url), 302);
}
