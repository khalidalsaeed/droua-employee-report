/* ─── صفوف جلسات البوابة ──────────────────────────────────────────────
   =========================================================================
   لماذا صفٌّ في القاعدة والتوكن موقَّع؟ لأن التوكن الموقَّع **لا يُبطَل**.
   الصفّ هو ما يجعل «قفل القسم» إبطالًا حقيقيًا لا مسحًا لكوكي متصفّح واحد.

   لا يُخزَّن هنا التوكن الخام، ولا معرّف الجلسة الخام (بل sha256 له)، ولا
   عنوان IP، ولا User-Agent.

   المدّتان معاملان لكل وحدة؛ والقيم الافتراضية (15 و60 دقيقة) هي سياسة
   Droua نفسها. ونصّ SQL مطابق لـlib/droua/gateSessions.js حين يكون الجدول
   droua_gate_sessions — يُثبته اختبار التكافؤ. */

const { assertTable } = require("./identifiers");

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_ABSOLUTE_MS = 60 * 60 * 1000;
const DEFAULT_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

function createSessionStore({
  table, idleMs = DEFAULT_IDLE_MS, absoluteMs = DEFAULT_ABSOLUTE_MS, pruneGraceMs = DEFAULT_PRUNE_GRACE_MS,
}) {
  const name = assertTable(table);
  if (!(idleMs > 0) || !(absoluteMs >= idleMs)) throw new Error("مدد الجلسة غير متّسقة");
  const T = (sql) => sql.unsafe(name);

  async function create(sql, { sidHash, userId, now }) {
    const absoluteExp = now + absoluteMs;
    const idleExp = Math.min(now + idleMs, absoluteExp);
    await sql`
    INSERT INTO ${T(sql)} (sid_hash, user_id, issued_at, last_seen_at, idle_exp, absolute_exp)
    VALUES (${sidHash}, ${userId}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz,
            ${iso(idleExp)}::timestamptz, ${iso(absoluteExp)}::timestamptz)`;
    return { idleExp, absoluteExp };
  }

  async function load(sql, sidHash) {
    const rows = await sql`
    SELECT sid_hash, user_id,
           extract(epoch from idle_exp) * 1000 AS idle_exp_ms,
           extract(epoch from absolute_exp) * 1000 AS absolute_exp_ms,
           revoked_at
    FROM ${T(sql)} WHERE sid_hash = ${sidHash}`;
    const row = rows && rows[0];
    if (!row) return null;
    return {
      sidHash: row.sid_hash,
      userId: row.user_id,
      idleExp: Number(row.idle_exp_ms),
      absoluteExp: Number(row.absolute_exp_ms),
      revokedAt: row.revoked_at || null,
    };
  }

  /* الأربعة معًا لا أحدها: غير مُبطَلة، وصاحبها صاحب الطلب، ولم يتجاوز
     الوقت الخمولَ ولا السقف. */
  function isUsable(session, userId, now) {
    if (!session) return false;
    if (session.revokedAt) return false;
    if (session.userId !== userId) return false;
    if (!(now < session.idleExp)) return false;
    if (!(now < session.absoluteExp)) return false;
    return true;
  }

  /* min(...) هو الحاجز الذي يمنع الخمول من تجاوز السقف. */
  async function touch(sql, session, now) {
    const idleExp = Math.min(now + idleMs, session.absoluteExp);
    await sql`
    UPDATE ${T(sql)}
    SET last_seen_at = ${iso(now)}::timestamptz, idle_exp = ${iso(idleExp)}::timestamptz
    WHERE sid_hash = ${session.sidHash} AND revoked_at IS NULL`;
    return idleExp;
  }

  async function revoke(sql, sidHash, now) {
    await sql`
    UPDATE ${T(sql)} SET revoked_at = ${iso(now)}::timestamptz
    WHERE sid_hash = ${sidHash} AND revoked_at IS NULL`;
  }

  async function revokeAllForUser(sql, userId, now) {
    await sql`
    UPDATE ${T(sql)} SET revoked_at = ${iso(now)}::timestamptz
    WHERE user_id = ${userId} AND revoked_at IS NULL`;
  }

  /* يفشل مغلقًا: توكنٌ يشير إلى صفٍّ محذوف لا يجد جلسته فيُردّ مقفولًا. */
  async function prune(sql, now) {
    await sql`
    DELETE FROM ${T(sql)}
    WHERE absolute_exp < ${iso(now - pruneGraceMs)}::timestamptz`;
  }

  return {
    create, load, isUsable, touch, revoke, revokeAllForUser, prune,
    IDLE_MS: idleMs, ABSOLUTE_MS: absoluteMs, SESSION_PRUNE_GRACE_MS: pruneGraceMs, table: name,
  };
}

module.exports = { createSessionStore, DEFAULT_IDLE_MS, DEFAULT_ABSOLUTE_MS, DEFAULT_PRUNE_GRACE_MS };
