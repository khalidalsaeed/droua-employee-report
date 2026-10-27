const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const { makeFakeSql } = require("./helpers/fake-sql");
const tour = require("../lib/tour/updateTour");
const UpdateTour = require("../update-tour.js");

/* جولة التحديثات — ثلاث طبقات:
     أ) الإصدارات والصلاحيات وحالة المشاهدة في lib/tour/updateTour.js
     ب) المسار /api/auth/update-tour من طرف إلى طرف بجلسة موقَّعة
     ج) المنطق الخالص في update-tour.js وربطه بالصفحات
   القاعدة مُزيَّفة: audit_log في الذاكرة، يحاكي ما يكتبه record ويقرؤه
   getStatus — فتُختبر دورة «لم يشاهد ← أكمل ← لا يراها» كاملة. */

const OWNER = { id: "u-owner", email: "owner@example.test", role: "owner", permissions: null };
const HR = { id: "u-hr", email: "hr@example.test", role: "hr", permissions: null };
const FIN = { id: "u-fin", email: "fin@example.test", role: "finance", permissions: null };
const custom = (perms, id = "u-custom") => ({ id, email: `${id}@example.test`, role: "viewer", permissions: perms });
const ids = (steps) => steps.map((s) => s.id);

/* audit_log في الذاكرة: INSERT يُضيف صفًّا، وSELECT يطابق actor/target ونوعًا نهائيًا.
   extra يخدم ما عداه (صفوف users للجلسة في اختبارات المسار). */
function auditDb({ failInsert = false, failSelect = false, extra = null } = {}) {
  const rows = [];
  let clock = 0;
  const sql = makeFakeSql((call) => {
    if (/^INSERT INTO audit_log/.test(call.text)) {
      if (failInsert) throw new Error("db down");
      const [type, actorEmail, actorId, targetId, meta] = call.values;
      rows.push({ type, actor_email: actorEmail, actor_id: actorId, target_id: targetId, meta: JSON.parse(meta), ts: ++clock });
      return [];
    }
    if (/^SELECT type FROM audit_log/.test(call.text)) {
      if (failSelect) throw new Error("db down");
      const [actorId, targetId] = call.values;
      return rows
        .filter((r) => r.actor_id === actorId && r.target_id === targetId && /update_tour_(completed|skipped)$/.test(r.type))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 1);
    }
    return extra ? extra(call) : [];
  });
  sql.rows = rows;
  return sql;
}

/* ════════════ أ) الإصدارات والصلاحيات ════════════ */

test("معرّف الإصدار الحالي ثابت وموجود في RELEASES", () => {
  assert.equal(tour.CURRENT_VERSION, "release-2026.10.27");
  assert.match(tour.CURRENT_VERSION, /^release-\d{4}\.\d{2}\.\d{2}$/);
  assert.ok(tour.releaseOf(tour.CURRENT_VERSION));
  assert.equal(tour.releaseOf("__proto__"), null, "لا يُقبل مفتاح موروث معرّفًا");
  assert.equal(tour.releaseOf("release-1999.01.01"), null);
});

test("محتوى الجولة الحالية: ثلاث ميزات بنصوصها المعتمدة", () => {
  const r = tour.RELEASES[tour.CURRENT_VERSION];
  assert.equal(r.title, "قمنا بإضافة مزايا جديدة");
  assert.equal(r.intro, "أضفنا مجموعة من التحسينات والمزايا الجديدة لتسهيل استخدام المنصة.");
  assert.deepEqual(r.steps.map((s) => s.title), ["تصاريح أجير", "الوثائق القادمة على انتهاء الصلاحية", "البطاقات البلدية"]);
  for (const s of r.steps) {
    assert.ok(s.body.length > 20, `${s.id}: وصف`);
    assert.ok(s.requires.length, `${s.id}: صلاحية واحدة على الأقل`);
    assert.ok(s.target.includes(s.section), `${s.id}: القسم آخر بديل للإبراز`);
  }
  const ids = new Set(r.steps.map((s) => s.id));
  assert.equal(ids.size, r.steps.length, "معرّفات الخطوات فريدة");
});

test("كل محدِّد قسم في الجولة موجود فعلًا في app-shell.html", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "app-shell.html"), "utf8");
  for (const version of Object.keys(tour.RELEASES)) {
    for (const s of tour.RELEASES[version].steps) {
      const id = s.section.replace(/^#/, "");
      assert.match(html, new RegExp(`id="${id}"`), `${version}/${s.id}: ${s.section}`);
      if (s.prepare) assert.ok(UpdateTour.PREPARE[s.prepare], `${s.id}: تجهيز ${s.prepare} مُعرَّف في update-tour.js`);
    }
  }
});

test("الخطوات مُرشَّحة بالصلاحيات: المالك يرى الثلاث", () => {
  assert.deepEqual(ids(tour.stepsFor(OWNER)), ["ajeer-cards", "doc-expiry-grouped", "municipal-cards"]);
});

test("الموارد البشرية بصلاحيات الدور الافتراضية: الثلاث", () => {
  assert.deepEqual(ids(tour.stepsFor(HR)), ["ajeer-cards", "doc-expiry-grouped", "municipal-cards"]);
});

test("مستخدم بلا صلاحية أجير: لا خطوة أجير", () => {
  const u = custom(["kpi:view", "employees:view", "municipal:view", "settings:view"]);
  assert.deepEqual(ids(tour.stepsFor(u)), ["doc-expiry-grouped", "municipal-cards"]);
});

test("صلاحيات جزئية: ميزتان من ثلاث، وخطوة الوثائق تحتاج kpi و employees معًا", () => {
  assert.deepEqual(ids(tour.stepsFor(custom(["ajeer:view", "municipal:view"]))), ["ajeer-cards", "municipal-cards"]);
  assert.deepEqual(ids(tour.stepsFor(custom(["kpi:view", "ajeer:view"]))), ["ajeer-cards"], "kpi بلا employees لا يكفي");
  assert.deepEqual(ids(tour.stepsFor(custom(["employees:view"]))), [], "employees بلا kpi لا يكفي");
});

test("مستخدم المالية الافتراضي: لا شيء يُشرح له، فلا جولة", () => {
  assert.deepEqual(tour.stepsFor(FIN), []);
});

test("ما يُرسل إلى المتصفّح لا يحمل requires، ولا يمسّ الأصل", () => {
  const steps = tour.stepsFor(OWNER);
  for (const s of steps) assert.equal("requires" in s, false);
  steps[0].target.push("#x");
  assert.ok(!tour.RELEASES[tour.CURRENT_VERSION].steps[0].target.includes("#x"));
});

/* ════════════ حالة المشاهدة ════════════ */

test("مستخدم جديد لم يشاهد: show=true بخطواته", async () => {
  const sql = auditDb();
  const st = await tour.stateFor(sql, HR);
  assert.equal(st.show, true);
  assert.equal(st.status, "pending");
  assert.equal(st.version, tour.CURRENT_VERSION);
  assert.equal(st.tour.title, "قمنا بإضافة مزايا جديدة");
  assert.equal(st.tour.steps.length, 3);
});

test("بدأ ولم يُكمل: تبقى معلّقة (started لا يُغلق الإصدار)", async () => {
  const sql = auditDb();
  await tour.record(sql, HR, tour.CURRENT_VERSION, "started", { steps: 3 });
  assert.equal((await tour.stateFor(sql, HR)).show, true);
});

test("أكمل الجولة: لا تظهر مرّة أخرى لنفس الإصدار", async () => {
  const sql = auditDb();
  await tour.record(sql, HR, tour.CURRENT_VERSION, "started", { steps: 3 });
  await tour.record(sql, HR, tour.CURRENT_VERSION, "completed", { steps: 3 });
  const st = await tour.stateFor(sql, HR);
  assert.equal(st.show, false);
  assert.equal(st.status, "completed");
  assert.equal(st.tour, null);
});

test("تخطّى الجولة: لا تظهر مرّة أخرى لنفس الإصدار", async () => {
  const sql = auditDb();
  await tour.record(sql, HR, tour.CURRENT_VERSION, "skipped", { steps: 3 });
  const st = await tour.stateFor(sql, HR);
  assert.equal(st.show, false);
  assert.equal(st.status, "skipped");
});

test("مستخدم مختلف لا يتأثّر بإكمال غيره", async () => {
  const sql = auditDb();
  await tour.record(sql, HR, tour.CURRENT_VERSION, "completed", { steps: 3 });
  assert.equal((await tour.stateFor(sql, OWNER)).show, true);
});

test("إصدار جديد: من أكمل السابق يرى الجديد مرّة واحدة", async () => {
  const NEXT = "release-2026.11.15";
  tour.RELEASES[NEXT] = {
    title: "قمنا بإضافة مزايا جديدة", intro: "—",
    steps: [{ id: "x", title: "س", body: "وصف خطوة الإصدار القادم", requires: [["kpi", "view"]], section: "#kpiSec", target: ["#kpiSec"] }],
  };
  try {
    const sql = auditDb();
    await tour.record(sql, HR, tour.CURRENT_VERSION, "completed", { steps: 3 });
    assert.equal((await tour.stateFor(sql, HR, tour.CURRENT_VERSION)).show, false);
    const fresh = await tour.stateFor(sql, HR, NEXT);
    assert.equal(fresh.show, true, "الإصدار الجديد لم يُشاهد");
    await tour.record(sql, HR, NEXT, "completed", { steps: 1 });
    assert.equal((await tour.stateFor(sql, HR, NEXT)).show, false);
  } finally {
    delete tour.RELEASES[NEXT];
  }
});

test("بلا خطوات مسموحة: لا يُستعلم عن القاعدة أصلًا", async () => {
  const sql = auditDb();
  const st = await tour.stateFor(sql, FIN);
  assert.deepEqual(st, { version: tour.CURRENT_VERSION, show: false, status: "none", tour: null });
  assert.equal(sql.calls.length, 0);
});

test("الكتابة: نوع الحدث والإصدار وعدد الخطوات فقط — لا بيانات أخرى", async () => {
  const sql = auditDb();
  await tour.record(sql, HR, tour.CURRENT_VERSION, "completed", { steps: 3, extra: "x" });
  const r = sql.rows[0];
  assert.equal(r.type, "update_tour_completed");
  assert.equal(r.actor_id, HR.id);
  assert.equal(r.target_id, tour.CURRENT_VERSION);
  assert.deepEqual(r.meta, { steps: 3 });
  await tour.record(sql, HR, tour.CURRENT_VERSION, "started", { steps: "3; DROP" });
  assert.deepEqual(sql.rows[1].meta, {}, "steps غير صحيح يُسقط");
});

test("الكتابة ترفض إجراءً أو إصدارًا غير معروف، وترمي عند فشل القاعدة", async () => {
  const sql = auditDb();
  await assert.rejects(tour.record(sql, HR, tour.CURRENT_VERSION, "deleted"));
  await assert.rejects(tour.record(sql, HR, "release-1999.01.01", "completed"));
  assert.equal(sql.rows.length, 0);
  await assert.rejects(tour.record(auditDb({ failInsert: true }), HR, tour.CURRENT_VERSION, "completed"));
});

/* ════════════ ب) المسار من طرف إلى طرف ════════════ */

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DB_PATH = require.resolve("../lib/db");
const TEST_SESSION_SECRET = "test-only-session-secret-not-a-real-value";

function userRow(u) {
  return {
    id: u.id, name: "حساب اختبار", email: u.email, password_hash: "x", role: u.role, status: u.status || "active",
    job_title: null, permissions: u.permissions, created_at: null, last_login: null,
  };
}

/* القاعدة المُزيَّفة تخدم users (للجلسة) و audit_log (للجولة) معًا. */
function appDb(users, opts = {}) {
  const sql = auditDb({
    ...opts,
    extra: (call) => {
      if (!/FROM users WHERE id =/.test(call.text)) return [];
      const u = users.find((x) => x.id === call.values[0]);
      return u ? [userRow(u)] : [];
    },
  });
  sql.audit = sql;
  return sql;
}

async function withFakeDb(sql, fn) {
  const originalLoad = Module._load;
  const clear = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(PROJECT_ROOT) && !key.includes("node_modules") && !key.includes(`${path.sep}test${path.sep}`)) delete require.cache[key];
    }
  };
  clear();
  Module._load = function (request, parent, isMain) {
    if (parent) {
      try {
        if (Module._resolveFilename(request, parent, isMain) === DB_PATH) return { getSql: () => sql };
      } catch (err) { /* يمرّ إلى المُحمِّل الأصلي */ }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return await fn(); } finally { Module._load = originalLoad; clear(); }
}

function makeRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; },
    status(code) { out.statusCode = code; return res; },
    json(payload) { out.body = payload; return res; },
    writeHead(code, headers) { out.statusCode = code; Object.assign(out.headers, headers || {}); return res; },
    end(payload) { if (payload !== undefined) out.body = payload; return res; },
  };
  return { res, out };
}

async function call(sql, actor, method, body) {
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  return withFakeDb(sql, async () => {
    const { issueSessionToken } = require("../lib/auth/tokens");
    const handler = require("../api/app");
    const headers = {};
    if (actor) headers.cookie = `session=${encodeURIComponent(issueSessionToken(actor, false))}`;
    const { res, out } = makeRes();
    await handler({ method, query: { kind: "api", apiPath: "auth/update-tour" }, headers, body }, res);
    return out;
  });
}

test("المسار: بلا جلسة 401", async () => {
  const out = await call(appDb([HR]), null, "GET");
  assert.equal(out.statusCode, 401);
});

test("المسار: دورة كاملة — يظهر، يُكمل، لا يظهر (Refresh / دخول جديد / جهاز آخر)", async () => {
  const sql = appDb([HR, OWNER]);
  let out = await call(sql, HR, "GET");
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.show, true);
  assert.deepEqual(ids(out.body.tour.steps), ["ajeer-cards", "doc-expiry-grouped", "municipal-cards"]);

  out = await call(sql, HR, "POST", { version: tour.CURRENT_VERSION, action: "started", steps: 3 });
  assert.equal(out.statusCode, 200);
  out = await call(sql, HR, "POST", { version: tour.CURRENT_VERSION, action: "completed", steps: 3 });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(sql.audit.rows.map((r) => r.type), ["update_tour_started", "update_tour_completed"]);
  assert.ok(sql.audit.rows.every((r) => r.actor_id === HR.id), "الهدف من الجلسة لا من الجسم");

  /* أي GET لاحق — إعادة تحميل، خروج ودخول، متصفّح آخر — يقرأ الخادم نفسه. */
  for (let k = 0; k < 2; k++) {
    out = await call(sql, HR, "GET");
    assert.equal(out.body.show, false);
    assert.equal(out.body.status, "completed");
  }
  out = await call(sql, OWNER, "GET");
  assert.equal(out.body.show, true, "مستخدم مختلف ما زال لم يشاهد");
});

test("المسار: تخطٍّ يُغلق الإصدار", async () => {
  const sql = appDb([HR]);
  await call(sql, HR, "POST", { version: tour.CURRENT_VERSION, action: "skipped", steps: 3 });
  const out = await call(sql, HR, "GET");
  assert.equal(out.body.show, false);
  assert.equal(out.body.status, "skipped");
});

test("المسار: لا يكتب عن مستخدم آخر ولو أرسل معرّفه", async () => {
  const sql = appDb([HR, OWNER]);
  await call(sql, HR, "POST", { version: tour.CURRENT_VERSION, action: "completed", userId: OWNER.id, actorId: OWNER.id });
  assert.equal(sql.audit.rows[0].actor_id, HR.id);
  assert.equal((await call(sql, OWNER, "GET")).body.show, true);
});

test("المسار: إصدار غير الحالي 409، وإجراء مجهول 400 — ولا كتابة", async () => {
  const sql = appDb([HR]);
  let out = await call(sql, HR, "POST", { version: "release-2026.01.01", action: "completed" });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.version, tour.CURRENT_VERSION);
  out = await call(sql, HR, "POST", { version: tour.CURRENT_VERSION, action: "later" });
  assert.equal(out.statusCode, 400);
  out = await call(sql, HR, "PUT", {});
  assert.equal(out.statusCode, 405);
  assert.equal(sql.audit.rows.length, 0);
});

test("المسار: فشل القاعدة 503 في القراءة والكتابة — لا «حُفظ» كاذب", async () => {
  let out = await call(appDb([HR], { failSelect: true }), HR, "GET");
  assert.equal(out.statusCode, 503);
  out = await call(appDb([HR], { failInsert: true }), HR, "POST", { version: tour.CURRENT_VERSION, action: "completed" });
  assert.equal(out.statusCode, 503);
});

test("المسار: مستخدم بلا صلاحية أجير يتلقّى خطواته المسموحة فقط", async () => {
  const u = custom(["kpi:view", "employees:view", "municipal:view"], "u-noajeer");
  const out = await call(appDb([u]), u, "GET");
  assert.deepEqual(ids(out.body.tour.steps), ["doc-expiry-grouped", "municipal-cards"]);
  assert.ok(!JSON.stringify(out.body).includes("أجير"), "لا ذكر لأجير في الردّ إطلاقًا");
});

/* ════════════ ج) المنطق الخالص في الواجهة ════════════ */

const VP = { w: 1280, h: 800 };

test("visibleSteps: يُسقط الخطوة التي قسمها غير ظاهر", () => {
  const steps = [{ id: "a", section: "#a" }, { id: "b", section: "#b" }, { id: "c" }];
  assert.deepEqual(UpdateTour.visibleSteps(steps, (s) => s === "#b").map((s) => s.id), ["b"]);
  assert.deepEqual(UpdateTour.visibleSteps(null, () => true), []);
});

test("spotRect: هامش حول العنصر، مقصوص تحت الترويسة وداخل الشاشة", () => {
  const r = UpdateTour.spotRect({ top: 100, left: 50, bottom: 300, right: 450 }, VP, 64);
  assert.deepEqual(r, { top: 92, left: 42, width: 416, height: 216 });
  const clipped = UpdateTour.spotRect({ top: 10, left: -20, bottom: 2000, right: 1400 }, VP, 64);
  assert.equal(clipped.top, 68);
  assert.equal(clipped.left, 4);
  assert.equal(clipped.top + clipped.height, VP.h - 4);
  assert.equal(UpdateTour.spotRect({ top: 100, left: 0, bottom: 2000, right: 300 }, VP, 64, 600).height, 600 - 4 - 92, "يتوقّف فوق الورقة السفلية");
  assert.equal(UpdateTour.spotRect({ top: 900, left: 0, bottom: 1000, right: 100 }, VP, 64), null, "خارج الشاشة");
});

test("placement: تحت إن اتّسع، فوق، بجانب، وإلا داخل المشهد — ولا خروج عن الحافة", () => {
  const pop = { w: 370, h: 200 };
  const below = UpdateTour.placement({ top: 100, left: 900, width: 360, height: 200 }, pop, VP);
  assert.equal(below.mode, "below");
  assert.equal(below.top, 314);
  assert.ok(below.left + pop.w <= VP.w - 16);
  const above = UpdateTour.placement({ top: 450, left: 100, width: 300, height: 300 }, pop, VP);
  assert.equal(above.mode, "above");
  assert.equal(above.top, 450 - 14 - 200);
  const side = UpdateTour.placement({ top: 80, left: 860, width: 400, height: 700 }, pop, VP);
  assert.equal(side.mode, "start-side", "عنصر طويل بجانبه الفراغ");
  assert.equal(side.left, 860 - 14 - 370);
  assert.equal(side.top, 80);
  const inside = UpdateTour.placement({ top: 70, left: 0, width: 1280, height: 720 }, pop, VP);
  assert.equal(inside.mode, "inside");
  assert.ok(inside.top + pop.h <= VP.h);
  assert.ok(inside.left >= 16);
});

test("placement: الجوال ورقة سفلية دائمًا", () => {
  assert.deepEqual(UpdateTour.placement({ top: 100, left: 0, width: 300, height: 100 }, { w: 300, h: 200 }, { w: 390, h: 844 }), { mode: "sheet" });
});

test("scrollTargetY: يتوسّط العنصر القصير، ويلصق الطويل تحت الترويسة", () => {
  const short = UpdateTour.scrollTargetY({ top: 1500, height: 200 }, 1000, VP, 64, 0);
  assert.equal(short, Math.round(1000 + 1500 - (64 + (800 - 64 - 200) / 2)));
  const tall = UpdateTour.scrollTargetY({ top: 1500, height: 2000 }, 1000, VP, 64, 0);
  assert.equal(tall, 1000 + 1500 - 76);
  assert.equal(UpdateTour.scrollTargetY({ top: -500, height: 10 }, 0, VP, 0, 0), 0, "لا تمرير سالب");
});

test("stepLabel: «1 من 3»", () => {
  assert.equal(UpdateTour.stepLabel(0, 3), "1 من 3");
  assert.equal(UpdateTour.stepLabel(2, 3), "3 من 3");
});

test("الربط: الرئيسية تحمّل الوحدة وتستدعيها بعد الرسم في كل تحميل، بلا شرط دخول جديد", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const shell = read("app-shell.html");
  const src = read("update-tour.js");
  assert.match(shell, /<script src="\/update-tour\.js\?v=\d+"><\/script>/);
  assert.match(shell, /<link rel="stylesheet" href="\/update-tour\.css\?v=\d+">/);
  const boot = shell.slice(shell.indexOf("(async function boot(){"));
  assert.ok(boot.indexOf("UpdateTour.maybeStart(") > boot.indexOf("MunicipalCards.mount("), "بعد رسم الأقسام");
  assert.equal(shell.split("UpdateTour.maybeStart(").length - 1, 1);
  /* لا اعتماد على حدث الدخول: لا علامة من login.html ولا قراءة لعلامة الترحيب. */
  assert.ok(!read("login.html").includes("droua:update-tour"), "صفحة الدخول لا تضع علامة للجولة");
  assert.ok(!src.includes("droua:welcome"), "الجولة لا تقرأ علامة الدخول");
  const body = src.slice(src.indexOf("async function maybeStart"));
  assert.ok(body.indexOf("fetch(API)") < body.indexOf("deferred("), "الخادم يُسأل أوّلًا، والتأجيل لا يمنع إلا داخل الزيارة");
  for (const page of ["users-shell.html", "payroll-shell.html", "tickets-shell.html", "reports-shell.html", "expiring-shell.html", "login.html"]) {
    assert.ok(!read(page).includes(`src="/update-tour.js`), `${page} لا تحمّل الجولة`);
  }
});

test("Esc أثناء الجولة مثل «لاحقًا»: لا يُرسل completed ولا skipped", () => {
  assert.equal(UpdateTour.ESC_ACTION, "later");
  const src = fs.readFileSync(path.join(__dirname, "..", "update-tour.js"), "utf8");
  assert.match(src, /e\.key === "Escape"\) \{ e\.preventDefault\(\); end\(ESC_ACTION\)/);
  assert.match(src, /if \(outcome === "later"\) \{ defer\(userId, ctx\.version\); return true; \}\s*await finalize\(ctx, outcome\)/,
    "«later» يعود قبل finalize — فلا POST نهائي");
  /* skipped لا يأتي إلا من الزرّ الصريح. */
  assert.equal((src.match(/end\("skipped"\)/g) || []).length, 1);
  assert.match(src, /b\.dataset\.ut === "skip"\) \{ end\("skipped"\)/);
});

test("مفتاح «لاحقًا» لكل مستخدم وإصدار", () => {
  assert.notEqual(UpdateTour.deferKey("u1", "release-2026.10.27"), UpdateTour.deferKey("u2", "release-2026.10.27"));
  assert.notEqual(UpdateTour.deferKey("u1", "release-2026.10.27"), UpdateTour.deferKey("u1", "release-2026.11.15"));
});

test("المسار: جلسة قديمة صادرة قبل الإصدار، بلا أي حدث دخول بعده — تُعرض الجولة عند فتح المنصّة", async () => {
  const sql = appDb([HR]);
  /* لا login_success ولا أي صفّ في audit_log: الجلسة وحدها. */
  const realNow = Date.now;
  let token;
  try {
    Date.now = () => realNow() - 20 * 24 * 3600 * 1000;   /* «تذكرني» قبل 20 يومًا */
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    token = require("../lib/auth/tokens").issueSessionToken(HR, true);
  } finally { Date.now = realNow; }
  const out = await withFakeDb(sql, async () => {
    const handler = require("../api/app");
    const { res, out } = makeRes();
    await handler({ method: "GET", query: { kind: "api", apiPath: "auth/update-tour" }, headers: { cookie: `session=${encodeURIComponent(token)}` } }, res);
    return out;
  });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.show, true);
  assert.equal(out.body.version, tour.CURRENT_VERSION);
  assert.equal(sql.matching(/INSERT INTO audit_log/).length, 0, "الاستعلام لا يكتب شيئًا");
});

test("لا مكتبة جولات جديدة في الاعتماديات", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const lib of ["shepherd.js", "driver.js", "intro.js"]) assert.ok(!deps.includes(lib), lib);
});
