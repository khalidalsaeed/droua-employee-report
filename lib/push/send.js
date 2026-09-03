const { configure, isConfigured } = require("./vapid");
const subscriptions = require("./subscriptions");

/* إرسال إشعار واحد إلى اشتراك واحد، مع التعامل مع الاشتراكات الميتة.
   =========================================================================
   لا يرمي هذا الملف استثناءً عند فشل الإرسال إلى جهاز بعينه: جهاز واحد
   ميّت يجب ألّا يوقف بقيّة الأجهزة ولا مهمّة الـCron. النتيجة تُرجَع
   ككائن يصف ما حدث، ويقرّر المُنادي ما يفعله به.

   404/410 من خدمة الدفع تعنيان أن الاشتراك زال نهائيًا (أُلغي تثبيت
   التطبيق، أو مُسحت بيانات الموقع، أو جدّدت الخدمة الرمز). الرد الصحيح
   هو الحذف لا إعادة المحاولة — وإلّا تراكمت أجهزة ميّتة تُبطئ كل إرسال
   لاحق وتملأ السجلّ بأخطاء لا تنتهي. */

const GONE_CODES = new Set([404, 410]);

/* TTL: كم تحتفظ خدمة الدفع بالإشعار إن كان الجهاز غير متصل. اثنتا عشرة
   ساعة — التنبيه اليومي يفقد معناه بعد ذلك، ولا نريد وصول إشعار الأمس
   صباح اليوم التالي مع إشعار اليوم. */
const TTL_SECONDS = 12 * 60 * 60;

async function sendToSubscription(sub, payload, { ttl = TTL_SECONDS, urgency = "normal" } = {}) {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  const webpush = configure();
  const target = { endpoint: sub.endpoint, keys: sub.keys };
  try {
    const res = await webpush.sendNotification(target, JSON.stringify(payload), {
      TTL: ttl,
      urgency,
    });
    await subscriptions.markSuccess(sub.id);
    return { ok: true, statusCode: res && res.statusCode };
  } catch (err) {
    const statusCode = err && err.statusCode;
    if (GONE_CODES.has(statusCode)) {
      /* الاشتراك زال — يُحذف الصفّ. الحذف يُسقط أيضًا صفوف سجلّ الإشعارات
         المرتبطة به عبر ON DELETE CASCADE. */
      await subscriptions.removeById(sub.id);
      return { ok: false, gone: true, statusCode, reason: "gone" };
    }
    await subscriptions.markFailure(sub.id);
    /* 429 = تجاوز حدّ المعدّل عند خدمة الدفع؛ ليست خطأً في الاشتراك،
       فلا يُحذف ويُعاد في التشغيل التالي. */
    return {
      ok: false,
      gone: false,
      statusCode,
      retryable: statusCode === 429 || statusCode >= 500,
      reason: (err && err.message) || "فشل الإرسال",
    };
  }
}

/* إرسال الحمولة نفسها إلى عدّة اشتراكات. يمضي في القائمة كلها مهما فشل
   بعضها، ويُرجع تقريرًا مجمّعًا. */
async function sendToMany(subs, payload, opts) {
  const results = [];
  for (const sub of subs) {
    const r = await sendToSubscription(sub, payload, opts);
    results.push({ subscriptionId: sub.id, userId: sub.userId, ...r });
  }
  return {
    total: results.length,
    sent: results.filter((r) => r.ok).length,
    gone: results.filter((r) => r.gone).length,
    failed: results.filter((r) => !r.ok && !r.gone).length,
    results,
  };
}

module.exports = { sendToSubscription, sendToMany, TTL_SECONDS, GONE_CODES };
