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

/* دالّة خالصة كي تُختبر العتبات بلا قاعدة. */
function evaluate(counts) {
  return {
    locked: counts.short >= WINDOWS.short.threshold || counts.long >= WINDOWS.long.threshold,
    critical: counts.critical >= WINDOWS.critical.threshold,
  };
}

/* ── التسجيل قبل العدّ، في عبارة واحدة ──
   الترتيب هنا هو الأمان نفسه لا تحسين أداء.

   كان المسار: اقرأ العدّاد ← إن لم يكن مقفولًا فاشتقّ ← إن أخطأ فسجّل.
   وبين القراءة والتسجيل يقع اشتقاق scrypt (مئات الميلي‌ثانية)، فطلباتٌ
   متزامنة تقرأ العدّاد كلّها قبل أن يسجّل أيٌّ منها — فتجتاز جميعها فحص
   القفل. قياسٌ فعليّ: اثنتا عشرة محاولة متزامنة اجتازت كلّها والعتبة خمس،
   بينما التتابع يقف عند الخامسة كما يجب. أي أن التزامن كان يضرب الحدّ في
   عدد الطلبات.

   الآن: الإدراج والعدّ في عبارة واحدة، والعدّ يشمل المحاولة الحالية. فكل
   طلب يُثبت نفسه قبل أن يقرأ، وما يقرؤه يشمل كل ما أُثبت وثُبّت قبله.

   والعدّ على الإخفاقات **السابقة** لا شاملًا الحالية: السياسة «خمس محاولات
   فاشلة ثم قفل» تعني أن تُتاح خمس محاولات وتُردّ السادسة. وعبارةٌ تحوي CTE
   كاتبًا تقرأ بلقطةٍ سابقة لإدراجها فلا ترى صفّها أصلًا — وهو المطلوب
   بالضبط هنا، فلا زيادة ولا نقصان. أمّا صفوف الطلبات المتزامنة الأخرى
   فتظهر متى أُودعت قبل لقطة هذه العبارة، وهي الفائدة كلّها. */
async function recordAndCount(sql, userId, now) {
  const rows = await sql`
    WITH ins AS (
      INSERT INTO droua_gate_attempts (user_id, outcome, ts)
      VALUES (${userId}, 'fail', ${iso(now)}::timestamptz)
      RETURNING id
    )
    SELECT (SELECT id FROM ins) AS attempt_id,
      count(*) FILTER (WHERE ts > ${iso(now - WINDOWS.short.ms)}::timestamptz) AS short_count,
      count(*) FILTER (WHERE ts > ${iso(now - WINDOWS.long.ms)}::timestamptz) AS long_count,
      count(*) FILTER (WHERE ts > ${iso(now - WINDOWS.critical.ms)}::timestamptz) AS critical_count
    FROM droua_gate_attempts
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

/* محاولةٌ رُدَّت بالقفل لا تُحسب، فتُحذف بعد أن أدّت غرضها في العدّ.

   بلا هذا يمدّد الطرقُ المتكرّر النافذةَ فلا تنتهي أبدًا — أي قفلٌ دائم
   بدل ستّين دقيقة، وهو الخطر التشغيليّ الذي حُدّد السقف لأجله: أن يُفقد
   الوصول يومًا كاملًا بسبب خطأ متكرّر. */
async function forget(sql, attemptId) {
  if (attemptId === null || attemptId === undefined) return;
  await sql`DELETE FROM droua_gate_attempts WHERE id = ${attemptId}`;
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
  evaluate, recordAndCount, forget, clearFailures, prune,
};
