const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");

/* Serves index.html itself, but only after verifying the session server-side —
   this is what actually blocks a direct/unauthenticated visit to "/", instead
   of relying on a client-side redirect that would still leak the page's
   embedded data in the initial HTML response. */
module.exports = async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html" });
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
};
