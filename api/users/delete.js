const { requireUser } = require("../../lib/auth/requireAuth");
const { isAdminLike, canManageUser } = require("../../lib/auth/roles");
const { findByIdRaw, deleteUser } = require("../../lib/auth/users");
const { logEvent } = require("../../lib/auth/audit");
const { parseBody } = require("../../lib/auth/parseBody");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  const actor = await requireUser(req);
  if (!actor) {
    res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });
    return;
  }
  if (!isAdminLike(actor.role)) {
    res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
    return;
  }

  const { id } = parseBody(req);
  if (!id) {
    res.status(400).json({ ok: false, error: "معرّف المستخدم مطلوب" });
    return;
  }
  if (id === actor.id) {
    res.status(400).json({ ok: false, error: "لا يمكنك حذف حسابك الخاص" });
    return;
  }

  const target = await findByIdRaw(id);
  if (!target) {
    res.status(404).json({ ok: false, error: "المستخدم غير موجود" });
    return;
  }
  if (!canManageUser(actor.role, target.role)) {
    res.status(403).json({ ok: false, error: "لا يمكنك حذف حساب Owner" });
    return;
  }

  await deleteUser(id);
  logEvent({ type: "user_deleted", actorEmail: actor.email, actorId: actor.id, targetId: id, meta: { deletedEmail: target.email } });
  res.status(200).json({ ok: true });
};
