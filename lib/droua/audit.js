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

  /* ── أحداث الملفّات ──
     أربعة معرّفات وتصنيف: لا بيان رواتب فيها، وبها وحدها يُعرف مدى العطل.
     ولا `fileName` هنا بحال — اسمٌ كـ«مسير الرواتب كامل سبتمبر» بيانُ
     رواتب لا واصف، ووجوده في جدول التدقيق يُبطل قاعدة القسم كلّها. */
  "fileId",
  "runId",
  "kind",
  "encKeyId",
  /* المسار عشوائيّ بحكم التصميم — لا اسم فيه ولا صيغة ولا شهر — وهو ما
     يجعل تسجيله سليمًا. وبدونه لا يمكن كنس كائنٍ بقي بلا صفّ. */
  "pathname",
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

/* نافذة كتم التكرار لأحداث الاستكشاف. */
const THROTTLE_MS = 10 * 60 * 1000;

/* صفٌّ واحد لكل (حدث، بصمة جهاز) في النافذة — مهما تكرّر الطلب.

   لماذا: access_denied يُكتب لكل طلب مرفوض، وأي مستخدم مسجَّل في المنصّة
   يستطيع طرق مسار القسم في حلقة. بلا حدٍّ يملأ ذلك جدول التدقيق ويستهلك
   القاعدة — ويُغرق الإشارة الحقيقية في ضجيج، وهو أسوأ من ضياع المساحة:
   سجلٌّ لا يُقرأ لكثرته سجلٌّ معطَّل.

   عبارةٌ واحدة لا اثنتان (فحصٌ ثم إدراج): الاثنتان تفتحان سباقًا يكتب
   صفّين، وتكلّفان رحلتين. و IS NOT DISTINCT FROM يعامل NULL كقيمة تُطابَق
   — فطلبٌ بلا عنوان معروف لا يفلت من الحدّ.

   ⚠️ يستلزم الفهرس (event, ip_hash, ts DESC) وإلّا صار الفحص مسحًا كاملًا
   يزداد ثقلًا كلّما كبر الجدول — أي أن غياب الفهرس يقلب الحماية عبئًا. */
async function logThrottled(sql, { event, userId, meta, ip, secret, now = Date.now(), windowMs = THROTTLE_MS }) {
  try {
    const ipHash = hashIp(ip, secret);
    await sql`
      INSERT INTO droua_gate_audit (event, user_id, meta, ip_hash)
      SELECT ${event}, ${userId || null}, ${JSON.stringify(sanitizeMeta(meta))}::jsonb, ${ipHash}
      WHERE NOT EXISTS (
        SELECT 1 FROM droua_gate_audit
        WHERE event = ${event}
          AND ip_hash IS NOT DISTINCT FROM ${ipHash}
          AND ts > ${new Date(now - windowMs).toISOString()}::timestamptz
      )`;
    return true;
  } catch (err) {
    console.error("[secure-audit] audit write failed");
    return false;
  }
}

module.exports = { log, logStrict, logThrottled, sanitizeMeta, hashIp, clientIp, META_ALLOWED, THROTTLE_MS };
