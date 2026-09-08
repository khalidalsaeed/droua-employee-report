/* ─── صفوف جلسات البوابة ──────────────────────────────────────────────
   =========================================================================
   لماذا صفٌّ في القاعدة أصلًا والتوكن موقَّع؟ لأن التوكن الموقَّع **لا
   يُبطَل**. بلا صفّ، «قفل القسم» يمسح الكوكي من متصفّحي فقط — ونسخةٌ
   مسروقة تبقى صالحة حتى انتهاء مدّتها. الصفّ هو ما يجعل revoked_at فعّالًا.

   ما لا يُخزَّن هنا: التوكن الخام، ولا معرّف الجلسة الخام (بل sha256 له)،
   ولا عنوان IP، ولا User-Agent. الربط بالـUA حمايةٌ ضعيفة: يتغيّر مع كل
   تحديث متصفّح فيقطع جلسة مشروعة، ولا يمنع من ينسخ الترويسة. */

const IDLE_MS = 15 * 60 * 1000;      // مهلة الخمول — تنزلق
const ABSOLUTE_MS = 60 * 60 * 1000;  // السقف المطلق — لا يُمدَّد أبدًا

const iso = (ms) => new Date(ms).toISOString();

async function create(sql, { sidHash, userId, now }) {
  const absoluteExp = now + ABSOLUTE_MS;
  const idleExp = Math.min(now + IDLE_MS, absoluteExp);
  await sql`
    INSERT INTO droua_gate_sessions (sid_hash, user_id, issued_at, last_seen_at, idle_exp, absolute_exp)
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
    FROM droua_gate_sessions WHERE sid_hash = ${sidHash}`;
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

/* الجلسة صالحة إذا: غير مُبطَلة، وصاحبها هو صاحب الطلب، ولم يتجاوز الوقت
   الخمولَ ولا السقف. الأربعة معًا لا أحدها. */
function isUsable(session, userId, now) {
  if (!session) return false;
  if (session.revokedAt) return false;
  if (session.userId !== userId) return false;
  if (!(now < session.idleExp)) return false;
  if (!(now < session.absoluteExp)) return false;
  return true;
}

/* الانزلاق. min(...) هو الحاجز الذي يمنع الخمول من تجاوز السقف: بلا هذا
   السطر تصير جلسةٌ نشطة أبديّة. */
async function touch(sql, session, now) {
  const idleExp = Math.min(now + IDLE_MS, session.absoluteExp);
  await sql`
    UPDATE droua_gate_sessions
    SET last_seen_at = ${iso(now)}::timestamptz, idle_exp = ${iso(idleExp)}::timestamptz
    WHERE sid_hash = ${session.sidHash} AND revoked_at IS NULL`;
  return idleExp;
}

async function revoke(sql, sidHash, now) {
  await sql`
    UPDATE droua_gate_sessions SET revoked_at = ${iso(now)}::timestamptz
    WHERE sid_hash = ${sidHash} AND revoked_at IS NULL`;
}

/* لإجراء الطوارئ في الـRunbook: إبطال كل جلسات البوابة دفعةً واحدة. لا
   يمسّ جلسات المنصّة ولا جدول users. */
async function revokeAllForUser(sql, userId, now) {
  await sql`
    UPDATE droua_gate_sessions SET revoked_at = ${iso(now)}::timestamptz
    WHERE user_id = ${userId} AND revoked_at IS NULL`;
}

module.exports = { create, load, isUsable, touch, revoke, revokeAllForUser, IDLE_MS, ABSOLUTE_MS };
