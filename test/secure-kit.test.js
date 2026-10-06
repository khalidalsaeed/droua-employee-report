const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

/* ─── سلوك الطبقة المشتركة نفسها (ما لا يغطّيه اختبار التكافؤ) ─────────── */

const kit = require("../lib/secure-kit");
const { makeFakeBlob } = require("./helpers/files-db");

const SECRET = "synthetic-kit-secret-0123456789abcdefgh";

test("الأسماء تُفحص عند الإنشاء لا عند الطلب", () => {
  for (const bad of ["", "x", "Drop Table", "a;b", "medins_x--", "1abc"]) {
    assert.throws(() => kit.identifiers.assertTable(bad), bad);
    assert.throws(() => kit.sessions.createSessionStore({ table: bad }));
  }
  assert.throws(() => kit.token.createTokenCodec({ type: "Bad Type" }));
  assert.throws(() => kit.http.gateCookie({ name: "x", path: "/" }));
  assert.throws(() => kit.sessions.createSessionStore({ table: "t_ok", idleMs: 10, absoluteMs: 5 }));
});

test("التوكن: السقف المطلق لا يُمدَّد، والانتهاء يُرفض", () => {
  const codec = kit.token.createTokenCodec({ type: "unit-gate" });
  const now = 1_000_000;
  const issued = codec.issue({ userId: "u", sid: "s", now, idleMs: 100, absoluteExp: now + 50 }, SECRET);
  assert.equal(issued.exp, now + 50, "الخمول تجاوز السقف");
  assert.ok(codec.verify(issued.token, SECRET, now + 49));
  assert.equal(codec.verify(issued.token, SECRET, now + 50), null);
  assert.equal(codec.verify(issued.token, "other-secret-0123456789abcdefghijk", now), null);
});

test("السياق: سياق وحدةٍ لا يفتح وحدةً أخرى", async () => {
  const a = kit.context.createGateContext();
  const b = kit.context.createGateContext();
  await a.runWithGate({ userId: "u" }, async () => {
    assert.ok(a.requireGate());
    assert.throws(() => b.requireGate(), /لا سياق بوابة/);
  });
  assert.throws(() => a.requireGate());
  assert.throws(() => a.runWithGate({}, () => {}));
});

test("التدقيق: قائمة المسموح تُسقط كل ما سواها والكائنات والطويل", () => {
  const audit = kit.audit.createAudit({ table: "unit_audit", allowedMeta: ["fileId"] });
  assert.deepEqual(audit.sanitizeMeta({ fileId: "x".repeat(200), fileName: "سرّ.pdf", amount: 5, nested: { a: 1 } }), { fileId: "x".repeat(120) });
});

test("الصلاحيات: حاجةٌ أو دورٌ مجهول يُرفض", () => {
  const authz = kit.authz.createAuthz({ roles: { a: ["view"], b: ["view", "edit"] } });
  assert.equal(authz.can("a", "edit"), false);
  assert.equal(authz.can("b", "edit"), true);
  assert.equal(authz.can("b", "admin"), false);
  assert.equal(authz.can(undefined, "view"), false);
  assert.equal(authz.isNeed("edit"), true);
  assert.equal(authz.isNeed("delete"), false);
});

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test("حلقة المفاتيح: نشطٌ مفقود، مادّةٌ مكرّرة، ومشاركةٌ مع حلقةٍ أخرى", async () => {
  const ring = kit.keyring.createKeyring({ envPrefix: "UNIT_KEY_", activeEnv: "UNIT_ACTIVE" });
  await withEnv({ UNIT_KEY_K1: "aa".repeat(32), UNIT_KEY_K2: "bb".repeat(32), UNIT_ACTIVE: "k2", OTHER_KEY_K1: "bb".repeat(32) }, () => {
    assert.equal(ring.activeKeyId(), "k2");
    assert.equal(ring.keyFor("k1").length, 32);
    assert.throws(() => ring.keyFor("k9"));
    assert.equal(ring.sharesMaterialWith("OTHER_KEY_"), true);
    assert.equal(ring.sharesMaterialWith("NONE_KEY_"), false);
  });
  await withEnv({ UNIT_KEY_K1: "aa".repeat(32), UNIT_KEY_K2: "aa".repeat(32), UNIT_ACTIVE: "k1" }, () => {
    assert.throws(() => ring.load(), /بمادّة واحدة/);
  });
  await withEnv({ UNIT_KEY_K1: "aa".repeat(32), UNIT_ACTIVE: "k3" }, () => assert.throws(() => ring.load()));
});

function unitStore(blob) {
  const keyring = kit.keyring.createKeyring({ envPrefix: "UNIT_KEY_", activeEnv: "UNIT_ACTIVE" });
  return kit.store.createEncryptedStore({
    tokenEnv: "UNIT_BLOB_TOKEN", forbiddenEqualEnvs: ["UNIT_PUBLIC_TOKEN"], keyring,
    aadPrefix: "unit-file|v1", aadFields: ["fileId", "groupId", "partIndex"], groupField: "groupId",
    pathPrefix: "unit-store", maxBytes: 1024, formats: { pdf: "application/pdf" }, blobApi: () => blob.api,
  });
}
const STORE_ENV = { UNIT_KEY_K1: "cc".repeat(32), UNIT_ACTIVE: "k1", UNIT_BLOB_TOKEN: "tok-unit", UNIT_PUBLIC_TOKEN: "tok-public" };

test("المتجر: خاصّ بتوكنٍ صريح، ويرفض توكنًا يساوي متجرًا ممنوعًا", async () => {
  await withEnv(STORE_ENV, async () => {
    const blob = makeFakeBlob();
    const store = unitStore(blob);
    const id = { fileId: crypto.randomUUID(), groupId: crypto.randomUUID(), partIndex: "0" };
    const d = await store.putEncrypted({ identity: id, bytes: Buffer.from("hello") });
    assert.equal(blob.calls[0].opts.access, "private");
    assert.equal(blob.calls[0].opts.token, "tok-unit");
    assert.deepEqual(await store.getDecrypted({ identity: id, ...d }), Buffer.from("hello"));
    process.env.UNIT_BLOB_TOKEN = "tok-public";
    await assert.rejects(store.putEncrypted({ identity: id, bytes: Buffer.from("x") }), /يطابق توكن متجرٍ آخر/);
    assert.equal(store.ready(), false);
    delete process.env.UNIT_BLOB_TOKEN;
    await assert.rejects(store.putEncrypted({ identity: id, bytes: Buffer.from("x") }), /غير مُهيّأ/);
  });
});

test("المتجر: الـAAD يربط الجزء برقمه — تبديل جزأين يفشل بالوسم", async () => {
  await withEnv(STORE_ENV, async () => {
    const blob = makeFakeBlob();
    const store = unitStore(blob);
    const base = { fileId: crypto.randomUUID(), groupId: crypto.randomUUID() };
    const d0 = await store.putEncrypted({ identity: { ...base, partIndex: "0" }, bytes: Buffer.from("part-zero") });
    const d1 = await store.putEncrypted({ identity: { ...base, partIndex: "1" }, bytes: Buffer.from("part-one") });
    await assert.rejects(store.getDecrypted({ identity: { ...base, partIndex: "1" }, ...d0 }), (e) => e.reason === "tag_mismatch");
    const other = { ...base, fileId: crypto.randomUUID(), partIndex: "1" };
    await assert.rejects(store.getDecrypted({ identity: other, ...d1 }), (e) => e.reason === "tag_mismatch");
    blob.objects.set(d0.pathname, blob.objects.get(d1.pathname));
    await assert.rejects(store.getDecrypted({ identity: { ...base, partIndex: "0" }, ...d0 }), (e) => e.reason === "tag_mismatch");
  });
});

test("المتجر: الهويّة بلا «|»، والحجم مقيَّد قبل الشبكة، والمسار من القائمة المغلقة", async () => {
  await withEnv(STORE_ENV, async () => {
    const blob = makeFakeBlob();
    const store = unitStore(blob);
    const ok = { fileId: crypto.randomUUID(), groupId: crypto.randomUUID(), partIndex: "0" };
    await assert.rejects(store.putEncrypted({ identity: { ...ok, partIndex: "0|1" }, bytes: Buffer.from("x") }));
    await assert.rejects(store.putEncrypted({ identity: { ...ok, groupId: "not-uuid" }, bytes: Buffer.from("x") }));
    await assert.rejects(store.putEncrypted({ identity: ok, bytes: Buffer.alloc(1025) }), /الحدّ/);
    await assert.rejects(store.putEncrypted({ identity: ok, bytes: Buffer.alloc(0) }));
    await assert.rejects(store.getDecrypted({ identity: ok, pathname: "../x", encIv: "", encTag: "", encKeyId: "k1" }), /مسار/);
    assert.equal(blob.calls.length, 0, "نداء شبكة قبل الرفض");
    assert.throws(() => store.safeContentType("exe"));
  });
});

test("المتجر: إعادة التسمية الصامتة من المتجر تُرفض وتُنظَّف", async () => {
  await withEnv(STORE_ENV, async () => {
    const blob = makeFakeBlob();
    const original = blob.api.put;
    blob.api.put = async (p, body, opts) => { await original(p + "x", body, opts); return { pathname: p + "x" }; };
    const store = unitStore(blob);
    const id = { fileId: crypto.randomUUID(), groupId: crypto.randomUUID(), partIndex: "0" };
    await assert.rejects(store.putEncrypted({ identity: id, bytes: Buffer.from("x") }), /أعاد تسمية/);
    assert.equal(blob.objects.size, 0);
  });
});
