const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

/* قسم «التذكيرات» في المتصفّح: الصفحة الرئيسية الحقيقية (app-shell.html
   بكل سكربتاتها) مع API مُحاكى. يغطّي Desktop وMobile وRTL وغياب التمرير
   الأفقي والفلاتر والصلاحيات والتجديد ثم التحديث.

   يحتاج Playwright ومتصفّح Chromium؛ إن لم يتوفّرا يُتخطّى بلا فشل. لقطات
   الشاشة تُحفظ فقط إن عُيِّن REMINDERS_SHOTS=<مجلد>. ⛔ كل البيانات مصنوعة. */
let chromium = null;
try { ({ chromium } = require("playwright")); } catch (e) { /* تخطٍّ */ }
const SKIP = !chromium && "Playwright غير متوفّر";
const SHOTS = process.env.REMINDERS_SHOTS || "";

const ROOT = path.join(__dirname, "..");
const R = require("../reminders.js");
const { F } = require("../doc-status.js");

const TODAY = R.todayKey();
const day = (n) => { const [y, m, d] = TODAY.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

const NAMES = ["محمد عبدالله الحربي", "سالم علي القحطاني", "خالد حسن الزهراني", "أحمد يوسف الشمري", "فهد ناصر العتيبي",
  "عمر إبراهيم الغامدي", "ياسر سعيد المالكي", "ماجد فيصل الدوسري", "بدر عادل السبيعي", "راشد طلال المطيري",
  "نواف سلطان العنزي", "تركي حمد البقمي"];
const JOBS = ["فني تكييف", "سائق", "عامل نظافة", "كهربائي", "مشرف موقع", "سبّاك"];
function fixtures() {
  const off = [[3, 12, 400], [-11, 45, null], [200, -2, null], [8, 70, 25], [-40, 15, null], [60, 95, null],
    [1, 33, null], [27, 140, null], [0, 88, null], [150, 6, null], [-3, 300, null], [52, 21, null]];
  const employees = NAMES.map((name, k) => ({
    [F.damanah]: String(500 + k), [F.name]: name, [F.iqama]: `24${String(10000000 + k)}`, [F.job]: JOBS[k % JOBS.length],
    [F.nat]: "—", [F.iqExp]: day(off[k][0]), [F.licExp]: day(off[k][1]), ...(off[k][2] != null ? { [F.passExp]: day(off[k][2]) } : {}),
    ...(k === 2 ? { _licPending: true } : {}),
  }));
  const permits = [
    { permit: "TQ6211705", iqama: employees[0][F.iqama], nameOnPermit: NAMES[0], issueDate: day(-16), expiryDate: day(44), file: "https://blob.example/p1.pdf" },
    { permit: "TQ6211709", iqama: employees[3][F.iqama], nameOnPermit: NAMES[3], issueDate: day(-25), expiryDate: day(5), file: "https://blob.example/p2.pdf" },
    { permit: "TQ6211782", iqama: employees[6][F.iqama], nameOnPermit: NAMES[6], issueDate: day(-40), expiryDate: day(-4), file: "https://blob.example/p3.pdf" },
  ];
  const municipal = [
    { cardId: "a1a1a1a1a1a1a1a1", employeeEid: "501", certificateNumber: "1447001", expiryDate: day(3), nameOnCard: NAMES[1], occupation: "عامل", hasQr: true, version: "v1", history: [] },
    { cardId: "b2b2b2b2b2b2b2b2", employeeEid: "504", certificateNumber: "1447002", expiryDate: day(-6), nameOnCard: NAMES[4], occupation: "عامل", hasQr: true, version: "v1", history: [] },
    { cardId: "c3c3c3c3c3c3c3c3", employeeEid: "508", certificateNumber: "1447003", expiryDate: day(66), nameOnCard: NAMES[8], occupation: "عامل", hasQr: true, version: "v1", history: [] },
  ];
  return { employees, permits, municipal };
}

/* شكل الملخّص المالي الذي يرسمه قسم التحليل المالي (خارج نطاق هذا الاختبار). */
const FIN = { grandTotal: 1000, avg: 500, payrollMonthly: 3000, licenseRenew: 250, sponsor: 250, iqamaRenew: 250, medical: 250,
  perEmployee: [{ name: "أ", total: 600 }, { name: "ب", total: 400 }] };

const OWNER = { id: 1, name: "مالك", email: "o@example.test", role: "owner", permissions: [] };
const custom = (perms) => ({ id: 2, name: "مستخدم", email: "u@example.test", role: "viewer", permissions: perms });

function serve() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".png": "image/png", ".webmanifest": "application/json" };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const rel = u.pathname === "/" ? "app-shell.html" : decodeURIComponent(u.pathname.slice(1));
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

/* API مُحاكى بالقواعد نفسها: بلا صلاحية عرض القسم ⇒ 403 كالخادم. */
async function openPage(browser, base, user, opts = {}) {
  const ctx = await browser.newContext({ locale: "ar-SA", timezoneId: "Asia/Riyadh", ...(opts.device || { viewport: { width: 1280, height: 900 } }) });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const data = opts.data || fixtures();
  const can = (s) => user.role === "owner" || user.permissions.includes(s);
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const state = { data, calls: [] };
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    state.calls.push(`${route.request().method()} ${p}`);
    if (p === "/api/auth/me") return json(route, { ok: true, user });
    if (p === "/api/auth/update-tour") return json(route, { ok: true, show: false });
    if (p === "/api/data/employees") return can("employees:view") ? json(route, { ok: true, items: data.employees }) : json(route, { ok: false }, 403);
    if (p === "/api/data/permits") return can("ajeer:view") ? json(route, { ok: true, items: data.permits }) : json(route, { ok: false }, 403);
    if (p === "/api/data/municipal-cards") return can("municipal:view") ? json(route, { ok: true, items: data.municipal }) : json(route, { ok: false }, 403);
    if (p === "/api/data/settings") return json(route, { ok: true, settings: { financial_summary: FIN } });
    if (p === "/api/files/municipal-renew" && opts.onRenew) return json(route, opts.onRenew("municipal", u, state));
    if (p === "/api/files/ajeer-renew" && opts.onRenew) return json(route, opts.onRenew("ajeer", u, state));
    if (p.startsWith("/api/data/")) return json(route, { ok: true, items: [] });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript(() => { try { sessionStorage.clear(); } catch (e) { /* */ } });
  await page.goto(`${base}/`);
  await page.waitForSelector("#docReminders .rm-table, #docReminders .rm-empty", { timeout: 15000 });
  /* البطاقات البلدية تصل بعد بقية البيانات */
  if (can("municipal:view")) await page.waitForFunction(() => window.Reminders._state.sources.municipal.length > 0, null, { timeout: 15000 });
  return { ctx, page, errors, state };
}

const noOverflow = (page) => page.evaluate(() => {
  const d = document.documentElement;
  const sec = document.getElementById("remindersSec").getBoundingClientRect();
  return { page: d.scrollWidth - d.clientWidth, secRight: sec.right - d.clientWidth, secLeft: sec.left };
});
const rowKeys = (page) => page.$$eval("#docReminders .rm-row", (rs) => rs.map((r) => r.dataset.key));
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.getElementById("remindersSec").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
  await page.locator("#remindersSec").screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test("التذكيرات في المتصفّح", { skip: SKIP, timeout: 120000 }, async (t) => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    srv.close();
    t.skip(`تعذّر تشغيل Chromium: ${e.message}`);
    return;
  }
  try {
    await t.test("Desktop: RTL، ثمانية صفوف أولًا، الأخطر في الصدارة، بلا تمرير أفقي", async () => {
      const { ctx, page, errors } = await openPage(browser, base, OWNER, { device: { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 } });
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#docReminders .rm-table")).direction), "rtl");
      assert.equal(await page.$("#docExpiry"), null, "القسم القديم أُزيل");
      const heads = await page.$$eval("#docReminders thead th", (th) => th.map((x) => x.textContent.trim()));
      assert.deepEqual(heads, ["اسم الموظف", "نوع الوثيقة", "الحالة", "تاريخ الانتهاء", "الإجراءات"]);
      const keys = await rowKeys(page);
      assert.equal(keys.length, R.PREVIEW);
      const first = await page.$eval("#docReminders .rm-row .rm-st", (e) => e.textContent.replace(/\s+/g, " ").trim());
      assert.match(first, /^منتهي منذ \d+ يومًا$/);
      assert.match(await page.$eval("#docReminders .rm-all", (e) => e.textContent), /عرض جميع التذكيرات \(\d+\)/);
      const o = await noOverflow(page);
      assert.ok(o.page <= 0 && o.secRight <= 1 && o.secLeft >= -1, JSON.stringify(o));
      await shot(page, "desktop-default");
      /* القائمة المنسدلة بالأنواع وأعدادها */
      await page.click("#rmTypesBtn");
      const opts = await page.$$eval("#rmTypesPop .rm-opt", (l) => l.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
      assert.match(opts[0], /^كل الأنواع \d+$/);
      assert.deepEqual(opts.slice(1).map((x) => x.replace(/ \d+$/, "")), ["الإقامة", "رخصة العمل", "جواز السفر", "تصريح أجير", "البطاقة البلدية"]);
      await shot(page, "desktop-types-open");
      await page.click('#rmTypesPop input[value="ajeer"]');
      const ajKeys = await rowKeys(page);
      assert.ok(ajKeys.length === 3 && ajKeys.every((k) => k.startsWith("ajeer:")));
      await page.keyboard.press("Escape");
      assert.equal(await page.textContent("#rmTypesLbl"), "تصريح أجير");
      /* التوسيع والترقيم */
      await page.click('#rmTypesBtn'); await page.click('#rmTypesPop input[value=""]'); await page.keyboard.press("Escape");
      await page.click("#docReminders .rm-all");
      const total = await page.$$eval("#docReminders .rm-row", (r) => r.length);
      assert.ok(total > R.PREVIEW && total <= R.PAGE);
      assert.equal(errors.length, 0, errors.join("\n"));
      await ctx.close();
    });

    await t.test("البحث وفلتر المدة (هذا الأسبوع / هذا الشهر / الشهر القادم / مدة محددة)", async () => {
      const { ctx, page } = await openPage(browser, base, OWNER);
      await page.fill("#rmQ", "سالم");
      await page.waitForFunction(() => document.querySelectorAll("#docReminders .rm-row").length && [...document.querySelectorAll("#docReminders .rm-row")].every((r) => r.textContent.includes("سالم")));
      await page.fill("#rmQ", "504");
      await page.waitForFunction(() => [...document.querySelectorAll("#docReminders .rm-row")].every((r) => r.textContent.includes("504")));
      await page.fill("#rmQ", "");
      await page.waitForTimeout(250);
      const range = (k) => R.periodRange(k, TODAY);
      for (const k of ["week", "month", "next_month"]) {
        await page.selectOption("#rmPeriod", k);
        const days = await page.$$eval("#docReminders .rm-date", (d) => d.map((x) => x.title));
        const r = range(k);
        assert.ok(days.every((d) => d >= r.from && d <= r.to), `${k}: ${days.join(",")}`);
      }
      await page.selectOption("#rmPeriod", "custom");
      assert.equal(await page.isVisible("#rmCustom"), true);
      await page.fill("#rmFrom", day(100)); await page.dispatchEvent("#rmFrom", "change");
      await page.fill("#rmTo", day(500)); await page.dispatchEvent("#rmTo", "change");
      const far = await page.$$eval("#docReminders .rm-date", (d) => d.map((x) => x.title));
      assert.ok(far.length > 0 && far.every((d) => d >= day(100)));
      await ctx.close();
    });

    await t.test("Mobile: بطاقات مكدّسة بلا تمرير أفقي", async () => {
      const iPhone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
      const { ctx, page, errors } = await openPage(browser, base, OWNER, { device: iPhone });
      assert.equal(await page.isVisible("#docReminders thead"), false);
      assert.equal(await page.$eval("#docReminders .rm-row", (r) => getComputedStyle(r).display), "grid");
      const o = await noOverflow(page);
      assert.ok(o.page <= 0 && o.secRight <= 1 && o.secLeft >= -1, JSON.stringify(o));
      const rowsFit = await page.$$eval("#docReminders .rm-row", (rs) => rs.every((r) => r.scrollWidth <= r.clientWidth + 1));
      assert.ok(rowsFit, "لا صفّ يتجاوز عرضه");
      await shot(page, "mobile-default");
      await page.click("#rmTypesBtn");
      const pop = await page.$eval("#rmTypesPop", (p) => { const r = p.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
      assert.ok(pop.l >= 0 && pop.r <= pop.w, JSON.stringify(pop));
      await shot(page, "mobile-types-open");
      assert.equal(errors.length, 0, errors.join("\n"));
      await ctx.close();
    });

    await t.test("مستخدم لا يرى أجير: لا صفوف أجير ولا خيار في الفلتر", async () => {
      const u = custom(["kpi:view", "employees:view", "municipal:view", "settings:view"]);
      const { ctx, page, state } = await openPage(browser, base, u);
      await page.click("#docReminders .rm-all");
      const keys = await rowKeys(page);
      assert.ok(keys.length && !keys.some((k) => k.startsWith("ajeer:")));
      await page.click("#rmTypesBtn");
      assert.equal(await page.$('#rmTypesPop input[value="ajeer"]'), null);
      assert.equal(await page.$('#docReminders [data-rm-act="renew"]'), null, "بلا municipal:manage لا تجديد");
      assert.ok(state.calls.includes("GET /api/data/permits"), "الخادم هو من يرفض (403)");
      await ctx.close();
    });

    await t.test("مستخدم لا يرى البلدية: لا بطاقات بلدية", async () => {
      const u = custom(["kpi:view", "employees:view", "ajeer:view", "settings:view"]);
      const { ctx, page } = await openPage(browser, base, u);
      await page.waitForTimeout(300);
      await page.click("#docReminders .rm-all");
      const keys = await rowKeys(page);
      assert.ok(keys.length && !keys.some((k) => k.startsWith("municipal:")));
      await page.click("#rmTypesBtn");
      assert.equal(await page.$('#rmTypesPop input[value="municipal"]'), null);
      await ctx.close();
    });

    await t.test("مستخدم بلا أي عرض للوثائق: القسم مخفي", async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.route("**/api/**", (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === "/api/auth/me") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, user: custom(["finance:view", "settings:view"]) }) });
        if (p === "/api/data/settings") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, settings: { financial_summary: FIN } }) });
        return route.fulfill({ status: 403, contentType: "application/json", body: '{"ok":false}' });
      });
      await page.goto(`${base}/`);
      await page.waitForTimeout(800);
      assert.equal(await page.isVisible("#remindersSec"), false);
      await ctx.close();
    });

    await t.test("التجديد ثم التحديث: البلدية (3 أيام → سنة) تختفي من الحالات، وأجير يُستبدل بمدته الجديدة", async () => {
      const onRenew = (kind, u, state) => {
        if (kind === "municipal") {
          const c = state.data.municipal.find((x) => x.cardId === u.searchParams.get("id"));
          return { ok: true, item: { ...c, expiryDate: day(365), version: "v2", certificateNumber: "1448001" }, summary: {} };
        }
        const old = state.data.permits.find((x) => x.permit === u.searchParams.get("permit"));
        const fresh = { ...old, permit: "TQ7000001", issueDate: day(0), expiryDate: day(75) };
        state.data.permits = [...state.data.permits, fresh];
        return { ok: true, item: fresh, summary: {} };
      };
      const { ctx, page, errors } = await openPage(browser, base, OWNER, { onRenew });
      const pdf = { name: "renewed.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") };
      const mKey = "municipal:a1a1a1a1a1a1a1a1";
      await page.click("#docReminders .rm-all");
      assert.match(await page.$eval(`.rm-row[data-key="${mKey}"] .rm-st`, (e) => e.textContent), /ينتهي خلال 3 أيام/);
      await page.click(`.rm-row[data-key="${mKey}"] [data-rm-act="renew"]`);
      await page.setInputFiles(".rn-file", pdf);
      await page.waitForFunction((k) => !document.querySelector(`.rm-row[data-key="${k}"]`), mKey, { timeout: 15000 });
      await page.keyboard.press("Escape");
      /* الصفّ لم يعد في «جميع الحالات»، ويظهر بمدته الجديدة في مدة محددة */
      await page.selectOption("#rmPeriod", "custom");
      await page.fill("#rmFrom", day(300)); await page.dispatchEvent("#rmFrom", "change");
      assert.match(await page.$eval(`.rm-row[data-key="${mKey}"] .rm-st`, (e) => e.textContent), /ساري.*باقي 365 يومًا/s);
      await page.selectOption("#rmPeriod", "all");

      const aOld = "ajeer:TQ6211709";
      assert.match(await page.$eval(`.rm-row[data-key="${aOld}"] .rm-st`, (e) => e.textContent), /ينتهي خلال 5 أيام/);
      await page.click(`.rm-row[data-key="${aOld}"] [data-rm-act="renew"]`);
      await page.setInputFiles(".rn-file", pdf);
      await page.waitForFunction(() => !document.querySelector('.rm-row[data-key="ajeer:TQ6211709"]'), null, { timeout: 15000 });
      await page.keyboard.press("Escape");
      await page.fill("#rmQ", "TQ7000001");
      await page.waitForSelector('.rm-row[data-key="ajeer:TQ7000001"]');
      assert.match(await page.$eval('.rm-row[data-key="ajeer:TQ7000001"] .rm-st', (e) => e.textContent), /تحت المتابعة.*باقي 75 يومًا/s);
      assert.equal(errors.length, 0, errors.join("\n"));
      await ctx.close();
    });
  } finally {
    await browser.close();
    srv.close();
  }
});
