/* ─── تدقيق أمنيّ لكل وحدة في جدولها ──────────────────────────────────
   =========================================================================
   جدولٌ مستقلّ لكل وحدة، لا audit_log المشترك: الجدول المشترك يكشف وجود
   الوحدة لمن يقرؤه، ويخلط تدقيقها بغيره.

   ── مُنقّي الحقول: قائمة مسموح تقدّمها الوحدة ──
   حقلٌ غير مُصنَّف يُسقط افتراضيًا. فلا يبلغ الجدولَ اسمُ ملفٍّ ولا مبلغٌ ولا
   نصٌّ حرّ لأن أحدهم أضافه إلى meta بعد سنة بلا انتباه.

   نصّ SQL والمُنقّي والبصمة مطابقة لـlib/droua/audit.js حين يُعطى الجدول
   droua_gate_audit وقائمة Droua بلا عمود الدور — يُثبتها اختبار التكافؤ.
   والوحدات الأحدث تُسجّل الدور أيضًا (`withRole`). */

const crypto = require("crypto");
const { assertTable } = require("./identifiers");

const MAX_STRING = 120;
const DEFAULT_THROTTLE_MS = 10 * 60 * 1000;
const ROLE_RE = /^[a-z_]{1,24}$/;

function makeSanitizer(allowed) {
  const set = new Set(allowed);
  return function sanitizeMeta(meta) {
    const out = {};
    for (const [key, value] of Object.entries(meta || {})) {
      if (!set.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      out[key] = typeof value === "string" ? value.slice(0, MAX_STRING) : value;
    }
    return out;
  };
}

/* بصمة العنوان: HMAC مقطوع بسرّ البوابة مع فصل مجال ("ip:"). ليست عنوانًا
   ولا تُعكس — غرضها أن يُرى فتحٌ من جهاز غير معتاد. */
function hashIp(ip, secret) {
  const value = String(ip || "").trim();
  if (!value || !secret) return null;
  return crypto.createHmac("sha256", secret).update("ip:" + value).digest("hex").slice(0, 16);
}

function clientIp(req) {
  const header = (req && req.headers && req.headers["x-forwarded-for"]) || "";
  return String(header).split(",")[0].trim() || null;
}

function createAudit({ table, allowedMeta, throttleMs = DEFAULT_THROTTLE_MS, withRole = false, label = "secure" }) {
  const name = assertTable(table);
  const sanitizeMeta = makeSanitizer(allowedMeta || []);
  const T = (sql) => sql.unsafe(name);
  const roleOf = (role) => (ROLE_RE.test(String(role || "")) ? String(role) : null);

  /* يرمي عند الفشل — لفتح البوابة وحده: بوابةٌ لا تُدقَّق يجب ألّا تُفتح. */
  async function logStrict(sql, { event, userId, role, meta, ip, secret }) {
    const metaJson = JSON.stringify(sanitizeMeta(meta));
    if (withRole) {
      await sql`
    INSERT INTO ${T(sql)} (event, user_id, role, meta, ip_hash)
    VALUES (${event}, ${userId || null}, ${roleOf(role)}, ${metaJson}::jsonb, ${hashIp(ip, secret)})`;
      return;
    }
    await sql`
    INSERT INTO ${T(sql)} (event, user_id, meta, ip_hash)
    VALUES (${event}, ${userId || null}, ${metaJson}::jsonb, ${hashIp(ip, secret)})`;
  }

  /* لا يرمي: عطلُ تدقيقٍ لا يُسقط عملية. */
  async function log(sql, entry) {
    try {
      await logStrict(sql, entry);
      return true;
    } catch (err) {
      console.error(`[${label}] audit write failed`);
      return false;
    }
  }

  /* صفٌّ واحد لكل (حدث، بصمة جهاز) في النافذة — لأحداث الاستكشاف التي
     يستطيع أي مستخدم مسجَّل أن يكرّرها في حلقة. */
  async function logThrottled(sql, { event, userId, meta, ip, secret, now = Date.now(), windowMs = throttleMs }) {
    try {
      const ipHash = hashIp(ip, secret);
      await sql`
      INSERT INTO ${T(sql)} (event, user_id, meta, ip_hash)
      SELECT ${event}, ${userId || null}, ${JSON.stringify(sanitizeMeta(meta))}::jsonb, ${ipHash}
      WHERE NOT EXISTS (
        SELECT 1 FROM ${T(sql)}
        WHERE event = ${event}
          AND ip_hash IS NOT DISTINCT FROM ${ipHash}
          AND ts > ${new Date(now - windowMs).toISOString()}::timestamptz
      )`;
      return true;
    } catch (err) {
      console.error(`[${label}] audit write failed`);
      return false;
    }
  }

  return { log, logStrict, logThrottled, sanitizeMeta, hashIp, clientIp, THROTTLE_MS: throttleMs, table: name };
}

module.exports = { createAudit, makeSanitizer, hashIp, clientIp, DEFAULT_THROTTLE_MS };
