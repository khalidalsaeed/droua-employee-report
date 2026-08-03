const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");
const { isAdminLike } = require("../../lib/auth/roles");

/* Serves the users-shell.html page only for authenticated Owner/Admin
   sessions — anyone else typing the "/users.html" URL directly is redirected
   server-side, not just hidden client-side. Never cached at the edge — see
   api/pages/home.js for why.

   Source file is named users-shell.html, not users.html — same static-file-
   beats-rewrite conflict described in api/pages/home.js. The public URL
   ("/users.html") is unaffected. */
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
  const html = fs.readFileSync(path.join(process.cwd(), "users-shell.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
  res.end(html);
};
