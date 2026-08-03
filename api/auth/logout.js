const { verify } = require("../../lib/auth/tokens");
const { getCookie, clearSessionCookie } = require("../../lib/auth/cookies");
const { logEvent } = require("../../lib/auth/audit");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  const token = getCookie(req, "session");
  const payload = token ? verify(token) : null;
  res.setHeader("Set-Cookie", clearSessionCookie());
  if (payload) logEvent({ type: "logout", actorEmail: payload.email, actorId: payload.sub });
  res.status(200).json({ ok: true });
};
