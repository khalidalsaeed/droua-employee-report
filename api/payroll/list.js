const { requireUser } = require("../../lib/auth/requireAuth");
const { can } = require("../../lib/auth/roles");
const { listPayrollRuns } = require("../../lib/payroll/runs");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  const user = await requireUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });
    return;
  }
  if (!can(user.role, "finance")) {
    res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
    return;
  }
  const runs = await listPayrollRuns();
  res.status(200).json({ ok: true, runs });
};
