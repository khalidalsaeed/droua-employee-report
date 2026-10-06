/* ─── الردود والرؤوس والكوكي ──────────────────────────────────────────
   =========================================================================
   ⚠️ ردّ الـ404 **لا يحمل رؤوس الأمان** عمدًا: يجب أن يطابق حرفيًا ردّ
   api/app.js على مسار غير موجود، وإلّا صار فرقُ الرؤوس دليلًا على أن هنا
   ما يُحرَس. ورؤوس الأمان للاستجابات المصرَّح بها وحدها.

   الأشكال مطابقة لـlib/droua/headers.js — يُثبتها اختبار التكافؤ. */

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

function secureApi(res) {
  res.setHeader("Cache-Control", "no-store, private, max-age=0, must-revalidate");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

/* CSP بـnonce لا 'unsafe-inline'. الافتراضيّ هو سياسة Droua حرفيًا؛ ووحدةٌ
   تحتاج مصدرًا إضافيًا (بلاطات خريطة لاحقًا) تمرّره صراحةً، فلا يتّسع
   الافتراضيّ لأحد. */
function defaultCsp(nonce) {
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; ` +
    `connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

function securePage(res, nonce, csp) {
  secureApi(res);
  res.setHeader("Content-Security-Policy", csp || defaultCsp(nonce));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
}

/* ─── الكوكي ─── */

function readCookie(req, name) {
  const header = (req && req.headers && req.headers.cookie) || "";
  const found = header.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
  if (!found) return null;
  try {
    return decodeURIComponent(found.slice(name.length + 1));
  } catch (err) {
    return null;
  }
}

/* ⚠️ `setHeader("Set-Cookie", …)` **يستبدل** ولا يضيف — وطلبٌ واحد قد يضع
   كوكيين (البوابة وجلسة المنصّة). فالإلحاق دائمًا. */
function appendCookie(res, value) {
  const current = res.getHeader("Set-Cookie");
  if (!current) return res.setHeader("Set-Cookie", value);
  return res.setHeader("Set-Cookie", (Array.isArray(current) ? current : [current]).concat(value));
}

const COOKIE_NAME_RE = /^[a-z][a-z0-9_]{2,31}$/;
const COOKIE_PATH_RE = /^\/[a-z0-9-]{3,48}$/;

/* كوكي البوابة بأضيق مسار يعمل للصفحة والـAPI معًا. وبحسب RFC 6265
   §5.1.4 لا يُرسل إلى /<path>XYZ: البادئة يجب أن تتبعها "/". */
function gateCookie({ name, path }) {
  if (!COOKIE_NAME_RE.test(String(name || ""))) throw new Error("اسم كوكي غير صالح");
  if (!COOKIE_PATH_RE.test(String(path || ""))) throw new Error("مسار كوكي غير صالح");
  const build = (token, maxAgeSeconds) =>
    `${name}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=${maxAgeSeconds}`;
  return { name, path, build, clear: () => build("", 0) };
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch (err) {
    return {};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* أرضيةٌ زمنية: لا يعود الردّ قبل `floorMs` من بدايته — فلا يكشف الزمنُ
   سببَ الفشل. */
async function floor(startedAt, floorMs) {
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

module.exports = {
  NO_CACHE, notFoundPage, notFoundApi, unauthenticatedPage, unauthenticatedApi,
  secureApi, securePage, defaultCsp,
  readCookie, appendCookie, gateCookie, parseJsonBody, sleep, floor,
};
