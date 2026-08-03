const { requireUser } = require("../../lib/auth/requireAuth");
const { isAdminLike, canManageUser, isValidRole } = require("../../lib/auth/roles");
const { findByIdRaw, updateUser } = require("../../lib/auth/users");
const { hashPassword } = require("../../lib/auth/passwords");
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

  const { id, name, email, role, status, password } = parseBody(req);
  if (!id) {
    res.status(400).json({ ok: false, error: "معرّف المستخدم مطلوب" });
    return;
  }

  const target = await findByIdRaw(id);
  if (!target) {
    res.status(404).json({ ok: false, error: "المستخدم غير موجود" });
    return;
  }
  if (!canManageUser(actor.role, target.role)) {
    res.status(403).json({ ok: false, error: "لا يمكنك تعديل حساب Owner" });
    return;
  }
  if (role && role !== target.role) {
    if (!isValidRole(role)) {
      res.status(400).json({ ok: false, error: "دور غير صالح" });
      return;
    }
    if ((role === "owner" || target.role === "owner") && actor.role !== "owner") {
      res.status(403).json({ ok: false, error: "فقط المالك يمكنه تعيين أو تغيير صلاحية Owner" });
      return;
    }
  }

  const patch = {};
  if (name) patch.name = name;
  if (email) patch.email = email;
  if (role) patch.role = role;
  if (status) patch.status = status;
  if (password) patch.passwordHash = hashPassword(password);

  try {
    const updated = await updateUser(id, patch);
    logEvent({ type: "user_updated", actorEmail: actor.email, actorId: actor.id, targetId: id, meta: { fields: Object.keys(patch) } });
    res.status(200).json({ ok: true, user: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err && err.message) || "تعذر تحديث المستخدم" });
  }
};
