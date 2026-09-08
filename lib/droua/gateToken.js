/* ─── توكن جلسة البوابة ────────────────────────────────────────────────
   =========================================================================
   توقيع HMAC-SHA256 مستقلّ تمامًا عن توكن جلسة المنصّة:

     • سرٌّ مختلف (DROUA_GATE_SECRET لا SESSION_SECRET) — فتوكن أحدهما لا
       يتحقّق في الآخر رياضيًا.
     • حقل typ يُفحص صراحةً — دفاعٌ ثانٍ لو صار السرّان واحدًا يومًا بخطأ.

   التوكن يحمل معرّف الجلسة (sid) لا حالتها: الحالة في القاعدة، وهي ما
   يجعل الإبطال حقيقيًا. فالتوكن يُثبت «اجتزتُ كلمة المرور»، لا «أنا
   مصرَّح لي» — التصريح يُعاد فحصه في كل طلب. */

const crypto = require("crypto");

const TOKEN_TYPE = "droua-gate";

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

/* يُرجع الحمولة أو null. لا يرمي بحال — أي مدخل مشوّه فشلٌ صامت. */
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
  /* المهلتان تُفحصان هنا أيضًا وإن كانتا مفحوصتين في القاعدة: توكن منتهٍ
     يُرفض بلا رحلة إلى Neon، والقاعدة تبقى المرجع النهائي. */
  if (!Number.isFinite(payload.exp) || now >= payload.exp) return null;
  if (!Number.isFinite(payload.aexp) || now >= payload.aexp) return null;
  return payload;
}

function issue({ userId, sid, now, idleMs, absoluteExp }, secret) {
  /* السقف المطلق يُمرَّر كما هو عند التجديد ولا يُعاد حسابه أبدًا؛ والخمول
     لا يتجاوزه بحال. هذا هو السطر الذي يمنع تمديد الجلسة إلى الأبد. */
  const aexp = absoluteExp;
  const exp = Math.min(now + idleMs, aexp);
  return { token: sign({ typ: TOKEN_TYPE, sub: userId, sid, iat: now, exp, aexp }, secret), exp, aexp };
}

/* معرّف الجلسة يُخزَّن مجزّأً في القاعدة، لا خامًا: تسريب القاعدة وحده لا
   يعطي شيئًا قابلًا للاستعمال. */
function hashSid(sid) {
  return crypto.createHash("sha256").update(String(sid)).digest("hex");
}
function newSid() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = { sign, verify, issue, hashSid, newSid, TOKEN_TYPE };
