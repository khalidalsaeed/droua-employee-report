/* ─── تدقيق أمنيّ لبوابة القسم ────────────────────────────────────────
   =========================================================================
   جدولٌ مستقلّ لا audit_log المشترك، لسببين: الفصل المطلوب عن أجير، وأن
   الجدول المشترك يكشف وجود القسم لمن يقرؤه.

   ── مُنقّي الحقول: قائمة مسموح لا قائمة ممنوع ──
   قائمةُ الممنوع تحمي ممّا فكّرنا فيه اليوم؛ وقائمةُ المسموح تحمي أيضًا
   ممّا يضيفه أحدنا بعد سنة بلا انتباه. فحقلٌ جديد يُسقَط افتراضيًا حتى
   يُصنَّف صراحةً — وهذا بالضبط الفرق بين نظام يصمد ونظام يتسرّب بهدوء. */

const crypto = require("crypto");

const META_ALLOWED = new Set([
  "reason",       // سبب مقنَّن من قائمة مغلقة — لا نصّ حرّ
  "route",
  "attempts",     // عدد لا محتوى
  "critical",
  "sessionAgeMs",
]);

const MAX_STRING = 120;

function sanitizeMeta(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (!META_ALLOWED.has(key)) continue;            // كل ما عداه يُسقط
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;          // لا كائنات ولا مصفوفات متداخلة
    out[key] = typeof value === "string" ? value.slice(0, MAX_STRING) : value;
  }
  return out;
}

/* بصمة العنوان: HMAC مقطوع بمفتاح البوابة مع فصل مجال. ليست عنوانًا ولا
   تُعكس، وغرضها واحد — أن يُرى أن فتحًا وقع من جهاز غير معتاد.

   فصل المجال ("ip:") هو ما يجعل إعادة استعمال سرّ التوقيع هنا سليمة، فلا
   يحتاج المشروع سرًّا سادسًا لهدفٍ ثانويّ. */
function hashIp(ip, secret) {
  const value = String(ip || "").trim();
  if (!value || !secret) return null;
  return crypto.createHmac("sha256", secret).update("ip:" + value).digest("hex").slice(0, 16);
}

function clientIp(req) {
  const header = (req && req.headers && req.headers["x-forwarded-for"]) || "";
  return String(header).split(",")[0].trim() || null;
}

/* لا يرمي: عطلُ تدقيقٍ لا يُسقط عملية. الاستثناء الوحيد هو فتح البوابة —
   والمُنادي هناك يستعمل logStrict. */
async function log(sql, { event, userId, meta, ip, secret }) {
  try {
    await logStrict(sql, { event, userId, meta, ip, secret });
    return true;
  } catch (err) {
    console.error("[secure-audit] audit write failed");
    return false;
  }
}

/* يرمي عند الفشل. يُستعمل لأحداث فتح البوابة: بوابةٌ لا تُدقَّق يجب ألّا
   تُفتح — وإلّا صار تعطيل التدقيق وسيلةَ فتحٍ صامت. */
async function logStrict(sql, { event, userId, meta, ip, secret }) {
  await sql`
    INSERT INTO droua_gate_audit (event, user_id, meta, ip_hash)
    VALUES (${event}, ${userId || null}, ${JSON.stringify(sanitizeMeta(meta))}::jsonb, ${hashIp(ip, secret)})`;
}

module.exports = { log, logStrict, sanitizeMeta, hashIp, clientIp, META_ALLOWED };
