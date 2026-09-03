/* sw.js — عامل الخدمة (Service Worker).
   =========================================================================
   وظيفته الوحيدة استقبال إشعارات الدفع وفتح الصفحة الصحيحة عند الضغط
   عليها. لا تخزين مؤقّت ولا اعتراض للطلبات: المنصّة تُقدَّم بـ
   Cache-Control: no-store عمدًا (بيانات موارد بشرية تتغيّر لحظيًا)،
   وأي طبقة تخزين هنا كانت ستعرض بيانات قديمة أو مستندات محمية بعد تسجيل
   الخروج. لا حدث fetch في هذا الملف على الإطلاق.

   الملف عامّ في middleware.mjs ولا يحوي سرًّا. السبب أنه عامّ: المتصفّح
   يُعيد جلب سكربت عامل الخدمة دوريًا للتحقّق من التحديث، وقد يقع ذلك
   والجلسة منتهية — فيردّ الوسيط بتحويل 302 إلى صفحة الدخول، والتحويل على
   سكربت عامل الخدمة خطأ قاطع يُبطل العامل المسجَّل ويُسقط الإشعارات صمتًا.

   يُقدَّم من الجذر ليكون نطاقه كامل الموقع. */

/* التفعيل فورًا بلا انتظار إغلاق التبويبات، والسيطرة على الصفحات المفتوحة
   — وإلّا بقي عامل قديم مسيطرًا بعد التحديث. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ---------- استقبال الإشعار ---------- */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    /* حمولة غير متوقّعة — لا تُسقط الإشعار بصمت، اعرض نصًّا عامًّا. */
    data = {};
  }

  const title = data.title || "ذروة الصعود";
  const options = {
    body: data.body || "",
    dir: "rtl",
    lang: "ar",
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/icon-192.png",
    /* tag يمنع تراكم إشعارات اليوم نفسه فوق بعضها؛ renotify يجعل الإشعار
       الجديد يُنبّه فعلًا رغم استبداله للسابق. */
    tag: data.tag || "droua",
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || "/expiring.html", kind: data.kind || "generic" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ---------- الضغط على الإشعار ----------
   وجهة الاحتياط مكتوبة مرّة واحدة ويشير إليها كل مسار في المعالج، فلا
   تتفرّق نسخ منها في الملف. */
const CLICK_FALLBACK_URL = "/expiring.html";

/* عنوان النافذة قد يكون غير قابل للتحليل (about:blank مثلًا)، وتحليله بلا
   حرز يرمي فيُسقط العملية كلها. */
function clientOrigin(client) {
  try {
    return new URL(client.url).origin;
  } catch (err) {
    return null;
  }
}

/* الوجهة مطلقةً دائمًا، منسوبة إلى self.location.origin. أي مدخل تالف أو
   عنوان خارج أصل المنصّة يرتدّ إلى وجهة الاحتياط: لا يصحّ أن يوجّه إشعارٌ
   نافذةَ المنصّة إلى أصل آخر. */
function resolveTarget(raw) {
  const origin = self.location.origin;
  let url;
  try {
    url = new URL(raw || CLICK_FALLBACK_URL, origin);
  } catch (err) {
    return new URL(CLICK_FALLBACK_URL, origin);
  }
  return url.origin === origin ? url : new URL(CLICK_FALLBACK_URL, origin);
}

/* فتح الوجهة: تركيز نافذة قائمة إن وُجدت، وإلّا فتح واحدة.
   =========================================================================
   الترتيب هنا مقصود، والسبب عطلٌ حقيقي ظهر على Production: navigate() ترمي
   TypeError حين لا تكون النافذة مسيطَرًا عليها من هذا العامل — و
   includeUncontrolled: true تضع نوافذ غير مسيطَر عليها في القائمة أصلًا
   (نافذة فُتحت قبل أن يسيطر العامل، أو بعد تحديث سكربته، أو بعد إعادة
   تشغيله). كان الرمي ينتشر خارج waitUntil فلا يحدث شيء إطلاقًا: لا انتقال
   ولا نافذة جديدة، وهو عين ما وُصف بأنه «أحيانًا لا يحدث شيء».

   فكل محاولة معزولة في try الآن: فشلُ نافذة يمضي إلى التالية، وفشل الجميع
   يمضي إلى openWindow — فلا يبقى الضغط بلا أثر. */
async function openNotificationTarget(rawUrl) {
  const url = resolveTarget(rawUrl);

  let windows = [];
  try {
    windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  } catch (err) {
    windows = [];
  }

  const sameOrigin = windows.filter((client) => clientOrigin(client) === url.origin);
  /* نافذة واقفة على الوجهة نفسها تُقدَّم على غيرها: تحتاج تركيزًا وحده،
     فلا يُعاد تحميل صفحة يقرأها المستخدم أصلًا. */
  const ordered = [
    ...sameOrigin.filter((client) => client.url === url.href),
    ...sameOrigin.filter((client) => client.url !== url.href),
  ];

  for (const client of ordered) {
    try {
      /* واقفة على الوجهة أصلًا: تركيز وحده. */
      if (client.url === url.href) {
        return typeof client.focus === "function" ? await client.focus() : client;
      }
      /* واقفة على مسار آخر ولا تدعم navigate: لا تُركَّز. تركيزها كان
         يُنهي الضغطة على الصفحة الخطأ — وهو الوجه الآخر لشكوى «لا ينتقل».
         تُتخطّى لتتكفّل openWindow بالوجهة الصحيحة. */
      if (typeof client.navigate !== "function") continue;

      /* navigate() تُرجع WindowClient جديدًا وقد تُرجع null؛ التركيز على
         المرجع القديم بعدها غير موثوق، فيُستعمل المُرجَع حين يوجد. */
      const handle = (await client.navigate(url.href)) || client;
      return handle && typeof handle.focus === "function" ? await handle.focus() : handle;
    } catch (err) {
      /* نافذة غير مسيطَر عليها أو رفضت الانتقال — جرّب التالية. */
    }
  }

  /* لا نافذة صالحة — يُفتح التطبيق على الوجهة مباشرة. */
  if (self.clients.openWindow) {
    try {
      return await self.clients.openWindow(url.href);
    } catch (err) {
      return null;
    }
  }
  return null;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openNotificationTarget(data.url));
});

/* إلغاء الاشتراك من طرف خدمة الدفع (تجديد رمز الجهاز مثلًا). لا يمكن
   إعادة الاشتراك هنا بلا مفتاح VAPID، فيتكفّل الخادم بالتنظيف حين يردّ
   الدفع بـ404/410 عند أول إرسال تالٍ. */
self.addEventListener("pushsubscriptionchange", (event) => {
  /* لا شيء يُفعل هنا عمدًا — موثَّق كي لا يُقرأ الصمت كسهو. */
});
