const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");

/* Serves index.html itself, but only after verifying the session server-side —
   this is what actually blocks a direct/unauthenticated visit to "/", instead
   of relying on a client-side redirect that would still leak the page's
   embedded data in the initial HTML response. */
/* This response depends on the caller's session cookie, so it must never be
   cached at Vercel's edge — otherwise the FIRST hit (e.g. an unauthenticated
   or stale one) gets served to every subsequent visitor regardless of who
   they are or whether they're logged in. This was the actual production bug. */
const NO_CACHE = { "Cache-Control": "no-store, must-revalidate" };

module.exports = async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html", ...NO_CACHE });
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
  res.end(html);
};
