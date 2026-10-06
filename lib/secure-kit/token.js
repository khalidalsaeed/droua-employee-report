/* ─── توكن جلسة البوابة: مُرمِّز لكل وحدة ──────────────────────────────
   =========================================================================
   توقيع HMAC-SHA256 مستقلّ عن توكن جلسة المنصّة. لكل وحدة مُرمِّزها بنوعٍ
   خاصّ (`typ`) وسرٍّ خاصّ — فتوكن وحدةٍ لا يتحقّق في أخرى لا رياضيًا (سرٌّ
   مختلف) ولا بنيويًا (نوعٌ مختلف). الثاني دفاعٌ لو صار السرّان واحدًا يومًا
   بخطأ لصق.

   التوكن يحمل معرّف الجلسة (sid) لا حالتها: الحالة في القاعدة، وهي ما
   يجعل الإبطال حقيقيًا. والصيغة هنا مطابقة بايتًا ببايت لـlib/droua/gateToken.js
   — يُثبتها test/secure-kit-parity.test.js. */

const crypto = require("crypto");

const TYPE_RE = /^[a-z][a-z0-9-]{2,31}$/;

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest();
  return `${body}.${base64url(sig)}`;
}

/* معرّف الجلسة يُخزَّن مجزّأً في القاعدة، لا خامًا. */
function hashSid(sid) {
  return crypto.createHash("sha256").update(String(sid)).digest("hex");
}
function newSid() {
  return crypto.randomBytes(32).toString("hex");
}

function createTokenCodec({ type }) {
  if (!TYPE_RE.test(String(type || ""))) throw new Error("نوع توكن غير صالح");
  const TOKEN_TYPE = type;

  /* يُرجع الحمولة أو null. لا يرمي بحال. */
  function verify(token, secret, now = Date.now()) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    if (!body || !sig) return null;

    let expected, actual;
    try {
      expected = crypto.createHmac("sha256", secret).update(body).digest();
      actual = base64urlDecode(sig);
    } catch (err) {
      return null;
    }
    if (actual.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(actual, expected)) return null;

    let payload;
    try {
      payload = JSON.parse(base64urlDecode(body).toString("utf8"));
    } catch (err) {
      return null;
    }
    if (!payload || payload.typ !== TOKEN_TYPE) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.sid !== "string" || !payload.sid) return null;
    if (!Number.isFinite(payload.exp) || now >= payload.exp) return null;
    if (!Number.isFinite(payload.aexp) || now >= payload.aexp) return null;
    return payload;
  }

  /* السقف المطلق يُمرَّر كما هو عند التجديد ولا يُعاد حسابه أبدًا؛ والخمول
     لا يتجاوزه بحال. */
  function issue({ userId, sid, now, idleMs, absoluteExp }, secret) {
    const aexp = absoluteExp;
    const exp = Math.min(now + idleMs, aexp);
    return { token: sign({ typ: TOKEN_TYPE, sub: userId, sid, iat: now, exp, aexp }, secret), exp, aexp };
  }

  return { sign, verify, issue, hashSid, newSid, TOKEN_TYPE };
}

module.exports = { createTokenCodec, sign, hashSid, newSid };
