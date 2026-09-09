const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const storage = require("../lib/droua/storage");
const keyring = require("../lib/droua/keyring");

/* ─── تخزين ملفّات القسم ────────────────────────────────────────────────
   =========================================================================
   ثلاثة أشياء تحرسها هذه الاختبارات، وكلّها من صنف الأعطال التي لا تظهر
   عند التشغيل بل بعد شهور:

     ① التوكن — نداءٌ واحد بلا `token` يكتب ملفّ رواتب سرّيًا في متجر أجير
       **العامّ**، بلا خطأ وبرابط يفتحه أي أحد. فالفحص على النداء نفسه.
     ② الـAAD — بلا ربطٍ بالهويّة يُفكّ أي شيفرة سليمة، فيُقدَّم ملفّ في
       موضع آخر بلا شكوى. وفي نظامٍ وظيفتُه المقارنة بين الشهور، هذا لا
       يُنتج عطلًا مرئيًّا بل ملاحظاتٍ كاذبة تُبنى عليها قرارات.
     ③ المفاتيح — سقوطٌ إلى المفتاح النشط عند معرّف مجهول يجعل العطل يبدو
       فسادًا في الملفّ، فيُشخَّص في الاتجاه الخطأ تمامًا.

   وكل مغلّف هنا **async** ويُنتظر جسمه: مغلّفٌ متزامن يستعيد البيئة عند أول
   await، فتمرّ اختبارات كان يجب أن تسقط. واختبارٌ يكذب أخطر من اختبار ساقط. */

const BLOB_ID = require.resolve("@vercel/blob");

const K1 = "a1".repeat(32);
const K2 = "b2".repeat(32);
const TOKEN = "vercel_blob_rw_DROUA_TEST_TOKEN";
const PUBLIC_TOKEN = "vercel_blob_rw_AJEER_PUBLIC_TOKEN";

const ENV_KEYS = [
  "DROUA_BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN",
  keyring.ENV_ACTIVE, keyring.ENV_PREFIX + "K1", keyring.ENV_PREFIX + "K2",
  keyring.ENV_PREFIX + "K3", keyring.ENV_PREFIX + "ZZ",
];

/* متجر مصطنع في الذاكرة يسجّل كل نداء بخياراته — فيُقاس التوكن على النداء
   لا بقراءة الشيفرة. */
function fakeBlob() {
  const objects = new Map();
  const calls = [];
  const api = {
    async put(pathname, body, opts) {
      calls.push({ op: "put", pathname, opts });
      objects.set(pathname, Buffer.from(body));
      return { pathname, url: `https://example.invalid/${pathname}` };
    },
    async get(pathname, opts) {
      calls.push({ op: "get", pathname, opts });
      if (!objects.has(pathname)) return null;
      const buf = objects.get(pathname);
      return {
        statusCode: 200,
        stream: new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(buf)); c.close(); },
        }),
        blob: { pathname },
      };
    },
    async del(pathname, opts) {
      calls.push({ op: "del", pathname, opts });
      if (!objects.delete(pathname)) throw new Error("not found");
    },
  };
  return { api, objects, calls };
}

/* بيئة نظيفة تمامًا: كل متغيّرات المفاتيح تُنزع أوّلًا، فلا يتسرّب إلى
   الاختبار مفتاحٌ من بيئة المطوّر. */
async function sandbox(overrides, fn) {
  const saved = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(keyring.ENV_PREFIX)) { saved[name] = process.env[name]; delete process.env[name]; }
  }
  for (const name of ENV_KEYS) {
    if (!(name in saved)) saved[name] = process.env[name];
    delete process.env[name];
  }
  const base = {
    DROUA_BLOB_READ_WRITE_TOKEN: TOKEN,
    [keyring.ENV_ACTIVE]: "k1",
    [keyring.ENV_PREFIX + "K1"]: K1,
  };
  for (const [name, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  const blob = fakeBlob();
  const stub = new Module(BLOB_ID, null);
  stub.filename = BLOB_ID;
  stub.loaded = true;
  stub.exports = blob.api;
  const previous = require.cache[BLOB_ID];
  require.cache[BLOB_ID] = stub;

  try {
    return await fn(blob);
  } finally {
    if (previous) require.cache[BLOB_ID] = previous;
    else delete require.cache[BLOB_ID];
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const uuid = () => crypto.randomUUID();
const bytes = (text) => Buffer.from(text, "utf8");
const identity = () => ({ fileId: uuid(), runId: uuid(), kind: "cash" });

async function rejects(fn, message) {
  await assert.rejects(fn, (err) => err instanceof Error, message);
}
async function reasonOf(fn) {
  try { await fn(); } catch (err) { return err.reason || null; }
  throw new Error("كان يجب أن يفشل");
}

/* ══ أ) التوكن — إغلاق R-12 ═══════════════════════════════════════════ */

test("التوكن: غيابه يُسقط كل دالّة، ولا نداء يبلغ المتجر", async () => {
  await sandbox({ DROUA_BLOB_READ_WRITE_TOKEN: undefined }, async (blob) => {
    const id = identity();
    await rejects(() => storage.putEncrypted({ ...id, bytes: bytes("x"), format: "pdf" }));
    await rejects(() => storage.getDecrypted({
      ...id, pathname: `${storage.PATH_PREFIX}/${id.runId}/${"0".repeat(32)}`,
      encIv: "00".repeat(12), encTag: "00".repeat(16), encKeyId: "k1",
    }));
    await rejects(() => storage.remove(`${storage.PATH_PREFIX}/${id.runId}/${"0".repeat(32)}`));
    assert.equal(blob.calls.length, 0, "لا نداء واحد بلغ الـSDK");
  });
});

test("التوكن: مساواته لتوكن المتجر العامّ تُسقط العملية", async () => {
  await sandbox({ DROUA_BLOB_READ_WRITE_TOKEN: TOKEN, BLOB_READ_WRITE_TOKEN: TOKEN }, async (blob) => {
    await rejects(() => storage.putEncrypted({ ...identity(), bytes: bytes("x"), format: "pdf" }));
    assert.equal(blob.calls.length, 0);
  });
});

test("التوكن: كل نداء put/get/del يحمل توكن القسم صراحةً", async () => {
  await sandbox({ BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN }, async (blob) => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("محتوى"), format: "pdf" });
    await storage.getDecrypted({ ...id, ...desc });
    await storage.remove(desc.pathname);

    assert.deepEqual(blob.calls.map((c) => c.op), ["put", "get", "del"]);
    for (const call of blob.calls) {
      assert.equal(call.opts.token, TOKEN, `${call.op} بلا توكن القسم`);
      assert.notEqual(call.opts.token, PUBLIC_TOKEN);
    }
  });
});

test("التوكن: access:'private' في كل put وget", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "csv" });
    await storage.getDecrypted({ ...id, ...desc });
    for (const call of blob.calls.filter((c) => c.op !== "del")) {
      assert.equal(call.opts.access, "private", `${call.op} بلا access خاصّ`);
    }
  });
});

/* ══ ب) التشفير الأساسيّ ══════════════════════════════════════════════ */

test("التشفير: المرفوع ليس النصّ الصريح ولا يحتوي مقطعًا منه", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    const plain = bytes("راتب أساسيّ 12345 — نصّ يميّز نفسه");
    const desc = await storage.putEncrypted({ ...id, bytes: plain, format: "pdf" });
    const stored = blob.objects.get(desc.pathname);
    assert.ok(!stored.equals(plain));
    assert.equal(stored.includes(plain), false, "الشيفرة تحوي النصّ الصريح");
    assert.equal(blob.calls[0].opts.contentType, storage.STORED_CONTENT_TYPE,
      "المخزَّن يُعلن شيفرةً لا صيغةَ الملفّ الحقيقية");
  });
});

test("التشفير: دورة كاملة تُرجع البايتات نفسها تمامًا", async () => {
  await sandbox({}, async () => {
    const id = identity();
    const plain = crypto.randomBytes(4096);
    const desc = await storage.putEncrypted({ ...id, bytes: plain, format: "xlsx" });
    const back = await storage.getDecrypted({ ...id, ...desc });
    assert.ok(back.equals(plain));
    assert.equal(desc.sizeBytes, plain.length);
    assert.equal(desc.encAlgo, storage.ALGORITHM);
  });
});

test("التشفير: عبثٌ ببايت واحد في الشيفرة يُسقط الفكّ", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("محتوى كافٍ للاختبار"), format: "pdf" });
    const stored = blob.objects.get(desc.pathname);
    stored[0] ^= 0x01;
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc })), "tag_mismatch");
  });
});

test("التشفير: عبثٌ بالوسم أو بالـIV يُسقط الفكّ", async () => {
  await sandbox({}, async () => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("محتوى"), format: "pdf" });

    const tag = Buffer.from(desc.encTag, "hex"); tag[0] ^= 0x01;
    assert.equal(
      await reasonOf(() => storage.getDecrypted({ ...id, ...desc, encTag: tag.toString("hex") })),
      "tag_mismatch");

    const iv = Buffer.from(desc.encIv, "hex"); iv[0] ^= 0x01;
    assert.equal(
      await reasonOf(() => storage.getDecrypted({ ...id, ...desc, encIv: iv.toString("hex") })),
      "tag_mismatch");
  });
});

test("التشفير: كائن مفقود يُبلَّغ object_missing لا استثناءً غامضًا", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "pdf" });
    blob.objects.delete(desc.pathname);
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc })), "object_missing");
  });
});

test("التشفير: لا مفتاح ولا توكن في أي رسالة خطأ", async () => {
  await sandbox({ BLOB_READ_WRITE_TOKEN: PUBLIC_TOKEN }, async (blob) => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "pdf" });
    blob.objects.get(desc.pathname)[0] ^= 0x01;

    const messages = [];
    const collect = async (fn) => { try { await fn(); } catch (err) { messages.push(String(err.message), String(err.stack || "")); } };
    await collect(() => storage.getDecrypted({ ...id, ...desc }));
    await collect(() => storage.getDecrypted({ ...id, ...desc, encKeyId: "k9" }));
    await collect(() => storage.putEncrypted({ ...id, bytes: Buffer.alloc(0), format: "pdf" }));

    for (const text of messages) {
      assert.ok(!text.includes(K1), "مادّة مفتاح في رسالة خطأ");
      assert.ok(!text.includes(TOKEN), "توكن في رسالة خطأ");
    }
  });
});

/* ══ ج) الهويّة والـAAD ═══════════════════════════════════════════════
   «التبديل» هنا يعني: يبقى الصفّ بهويّته، ويُستبدَل ما يصف الشيفرة كلّه
   (المسار والـIV والوسم). فلا يبقى فارقٌ إلا الـAAD — وهو المُختبَر. */

async function twoFiles(a, b) {
  const one = await storage.putEncrypted({ ...a, bytes: bytes("ملفّ أوّل"), format: "pdf" });
  const two = await storage.putEncrypted({ ...b, bytes: bytes("ملفّ ثانٍ"), format: "pdf" });
  return [one, two];
}
const swap = (id, other) => ({
  ...id, pathname: other.pathname, encIv: other.encIv,
  encTag: other.encTag, encKeyId: other.encKeyId,
});

test("الهويّة: تبديل بين شهرين يفشل", async () => {
  await sandbox({}, async () => {
    const a = { fileId: uuid(), runId: uuid(), kind: "cash" };
    const b = { fileId: uuid(), runId: uuid(), kind: "cash" };
    const [, two] = await twoFiles(a, b);
    assert.equal(await reasonOf(() => storage.getDecrypted(swap(a, two))), "tag_mismatch");
  });
});

test("الهويّة: تبديل بين نوعين في الشهر نفسه يفشل", async () => {
  await sandbox({}, async () => {
    const runId = uuid();
    const a = { fileId: uuid(), runId, kind: "cash" };
    const b = { fileId: uuid(), runId, kind: "transfer" };
    const [, two] = await twoFiles(a, b);
    assert.equal(await reasonOf(() => storage.getDecrypted(swap(a, two))), "tag_mismatch");
  });
});

test("الهويّة: تبديل بين ملفّين لنفس الشهر ونفس النوع يفشل ← الثقب المُغلق", async () => {
  await sandbox({}, async () => {
    /* الحالة التي كان `runId|kind` وحده يمرّرها: إعادة رفع ملفّ لتصحيحه،
       فيصير للنسختين AAD متطابق لولا fileId. */
    const runId = uuid();
    const a = { fileId: uuid(), runId, kind: "cash" };
    const b = { fileId: uuid(), runId, kind: "cash" };
    const [, two] = await twoFiles(a, b);
    assert.notEqual(a.fileId, b.fileId);
    assert.equal(await reasonOf(() => storage.getDecrypted(swap(a, two))), "tag_mismatch");
  });
});

test("الهويّة: تحوير runId أو kind في الصفّ وحده يفشل", async () => {
  await sandbox({}, async () => {
    const id = { fileId: uuid(), runId: uuid(), kind: "cash" };
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "pdf" });
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc, runId: uuid() })), "tag_mismatch");
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc, kind: "transfer" })), "tag_mismatch");
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc, fileId: uuid() })), "tag_mismatch");
  });
});

test("الهويّة: بلا fileId صالح لا يبدأ تشفير ولا يقع نداء", async () => {
  await sandbox({}, async (blob) => {
    const base = { runId: uuid(), kind: "cash", bytes: bytes("م"), format: "pdf" };
    for (const fileId of [undefined, "", "not-a-uuid", "11111111-1111-1111-1111-111111111111x"]) {
      await rejects(() => storage.putEncrypted({ ...base, fileId }), `قُبل fileId: ${fileId}`);
    }
    await rejects(() => storage.putEncrypted({ ...base, fileId: uuid(), runId: "x" }));
    assert.equal(blob.calls.length, 0);
  });
});

test("الهويّة: نفس البايتات بـfileId مختلف ⇒ شيفرتان لا تُفكّ إحداهما بالأخرى", async () => {
  await sandbox({}, async (blob) => {
    const runId = uuid();
    const plain = bytes("بايتات متطابقة تمامًا");
    const a = { fileId: uuid(), runId, kind: "cash" };
    const b = { fileId: uuid(), runId, kind: "cash" };
    const one = await storage.putEncrypted({ ...a, bytes: plain, format: "pdf" });
    const two = await storage.putEncrypted({ ...b, bytes: plain, format: "pdf" });

    assert.notEqual(one.pathname, two.pathname);
    assert.notEqual(one.encIv, two.encIv);
    assert.ok(!blob.objects.get(one.pathname).equals(blob.objects.get(two.pathname)));
    assert.equal(one.plaintextSha256, two.plaintextSha256, "البصمة للنصّ الصريح فتتساوى");
    assert.equal(await reasonOf(() => storage.getDecrypted(swap(a, two))), "tag_mismatch");
  });
});

test("الهويّة: بادئة الـAAD مثبَّتة حرفًا بحرف", async () => {
  /* تغييرها يجعل **كل ملفّ مخزَّن** غير قابل للقراءة — ولا يظهر إلا بعد
     النشر. فتُقفل هنا بقيمة حرفية لا بمرجع إلى الثابت نفسه. */
  assert.equal(storage.AAD_PREFIX, "droua-payroll-file|v1");
  const source = fs.readFileSync(path.resolve(__dirname, "..", "lib", "droua", "storage.js"), "utf8");
  assert.ok(/`\$\{AAD_PREFIX\}\|\$\{fileId\}\|\$\{runId\}\|\$\{kind\}`/.test(source),
    "تركيب الـAAD يجب أن يبقى: البادئة ثمّ fileId ثمّ runId ثمّ kind");
});

test("الهويّة: kind يحمل فاصل الـAAD مرفوض", async () => {
  await sandbox({}, async (blob) => {
    /* «|» فاصل أجزاء الـAAD. قيمةٌ تحمله تجعل تركيبين مختلفين ينتجان
       AAD واحدًا — وهو التفافٌ كامل على الربط بالهويّة. */
    for (const kind of ["cash|x", "a|b", "ca sh", "CASH", "كاش", "x".repeat(33)]) {
      await rejects(() => storage.putEncrypted({
        fileId: uuid(), runId: uuid(), kind, bytes: bytes("م"), format: "pdf",
      }), `قُبل kind: ${kind}`);
    }
    assert.equal(blob.calls.length, 0);
  });
});

/* ══ د) حلقة المفاتيح ═════════════════════════════════════════════════ */

test("المفاتيح: الكتابة بالمفتاح النشط، والواصف يحمله", async () => {
  await sandbox({ [keyring.ENV_PREFIX + "K2"]: K2, [keyring.ENV_ACTIVE]: "k2" }, async () => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "pdf" });
    assert.equal(desc.encKeyId, "k2");
  });
});

test("المفاتيح: ملفّ كُتب بـk1 يُقرأ بعد أن يصير النشط k2", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    const plain = bytes("ملفّ من قبل التدوير");
    const desc = await storage.putEncrypted({ ...id, bytes: plain, format: "pdf" });
    assert.equal(desc.encKeyId, "k1");

    /* التدوير: يُضاف k2 ويصير النشط — ولا يُمسّ k1. */
    process.env[keyring.ENV_PREFIX + "K2"] = K2;
    process.env[keyring.ENV_ACTIVE] = "k2";
    assert.deepEqual(keyring.load(), { activeKeyId: "k2", ids: ["k1", "k2"] });

    const back = await storage.getDecrypted({ ...id, ...desc });
    assert.ok(back.equals(plain), "القراءة بمفتاح الصفّ لا بالنشط");

    const fresh = await storage.putEncrypted({ ...identity(), bytes: plain, format: "pdf" });
    assert.equal(fresh.encKeyId, "k2");
    assert.ok(blob.objects.size >= 2);
  });
});

test("المفاتيح: معرّف مجهول يرمي unknown_key ولا يسقط إلى النشط", async () => {
  await sandbox({}, async () => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "pdf" });
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc, encKeyId: "k7" })), "unknown_key");
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc, encKeyId: "" })), "unknown_key");
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc, encKeyId: "../k1" })), "unknown_key");
  });
});

test("المفاتيح: مفتاح مشوَّه يُسقط الحلقة كلَّها عند التحميل", async () => {
  await sandbox({ [keyring.ENV_PREFIX + "K1"]: "not-hex" }, async () => {
    assert.throws(() => keyring.load(), /64 محرفًا hex/);
    /* ولا حلقة نصف صالحة: وجود k2 سليمًا لا يشفع لتشويه k1. */
    process.env[keyring.ENV_PREFIX + "K2"] = K2;
    assert.throws(() => keyring.load());
  });
});

test("المفاتيح: نشطٌ غير موجود في الحلقة، وحلقة فارغة، ومعرّف بصيغة خاطئة", async () => {
  await sandbox({ [keyring.ENV_ACTIVE]: "k2" }, async () => {
    assert.throws(() => keyring.load(), /غير موجود في الحلقة/);
  });
  await sandbox({ [keyring.ENV_PREFIX + "K1"]: undefined }, async () => {
    assert.throws(() => keyring.load(), /فارغة/);
  });
  await sandbox({ [keyring.ENV_ACTIVE]: "" }, async () => {
    assert.throws(() => keyring.load(), /غير مضبوط/);
  });
  await sandbox({ [keyring.ENV_PREFIX + "ZZ"]: K2 }, async () => {
    assert.throws(() => keyring.load(), /اسم متغيّر مفتاح غير صالح/);
  });
});

test("المفاتيح: معرّفان بمادّة واحدة = تدوير وهميّ مرفوض", async () => {
  await sandbox({ [keyring.ENV_PREFIX + "K2"]: K1 }, async () => {
    assert.throws(() => keyring.load(), /مادّة واحدة/);
  });
});

test("المفاتيح: مادّة المفتاح لا تظهر في أي رسالة أو في load()", async () => {
  await sandbox({ [keyring.ENV_PREFIX + "K2"]: K1 }, async () => {
    try { keyring.load(); assert.fail("كان يجب أن يرمي"); }
    catch (err) { assert.ok(!String(err.message).includes(K1)); }
  });
  await sandbox({}, async () => {
    assert.equal(JSON.stringify(keyring.load()).includes(K1), false, "load لا يُخرج مادّة");
    assert.ok(Buffer.isBuffer(keyring.keyFor("k1")));
    assert.equal(keyring.keyFor("k1").length, keyring.KEY_BYTES);
  });
});

/* ══ هـ) الحدود والمدخلات ═════════════════════════════════════════════ */

test("الحدود: ما يتجاوز 10 MB يُرفض قبل التشفير وقبل أي نداء", async () => {
  await sandbox({}, async (blob) => {
    assert.equal(storage.MAX_BYTES, 10 * 1024 * 1024);
    const big = Buffer.alloc(storage.MAX_BYTES + 1, 0x41);
    await rejects(() => storage.putEncrypted({ ...identity(), bytes: big, format: "pdf" }));
    assert.equal(blob.calls.length, 0, "لا رفع لما سيُرفض");

    const edge = Buffer.alloc(storage.MAX_BYTES, 0x41);
    const desc = await storage.putEncrypted({ ...identity(), bytes: edge, format: "pdf" });
    assert.equal(desc.sizeBytes, storage.MAX_BYTES, "الحدّ نفسه مقبول");
  });
});

test("الحدود: بايتات فارغة أو نوع غير مدعوم مرفوضة", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    await rejects(() => storage.putEncrypted({ ...id, bytes: Buffer.alloc(0), format: "pdf" }));
    await rejects(() => storage.putEncrypted({ ...id, bytes: "نصّ لا بايتات", format: "pdf" }));
    await rejects(() => storage.putEncrypted({ ...id, bytes: undefined, format: "pdf" }));
    assert.equal(blob.calls.length, 0);
  });
});

test("المسار: مولَّد بلا اسم ملفّ ولا شهر ولا انتقال أدلّة", async () => {
  await sandbox({}, async () => {
    const id = { fileId: uuid(), runId: uuid(), kind: "cash" };
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "pdf" });
    assert.match(desc.pathname, new RegExp(`^${storage.PATH_PREFIX}/${id.runId}/[0-9a-f]{32}$`));
    assert.ok(!desc.pathname.includes(".."));
    assert.ok(!desc.pathname.includes("//"));
    assert.ok(!/\.(pdf|xlsx|xls|csv)$/i.test(desc.pathname), "لا امتداد يفصح عن الصيغة");
    /* الفحص على **مقاطع** المسار لا على نصّه: «\\d{4}-\\d{2}» يطابق داخل أي
       UUID مصادفةً، فيصير اختبارًا يسقط مرّة من عشر بلا سبب — وذلك أسوأ من
       ألّا يوجد، لأنه يُدرَّب الناظر على تجاهل الأحمر. */
    const segments = desc.pathname.split("/");
    assert.equal(segments.length, 3, "بادئة ثمّ runId ثمّ اسم عشوائيّ — لا أكثر");
    assert.ok(!segments.some((s) => /^\d{4}-\d{2}$/.test(s)), "لا مقطع شهر في المسار");

    for (const bad of [
      "", "x", "../etc/passwd", `${storage.PATH_PREFIX}/../x/${"0".repeat(32)}`,
      `${storage.PATH_PREFIX}//${"0".repeat(32)}`,
      `https://example.invalid/${desc.pathname}`, `/${desc.pathname}`,
    ]) {
      await rejects(() => storage.remove(bad), `قُبل مسار: ${bad}`);
      await rejects(() => storage.getDecrypted({ ...id, ...desc, pathname: bad }));
    }
  });
});

test("النوع: safeContentType من قائمة مغلقة لا من العميل", async () => {
  assert.equal(storage.safeContentType("pdf"), "application/pdf");
  assert.equal(storage.safeContentType("csv"), "text/csv");
  for (const bad of ["html", "text/html", "", null, undefined, "PDF", "constructor", "__proto__", "toString"]) {
    assert.throws(() => storage.safeContentType(bad), `قُبل نوع: ${bad}`);
  }
  assert.deepEqual(Object.keys(storage.SAFE_CONTENT_TYPES).sort(), ["csv", "pdf", "xls", "xlsx"]);
});

/* ══ و) السلامة والتسريب ══════════════════════════════════════════════ */

test("السلامة: اختلاف بصمة النصّ الصريح يُبلَّغ sha_mismatch", async () => {
  await sandbox({}, async () => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("محتوى"), format: "pdf" });
    assert.equal(desc.plaintextSha256, crypto.createHash("sha256").update(bytes("محتوى")).digest("hex"));
    const wrong = "0".repeat(64);
    assert.equal(await reasonOf(() => storage.getDecrypted({ ...id, ...desc, plaintextSha256: wrong })), "sha_mismatch");
    /* وبالبصمة الصحيحة يمرّ. */
    assert.ok((await storage.getDecrypted({ ...id, ...desc })).equals(bytes("محتوى")));
  });
});

test("السلامة: كل الأسباب من قائمة مغلقة، والرسالة واحدة لا تميّز", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("محتوى"), format: "pdf" });
    const seen = new Map();

    seen.set("unknown_key", await catchErr(() => storage.getDecrypted({ ...id, ...desc, encKeyId: "k7" })));
    seen.set("sha_mismatch", await catchErr(() => storage.getDecrypted({ ...id, ...desc, plaintextSha256: "0".repeat(64) })));
    blob.objects.get(desc.pathname)[0] ^= 0x01;
    seen.set("tag_mismatch", await catchErr(() => storage.getDecrypted({ ...id, ...desc })));
    blob.objects.delete(desc.pathname);
    seen.set("object_missing", await catchErr(() => storage.getDecrypted({ ...id, ...desc })));

    const messages = new Set();
    for (const [expected, err] of seen) {
      assert.equal(err.reason, expected);
      assert.ok(storage.INTEGRITY_REASONS.includes(err.reason), `سبب خارج القائمة: ${err.reason}`);
      assert.equal(err.name, "DrouaIntegrityError");
      messages.add(err.message);
      for (const secret of [id.fileId, desc.pathname, desc.encIv, desc.encTag]) {
        assert.ok(!err.message.includes(secret), "الرسالة تحمل ما يميّز الملفّ");
      }
    }
    assert.equal(messages.size, 1, "رسالة واحدة لكل الأسباب — لا تمييز للمُنادي");
  });
});

async function catchErr(fn) {
  try { await fn(); } catch (err) { return err; }
  throw new Error("كان يجب أن يفشل");
}

test("التسريب: الواصف بلا رابط، وبـplaintextSha256 لا sha256 مجرَّدة", async () => {
  await sandbox({}, async () => {
    const desc = await storage.putEncrypted({ ...identity(), bytes: bytes("م"), format: "pdf" });
    const keys = Object.keys(desc);
    assert.deepEqual(keys.sort(), [
      "encAlgo", "encIv", "encKeyId", "encTag", "pathname", "plaintextSha256", "sizeBytes",
    ]);
    assert.ok(!keys.some((k) => /url|link|href|downloadUrl/i.test(k)), "حقل رابط في الواصف");
    assert.ok(!keys.includes("sha256"), "الاسم المجرَّد يعيد الالتباس");
    assert.ok(!keys.includes("fileName"), "الوحدة لا ترى اسم الملفّ أصلًا");
    assert.equal(JSON.stringify(desc).includes("https://"), false);
  });
});

test("التسريب: لا console.* ولا اسم ملفّ في وحدتَي التخزين", async () => {
  const dir = path.resolve(__dirname, "..", "lib", "droua");
  for (const name of ["storage.js", "keyring.js"]) {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    assert.ok(!/console\./.test(code), `${name} يطبع — والطباعة هنا تسريب`);
    assert.ok(!/\bfileName\b/.test(code), `${name} يذكر fileName`);
  }
});

test("الحذف: أفضل جهد — لا يُسقط العملية على كائن غير موجود", async () => {
  await sandbox({}, async (blob) => {
    const id = identity();
    const desc = await storage.putEncrypted({ ...id, bytes: bytes("م"), format: "pdf" });
    assert.deepEqual(await storage.remove(desc.pathname), { removed: true });
    assert.equal(blob.objects.has(desc.pathname), false);
    assert.deepEqual(await storage.remove(desc.pathname), { removed: false }, "الثاني لا يرمي");
  });
});
