const { requireUser } = require("../../lib/auth/requireAuth");
const { can } = require("../../lib/auth/roles");
const { listPayrollRuns, getPayrollRunById } = require("../../lib/payroll/runs");

/* Also answers single-run lookups via ?id= (used by the payroll detail
   page) so the detail feature didn't need its own Serverless Function —
   the Hobby plan caps a deployment at 12 functions. */
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
  const { id } = req.query || {};
  if (id) {
    const run = await getPayrollRunById(id);
    if (!run) {
      res.status(404).json({ ok: false, error: "مسير الرواتب غير موجود" });
      return;
    }
    res.status(200).json({ ok: true, run });
    return;
  }
  const runs = await listPayrollRuns();
  res.status(200).json({ ok: true, runs });
};
