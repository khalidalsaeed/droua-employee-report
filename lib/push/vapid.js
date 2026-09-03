const webpush = require("web-push");

/* إعداد VAPID من متغيّرات البيئة وحدها.
   =========================================================================
   المفتاح الخاص لا يوجد في المستودع ولا في أي ملف يُرفع إليه، ولا يُطبع في
   سجلّ ولا في رسالة خطأ. الدالّة الوحيدة التي تلمسه تسلّمه إلى web-push
   مباشرةً.

   isConfigured() تسمح للواجهة والـCron بالتدهور بهدوء حين لا تكون المفاتيح
   مضبوطة بعد: لا زرّ تفعيل يظهر للمستخدم، ولا يفشل الـCron — يتخطّى الدفع
   ويكمل البريد. */

let configured = null;

function readEnv() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = (process.env.VAPID_SUBJECT || "").trim();
  return { publicKey, privateKey, subject };
}

function isConfigured() {
  const { publicKey, privateKey, subject } = readEnv();
  return !!(publicKey && privateKey && subject);
}

/* المفتاح العام وحده — هذا ما يُسلَّم للمتصفّح ليبني به الاشتراك.
   عام بطبيعته: يُنشر في كل جهاز يشترك. */
function publicKey() {
  return readEnv().publicKey;
}

/* تُستدعى قبل كل إرسال. web-push يحتفظ بالإعداد عالميًا فتكفي مرّة واحدة
   لكل عملية تشغيل، لكن الدالّة رخيصة وتُبقي الشيفرة بلا حالة مخفية. */
function configure() {
  if (configured) return webpush;
  const { publicKey: pub, privateKey: priv, subject } = readEnv();
  if (!pub || !priv || !subject) {
    throw new Error("مفاتيح VAPID غير مُهيّأة على الخادم");
  }
  /* VAPID_SUBJECT يجب أن يكون mailto: أو https: وفق RFC 8292. خدمات الدفع
     ترفض غير ذلك برسالة غامضة، فيُفحص هنا حيث يُقرأ. */
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error("VAPID_SUBJECT يجب أن يبدأ بـ mailto: أو https://");
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return webpush;
}

module.exports = { isConfigured, publicKey, configure, webpush };
