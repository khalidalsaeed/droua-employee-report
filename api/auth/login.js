const { findByEmailRaw, touchLastLogin } = require("../../lib/auth/users");
const { verifyPassword } = require("../../lib/auth/passwords");
const { issueSessionToken } = require("../../lib/auth/tokens");
const { sessionCookie } = require("../../lib/auth/cookies");
const { logEvent } = require("../../lib/auth/audit");
const { parseBody } = require("../../lib/auth/parseBody");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  const { email, password, remember } = parseBody(req);
  if (!email || !password) {
    res.status(400).json({ ok: false, error: "أدخل البريد الإلكتروني وكلمة المرور" });
    return;
  }

  const genericError = "البريد الإلكتروني أو كلمة المرور غير صحيحة";
  try {
    const user = await findByEmailRaw(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      logEvent({ type: "login_failed", actorEmail: email });
      res.status(401).json({ ok: false, error: genericError });
      return;
    }
    if (user.status !== "active") {
      logEvent({ type: "login_blocked_disabled", actorEmail: email, actorId: user.id });
      res.status(403).json({ ok: false, error: "هذا الحساب معطّل. تواصل مع مسؤول النظام." });
      return;
    }

    const remembered = !!remember;
    const token = issueSessionToken(user, remembered);
    res.setHeader("Set-Cookie", sessionCookie(token, remembered));
    await touchLastLogin(user.id);
    logEvent({ type: "login_success", actorEmail: user.email, actorId: user.id });
    res.status(200).json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) || "خطأ داخلي" });
  }
};
