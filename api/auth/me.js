const { requireUser } = require("../../lib/auth/requireAuth");
const { issueSessionToken } = require("../../lib/auth/tokens");
const { getCookie, sessionCookie } = require("../../lib/auth/cookies");
const { verify } = require("../../lib/auth/tokens");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  const user = await requireUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });
    return;
  }

  // Slide the idle-timeout window forward on activity (only for non-"remember" sessions).
  const token = getCookie(req, "session");
  const payload = verify(token);
  if (payload && !payload.remember) {
    const fresh = issueSessionToken(user, false);
    res.setHeader("Set-Cookie", sessionCookie(fresh, false));
  }

  res.status(200).json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
};
