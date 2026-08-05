const fs = require("fs");
const path = require("path");
const { requireUser } = require("../../lib/auth/requireAuth");
const { can } = require("../../lib/auth/roles");

/* Serves the payroll-detail-shell.html page — one independent page per
   payroll-run id (/payroll/:id), gated by the same "finance" permission as
   the payroll index page. The actual run data is fetched client-side from
   /api/payroll/detail?id=..., so this handler never needs to know about
   individual months. Never cached at the edge — same reasoning as
   api/pages/payroll.js. */
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
  const html = fs.readFileSync(path.join(process.cwd(), "payroll-detail-shell.html"), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
  res.end(html);
};
