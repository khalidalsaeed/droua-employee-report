const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");
const { isAdminLike } = require("../../lib/auth/roles");

/* Serves users.html only for authenticated Owner/Admin sessions — anyone
   else typing the URL directly is redirected server-side, not just hidden
   client-side. */
module.exports = async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html" });
    res.end();
    return;
  }
  if (!isAdminLike(user.role)) {
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(process.cwd(), "users.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
};
