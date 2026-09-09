const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

const { makeFakeSql } = require("./helpers/fake-sql");

/* ─── بوابة القسم السرّي ───────────────────────────────────────────────
   =========================================================================
   الاختبارات تقيس ما يخرج فعلًا: البايتات في الاستجابة، والكوكي بسماته،
   وعبارات SQL التي تصل إلى القاعدة. رفضٌ لا يمنع الكتابة ليس رفضًا، و404
   يختلف بايتًا واحدًا عن 404 المنصّة ليس إخفاءً. */

const PROTECTED_ID = "11111111-2222-3333-4444-555555555555";
const PROTECTED_EMAIL = "owner@example.test";
const OTHER_ID = "99999999-8888-7777-6666-555555555555";
const ADMIN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OWNER2_ID = "0f0f0f0f-1111-2222-3333-444444444444";

/* قيم اختبار محضة. */
const SESSION_SECRET = "test-only-session-secret-not-a-real-value";
const GATE_SECRET = "test-only-gate-secret-value-not-real-000";
const PEPPER = "test-only-pepper";
const GATE_PASSWORD = "correct-gate-password";

/* معاملات مخفَّضة للاختبار: الصيغة مكتفية ذاتيًا فتُقرأ من الهاش نفسه،
   والمسار المُختبَر هو مسار الإنتاج حرفًا بحرف. واختبار مستقلّ في
   droua-isolation يثبت أن سكربت التوليد يستعمل 2^17. */
const TEST_LOG_N = 14;
let GATE_HASH = null;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DB_PATH = require.resolve("../lib/db");

function clearProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PROJECT_ROOT) && !key.includes("node_modules")) delete require.cache[key];
  }
}

/* async مع await: النسخة المتزامنة تستعيد البيئة قبل أن يبلغ الجسم أول
   await، فتُرفع الحماية في منتصف الاختبار وتمرّ حالات كان يجب أن تُرفض. */
async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withFakeDb(sql, fn) {
  const originalLoad = Module._load;
  clearProjectCache();
  Module._load = function (request, parent, isMain) {
    if (parent) {
      try {
        if (Module._resolveFilename(request, parent, isMain) === DB_PATH) return { getSql: () => sql };
      } catch (err) { /* يمرّ إلى المُحمِّل الأصلي */ }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await fn();
  } finally {
    Module._load = originalLoad;
    clearProjectCache();
  }
}

/* الإعداد الكامل والسليم — نقطة الانطلاق لكل اختبار، ثمّ يُعطَّل منه واحد. */
function fullEnv(extra = {}) {
  return {
    SESSION_SECRET,
    PROTECTED_USER_IDS: PROTECTED_ID,
    DROUA_AUDIT_USER_IDS: PROTECTED_ID,
    DROUA_AUDIT_EMAILS: PROTECTED_EMAIL,
    DROUA_GATE_SECRET: GATE_SECRET,
    DROUA_AUDIT_GATE_PASSWORD_HASH: GATE_HASH,
    DROUA_AUDIT_GATE_PEPPER: PEPPER,
    ...extra,
  };
}

function userRow(o) {
  return {
    id: o.id, name: o.name || "حساب", email: o.email,
    password_hash: "scrypt:00:00", role: o.role || "hr", status: o.status || "active",
    job_title: null, permissions: null, created_at: "2026-01-01", last_login: null,
  };
}
const OWNER_ROW = () => userRow({ id: PROTECTED_ID, email: PROTECTED_EMAIL, role: "hr" });

/* قاعدة مُزيَّفة: مستخدمون + جداول البوابة الثلاثة. */
function fakeDb({ users = [], session = null, failCounts = { short: 0, long: 0, critical: 0 } } = {}) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const state = { session, inserts: [] };
  const sql = makeFakeSql((call) => {
    if (/SELECT \* FROM users WHERE id =/.test(call.text)) {
      const found = byId.get(call.values[0]);
      return found ? [found] : [];
    }
    if (/FROM droua_gate_attempts/.test(call.text) && /count\(\*\)/.test(call.text)) {
      return [{ short_count: failCounts.short, long_count: failCounts.long, critical_count: failCounts.critical }];
    }
    if (/FROM droua_gate_sessions WHERE sid_hash =/.test(call.text)) {
      if (!state.session || state.session.sid_hash !== call.values[0]) return [];
      return [state.session];
    }
    return [];
  });
  sql.state = state;
  return sql;
}

function sessionRow({ sidHash, userId = PROTECTED_ID, idleMs = 900000, absMs = 3600000, revoked = null, now = Date.now() }) {
  return {
    sid_hash: sidHash, user_id: userId,
    idle_exp_ms: now + idleMs, absolute_exp_ms: now + absMs, revoked_at: revoked,
  };
}

function makeRes() {
  const out = { statusCode: 0, body: null, headers: {}, ended: false };
  const setH = (k, v) => { out.headers[String(k).toLowerCase()] = v; };
  const res = {
    setHeader: setH,
    status(code) { out.statusCode = code; return res; },
    json(payload) { out.body = payload; out.ended = true; return res; },
    writeHead(code, headers) {
      out.statusCode = code;
      for (const [k, v] of Object.entries(headers || {})) setH(k, v);
      return res;
    },
    end(payload) { if (payload !== undefined) out.body = payload; out.ended = true; return res; },
  };
  return { res, out };
}

function platformToken(user) {
  const { issueSessionToken } = require("../lib/auth/tokens");
  return issueSessionToken({ id: user.id, email: user.email, role: user.role }, false);
}

/* طلب حقيقي عبر api/app.js — لا عبر الموجّه مباشرة: هذا ما يُثبت أن سطر
   التفويض موصول وأن المسار كامل من المدخل إلى الردّ. */
async function call({ sql, actor, kind = "page", apiPath = null, page = "secure-audit", method = "GET", body, gateCookie = null, ip = null }) {
  return withFakeDb(sql, async () => {
    const handler = require("../api/app");
    const cookies = [];
    if (actor) cookies.push(`session=${encodeURIComponent(platformToken(actor))}`);
    if (gateCookie) cookies.push(`droua_gate=${gateCookie}`);
    const headers = { cookie: cookies.join("; ") };
    if (ip) headers["x-forwarded-for"] = ip;
    const req = {
      method,
      query: kind === "api" ? { kind: "api", apiPath } : { kind: "page", page },
      headers, body,
    };
    const { res, out } = makeRes();
    await handler(req, res);
    return out;
  });
}

/* ردّ المنصّة على مسار غير موجود — مرجع المقارنة البايتيّة. */
async function platformNotFound(sql, actor, kind) {
  return call(sql
    ? { sql, actor, kind, apiPath: kind === "api" ? "no-such-section/x" : null, page: "no-such-page" }
    : {});
}

test("تهيئة: توليد هاش الاختبار", () => {
  const { derive } = require("../lib/droua/gatePassword");
  GATE_HASH = derive(GATE_PASSWORD, { logN: TEST_LOG_N, r: 8, p: 1, pepper: PEPPER });
  assert.match(GATE_HASH, /^scrypt\$14\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
});

/* ════════ أ) الإخفاء: 404 موحّد ════════ */

test("الإخفاء: مستخدم مسجَّل غير مصرَّح يرى 404 مطابقًا لردّ المنصّة", async () => {
  await withEnv(fullEnv(), async () => {
    const other = userRow({ id: OTHER_ID, email: "other@example.test", role: "viewer" });
    const sql = fakeDb({ users: [other] });
    const secure = await call({ sql, actor: other, kind: "page" });
    const reference = await call({ sql, actor: other, kind: "page", page: "no-such-page" });
    assert.equal(secure.statusCode, 404);
    assert.equal(secure.body, reference.body);
    assert.deepEqual(secure.headers, reference.headers, "الرؤوس يجب أن تتطابق أيضًا — فرقٌ فيها دليل");
  });
});

test("الإخفاء: API غير مصرَّح يرى 404 مطابقًا لمسار API مجهول", async () => {
  await withEnv(fullEnv(), async () => {
    const other = userRow({ id: OTHER_ID, email: "other@example.test" });
    const sql = fakeDb({ users: [other] });
    const secure = await call({ sql, actor: other, kind: "api", apiPath: "secure-audit/gate/status" });
    const reference = await call({ sql, actor: other, kind: "api", apiPath: "no-such-section/x" });
    assert.equal(secure.statusCode, 404);
    assert.deepEqual(secure.body, reference.body);
    assert.deepEqual(secure.headers, reference.headers);
  });
});

test("الإخفاء: owner و admin لا يملكان أي تجاوز", async () => {
  await withEnv(fullEnv(), async () => {
    for (const role of ["owner", "admin"]) {
      const id = role === "owner" ? OWNER2_ID : ADMIN_ID;
      const actor = userRow({ id, email: `${role}@example.test`, role });
      const sql = fakeDb({ users: [actor] });
      const page = await call({ sql, actor, kind: "page" });
      const api = await call({ sql, actor, kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: GATE_PASSWORD } });
      assert.equal(page.statusCode, 404, `${role} يجب أن يرى 404`);
      assert.equal(api.statusCode, 404, `${role} يجب ألّا يبلغ الفتح`);
    }
  });
});

test("الإخفاء: كل إعداد ناقص أو تالف يُخفي القسم — لا فشل مميّز", async () => {
  const broken = {
    "DROUA_AUDIT_USER_IDS غائب": { DROUA_AUDIT_USER_IDS: null },
    "DROUA_AUDIT_EMAILS غائب": { DROUA_AUDIT_EMAILS: null },
    "PROTECTED_USER_IDS غائب": { PROTECTED_USER_IDS: null },
    "DROUA_GATE_SECRET غائب": { DROUA_GATE_SECRET: null },
    "DROUA_GATE_SECRET قصير": { DROUA_GATE_SECRET: "short" },
    "الهاش غائب": { DROUA_AUDIT_GATE_PASSWORD_HASH: null },
    "الهاش تالف": { DROUA_AUDIT_GATE_PASSWORD_HASH: "scrypt$17$8$1$zz$yy" },
    "الهاش بخوارزمية مجهولة": { DROUA_AUDIT_GATE_PASSWORD_HASH: "bcrypt$17$8$1$aabb$ccdd" },
    "المصرَّح له غير محميّ": { PROTECTED_USER_IDS: OTHER_ID },
  };
  for (const [label, override] of Object.entries(broken)) {
    await withEnv(fullEnv(override), async () => {
      const sql = fakeDb({ users: [OWNER_ROW()] });
      const out = await call({ sql, actor: OWNER_ROW(), kind: "page" });
      assert.equal(out.statusCode, 404, `${label}: يجب 404`);
      assert.equal(out.body, "Not found");
    });
  }
});

test("الإخفاء: تطابق المعرّف دون البريد — والعكس — يُردّان", async () => {
  await withEnv(fullEnv({ DROUA_AUDIT_EMAILS: "someone-else@example.test" }), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "page" });
    assert.equal(out.statusCode, 404, "بريد غير مطابق → 404");
  });
  await withEnv(fullEnv({ DROUA_AUDIT_USER_IDS: OTHER_ID, PROTECTED_USER_IDS: OTHER_ID }), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "page" });
    assert.equal(out.statusCode, 404, "معرّف غير مطابق → 404");
  });
});

test("الإخفاء: حساب معطَّل يُخفى ولا يُصرَّح بحاله", async () => {
  await withEnv(fullEnv(), async () => {
    const disabled = userRow({ id: PROTECTED_ID, email: PROTECTED_EMAIL, status: "disabled" });
    const sql = fakeDb({ users: [disabled] });
    const out = await call({ sql, actor: disabled, kind: "page" });
    assert.equal(out.statusCode, 404);
  });
});

test("الإخفاء: غير المسجَّل يُعامل كأي مسار في المنصّة", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({});
    const page = await call({ sql, actor: null, kind: "page" });
    assert.equal(page.statusCode, 302);
    assert.equal(page.headers.location, "/login.html");
    const api = await call({ sql, actor: null, kind: "api", apiPath: "secure-audit/gate/status" });
    assert.equal(api.statusCode, 401);
  });
});

test("الإخفاء: الرفض المبكّر لا يستعلم القاعدة أصلًا", async () => {
  /* شرطُ إخفاء لا تحسين أداء: لو استعلمنا القاعدة قبل فحص القائمة لصار
     ردّ /secure-audit أبطأ بجولة قاعدة من ردّ مسار غير موجود. */
  await withEnv(fullEnv(), async () => {
    const other = userRow({ id: OTHER_ID, email: "other@example.test" });
    const sql = fakeDb({ users: [other] });
    await call({ sql, actor: other, kind: "page" });
    assert.equal(sql.matching(/SELECT \* FROM users/).length, 0, "لا رحلة إلى القاعدة لمن ليس في القائمة");
  });
});

/* ════════ ب) كلمة المرور والقفل ════════ */

test("البوابة: كلمة المرور الصحيحة تفتح وتضع الكوكي بسماته الخمس", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const out = await call({
      sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock",
      method: "POST", body: { password: GATE_PASSWORD },
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(out.body.ok, true);
    assert.equal(out.body.unlocked, true);
    const cookie = out.headers["set-cookie"];
    assert.match(cookie, /^droua_gate=[^;]+;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/secure-audit(;|$)/);
    assert.match(cookie, /Max-Age=\d+/);
    /* الصفّ كُتب، والمكتوب هو التجزئة لا المعرّف الخام. */
    const insert = sql.matching(/INSERT INTO droua_gate_sessions/)[0];
    assert.ok(insert, "يجب إنشاء صفّ جلسة");
    assert.match(String(insert.values[0]), /^[0-9a-f]{64}$/, "المخزَّن sha256 لا معرّف خام");
    const token = cookie.split(";")[0].split("=")[1];
    assert.ok(!insert.values.some((v) => String(v).includes(token)), "التوكن الخام يجب ألّا يُخزَّن");
  });
});

test("البوابة: الخاطئة والغائبة والطويلة تُردّ بالبايتات نفسها", async () => {
  await withEnv(fullEnv(), async () => {
    const bodies = [
      { password: "wrong-password" },
      {},
      { password: "" },
      { password: "x".repeat(300) },
      { password: 12345 },
    ];
    const seen = [];
    for (const body of bodies) {
      const sql = fakeDb({ users: [OWNER_ROW()] });
      const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body });
      assert.equal(out.statusCode, 403);
      assert.equal(sql.matching(/INSERT INTO droua_gate_sessions/).length, 0, "لا جلسة عند الفشل");
      seen.push(JSON.stringify(out.body));
    }
    assert.equal(new Set(seen).size, 1, "كل أسباب الفشل يجب أن تُنتج الجسم نفسه");
  });
});

test("البوابة: القفل يُنتج الردّ نفسه — ولا يكشف نفسه", async () => {
  await withEnv(fullEnv(), async () => {
    const locked = fakeDb({ users: [OWNER_ROW()], failCounts: { short: 5, long: 5, critical: 5 } });
    const lockedOut = await call({
      sql: locked, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock",
      method: "POST", body: { password: GATE_PASSWORD },   // الصحيحة! ومع ذلك يُردّ
    });
    const plain = fakeDb({ users: [OWNER_ROW()] });
    const wrong = await call({
      sql: plain, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock",
      method: "POST", body: { password: "wrong" },
    });
    assert.equal(lockedOut.statusCode, wrong.statusCode);
    assert.deepEqual(lockedOut.body, wrong.body);
    assert.ok(!("retryAfter" in lockedOut.body), "ممنوع كشف مدّة القفل");
    assert.equal(locked.matching(/INSERT INTO droua_gate_sessions/).length, 0, "القفل يمنع الفتح ولو صحّت الكلمة");
  });
});

test("البوابة: زمن الردّ عند القفل لا يقلّ عن الأرضية", async () => {
  await withEnv(fullEnv(), async () => {
    const { RESPONSE_FLOOR_MS } = require("../lib/droua/router");
    const sql = fakeDb({ users: [OWNER_ROW()], failCounts: { short: 9, long: 9, critical: 9 } });
    const t0 = Date.now();
    await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "x" } });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= RESPONSE_FLOOR_MS - 25, `الزمن ${elapsed}ms أقلّ من الأرضية — فرقٌ يُقاس يكشف السبب`);
  });
});

test("البوابة: محاولات القفل لا تكتب حرفًا في users", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()], failCounts: { short: 14, long: 14, critical: 14 } });
    for (let i = 0; i < 3; i++) {
      await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "wrong" } });
    }
    assert.equal(sql.matching(/UPDATE users/).length, 0, "حساب المنصّة يجب ألّا يُقفل ولا يُعدَّل");
    assert.equal(sql.matching(/DELETE FROM users/).length, 0);
    assert.equal(sql.matching(/INSERT INTO users/).length, 0);
  });
});

test("البوابة: كلمة المرور لا تظهر في أي صفّ يُكتب", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "my-secret-attempt" } });
    for (const c of sql.calls) {
      const all = JSON.stringify(c.values) + c.text;
      assert.ok(!all.includes("my-secret-attempt"), `تسرّبت كلمة المرور في: ${c.text}`);
    }
  });
});

test("البوابة: العتبة الثالثة تُبلّغ ولا تُطيل القفل فوق 60 دقيقة", () => {
  const rl = require("../lib/droua/rateLimit");
  assert.deepEqual(rl.evaluate({ short: 4, long: 4, critical: 4 }), { locked: false, critical: false });
  assert.deepEqual(rl.evaluate({ short: 5, long: 5, critical: 5 }), { locked: true, critical: false });
  assert.deepEqual(rl.evaluate({ short: 0, long: 10, critical: 10 }), { locked: true, critical: false });
  /* 15 خلال 24 ساعة بلا إخفاقات حديثة: تبليغ بلا قفل. */
  assert.deepEqual(rl.evaluate({ short: 0, long: 0, critical: 15 }), { locked: false, critical: true });
  assert.equal(rl.MAX_LOCK_MS, 60 * 60 * 1000, "أقصى قفل 60 دقيقة");
});

/* ════════ ج) الجلسة ════════ */

function openSession({ now = Date.now(), idleMs = 900000, absMs = 3600000, revoked = null, userId = PROTECTED_ID, secret = GATE_SECRET } = {}) {
  const gateToken = require("../lib/droua/gateToken");
  const sid = gateToken.newSid();
  const issued = gateToken.issue({ userId, sid, now, idleMs, absoluteExp: now + absMs }, secret);
  return { sid, token: issued.token, row: sessionRow({ sidHash: gateToken.hashSid(sid), userId, idleMs, absMs, revoked, now }) };
}

test("الجلسة: كوكي صالح يفتح الصفحة ويجدّد المهلة", async () => {
  await withEnv(fullEnv(), async () => {
    let s;
    await withFakeDb(makeFakeSql(() => []), async () => { s = openSession(); });
    const sql = fakeDb({ users: [OWNER_ROW()], session: s.row });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "page", gateCookie: s.token });
    assert.equal(out.statusCode, 200);
    assert.match(out.body, /id="v-runs"/);
    assert.ok(!/رواتب|ذروة|مسير/.test(out.body), "الصفحة يجب ألّا تسمّي القسم");
    assert.equal(sql.matching(/UPDATE droua_gate_sessions/).length, 1, "يجب انزلاق مهلة الخمول");
  });
});

test("الجلسة: بلا كوكي تُعرض شاشة كلمة المرور لا البيانات", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "page" });
    assert.equal(out.statusCode, 200);
    assert.match(out.body, /أدخل كلمة المرور/);
    assert.ok(!/id="v-runs"/.test(out.body));
  });
});

test("الجلسة: توكن موقَّع بسرّ المنصّة مرفوض", async () => {
  await withEnv(fullEnv(), async () => {
    let s;
    await withFakeDb(makeFakeSql(() => []), async () => { s = openSession({ secret: SESSION_SECRET }); });
    const sql = fakeDb({ users: [OWNER_ROW()], session: s.row });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/status", gateCookie: s.token });
    assert.equal(out.body.unlocked, false, "سرٌّ مختلف يجب ألّا يُقبل");
  });
});

test("الجلسة: توكن جلسة المنصّة نفسه مُقدَّمًا ككوكي بوابة مرفوض", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const platform = await withFakeDb(sql, async () => platformToken(OWNER_ROW()));
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/status", gateCookie: platform });
    assert.equal(out.body.unlocked, false);
  });
});

test("الجلسة: تجاوز الخمول يُقفل", async () => {
  await withEnv(fullEnv(), async () => {
    let s;
    await withFakeDb(makeFakeSql(() => []), async () => {
      /* توكن انتهى خموله قبل دقيقة، وسقفه المطلق ما زال بعيدًا. */
      s = openSession({ now: Date.now() - 16 * 60 * 1000, idleMs: 900000, absMs: 3600000 });
    });
    const sql = fakeDb({ users: [OWNER_ROW()], session: s.row });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/status", gateCookie: s.token });
    assert.equal(out.body.unlocked, false);
  });
});

test("الجلسة: تجاوز السقف المطلق يُقفل ولو كان الخمول حيًّا", async () => {
  await withEnv(fullEnv(), async () => {
    const gateToken = require("../lib/droua/gateToken");
    const now = Date.now();
    /* أسوأ حالة: توكن أُصدر الآن (خموله حيّ تمامًا) لكن سقفه المطلق مضى.
       بلا فحص aexp لكان النشاط المتّصل يمدّد الجلسة إلى الأبد. */
    const sid = gateToken.newSid();
    const issued = gateToken.issue({ userId: PROTECTED_ID, sid, now, idleMs: 900000, absoluteExp: now - 1000 }, GATE_SECRET);
    const sql = fakeDb({ users: [OWNER_ROW()], session: sessionRow({ sidHash: gateToken.hashSid(sid), absMs: -1000, now }) });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/status", gateCookie: issued.token });
    assert.equal(out.body.unlocked, false);
  });
});

test("الجلسة: الانزلاق لا يتجاوز السقف المطلق أبدًا", () => {
  const gateToken = require("../lib/droua/gateToken");
  const now = Date.now();
  const soon = now + 60 * 1000;   // السقف بعد دقيقة، والخمول 15
  const issued = gateToken.issue({ userId: "u", sid: "s", now, idleMs: 900000, absoluteExp: soon }, GATE_SECRET);
  assert.equal(issued.exp, soon, "الخمول يُقصَّر إلى السقف لا العكس");
  assert.equal(issued.aexp, soon);
});

test("الجلسة: صفّ مُبطَل يُرفض ولو صحّ التوقيع والمهلة", async () => {
  await withEnv(fullEnv(), async () => {
    let s;
    await withFakeDb(makeFakeSql(() => []), async () => { s = openSession({ revoked: "2026-09-08T00:00:00Z" }); });
    const sql = fakeDb({ users: [OWNER_ROW()], session: s.row });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/status", gateCookie: s.token });
    assert.equal(out.body.unlocked, false, "الإبطال هو ما يجعل قفل القسم حقيقيًا");
  });
});

test("الجلسة: إعادة استعمال توكن بعد القفل مرفوضة", async () => {
  await withEnv(fullEnv(), async () => {
    let s;
    await withFakeDb(makeFakeSql(() => []), async () => { s = openSession(); });
    const sql = fakeDb({ users: [OWNER_ROW()], session: s.row });

    const lock = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/lock", method: "POST", gateCookie: s.token });
    assert.equal(lock.statusCode, 200);
    assert.equal(sql.matching(/UPDATE droua_gate_sessions SET revoked_at/).length, 1);
    assert.match(lock.headers["set-cookie"], /droua_gate=;/);
    assert.match(lock.headers["set-cookie"], /Path=\/secure-audit(;|$)/, "المسح يجب أن يكون بنفس الـPath وإلّا بقي الكوكي");

    /* الآن نُحاكي أن القاعدة صارت تُرجعه مُبطَلًا — نفس التوكن يُعاد استعماله. */
    sql.state.session = { ...s.row, revoked_at: "2026-09-08T00:00:00Z" };
    const replay = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/status", gateCookie: s.token });
    assert.equal(replay.body.unlocked, false, "توكن مُبطَل لا يُقبل مهما أُعيد");
  });
});

test("الجلسة: جلسة مستخدم آخر لا تُقبل", async () => {
  await withEnv(fullEnv(), async () => {
    let s;
    await withFakeDb(makeFakeSql(() => []), async () => { s = openSession({ userId: OTHER_ID }); });
    const sql = fakeDb({ users: [OWNER_ROW()], session: s.row });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/status", gateCookie: s.token });
    assert.equal(out.body.unlocked, false);
  });
});

test("الجلسة: مسارات غير معروفة داخل القسم تُردّ بـ404", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    for (const p of [
      "secure-audit/gate/whatever", "secure-audit/nope", "secure-audit/files",
      "secure-audit/runs/not-a-uuid", "secure-audit/runs/../../etc",
    ]) {
      const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: p });
      assert.equal(out.statusCode, 404, `${p} يجب ألّا يوجد`);
    }
  });
});

test("الجلسة: مسار بياناتٍ حقيقيّ ببوابة مقفلة يُردّ 401 لا بيانات", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/runs" });
    /* 401 لا 404: من بلغ هنا اجتاز التحقّق من الهويّة أصلًا وهو صاحب
       الحساب، فالتمييز لا يكشف شيئًا لأحد سواه — ويقول له أن يفتح البوابة
       بدل أن يظنّ المسار غير موجود. */
    assert.equal(out.statusCode, 401);
    assert.equal(out.body.locked, true);
    assert.equal(out.body.runs, undefined, "لا بيان يخرج قبل فتح البوابة");
    assert.equal(sql.matching(/droua_payroll_/).length, 0, "ولا استعلام بلغ جداول البيانات");
  });
});

test("الجلسة: الطريقة الخاطئة مرفوضة", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const get = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "GET" });
    assert.equal(get.statusCode, 404);
    assert.equal(sql.matching(/INSERT INTO droua_gate_sessions/).length, 0);
  });
});

/* ════════ د) الرؤوس ════════ */

test("الرؤوس: الاستجابة المصرَّح بها تحمل رؤوس الأمان و CSP بـnonce", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "page" });
    assert.match(out.headers["cache-control"], /no-store/);
    assert.equal(out.headers["referrer-policy"], "no-referrer");
    assert.equal(out.headers["x-content-type-options"], "nosniff");
    assert.equal(out.headers["x-frame-options"], "DENY");
    assert.match(out.headers["x-robots-tag"], /noindex/);
    const csp = out.headers["content-security-policy"];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
    assert.ok(out.body.includes(`nonce="${nonce}"`), "الـnonce في الرأس يجب أن يطابق الصفحة");
    assert.ok(!/unsafe-inline/.test(csp), "ممنوع unsafe-inline");
  });
});

test("الرؤوس: ردّ 404 لا يحمل رؤوس أمان — وإلّا صار مميّزًا", async () => {
  await withEnv(fullEnv(), async () => {
    const other = userRow({ id: OTHER_ID, email: "other@example.test" });
    const sql = fakeDb({ users: [other] });
    const out = await call({ sql, actor: other, kind: "page" });
    assert.equal(out.headers["content-security-policy"], undefined);
    assert.equal(out.headers["x-robots-tag"], undefined);
  });
});

/* ════════ هـ) الصفحة لا تحمل أصلًا كاشفًا ════════ */

test("الصفحة: مكتفية ذاتيًا — لا ملفّ CSS أو JS خارجيّ", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    const out = await call({ sql, actor: OWNER_ROW(), kind: "page" });
    assert.ok(!/<link[^>]+href=/.test(out.body), "لا رابط أصل خارجيّ");
    assert.ok(!/<script[^>]+src=/.test(out.body), "لا سكربت خارجيّ");
    assert.match(out.body, /<style nonce=/);
    assert.match(out.body, /noindex/);
  });
});

test("البوابة: القفل ينفّذ الاشتقاق نفسه — التوحيد الزمنيّ بنيويّ", async () => {
  /* الأرضية وحدها لا تكفي: لو تجاوز scrypt الأرضية على نسخة بطيئة لعاد
     الفرق. فالمقياس هنا أن الحالتين تُنفّذان العمل نفسه لا أنّهما تنتهيان
     عند رقم واحد. */
  await withEnv(fullEnv(), async () => {
    const samples = { locked: [], wrong: [] };
    for (let i = 0; i < 3; i++) {
      const lockedSql = fakeDb({ users: [OWNER_ROW()], failCounts: { short: 9, long: 9, critical: 9 } });
      let t = Date.now();
      await call({ sql: lockedSql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: GATE_PASSWORD } });
      samples.locked.push(Date.now() - t);

      const openSql = fakeDb({ users: [OWNER_ROW()] });
      t = Date.now();
      await call({ sql: openSql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "wrong-password" } });
      samples.wrong.push(Date.now() - t);
    }
    const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const gap = Math.abs(median(samples.locked) - median(samples.wrong));
    assert.ok(gap < 120, `فرق الزمن بين القفل وكلمة المرور الخاطئة ${gap}ms — يجب أن يكون ضئيلًا`);
  });
});

test("البوابة: استكشاف القسم يُسجَّل ببصمة جهاز", async () => {
  await withEnv(fullEnv(), async () => {
    const other = userRow({ id: OTHER_ID, email: "other@example.test" });
    const sql = fakeDb({ users: [other] });
    await call({ sql, actor: other, kind: "page", ip: "203.0.113.9" });
    const rows = sql.matching(/INSERT INTO droua_gate_audit/);
    assert.equal(rows.length, 1, "الرفض المستحقّ يجب أن يُسجَّل");
    assert.equal(rows[0].values[0], "access_denied");
    /* البصمة تظهر مرّتين في العبارة المحروسة: في المُدرَج وفي مسند الكتم. */
    const hashes = rows[0].values.filter((v) => /^[0-9a-f]{16}$/.test(String(v)));
    assert.equal(hashes.length, 2, "بصمة مقطوعة في المُدرَج وفي حرس النافذة");
    assert.ok(!JSON.stringify(rows[0].values).includes("203.0.113.9"), "العنوان الخام يجب ألّا يُخزَّن");
  });
});

test("التدقيق: كتابة أحداث الاستكشاف مقيَّدة بنافذة — لا صفّ لكل طلب", async () => {
  /* انحدار: أي مستخدم مسجَّل يستطيع طرق مسار القسم في حلقة. صفٌّ لكل طلب
     يملأ جدول التدقيق ويستهلك القاعدة، ويُغرق الإشارة الحقيقية في ضجيج —
     وسجلٌّ لا يُقرأ لكثرته سجلٌّ معطَّل. */
  await withEnv(fullEnv(), async () => {
    const other = userRow({ id: OTHER_ID, email: "other@example.test" });
    const sql = fakeDb({ users: [other] });
    for (let i = 0; i < 5; i++) await call({ sql, actor: other, kind: "page", ip: "203.0.113.9" });

    const writes = sql.matching(/INSERT INTO droua_gate_audit/);
    assert.equal(writes.length, 5, "خمسة طلبات = خمس عبارات");
    for (const w of writes) {
      /* الحدّ في القاعدة لا في التطبيق: عبارة واحدة ذرّية تُدرج فقط إن لم
         يوجد صفّ مطابق داخل النافذة — فلا سباق يكتب صفّين. */
      assert.match(w.text, /WHERE NOT EXISTS/, "الكتابة يجب أن تكون محروسة");
      assert.match(w.text, /ip_hash IS NOT DISTINCT FROM/, "طلبٌ بلا عنوان معروف يجب ألّا يفلت");
      assert.match(w.text, /ts > \?/, "الحرس يجب أن يكون مقيَّدًا بنافذة زمنية");
    }
  });
});

test("التدقيق: نافذة الكتم عشر دقائق، والحدث والبصمة معًا مفتاحها", () => {
  const audit = require("../lib/droua/audit");
  assert.equal(audit.THROTTLE_MS, 10 * 60 * 1000);
  const calls = [];
  const fake = (strings, ...values) => { calls.push({ text: strings.join("?"), values }); return Promise.resolve([]); };
  fake.unsafe = (x) => x;
  const now = 1_700_000_000_000;
  return audit.logThrottled(fake, { event: "access_denied", ip: "198.51.100.4", secret: "s".repeat(40), now }).then(() => {
    const v = calls[0].values;
    assert.equal(v[0], "access_denied");
    assert.ok(v.includes(new Date(now - audit.THROTTLE_MS).toISOString()), "حدّ النافذة يجب أن يُمرَّر معاملًا");
    assert.ok(!JSON.stringify(v).includes("198.51.100.4"), "العنوان الخام يجب ألّا يُمرَّر");
  });
});

test("التدقيق: أحداث الفتح ليست مقيَّدة — حدّها هو القفل نفسه", async () => {
  /* gate_unlock_failed محدود أصلًا بالقفل (عشرات في الساعة على الأكثر)،
     وكل واحد منها ذو معنى. تقييده كان سيُخفي محاولاتٍ يجب أن تُرى. */
  await withEnv(fullEnv(), async () => {
    const sql = fakeDb({ users: [OWNER_ROW()] });
    await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "wrong" } });
    const writes = sql.matching(/INSERT INTO droua_gate_audit/);
    assert.equal(writes.length, 1);
    assert.ok(!/WHERE NOT EXISTS/.test(writes[0].text), "أحداث الفتح تُسجَّل كلّها");
  });
});

/* ════════ و) التزامن والتقليم ════════ */

/* قاعدة ذات حالة تحاكي دلالات العبارة المدمجة: الإدراج يُودَع ثم يُعدّ،
   فالعدّ يشمل صفّ الطلب نفسه وكل ما أُودع قبله. */
function statefulDb(users) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const fails = [];
  let nextId = 1;
  const sessions = new Map();
  const sql = makeFakeSql((call) => {
    if (/SELECT \* FROM users WHERE id =/.test(call.text)) {
      const u = byId.get(call.values[0]);
      return u ? [u] : [];
    }
    /* العبارة المدمجة: تُفحص قبل أي نمط آخر لأنها تحوي INSERT و count معًا. */
    if (/WITH ins AS/.test(call.text)) {
      /* لقطة ما قبل الإدراج — كما تفعل Postgres مع CTE كاتب. */
      const prior = fails.length;
      const row = { id: nextId++, user_id: call.values[0] };
      fails.push(row);
      return [{ attempt_id: row.id, short_count: prior, long_count: prior, critical_count: prior }];
    }
    if (/DELETE FROM droua_gate_attempts WHERE id =/.test(call.text)) {
      const i = fails.findIndex((f) => f.id === call.values[0]);
      if (i >= 0) fails.splice(i, 1);
      return [];
    }
    if (/DELETE FROM droua_gate_attempts WHERE user_id/.test(call.text)) {
      fails.length = 0;
      return [];
    }
    if (/INSERT INTO droua_gate_sessions/.test(call.text)) {
      sessions.set(call.values[0], call.values[1]);
      return [];
    }
    return [];
  });
  sql.fails = fails;
  sql.sessions = sessions;
  return sql;
}

test("التزامن: طلبات متزامنة لا تتجاوز عتبة القفل", async () => {
  /* انحدار لعطل مقيس: كان المسار يقرأ العدّاد ثم يشتقّ scrypt ثم يسجّل،
     وبين القراءة والتسجيل مئات الميلي‌ثانية — فاثنتا عشرة محاولة متزامنة
     اجتازت كلّها فحص القفل والعتبة خمس. أي أن التزامن كان يضرب الحدّ في
     عدد الطلبات. */
  await withEnv(fullEnv(), async () => {
    const sql = statefulDb([OWNER_ROW()]);
    const attempts = Array.from({ length: 12 }, () =>
      call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "wrong" } })
    );
    const results = await Promise.all(attempts);
    assert.ok(results.every((r) => r.statusCode === 403), "كلّها تُردّ — والردّ واحد لا يميّز السبب");
    /* المحاولة المردودة بالقفل تُحذف، فالباقي هو ما بلغ الاشتقاق فعلًا. */
    assert.ok(sql.fails.length <= WINDOWS_SHORT_THRESHOLD, `بلغ الاشتقاق ${sql.fails.length} — يجب ألّا يتجاوز العتبة`);
    assert.ok(sql.fails.length >= 1, "بعضها يجب أن يمرّ قبل أن ينعقد القفل");
  });
});

const WINDOWS_SHORT_THRESHOLD = require("../lib/droua/rateLimit").WINDOWS.short.threshold;

test("التزامن: المحاولة المردودة بالقفل لا تُحسب ولا تمدّده", async () => {
  /* بلا الحذف يمدّد الطرقُ المتكرّر النافذةَ فلا تنتهي — أي قفلٌ دائم بدل
     ستّين دقيقة، وهو الخطر التشغيليّ الذي حُدّد السقف لأجله. */
  await withEnv(fullEnv(), async () => {
    const sql = statefulDb([OWNER_ROW()]);
    for (let i = 0; i < 30; i++) {
      await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "wrong" } });
    }
    assert.equal(sql.fails.length, WINDOWS_SHORT_THRESHOLD,
      "ثلاثون محاولة يجب أن تُبقي عدد الصفوف عند العتبة — لا أن تراكم ثلاثين");
    assert.ok(sql.matching(/DELETE FROM droua_gate_attempts WHERE id =/).length >= 25, "الزائدة تُحذف");
  });
});

test("التزامن: النجاح يمسح صفّ محاولته مع ما سبقه", async () => {
  await withEnv(fullEnv(), async () => {
    const sql = statefulDb([OWNER_ROW()]);
    await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: "wrong" } });
    assert.equal(sql.fails.length, 1);
    const out = await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: GATE_PASSWORD } });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(sql.fails.length, 0, "النجاح يمسح العدّاد — بما فيه صفّ محاولته هو");
    assert.equal(sql.sessions.size, 1);
  });
});

test("التقليم: كل فتح ناجح يقلّم الجلسات المنتهية والمحاولات القديمة", async () => {
  /* صفوف الجلسات كانت تتراكم بلا حذف: كل فتح صفّ، ولا شيء ينظّفه. */
  await withEnv(fullEnv(), async () => {
    const sql = statefulDb([OWNER_ROW()]);
    await call({ sql, actor: OWNER_ROW(), kind: "api", apiPath: "secure-audit/gate/unlock", method: "POST", body: { password: GATE_PASSWORD } });
    assert.equal(sql.matching(/DELETE FROM droua_gate_attempts WHERE ts </).length, 1, "تقليم المحاولات");
    assert.equal(sql.matching(/DELETE FROM droua_gate_sessions WHERE absolute_exp </).length, 1, "تقليم الجلسات");
  });
});

test("التقليم: حذف صفّ جلسة يفشل مغلقًا لا مفتوحًا", () => {
  const gs = require("../lib/droua/gateSessions");
  /* توكنٌ يشير إلى صفٍّ محذوف لا يجد جلسته. */
  assert.equal(gs.isUsable(null, PROTECTED_ID, Date.now()), false);
  assert.ok(gs.SESSION_PRUNE_GRACE_MS >= 24 * 60 * 60 * 1000, "مهلة يوم بعد السقف تُبقي أثر الجلسات الحديثة");
});
