const { requireUser } = require("../../lib/auth/requireAuth");
const { isAdminLike, isValidRole, canManageUser } = require("../../lib/auth/roles");
const { createUser } = require("../../lib/auth/users");
const { hashPassword, generatePassword } = require("../../lib/auth/passwords");
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

  const { name, email, role, password } = parseBody(req);
  if (!name || !email || !role) {
    res.status(400).json({ ok: false, error: "الاسم والبريد الإلكتروني والدور مطلوبة" });
    return;
  }
  if (!isValidRole(role)) {
    res.status(400).json({ ok: false, error: "دور غير صالح" });
    return;
  }
  if (!canManageUser(actor.role, role)) {
    res.status(403).json({ ok: false, error: "فقط المالك يمكنه إنشاء حساب بصلاحية Owner" });
    return;
  }

  try {
    const generated = password ? null : generatePassword(14);
    const user = await createUser({
      name,
      email,
      role,
      passwordHash: hashPassword(password || generated),
      status: "active",
    });
    logEvent({ type: "user_created", actorEmail: actor.email, actorId: actor.id, targetId: user.id, meta: { role } });
    res.status(200).json({ ok: true, user, generatedPassword: generated || undefined });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err && err.message) || "تعذر إنشاء المستخدم" });
  }
};
