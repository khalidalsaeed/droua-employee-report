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

/* ---------- الضغط على الإشعار ---------- */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/expiring.html";

  event.waitUntil((async () => {
    const url = new URL(target, self.location.origin);
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    /* نافذة مفتوحة على المسار نفسه: تُرفَع إلى المقدّمة بدل فتح ثانية. */
    for (const client of clientList) {
      if (new URL(client.url).pathname === url.pathname && "focus" in client) {
        return client.focus();
      }
    }
    /* نافذة مفتوحة على المنصّة عمومًا: تُوجَّه إلى المسار المطلوب. */
    for (const client of clientList) {
      if (new URL(client.url).origin === url.origin && "navigate" in client) {
        await client.navigate(url.href);
        return client.focus();
      }
    }
    /* لا نافذة مفتوحة — يُفتح التطبيق. */
    if (self.clients.openWindow) return self.clients.openWindow(url.href);
  })());
});

/* إلغاء الاشتراك من طرف خدمة الدفع (تجديد رمز الجهاز مثلًا). لا يمكن
   إعادة الاشتراك هنا بلا مفتاح VAPID، فيتكفّل الخادم بالتنظيف حين يردّ
   الدفع بـ404/410 عند أول إرسال تالٍ. */
self.addEventListener("pushsubscriptionchange", (event) => {
  /* لا شيء يُفعل هنا عمدًا — موثَّق كي لا يُقرأ الصمت كسهو. */
});
