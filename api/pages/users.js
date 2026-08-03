const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");
const { isAdminLike } = require("../../lib/auth/roles");

/* Serves users.html only for authenticated Owner/Admin sessions — anyone
   else typing the URL directly is redirected server-side, not just hidden
   client-side. Never cached at the edge — see api/pages/home.js for why. */
const NO_CACHE = { "Cache-Control": "no-store, must-revalidate" };

module.exports = async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html", ...NO_CACHE });
    res.end();
    return;
  }
  if (!isAdminLike(user.role)) {
    res.writeHead(302, { Location: "/", ...NO_CACHE });
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(process.cwd(), "users.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
  res.end(html);
};
