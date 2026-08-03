const { requireUser } = require("../../lib/auth/requireAuth");
const { isAdminLike } = require("../../lib/auth/roles");
const { listUsers } = require("../../lib/auth/users");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  const actor = await requireUser(req);
  if (!actor) {
    res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });
    return;
  }
  if (!isAdminLike(actor.role)) {
    res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
    return;
  }
  const users = await listUsers();
  res.status(200).json({ ok: true, users });
};
