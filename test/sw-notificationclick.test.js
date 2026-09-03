const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadSw,
  makeClient,
  clickNotification,
  dispatchPush,
  DEFAULT_ORIGIN,
} = require("./helpers/sw-harness");

const TARGET = `${DEFAULT_ORIGIN}/expiring.html`;

/* اختبارات الضغط على إشعار الدفع.
   =========================================================================
   كلها تُنفّذ sw.js الحقيقي في سياق عامل خدمة مُزيَّف، فالمقياس هو سلوك
   الملف المنشور: أي نافذة نُوجّهها، ومتى نفتح واحدة جديدة، وأين ينتهي
   المستخدم. */

test("نافذة مفتوحة على مسار آخر: navigate إلى الوجهة ثم focus", async () => {
  const home = makeClient(`${DEFAULT_ORIGIN}/`);
  const sw = loadSw({ windows: [home] });

  await clickNotification(sw, { url: "/expiring.html", kind: "expiry" });

  assert.deepEqual(home.navigateCalls, [TARGET], "navigate تُنادى بالعنوان المطلق مرّة واحدة");
  assert.equal(home.focusCalls, 1, "focus تُنادى بعد navigate");
  assert.deepEqual(sw.calls.openWindow, [], "لا تُفتح نافذة جديدة مع وجود واحدة");
});

test("لا نافذة مفتوحة: openWindow على الوجهة المطلقة", async () => {
  const sw = loadSw({ windows: [] });

  await clickNotification(sw, { url: "/expiring.html", kind: "expiry" });

  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("الرابط داخل notification.data يُستعمل كما هو", async () => {
  const home = makeClient(`${DEFAULT_ORIGIN}/`);
  const sw = loadSw({ windows: [home] });

  await clickNotification(sw, { url: "/payroll.html", kind: "other" });

  assert.deepEqual(home.navigateCalls, [`${DEFAULT_ORIGIN}/payroll.html`]);
  assert.equal(home.focusCalls, 1);
});

test("غياب url داخل data: ارتداد إلى /expiring.html", async () => {
  const sw = loadSw({ windows: [] });

  await clickNotification(sw, { kind: "expiry" });

  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("غياب data كلّها: ارتداد إلى /expiring.html بلا رمي", async () => {
  const sw = loadSw({ windows: [] });

  const { notification } = await clickNotification(sw, undefined);

  assert.deepEqual(sw.calls.openWindow, [TARGET]);
  assert.equal(notification.closeCalls, 1);
});

test("url فارغ أو غير قابل للتحليل: ارتداد إلى /expiring.html", async () => {
  for (const bad of ["", null, undefined, "http://", "https://"]) {
    const sw = loadSw({ windows: [] });
    await clickNotification(sw, { url: bad });
    assert.deepEqual(sw.calls.openWindow, [TARGET], `المدخل ${JSON.stringify(bad)}`);
  }
});

/* "::::" مسار نسبي صالح وفق معيار WHATWG لا مدخل تالف، فلا يرتدّ إلى
   وجهة الاحتياط. الثابت المهم أنه يبقى داخل أصل المنصّة. */
test("مسار نسبي غريب لكن صالح يبقى داخل أصل المنصّة", async () => {
  const sw = loadSw({ windows: [] });

  await clickNotification(sw, { url: "::::" });

  assert.equal(sw.calls.openWindow.length, 1);
  assert.equal(new URL(sw.calls.openWindow[0]).origin, DEFAULT_ORIGIN);
});

/* هذا هو العطل الذي ظهر على Production. navigate() ترمي TypeError على
   نافذة غير مسيطَر عليها، وكانت تُسقط العملية كلها فلا يحدث شيء. */
test("navigate ترمي (نافذة غير مسيطَر عليها): ارتداد إلى openWindow", async () => {
  const stray = makeClient(`${DEFAULT_ORIGIN}/`, { navigateThrows: true });
  const sw = loadSw({ windows: [stray] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(stray.navigateCalls, [TARGET], "المحاولة جرت");
  assert.equal(stray.focusCalls, 0, "لا تركيز على نافذة لم تنتقل");
  assert.deepEqual(sw.calls.openWindow, [TARGET], "الضغط لا يبقى بلا أثر");
});

test("navigate ترمي على نافذة وتنجح على أخرى: الثانية تُستعمل", async () => {
  const stray = makeClient(`${DEFAULT_ORIGIN}/`, { navigateThrows: true, id: "stray" });
  const good = makeClient(`${DEFAULT_ORIGIN}/payroll.html`, { id: "good" });
  const sw = loadSw({ windows: [stray, good] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(good.navigateCalls, [TARGET]);
  assert.equal(good.focusCalls, 1);
  assert.deepEqual(sw.calls.openWindow, [], "لا حاجة لنافذة جديدة");
});

test("بيئة بلا navigate: النافذة تُتخطّى وتُفتح واحدة على الوجهة", async () => {
  const home = makeClient(`${DEFAULT_ORIGIN}/`, { noNavigate: true });
  const sw = loadSw({ windows: [home] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.equal(home.focusCalls, 0, "لا تركيز على نافذة واقفة على المسار الخطأ");
  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("navigate تُرجع null: التركيز يقع على المرجع الأصلي", async () => {
  const home = makeClient(`${DEFAULT_ORIGIN}/`, { navigateNull: true });
  const sw = loadSw({ windows: [home] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(home.navigateCalls, [TARGET]);
  assert.equal(home.focusCalls, 1);
  assert.deepEqual(sw.calls.openWindow, []);
});

test("نافذة واقفة على الوجهة نفسها: تركيز بلا navigate", async () => {
  const already = makeClient(TARGET);
  const sw = loadSw({ windows: [already] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(already.navigateCalls, [], "لا إعادة تحميل لصفحة يقرأها المستخدم");
  assert.equal(already.focusCalls, 1);
  assert.deepEqual(sw.calls.openWindow, []);
});

test("النافذة الواقفة على الوجهة تُقدَّم على غيرها", async () => {
  const home = makeClient(`${DEFAULT_ORIGIN}/`, { id: "home" });
  const already = makeClient(TARGET, { id: "already" });
  const sw = loadSw({ windows: [home, already] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.equal(already.focusCalls, 1);
  assert.deepEqual(home.navigateCalls, [], "النافذة الأخرى لا تُلمس");
  assert.equal(home.focusCalls, 0);
});

test("نوافذ من أصل آخر تُتجاهل", async () => {
  const foreign = makeClient("https://example.com/");
  const sw = loadSw({ windows: [foreign] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(foreign.navigateCalls, []);
  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("نافذة بعنوان غير قابل للتحليل (about:blank) تُتجاهل بلا رمي", async () => {
  const blank = makeClient("about:blank");
  const sw = loadSw({ windows: [blank] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("url خارج أصل المنصّة يرتدّ إلى /expiring.html ولا يوجّه نافذة خارجًا", async () => {
  const home = makeClient(`${DEFAULT_ORIGIN}/`);
  const sw = loadSw({ windows: [home] });

  await clickNotification(sw, { url: "https://evil.example/steal" });

  assert.deepEqual(home.navigateCalls, [TARGET]);
});

test("فشل matchAll: openWindow ما زالت تعمل", async () => {
  const sw = loadSw({ windows: [], matchAllThrows: true });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("فشل openWindow لا يرمي خارج waitUntil", async () => {
  const sw = loadSw({ windows: [], openWindowThrows: true });

  const { result } = await clickNotification(sw, { url: "/expiring.html" });

  assert.equal(result, null);
});

test("بيئة بلا openWindow لا ترمي", async () => {
  const sw = loadSw({ windows: [], noOpenWindow: true });

  const { result } = await clickNotification(sw, { url: "/expiring.html" });

  assert.equal(result, null);
});

test("matchAll تُنادى بـ type: window و includeUncontrolled", async () => {
  const sw = loadSw({ windows: [] });

  await clickNotification(sw, { url: "/expiring.html" });

  assert.deepEqual(sw.calls.matchAll, [{ type: "window", includeUncontrolled: true }]);
});

test("notification.close() تُنادى دائمًا", async () => {
  for (const windows of [[], [makeClient(`${DEFAULT_ORIGIN}/`)], [makeClient(TARGET)]]) {
    const sw = loadSw({ windows });
    const { notification } = await clickNotification(sw, { url: "/expiring.html" });
    assert.equal(notification.closeCalls, 1);
  }
});

/* ---------- الرحلة كاملة: من حمولة الخادم إلى الوجهة ---------- */

test("إشعار انتهاء الوثائق: الضغط يفتح /expiring.html", async () => {
  const { buildExpiryDigest } = require("../lib/push/notify");
  const payload = buildExpiryDigest([
    { employeeName: "أ", stage: "overdue", remainingDays: -3 },
    { employeeName: "ب", stage: "today", remainingDays: 0 },
  ]);
  assert.equal(payload.url, "/expiring.html", "الحمولة نفسها تحمل الوجهة");

  const sw = loadSw({ windows: [] });
  const shown = await dispatchPush(sw, payload);
  assert.equal(shown.options.data.url, "/expiring.html");

  await clickNotification(sw, shown.options.data);
  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("الإشعار التجريبي: الضغط يفتح /expiring.html", async () => {
  const { buildTestPayload } = require("../lib/push/notify");
  const payload = buildTestPayload();
  assert.equal(payload.url, "/expiring.html");

  const sw = loadSw({ windows: [] });
  const shown = await dispatchPush(sw, payload);
  assert.equal(shown.options.data.url, "/expiring.html");

  await clickNotification(sw, shown.options.data);
  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("حمولة بلا url: الإشعار يحمل /expiring.html والضغط يفتحها", async () => {
  const sw = loadSw({ windows: [] });

  const shown = await dispatchPush(sw, { title: "بلا وجهة", body: "" });
  assert.equal(shown.options.data.url, "/expiring.html");

  await clickNotification(sw, shown.options.data);
  assert.deepEqual(sw.calls.openWindow, [TARGET]);
});

test("نافذة مفتوحة على الرئيسية: الإشعار التجريبي ينقلها إلى /expiring.html", async () => {
  const { buildTestPayload } = require("../lib/push/notify");
  const home = makeClient(`${DEFAULT_ORIGIN}/`);
  const sw = loadSw({ windows: [home] });

  const shown = await dispatchPush(sw, buildTestPayload());
  await clickNotification(sw, shown.options.data);

  assert.deepEqual(home.navigateCalls, [TARGET]);
  assert.equal(home.focusCalls, 1);
});

/* ---------- ما لم يتغيّر ---------- */

test("لا معالج fetch في sw.js", () => {
  const sw = loadSw();
  assert.equal(sw.listeners.has("fetch"), false);
});

test("install و activate و push و pushsubscriptionchange ما زالت مسجَّلة", () => {
  const sw = loadSw();
  for (const type of ["install", "activate", "push", "notificationclick", "pushsubscriptionchange"]) {
    assert.equal(sw.listeners.has(type), true, `المعالج ${type} مسجَّل`);
  }
});

test("حمولة push تالفة تعرض إشعارًا عامًّا بدل السقوط بصمت", async () => {
  const sw = loadSw({ windows: [] });
  const waited = [];
  const event = {
    data: { json: () => { throw new SyntaxError("bad json"); } },
    waitUntil: (p) => waited.push(p),
  };
  sw.listeners.get("push")(event);
  await Promise.all(waited);

  const shown = sw.calls.showNotification[0];
  assert.equal(shown.title, "ذروة الصعود");
  assert.equal(shown.options.data.url, "/expiring.html");
});
