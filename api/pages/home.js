const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");

/* Serves the app shell (app-shell.html) itself, but only after verifying the
   session server-side — this is what actually blocks a direct/unauthenticated
   visit to "/", instead of relying on a client-side redirect that would still
   leak the page's embedded data in the initial HTML response.

   The source file is named app-shell.html (not index.html) on purpose: Vercel
   gives static files unconditional precedence over rewrites when a file
   exists at the exact request path (confirmed in Vercel's own docs and by a
   Vercel engineer — https://github.com/vercel/vercel/discussions/5723). An
   "index.html" at the project root would always win over this function for
   "/", no matter what rewrites/routes config says. Renaming removes the
   conflict entirely; the public URL ("/") is unaffected. */
const NO_CACHE = { "Cache-Control": "no-store, must-revalidate" };

module.exports = async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html", ...NO_CACHE });
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(process.cwd(), "app-shell.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
  res.end(html);
};
