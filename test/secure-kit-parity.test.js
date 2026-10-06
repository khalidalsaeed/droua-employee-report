const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { makeFakeSql } = require("./helpers/fake-sql");
const { withDroua } = require("./helpers/droua-harness");

/* ─── تكافؤ lib/secure-kit مع lib/droua ────────────────────────────────
   =========================================================================
   الطبقة المشتركة تنفيذٌ ثانٍ مؤقّت لمنطق Droua الأمنيّ، حتى يُنقل Droua
   إليها في تاسكٍ مستقلّ. وهذا الملفّ هو ما يمنع التنفيذين من الافتراق:
   يشغّل الطبقة **بإعداد Droua** ويقارن ما يخرج منها بما يخرج من وحدات Droua
   الحالية — بايتًا ببايت ونصًّا بنصّ.

   فإصلاحٌ أمنيّ يدخل أحدهما وينسى الآخر يُسقط هذا الاختبار. وهو نفسه
   مواصفة النقل: ما دام أخضر، فالاستبدال لا يغيّر سلوكًا.

   كل القيم هنا اصطناعية: لا سرّ حقيقيّ، ولا بيانات إنتاج، ولا شبكة. */

const kit = require("../lib/secure-kit");
const drouaToken = require("../lib/droua/gateToken");
const drouaPassword = require("../lib/droua/gatePassword");
const drouaConfig = require("../lib/droua/config");
const drouaRate = require("../lib/droua/rateLimit");
const drouaSessions = require("../lib/droua/gateSessions");
const drouaAudit = require("../lib/droua/audit");
const drouaHeaders = require("../lib/droua/headers");

const SECRET = "synthetic-parity-secret-0123456789abcdef";
const USER = "11111111-2222-4333-8444-555555555555";
const NOW = Date.UTC(2026, 0, 15, 9, 30, 0);

const drouaCodec = kit.token.createTokenCodec({ type: drouaToken.TOKEN_TYPE });
const otherCodec = kit.token.createTokenCodec({ type: "medins-gate" });

/* ─── التوكن ─── */

test("التكافؤ: sign يُنتج النصّ نفسه لكل حمولة", () => {
  const payloads = [
    { typ: "droua-gate", sub: USER, sid: "a".repeat(64), iat: NOW, exp: NOW + 1, aexp: NOW + 2 },
    { typ: "x", sub: "ص", sid: "s", iat: 0, exp: 1, aexp: 1, extra: [1, 2] },
    {},
  ];
  for (const p of payloads) assert.equal(drouaCodec.sign(p, SECRET), drouaToken.sign(p, SECRET));
});

test("التكافؤ: issue متطابق، والسقف المطلق لا يُتجاوز", () => {
  const args = { userId: USER, sid: "b".repeat(64), now: NOW, idleMs: 15 * 60 * 1000, absoluteExp: NOW + 10 * 60 * 1000 };
  assert.deepEqual(drouaCodec.issue(args, SECRET), drouaToken.issue(args, SECRET));
});

test("التكافؤ: كلٌّ يقبل توكن الآخر بإعداد Droua — وجدول الحقيقة واحد", () => {
  const good = drouaToken.issue({ userId: USER, sid: "c".repeat(64), now: NOW, idleMs: 60000, absoluteExp: NOW + 120000 }, SECRET).token;
  const cases = [
    [good, NOW + 1], [good, NOW + 60000], [good, NOW - 1],
    [good + "x", NOW], [good.split(".")[0], NOW], ["", NOW], [null, NOW], ["a.b.c", NOW],
    [drouaToken.sign({ typ: "droua-gate", sub: USER, sid: "s", exp: NOW + 5, aexp: NOW + 4 }, SECRET), NOW],
    [drouaToken.sign({ typ: "droua-gate", sub: "", sid: "s", exp: NOW + 5, aexp: NOW + 9 }, SECRET), NOW],
    [drouaToken.sign({ typ: "droua-gate", sub: USER, sid: "s", exp: "1", aexp: NOW + 9 }, SECRET), NOW],
  ];
  for (const [token, now] of cases) {
    assert.deepEqual(drouaCodec.verify(token, SECRET, now), drouaToken.verify(token, SECRET, now));
  }
  assert.equal(drouaToken.hashSid("abc"), drouaCodec.hashSid("abc"));
});

test("الفصل: توكن وحدةٍ أخرى يُرفض في Droua، وتوكن Droua يُرفض فيها", () => {
  const args = { userId: USER, sid: "d".repeat(64), now: NOW, idleMs: 60000, absoluteExp: NOW + 120000 };
  const foreign = otherCodec.issue(args, SECRET).token;
  const droua = drouaToken.issue(args, SECRET).token;
  assert.equal(drouaToken.verify(foreign, SECRET, NOW + 1), null, "Droua يقبل توكنًا ليس له");
  assert.equal(otherCodec.verify(droua, SECRET, NOW + 1), null, "الوحدة تقبل توكن Droua");
  assert.ok(otherCodec.verify(foreign, SECRET, NOW + 1));
});

/* ─── كلمة المرور ─── */

const LOG_N = 12; // معامل مخفَّض للسرعة؛ الصيغة تحمل معاملها فالمسار واحد

test("التكافؤ: derive بالـsalt نفسه يعطي الهاش نفسه", () => {
  const opts = { logN: LOG_N, pepper: "synthetic-pepper", salt: "00112233445566778899aabbccddeeff" };
  assert.equal(kit.password.derive("كلمة-اصطناعية", opts), drouaPassword.derive("كلمة-اصطناعية", opts));
});

test("التكافؤ: verify له جدول الحقيقة نفسه", () => {
  const pepper = "synthetic-pepper";
  const stored = drouaPassword.derive("pw-1", { logN: LOG_N, pepper });
  const parsedDroua = drouaConfig.parseHash(stored);
  const parsedKit = kit.password.parseHash(stored);
  assert.deepEqual(parsedKit, parsedDroua);
  const inputs = ["pw-1", "pw-2", "", "x".repeat(256), "x".repeat(257), 42, null, undefined, "PW-1"];
  for (const input of inputs) {
    for (const pep of [pepper, "other", ""]) {
      assert.equal(kit.password.verify(input, parsedKit, pep), drouaPassword.verify(input, parsedDroua, pep), `input=${String(input).slice(0, 8)}`);
    }
  }
  assert.equal(kit.password.MAX_INPUT_LENGTH, drouaPassword.MAX_INPUT_LENGTH);
});

test("التكافؤ: parseHash على صيغ صحيحة وتالفة", () => {
  const salt = "a".repeat(32);
  const hash = "b".repeat(128);
  const fixtures = [
    `scrypt$17$8$1$${salt}$${hash}`, `scrypt$12$1$1$${salt}$${hash}`, `scrypt$20$32$16$${salt}$${hash}`,
    `scrypt$11$8$1$${salt}$${hash}`, `scrypt$21$8$1$${salt}$${hash}`, `scrypt$17$0$1$${salt}$${hash}`,
    `scrypt$17$8$17$${salt}$${hash}`, `bcrypt$17$8$1$${salt}$${hash}`, `scrypt$17$8$1$${salt}`,
    `scrypt$17$8$1$abc$${hash}`, `scrypt$17$8$1$${salt}$xyz`, `scrypt$17$8$1$${salt}a$${hash}`,
    `scrypt$17.5$8$1$${salt}$${hash}`, "", null, undefined,
  ];
  for (const f of fixtures) assert.deepEqual(kit.password.parseHash(f), drouaConfig.parseHash(f), String(f));
});

/* ─── حدّ المحاولات ─── */

const kitRate = kit.rateLimit.createRateLimiter({ table: "droua_gate_attempts" });

test("التكافؤ: evaluate متطابق على كل التركيبات 0..16", () => {
  for (let s = 0; s <= 16; s += 1) {
    for (let l = 0; l <= 16; l += 1) {
      for (let c = 0; c <= 16; c += 1) {
        const counts = { short: s, long: l, critical: c };
        assert.deepEqual(kitRate.evaluate(counts), drouaRate.evaluate(counts));
      }
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(kitRate.WINDOWS)), JSON.parse(JSON.stringify(drouaRate.WINDOWS)));
  assert.equal(kitRate.MAX_LOCK_MS, drouaRate.MAX_LOCK_MS);
  assert.equal(kitRate.PRUNE_MS, drouaRate.PRUNE_MS);
});

/* يشغّل الدالّة نفسها على التنفيذين ويقارن ما وصل إلى القاعدة. */
async function sameSql(run, respond, { expectQuery = true } = {}) {
  const a = makeFakeSql(respond);
  const b = makeFakeSql(respond);
  const ra = await run.droua(a);
  const rb = await run.kit(b);
  /* بلا هذا يتساوى «لا شيء» مع «لا شيء» فيمرّ الاختبار فارغًا. */
  if (expectQuery) assert.ok(a.calls.length > 0, "Droua لم يُصدر استعلامًا — المقارنة فارغة");
  assert.deepEqual(b.calls, a.calls);
  assert.deepEqual(rb, ra);
}

test("التكافؤ: نصوص SQL لحدّ المحاولات متطابقة", async () => {
  const row = () => [{ attempt_id: 7, short_count: "3", long_count: "4", critical_count: "5" }];
  await sameSql({ droua: (s) => drouaRate.recordAndCount(s, USER, NOW), kit: (s) => kitRate.recordAndCount(s, USER, NOW) }, row);
  await sameSql({ droua: (s) => drouaRate.forget(s, 7), kit: (s) => kitRate.forget(s, 7) });
  await sameSql({ droua: (s) => drouaRate.forget(s, null), kit: (s) => kitRate.forget(s, null) }, undefined, { expectQuery: false });
  await sameSql({ droua: (s) => drouaRate.clearFailures(s, USER), kit: (s) => kitRate.clearFailures(s, USER) });
  await sameSql({ droua: (s) => drouaRate.prune(s, NOW), kit: (s) => kitRate.prune(s, NOW) });
});

/* ─── الجلسات ─── */

const kitSessions = kit.sessions.createSessionStore({ table: "droua_gate_sessions" });

test("التكافؤ: نصوص SQL للجلسات متطابقة، والمدد الافتراضية واحدة", async () => {
  assert.equal(kitSessions.IDLE_MS, drouaSessions.IDLE_MS);
  assert.equal(kitSessions.ABSOLUTE_MS, drouaSessions.ABSOLUTE_MS);
  assert.equal(kitSessions.SESSION_PRUNE_GRACE_MS, drouaSessions.SESSION_PRUNE_GRACE_MS);
  const loaded = () => [{ sid_hash: "h", user_id: USER, idle_exp_ms: "1700000000000", absolute_exp_ms: "1700000001000", revoked_at: null }];
  const session = { sidHash: "h", userId: USER, idleExp: NOW + 1000, absoluteExp: NOW + 5000, revokedAt: null };
  await sameSql({ droua: (s) => drouaSessions.create(s, { sidHash: "h", userId: USER, now: NOW }), kit: (s) => kitSessions.create(s, { sidHash: "h", userId: USER, now: NOW }) });
  await sameSql({ droua: (s) => drouaSessions.load(s, "h"), kit: (s) => kitSessions.load(s, "h") }, loaded);
  await sameSql({ droua: (s) => drouaSessions.load(s, "h"), kit: (s) => kitSessions.load(s, "h") });
  await sameSql({ droua: (s) => drouaSessions.touch(s, session, NOW), kit: (s) => kitSessions.touch(s, session, NOW) });
  await sameSql({ droua: (s) => drouaSessions.revoke(s, "h", NOW), kit: (s) => kitSessions.revoke(s, "h", NOW) });
  await sameSql({ droua: (s) => drouaSessions.revokeAllForUser(s, USER, NOW), kit: (s) => kitSessions.revokeAllForUser(s, USER, NOW) });
  await sameSql({ droua: (s) => drouaSessions.prune(s, NOW), kit: (s) => kitSessions.prune(s, NOW) });
});

test("التكافؤ: isUsable له جدول الحقيقة نفسه", () => {
  const base = { sidHash: "h", userId: USER, idleExp: NOW + 10, absoluteExp: NOW + 20, revokedAt: null };
  const variants = [
    null, base, { ...base, revokedAt: "x" }, { ...base, userId: "other" },
    { ...base, idleExp: NOW }, { ...base, absoluteExp: NOW }, { ...base, idleExp: NaN },
  ];
  for (const v of variants) {
    for (const now of [NOW - 1, NOW, NOW + 15, NOW + 25]) {
      assert.equal(kitSessions.isUsable(v, USER, now), drouaSessions.isUsable(v, USER, now));
    }
  }
});

/* ─── التدقيق ─── */

const kitAudit = kit.audit.createAudit({ table: "droua_gate_audit", allowedMeta: [...drouaAudit.META_ALLOWED] });

test("التكافؤ: المُنقّي والبصمة متطابقان", () => {
  const metas = [
    { reason: "x", fileName: "مسير سبتمبر.pdf", runId: "r", nested: { a: 1 }, attempts: 3, pathname: "p".repeat(300) },
    { route: null, critical: true, kind: undefined, encKeyId: "k1", list: [1] },
    {}, null, undefined,
  ];
  for (const m of metas) assert.deepEqual(kitAudit.sanitizeMeta(m), drouaAudit.sanitizeMeta(m));
  for (const ip of ["1.2.3.4", " 10.0.0.1 ", "", null, "::1"]) {
    assert.equal(kit.audit.hashIp(ip, SECRET), drouaAudit.hashIp(ip, SECRET));
    assert.equal(kit.audit.hashIp(ip, ""), drouaAudit.hashIp(ip, ""));
  }
  for (const xff of ["1.1.1.1, 2.2.2.2", "", undefined]) {
    const req = { headers: xff === undefined ? {} : { "x-forwarded-for": xff } };
    assert.equal(kit.audit.clientIp(req), drouaAudit.clientIp(req));
  }
  assert.equal(kitAudit.THROTTLE_MS, drouaAudit.THROTTLE_MS);
});

test("التكافؤ: نصوص SQL للتدقيق متطابقة", async () => {
  const entry = { event: "gate_unlock_failed", userId: USER, meta: { reason: "bad_password", fileName: "x" }, ip: "1.2.3.4", secret: SECRET };
  await sameSql({ droua: (s) => drouaAudit.logStrict(s, entry), kit: (s) => kitAudit.logStrict(s, entry) });
  await sameSql({ droua: (s) => drouaAudit.log(s, { ...entry, userId: null }), kit: (s) => kitAudit.log(s, { ...entry, userId: null }) });
  await sameSql({
    droua: (s) => drouaAudit.logThrottled(s, { ...entry, event: "access_denied", now: NOW }),
    kit: (s) => kitAudit.logThrottled(s, { ...entry, event: "access_denied", now: NOW }),
  });
});

/* ─── الردود ─── */

function capture(fn) {
  const out = { status: 0, headers: {}, body: undefined, head: null };
  const res = {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    getHeader(k) { return out.headers[k.toLowerCase()]; },
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    end(b) { out.body = b; return res; },
    writeHead(c, h) { out.status = c; out.head = h; return res; },
  };
  fn(res);
  return out;
}

test("التكافؤ: أشكال الردود والرؤوس متطابقة", () => {
  for (const name of ["notFoundPage", "notFoundApi", "unauthenticatedPage", "unauthenticatedApi", "secureApi"]) {
    assert.deepEqual(capture(kit.http[name]), capture(drouaHeaders[name]), name);
  }
  const nonce = "bm9uY2U=";
  assert.deepEqual(capture((r) => kit.http.securePage(r, nonce)), capture((r) => drouaHeaders.securePage(r, nonce)));
});

/* ─── التخزين المشفَّر: كلٌّ يفكّ ما يكتبه الآخر ─── */

const DROUA_STORE_CONFIG = {
  tokenEnv: "DROUA_BLOB_READ_WRITE_TOKEN",
  forbiddenEqualEnvs: ["BLOB_READ_WRITE_TOKEN"],
  aadPrefix: "droua-payroll-file|v1",
  aadFields: ["fileId", "runId", "kind"],
  groupField: "runId",
  pathPrefix: "droua-payroll-audit",
  maxBytes: 10 * 1024 * 1024,
  formats: { pdf: "application/pdf", xlsx: "x", xls: "y", csv: "text/csv" },
};

function kitStoreWithDrouaConfig() {
  const keyring = kit.keyring.createKeyring({ envPrefix: "DROUA_FILE_KEY_", activeEnv: "DROUA_FILE_ACTIVE_KEY_ID" });
  return kit.store.createEncryptedStore({ ...DROUA_STORE_CONFIG, keyring });
}

test("التكافؤ: ما تشفّره الطبقة بإعداد Droua يفكّه Droua، والعكس", async () => {
  await withDroua(async ({ blob }) => {
    const storage = require("../lib/droua/storage");
    const store = kitStoreWithDrouaConfig();
    const identity = { fileId: crypto.randomUUID(), runId: crypto.randomUUID(), kind: "full" };
    const bytes = Buffer.from("رقم,اسم\n1,موظف اصطناعي\n", "utf8");

    const d1 = await store.putEncrypted({ identity, bytes });
    const back1 = await storage.getDecrypted({ ...identity, ...d1 });
    assert.deepEqual(back1, bytes);

    const d2 = await storage.putEncrypted({ ...identity, bytes, format: "csv" });
    const back2 = await store.getDecrypted({ identity, ...d2 });
    assert.deepEqual(back2, bytes);

    /* المخزَّن شيفرةٌ لا يعلن نوعه، في متجر خاصّ، بتوكن صريح. */
    const puts = blob.calls.filter((c) => c.op === "put");
    for (const p of puts) {
      assert.equal(p.opts.access, "private");
      assert.equal(p.opts.contentType, "application/octet-stream");
      assert.equal(p.opts.addRandomSuffix, false);
      assert.ok(p.opts.token);
    }
    assert.deepEqual(puts.map((p) => p.opts.token), [puts[1].opts.token, puts[1].opts.token]);
  });
});

test("الفصل: كائن Droua لا يُفكّ بإعداد وحدةٍ أخرى ولو تشاركا المفتاح", async () => {
  await withDroua(async () => {
    const storage = require("../lib/droua/storage");
    const keyring = kit.keyring.createKeyring({ envPrefix: "DROUA_FILE_KEY_", activeEnv: "DROUA_FILE_ACTIVE_KEY_ID" });
    const other = kit.store.createEncryptedStore({
      ...DROUA_STORE_CONFIG, keyring, aadPrefix: "medins-file|v1",
    });
    const identity = { fileId: crypto.randomUUID(), runId: crypto.randomUUID(), kind: "full" };
    const d = await storage.putEncrypted({ ...identity, bytes: Buffer.from("x"), format: "csv" });
    await assert.rejects(other.getDecrypted({ identity, ...d }), (err) => err.reason === "tag_mismatch");
  });
});
