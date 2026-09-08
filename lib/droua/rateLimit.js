/* ─── الحدّ من محاولات فتح البوابة ─────────────────────────────────────
   =========================================================================
   العدّ في Neon لا في الذاكرة. هذا ليس تفضيلًا: كل طلب على Vercel قد يقع
   على نسخة دالّة جديدة أو متوازية، فعدّادٌ في الذاكرة يمرّ في الاختبار
   ويفشل في الإنتاج بصمت — ضابطٌ وهميّ لا ضابط.

   الآلية نافذةٌ زمنية متدحرّجة لا «قفلٌ» مخزَّن: نعدّ إخفاقات المستخدم في
   النوافذ الثلاث، فإن بلغت العتبة فهو مقفول. ومدّة القفل تنشأ من ذلك
   تلقائيًا — فإخفاقاتٌ تخرج من النافذة تفتح البوابة من نفسها بلا صفٍّ
   يُحدَّث ولا مهمّة تنظيف.

   السياسة (أقصى قفل 60 دقيقة عمدًا):

     5  إخفاقات خلال 15 دقيقة  →  قفل حتى تخرج الخامسة من النافذة  (≤ 15د)
     10 إخفاقات خلال 60 دقيقة  →  قفل حتى تخرج العاشرة              (≤ 60د)
     15 إخفاقًا خلال 24 ساعة   →  حدث critical في التدقيق — بلا تمديد قفل

   العتبة الثالثة تُبلِّغ ولا تُطيل. القسم لمستخدم واحد، وقفل يوم كامل خطرٌ
   تشغيليّ حقيقيّ (فقدان الوصول بسبب خطأ متكرّر) يفوق ما يضيفه أمنيًا فوق
   أربع طبقات قائمة: كلمة مرور الحساب، وكلمة مرور البوابة، والحساب المحميّ،
   والجلسة المحدودة. */

const WINDOWS = {
  short: { ms: 15 * 60 * 1000, threshold: 5 },
  long: { ms: 60 * 60 * 1000, threshold: 10 },
  critical: { ms: 24 * 60 * 60 * 1000, threshold: 15 },
};

/* حدّ أقصى للقفل مُعلن صراحةً كي يُختبر: لا مسار في هذه الوحدة يُنتج قفلًا
   أطول من أطول نافذة قافلة. */
const MAX_LOCK_MS = WINDOWS.long.ms;

const PRUNE_MS = 30 * 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/* استعلام واحد يُرجع العدّادات الثلاثة — لا ثلاث رحلات إلى القاعدة. */
async function failureCounts(sql, userId, now) {
  const rows = await sql`
    SELECT
      count(*) FILTER (WHERE ts > ${iso(now - WINDOWS.short.ms)}::timestamptz) AS short_count,
      count(*) FILTER (WHERE ts > ${iso(now - WINDOWS.long.ms)}::timestamptz) AS long_count,
      count(*) FILTER (WHERE ts > ${iso(now - WINDOWS.critical.ms)}::timestamptz) AS critical_count
    FROM droua_gate_attempts
    WHERE user_id = ${userId} AND outcome = 'fail'`;
  const row = (rows && rows[0]) || {};
  return {
    short: Number(row.short_count || 0),
    long: Number(row.long_count || 0),
    critical: Number(row.critical_count || 0),
  };
}

/* دالّة خالصة كي تُختبر العتبات بلا قاعدة. */
function evaluate(counts) {
  return {
    locked: counts.short >= WINDOWS.short.threshold || counts.long >= WINDOWS.long.threshold,
    critical: counts.critical >= WINDOWS.critical.threshold,
  };
}

async function status(sql, userId, now) {
  return evaluate(await failureCounts(sql, userId, now));
}

async function recordFailure(sql, userId, now) {
  await sql`
    INSERT INTO droua_gate_attempts (user_id, outcome, ts)
    VALUES (${userId}, 'fail', ${iso(now)}::timestamptz)`;
}

/* نجاحٌ واحد يمسح العدّاد: الإخفاقات السابقة لم تكن هجومًا ناجحًا، وإبقاؤها
   يقفل البوابة على صاحبها بعد أن أثبت أنه هو. */
async function clearFailures(sql, userId) {
  await sql`DELETE FROM droua_gate_attempts WHERE user_id = ${userId} AND outcome = 'fail'`;
}

/* تنظيف يركب على نداءٍ قائم بدل مهمّة مجدولة — لا كرون جديد ولا خانة
   إضافية في خطّة Vercel. */
async function prune(sql, now) {
  await sql`DELETE FROM droua_gate_attempts WHERE ts < ${iso(now - PRUNE_MS)}::timestamptz`;
}

module.exports = {
  WINDOWS, MAX_LOCK_MS, PRUNE_MS,
  failureCounts, evaluate, status, recordFailure, clearFailures, prune,
};
