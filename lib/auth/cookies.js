const { IDLE_TTL_MS, REMEMBER_TTL_MS } = require("./tokens");

function getCookie(req, name) {
  const header = (req.headers && req.headers.cookie) || "";
  const parts = header.split(";").map((s) => s.trim());
  const found = parts.find((s) => s.startsWith(name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

function sessionCookie(token, remember) {
  const maxAge = Math.floor((remember ? REMEMBER_TTL_MS : IDLE_TTL_MS) / 1000);
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}

module.exports = { getCookie, sessionCookie, clearSessionCookie };
