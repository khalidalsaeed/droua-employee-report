/* ─── الحدّ من محاولات فتح البوابة ─────────────────────────────────────
   =========================================================================
   العدّ في القاعدة لا في الذاكرة: كل طلب على Vercel قد يقع على نسخة دالّة
   أخرى، فعدّادٌ في الذاكرة ضابطٌ وهميّ.

   نافذةٌ متدحرّجة لا «قفلٌ» مخزَّن. والسياسة الافتراضية هي سياسة Droua:
     5  إخفاقات / 15 دقيقة  → قفل        10 / 60 دقيقة → قفل
     15 / 24 ساعة           → حدث critical، بلا تمديد قفل

   والتسجيل **قبل** العدّ في عبارة واحدة: التزامن كان يضرب الحدّ في عدد
   الطلبات (انظر شرح lib/droua/rateLimit.js). نصّ SQL مطابق لـDroua حين
   يكون الجدول droua_gate_attempts — يُثبته اختبار التكافؤ. */

const { assertTable } = require("./identifiers");

const DEFAULT_WINDOWS = Object.freeze({
  short: Object.freeze({ ms: 15 * 60 * 1000, threshold: 5 }),
  long: Object.freeze({ ms: 60 * 60 * 1000, threshold: 10 }),
  critical: Object.freeze({ ms: 24 * 60 * 60 * 1000, threshold: 15 }),
});
const DEFAULT_PRUNE_MS = 30 * 24 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

function createRateLimiter({ table, windows = DEFAULT_WINDOWS, pruneMs = DEFAULT_PRUNE_MS }) {
  const name = assertTable(table);
  const W = windows;
  const T = (sql) => sql.unsafe(name);

  function evaluate(counts) {
    return {
      locked: counts.short >= W.short.threshold || counts.long >= W.long.threshold,
      critical: counts.critical >= W.critical.threshold,
    };
  }

  async function recordAndCount(sql, userId, now) {
    const rows = await sql`
    WITH ins AS (
      INSERT INTO ${T(sql)} (user_id, outcome, ts)
      VALUES (${userId}, 'fail', ${iso(now)}::timestamptz)
      RETURNING id
    )
    SELECT (SELECT id FROM ins) AS attempt_id,
      count(*) FILTER (WHERE ts > ${iso(now - W.short.ms)}::timestamptz) AS short_count,
      count(*) FILTER (WHERE ts > ${iso(now - W.long.ms)}::timestamptz) AS long_count,
      count(*) FILTER (WHERE ts > ${iso(now - W.critical.ms)}::timestamptz) AS critical_count
    FROM ${T(sql)}
    WHERE user_id = ${userId} AND outcome = 'fail'`;
    const row = (rows && rows[0]) || {};
    return {
      attemptId: row.attempt_id != null ? row.attempt_id : null,
      counts: {
        short: Number(row.short_count || 0),
        long: Number(row.long_count || 0),
        critical: Number(row.critical_count || 0),
      },
    };
  }

  /* محاولةٌ رُدَّت بالقفل لا تُحسب — وإلّا مدّد الطرقُ المتكرّر النافذةَ
     فصار القفل دائمًا. */
  async function forget(sql, attemptId) {
    if (attemptId === null || attemptId === undefined) return;
    await sql`DELETE FROM ${T(sql)} WHERE id = ${attemptId}`;
  }

  async function clearFailures(sql, userId) {
    await sql`DELETE FROM ${T(sql)} WHERE user_id = ${userId} AND outcome = 'fail'`;
  }

  async function prune(sql, now) {
    await sql`DELETE FROM ${T(sql)} WHERE ts < ${iso(now - pruneMs)}::timestamptz`;
  }

  return {
    WINDOWS: W, MAX_LOCK_MS: W.long.ms, PRUNE_MS: pruneMs, table: name,
    evaluate, recordAndCount, forget, clearFailures, prune,
  };
}

module.exports = { createRateLimiter, DEFAULT_WINDOWS, DEFAULT_PRUNE_MS };
