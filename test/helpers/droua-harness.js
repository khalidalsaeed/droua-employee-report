/* بيئة تشغيل كاملة للقسم في الذاكرة: مفاتيح، ومتجر مُزيَّف، وقاعدة
   مُزيَّفة، وسياق بوابة مفتوح.
   =========================================================================
   المغلّف **async ويُنتظر جسمه**. النسخة المتزامنة تستعيد البيئة عند أول
   `await` فتُرفع الحماية في منتصف الاختبار وتمرّ حالات كان يجب أن تسقط —
   وهو عطلٌ وقع في هذا المشروع ثلاث مرّات، ولذلك يُكرَّر التنبيه. */

const Module = require("node:module");
const gateContext = require("../../lib/droua/gateContext");
const keyring = require("../../lib/droua/keyring");
const { makeFilesDb, makeFakeBlob } = require("./files-db");

const BLOB_ID = require.resolve("@vercel/blob");
const K1 = "a1".repeat(32);
const TOKEN = "vercel_blob_rw_DROUA_TEST_TOKEN";
const ACTOR = "11111111-2222-3333-4444-555555555555";

const ENV_KEYS = ["DROUA_BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN", keyring.ENV_ACTIVE];

async function withDroua(fn, { openGate = true } = {}) {
  const saved = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(keyring.ENV_PREFIX)) { saved[name] = process.env[name]; delete process.env[name]; }
  }
  for (const name of ENV_KEYS) {
    if (!(name in saved)) saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.DROUA_BLOB_READ_WRITE_TOKEN = TOKEN;
  process.env[keyring.ENV_ACTIVE] = "k1";
  process.env[keyring.ENV_PREFIX + "K1"] = K1;

  const blob = makeFakeBlob();
  const stub = new Module(BLOB_ID, null);
  stub.filename = BLOB_ID;
  stub.loaded = true;
  stub.exports = blob.api;
  const previous = require.cache[BLOB_ID];
  require.cache[BLOB_ID] = stub;

  const db = makeFilesDb();
  const ctx = { actorId: ACTOR };
  try {
    const body = () => fn({ db, blob, ctx, sql: db.sql });
    return openGate ? await gateContext.runWithGate({ userId: ACTOR, sidHash: "h" }, body) : await body();
  } finally {
    if (previous) require.cache[BLOB_ID] = previous;
    else delete require.cache[BLOB_ID];
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/* استجابة مُزيَّفة على شكل ما يعطيه Vercel: تُلتقط الحالة والرؤوس والجسم. */
function makeRes() {
  const out = { statusCode: 0, headers: {}, body: null, ended: false };
  const res = {
    setHeader(name, value) { out.headers[String(name).toLowerCase()] = value; },
    status(code) { out.statusCode = code; return res; },
    json(body) { out.body = body; out.ended = true; return res; },
    end(body) { if (body !== undefined) out.body = body; out.ended = true; return res; },
  };
  return { res, out };
}

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

module.exports = { withDroua, makeRes, b64, ACTOR, TOKEN, K1 };
