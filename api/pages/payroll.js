const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");
const { can } = require("../../lib/auth/roles");

/* Serves the payroll-shell.html page only for sessions whose role has the
   existing "finance" permission (owner/admin/finance/viewer — matches the
   financial-analysis section's existing access rule; HR does not get it).
   Anyone else typing "/payroll.html" directly is redirected server-side.
   Never cached at the edge — same reasoning as api/pages/home.js. */
const NO_CACHE = { "Cache-Control": "no-store, must-revalidate" };

module.exports = async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html", ...NO_CACHE });
    res.end();
    return;
  }
  if (!can(user.role, "finance")) {
    res.writeHead(302, { Location: "/", ...NO_CACHE });
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(process.cwd(), "payroll-shell.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
  res.end(html);
};
