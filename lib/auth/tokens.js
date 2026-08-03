const crypto = require("crypto");

/* Hand-rolled HMAC-signed session token (JWT-like), using only Node's core
   crypto module so the exact same code runs both in the Node-runtime routing
   middleware and in regular serverless functions — no extra dependency. */

const IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes — default session idle timeout
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — "تذكرني"

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET غير مُهيّأ على الخادم");
  return secret;
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function sign(payload) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest();
  return `${body}.${base64url(sig)}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let actual, expected;
  try {
    expected = crypto.createHmac("sha256", getSecret()).update(body).digest();
    actual = base64urlDecode(sig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

/* Issues a fresh signed session token for a user. remember=true → 30-day
   fixed session; otherwise a 30-minute sliding idle timeout (callers should
   re-issue on each authenticated request to slide the window forward). */
function issueSessionToken(user, remember) {
  const now = Date.now();
  const ttl = remember ? REMEMBER_TTL_MS : IDLE_TTL_MS;
  return sign({
    sub: user.id,
    email: user.email,
    role: user.role,
    remember: !!remember,
    iat: now,
    exp: now + ttl,
  });
}

module.exports = { sign, verify, issueSessionToken, IDLE_TTL_MS, REMEMBER_TTL_MS };
