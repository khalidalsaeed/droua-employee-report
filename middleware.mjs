import tokensPkg from "./lib/auth/tokens.js";
const { verify } = tokensPkg;

/* Every route runs through this except the Ajeer/expiration cron job, which
   is protected separately by its own CRON_SECRET bearer check and has no
   human session to check. Login itself, and the login page, must stay
   reachable or nobody could ever sign in. */
const PUBLIC_PATHS = new Set(["/login.html", "/api/auth/login", "/api/auth/logout"]);

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

  if (PUBLIC_PATHS.has(path)) return;

  const token = getCookie(request, "session");
  const payload = token ? verify(token) : null;
  if (payload) return;

  if (path.startsWith("/api/")) {
    return Response.json({ ok: false, error: "غير مسجّل الدخول" }, { status: 401 });
  }
  return Response.redirect(new URL("/login.html", request.url), 302);
}
