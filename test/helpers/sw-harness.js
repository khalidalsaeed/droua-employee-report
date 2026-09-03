const fs = require("node:fs");
const path = require("node:path");

/* تشغيل sw.js نفسه في سياق عامل خدمة مُزيَّف.
   =========================================================================
   الملف الحقيقي يُقرأ من القرص ويُنفَّذ بلا تعديل، فما تختبره هذه الأدوات
   هو الشيفرة المنشورة لا نسخة موازية منها. الوصل الوحيد بالخارج هو
   self.addEventListener، فيكفي أن نمرّر self مُزيَّفًا ونحتفظ بالمعالجات.

   new Function بدل vm: نطاق منفصل يكفي هنا (الملف لا يلمس شيئًا غير self
   و URL)، وتجنّبه لعوالم vm يعني أن الوعود والأخطاء من نوع واحد فلا
   يُفاجئنا instanceof عبر العوالم. */

/* SW_PATH_OVERRIDE يسمح بتشغيل الحزمة نفسها على نسخة أخرى من الملف —
   الطريقة التي تُثبت بها أن اختبار انحدار يعضّ فعلًا:
   git show <rev>:sw.js > old.js && SW_PATH_OVERRIDE=old.js npm test */
const SW_PATH = process.env.SW_PATH_OVERRIDE
  ? path.resolve(process.env.SW_PATH_OVERRIDE)
  : path.join(__dirname, "..", "..", "sw.js");
const DEFAULT_ORIGIN = "https://droua-employee-report.vercel.app";

/* نافذة مُزيَّفة. الخيارات تحاكي ما يفعله المتصفّح حقًّا:
   - navigateThrows: النافذة غير مسيطَر عليها — navigate ترمي TypeError.
   - noNavigate:     بيئة لا تعرّض navigate إطلاقًا.
   - navigateNull:   navigate تنجح لكنها تُرجع null بدل WindowClient. */
function makeClient(url, opts = {}) {
  const client = {
    url,
    id: opts.id || url,
    navigateCalls: [],
    focusCalls: 0,
  };
  if (!opts.noNavigate) {
    client.navigate = async (href) => {
      client.navigateCalls.push(href);
      if (opts.navigateThrows) throw new TypeError("client is not controlled by this service worker");
      client.url = href;
      return opts.navigateNull ? null : client;
    };
  }
  client.focus = async () => {
    client.focusCalls++;
    return client;
  };
  return client;
}

function loadSw(opts = {}) {
  const {
    origin = DEFAULT_ORIGIN,
    windows = [],
    matchAllThrows = false,
    openWindowThrows = false,
    noOpenWindow = false,
  } = opts;

  const listeners = new Map();
  const calls = {
    skipWaiting: 0,
    claim: 0,
    openWindow: [],
    matchAll: [],
    showNotification: [],
  };

  const self = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    skipWaiting() {
      calls.skipWaiting++;
    },
    location: { origin },
    registration: {
      async showNotification(title, options) {
        calls.showNotification.push({ title, options });
      },
    },
    clients: {
      async claim() {
        calls.claim++;
      },
      async matchAll(query) {
        calls.matchAll.push(query);
        if (matchAllThrows) throw new Error("matchAll unavailable");
        return windows;
      },
    },
  };

  if (!noOpenWindow) {
    self.clients.openWindow = async (href) => {
      calls.openWindow.push(href);
      if (openWindowThrows) throw new Error("popup blocked");
      return makeClient(href);
    };
  }

  const source = fs.readFileSync(SW_PATH, "utf8");
  /* eslint-disable-next-line no-new-func */
  new Function("self", "URL", "console", source)(self, URL, console);

  return { self, listeners, calls, windows };
}

/* إطلاق notificationclick وانتظار ما سُلّم إلى waitUntil.
   انتظار الوعد هنا مقصود: الرمي الذي كان يُسقط العملية بصمت في المتصفّح
   سيُسقط الاختبار بوضوح. */
async function clickNotification(sw, notificationData) {
  const notification = {
    data: notificationData,
    closeCalls: 0,
    close() {
      this.closeCalls++;
    },
  };
  const waited = [];
  const event = {
    notification,
    waitUntil(promise) {
      waited.push(promise);
    },
  };

  const handler = sw.listeners.get("notificationclick");
  if (!handler) throw new Error("sw.js did not register a notificationclick listener");
  handler(event);

  const results = await Promise.all(waited);
  return { notification, waited, result: results[0] };
}

/* إطلاق push بحمولة، وإرجاع خيارات الإشعار الذي طُلب عرضه. */
async function dispatchPush(sw, payload) {
  const waited = [];
  const event = {
    data: payload === undefined ? null : { json: () => payload },
    waitUntil(promise) {
      waited.push(promise);
    },
  };
  const handler = sw.listeners.get("push");
  if (!handler) throw new Error("sw.js did not register a push listener");
  handler(event);
  await Promise.all(waited);
  return sw.calls.showNotification[sw.calls.showNotification.length - 1];
}

module.exports = { loadSw, makeClient, clickNotification, dispatchPush, DEFAULT_ORIGIN, SW_PATH };
