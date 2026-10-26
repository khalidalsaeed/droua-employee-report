/* متجر البطاقات البلدية — Vercel Blob خاصّ ومستقلّ، بمصادقة OIDC.
   =========================================================================
   على نمط lib/photos/store.js حرفيًا: معرّف المتجر في
   MUNICIPAL_CARDS_STORE_ID، والمصادقة رمز OIDC قصير العمر يُمرَّر صراحةً
   في كل نداء (ترويسة x-vercel-oidc-token داخل الدالّة، أو VERCEL_OIDC_TOKEN
   الذي يحقنه `vercel env run` محليًا). لا توكن قراءة/كتابة دائم، ولا سقوط
   صامت إلى BLOB_READ_WRITE_TOKEN (متجر أجير العامّ).

   محتوى المتجر — ولا شيء منه في Git ولا في القاعدة:
     municipal-cards/index.json        الفهرس: من صاحب كل بطاقة (employee_eid)
                                       وحقولها ومفاتيح كائناتها وبصماتها.
     municipal-cards/card/<32hex>.png  وجه الشهادة الأصلي مرسومًا من الملفّ.
     municipal-cards/qr/<32hex>.png    صورة رمز QR الأصلية من الملفّ نفسه.
   ملفّ PDF نفسه لا يُخزَّن: تبقى بصمته (source_file_hash) فقط.

   معرّف متجر يطابق متجر أجير أو المراجعة أو صور الموظفين خطأ إعداد يرمي.
   غياب MUNICIPAL_CARDS_STORE_ID (الإنتاج قبل الاعتماد) = لا بطاقات، بلا خطأ. */

const crypto = require("crypto");

const ENV_STORE_ID = "MUNICIPAL_CARDS_STORE_ID";
const INDEX_KEY = "municipal-cards/index.json";
const OBJECT_KEY_RE = /^municipal-cards\/(card|qr)\/[0-9a-f]{32}\.png$/;
const CARD_ID_RE = /^[0-9a-f]{16}$/;
const STORE_ID_RE = /^(store_)?[A-Za-z0-9]+$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OBJECT_CAP = 4 * 1024 * 1024; // وجه شهادة PNG أقلّ من 1MB بكثير
const INDEX_CAP = 512 * 1024;
const INDEX_TTL_MS = 60 * 1000;

const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const bareStoreId = (v) => String(v || "").trim().replace(/^store_/, "");
const storeIdOfRwToken = (t) => (t ? bareStoreId(String(t).split("_")[3]) : "");

function configured() {
  return !!String(process.env[ENV_STORE_ID] || "").trim();
}

function credentials(oidcToken) {
  const raw = String(process.env[ENV_STORE_ID] || "").trim();
  if (!raw) throw new Error("متجر البطاقات البلدية غير مُهيّأ");
  if (!STORE_ID_RE.test(raw)) throw new Error("معرّف متجر البطاقات غير صالح");
  const storeId = bareStoreId(raw);
  if (storeId === storeIdOfRwToken(process.env.BLOB_READ_WRITE_TOKEN)) throw new Error("معرّف متجر البطاقات هو متجر أجير العامّ");
  if (storeId === storeIdOfRwToken(process.env.DROUA_BLOB_READ_WRITE_TOKEN)) throw new Error("معرّف متجر البطاقات هو متجر قسم المراجعة");
  if (storeId === bareStoreId(process.env.EMPLOYEE_PHOTOS_STORE_ID)) throw new Error("معرّف متجر البطاقات هو متجر صور الموظفين");
  const token = String(oidcToken || process.env.VERCEL_OIDC_TOKEN || "").trim();
  if (!token) throw new Error("رمز OIDC غير متاح — لا مصادقة لمتجر البطاقات");
  return { storeId, oidcToken: token };
}

function blobApi() {
  return require("@vercel/blob");
}

async function readCapped(stream, cap) {
  const chunks = [];
  let total = 0;
  const push = (c) => {
    const b = Buffer.from(c);
    total += b.length;
    if (total > cap) throw new Error("الكائن أكبر من المتوقّع");
    chunks.push(b);
  };
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      push(value);
    }
  } else {
    for await (const c of stream) push(c);
  }
  return Buffer.concat(chunks);
}

/* ── الفهرس ── */

const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n || 160) : null);

/* مدخل صالح فقط يمرّ؛ ما سواه يُسقط بصمت فلا يكسر مدخلٌ تالف القسم كله. */
function validEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (!CARD_ID_RE.test(String(e.cardId || ""))) return null;
  if (!/^\d+$/.test(String(e.employeeEid || ""))) return null;
  if (!/^\d{3,}-\d{4}$/.test(String(e.certificateNumber || ""))) return null;
  if (!OBJECT_KEY_RE.test(String(e.cardKey || "")) || !/^[0-9a-f]{64}$/.test(String(e.cardSha256 || ""))) return null;
  const hasQr = OBJECT_KEY_RE.test(String(e.qrKey || "")) && /^[0-9a-f]{64}$/.test(String(e.qrSha256 || ""));
  return {
    cardId: e.cardId,
    employeeEid: String(e.employeeEid),
    certificateNumber: e.certificateNumber,
    issuePlace: str(e.issuePlace),
    expiryDate: isIso(e.expiryDate) ? e.expiryDate : null,
    expiryHijri: isIso(e.expiryHijri) ? e.expiryHijri : null,
    nameOnCard: str(e.nameOnCard),
    occupation: str(e.occupation),
    cardKey: e.cardKey,
    cardSha256: e.cardSha256,
    qrKey: hasQr ? e.qrKey : null,
    qrSha256: hasQr ? e.qrSha256 : null,
    qrTarget: hasQr ? str(e.qrTarget, 4096) : null,
    sourceFileHash: /^[0-9a-f]{64}$/.test(String(e.sourceFileHash || "")) ? e.sourceFileHash : null,
    createdAt: str(e.createdAt, 40),
    updatedAt: str(e.updatedAt, 40),
  };
}

function parseIndex(text) {
  const j = JSON.parse(text);
  if (!j || j.version !== 1 || !Array.isArray(j.cards)) throw new Error("فهرس البطاقات بصيغة غير معروفة");
  return { version: 1, updatedAt: str(j.updatedAt, 40), cards: j.cards.map(validEntry).filter(Boolean) };
}

let cache = null; // { at, index } — لكل نسخة من الدالّة، دقيقة واحدة

async function readIndex(oidcToken, opts) {
  if (!configured()) return { version: 1, cards: [] };
  if (cache && !(opts && opts.fresh) && Date.now() - cache.at < INDEX_TTL_MS) return cache.index;
  let res;
  try {
    res = await blobApi().get(INDEX_KEY, { access: "private", ...credentials(oidcToken) });
  } catch (err) {
    if (/not.?found|404/i.test(String(err && err.message))) res = null;
    else throw err;
  }
  const index = res && res.stream ? parseIndex((await readCapped(res.stream, INDEX_CAP)).toString("utf8")) : { version: 1, cards: [] };
  cache = { at: Date.now(), index };
  return index;
}

function entryById(index, cardId) {
  const id = String(cardId || "");
  if (!CARD_ID_RE.test(id)) return null;
  return (index.cards || []).find((c) => c.cardId === id) || null;
}

/* يقرأ وجه البطاقة أو صورة رمزها ويتحقّق قبل التسليم: البصمة يجب أن تطابق
   الفهرس، والتوقيع PNG. كائنٌ استُبدل في المتجر لا يُقدَّم أبدًا. */
async function readObject(entry, kind, oidcToken) {
  const key = kind === "qr" ? entry.qrKey : entry.cardKey;
  const sha = kind === "qr" ? entry.qrSha256 : entry.cardSha256;
  if (!OBJECT_KEY_RE.test(String(key || ""))) return null;
  const res = await blobApi().get(key, { access: "private", ...credentials(oidcToken) });
  if (!res || !res.stream) return null;
  const bytes = await readCapped(res.stream, OBJECT_CAP);
  if (sha256hex(bytes) !== sha) throw new Error("بصمة الكائن لا تطابق الفهرس");
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("الكائن ليس PNG");
  return bytes;
}

/* ── الكتابة (سكربت الاستيراد وحده) ── */

const newObjectKey = (kind) => `municipal-cards/${kind}/${crypto.randomBytes(16).toString("hex")}.png`;
const newCardId = () => crypto.randomBytes(8).toString("hex");

async function putObject(key, bytes, oidcToken) {
  if (!OBJECT_KEY_RE.test(key)) throw new Error("مفتاح كائن غير صالح");
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("الكائن ليس PNG");
  const result = await blobApi().put(key, bytes, {
    access: "private",
    contentType: "application/octet-stream",
    addRandomSuffix: false,
    allowOverwrite: true,
    ...credentials(oidcToken),
  });
  const stored = String((result && result.pathname) || "").replace(/^\//, "");
  if (stored !== key) throw new Error("المتجر أعاد تسمية الكائن");
  return result;
}

async function writeIndex(index, oidcToken) {
  const clean = { version: 1, updatedAt: new Date().toISOString(), cards: index.cards.map(validEntry).filter(Boolean) };
  if (clean.cards.length !== index.cards.length) throw new Error("مدخل غير صالح في الفهرس — لم يُكتب شيء");
  const result = await blobApi().put(INDEX_KEY, Buffer.from(JSON.stringify(clean, null, 2)), {
    access: "private",
    contentType: "application/octet-stream",
    addRandomSuffix: false,
    allowOverwrite: true,
    ...credentials(oidcToken),
  });
  cache = null;
  return result;
}

async function deleteObjects(keys, oidcToken) {
  const valid = keys.filter((k) => OBJECT_KEY_RE.test(String(k || "")));
  if (valid.length) await blobApi().del(valid, credentials(oidcToken));
}

module.exports = {
  ENV_STORE_ID, INDEX_KEY, OBJECT_KEY_RE, CARD_ID_RE,
  configured, credentials, readIndex, parseIndex, validEntry, entryById, readObject,
  newObjectKey, newCardId, putObject, writeIndex, deleteObjects, sha256hex,
  _resetCache: () => { cache = null; },
};
