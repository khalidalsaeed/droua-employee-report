/* ─── تخزين خاصّ مشفَّر: بايتات تدخل، بايتات تخرج ──────────────────────
   =========================================================================
   الوحدة **لا تعرف القاعدة ولا HTTP**. تأخذ بايتات وهويّة وتُرجع واصفًا
   يحفظه غيرها. ولا ترى اسم الملفّ أصلًا.

   ── ما تحرسه هذه الطبقة لكل وحدة تستعملها ──
   ① توكن متجر الوحدة صراحةً في كل نداء. `@vercel/blob` يقرأ توكن المتجر
     العامّ **تلقائيًا** حين لا يُمرَّر token — فالنسيان يكتب ملفًّا سرّيًا
     في متجر عامّ بلا خطأ. ولذلك: الغياب يرمي، ومساواة أيّ توكن ممنوع يرمي.
   ② AES-256-GCM مع AAD يربط الشيفرة بهويّة الملفّ (حقول تحدّدها الوحدة) —
     فلا يُقرأ كائنٌ في موضع آخر، ولا جزءٌ في ترتيب آخر.
   ③ لا بايت نصٍّ صريح يخرج قبل نجاح final() — أي قبل التحقّق من الوسم.
   ④ لا رابط: لا دالّة تُرجع رابطًا ولا تقبله. المرجع الوحيد pathname
     يولّده الخادم عشوائيًا.

   مع إعداد Droua (البادئة والحقول) تتشارك هذه الطبقة وlib/droua/storage.js
   الصيغة نفسها: كلٌّ يفكّ ما يكتبه الآخر — يُثبته اختبار التكافؤ. */

const crypto = require("crypto");
const { isUuid } = require("./identifiers");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STORED_CONTENT_TYPE = "application/octet-stream";

/* قيمة حقل هويّة: بلا «|» بحكم القائمة — هو فاصل أجزاء الـAAD، وقيمةٌ
   تحمله تجعل تركيبين مختلفين ينتجان AAD واحدًا. */
const FIELD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX_RE = /^[a-z][a-z0-9-]{2,40}$/;

const INTEGRITY_REASONS = Object.freeze([
  "tag_mismatch", "sha_mismatch", "unknown_key", "object_missing", "decrypt_error",
]);

function integrityError(reason) {
  const err = new Error("تعذّر التحقّق من سلامة الملفّ");
  err.name = "SecureIntegrityError";
  err.reason = reason;
  return err;
}

const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new Error("bytes يجب أن تكون Buffer أو Uint8Array");
}

async function readAllCapped(stream, cap) {
  const chunks = [];
  let total = 0;
  const push = (chunk) => {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > cap) throw integrityError("decrypt_error");
    chunks.push(buf);
  };
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        push(value);
      }
    } finally {
      try { await reader.cancel(); } catch (err) { /* أفضل جهد */ }
    }
  } else if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) push(chunk);
  } else {
    throw integrityError("object_missing");
  }
  return Buffer.concat(chunks);
}

function createEncryptedStore({
  tokenEnv, forbiddenEqualEnvs = [], keyring, aadPrefix, aadFields, groupField,
  pathPrefix, maxBytes, formats, blobApi = () => require("@vercel/blob"),
}) {
  if (!tokenEnv) throw new Error("tokenEnv مطلوب");
  if (!keyring) throw new Error("keyring مطلوبة");
  if (!/^[a-z][a-z0-9-]*\|v[0-9]+$/.test(String(aadPrefix || ""))) throw new Error("بادئة AAD غير صالحة");
  if (!Array.isArray(aadFields) || !aadFields.length) throw new Error("حقول AAD مطلوبة");
  if (!aadFields.includes(groupField)) throw new Error("حقل التجميع يجب أن يكون من حقول الهويّة");
  if (!PREFIX_RE.test(String(pathPrefix || ""))) throw new Error("بادئة مسار غير صالحة");
  if (!(maxBytes > 0)) throw new Error("حدّ الحجم مطلوب");
  const FORMATS = Object.freeze({ ...formats });

  const PATHNAME_RE = new RegExp(`^${pathPrefix}/[0-9a-f-]{36}/[0-9a-f]{32}$`, "i");

  function token() {
    const value = process.env[tokenEnv];
    if (!value) throw new Error("تخزين الوحدة غير مُهيّأ");
    for (const other of forbiddenEqualEnvs) {
      if (process.env[other] && value === process.env[other]) {
        throw new Error("توكن تخزين الوحدة يطابق توكن متجرٍ آخر");
      }
    }
    return value;
  }

  function assertIdentity(identity) {
    for (const field of aadFields) {
      const value = identity && identity[field];
      if (!FIELD_RE.test(String(value === undefined || value === null ? "" : value))) {
        throw new Error(`${field} غير صالح`);
      }
    }
    if (!isUuid(String(identity[groupField]))) throw new Error(`${groupField} غير صالح`);
  }

  function aadFor(identity) {
    return Buffer.from([aadPrefix, ...aadFields.map((f) => String(identity[f]))].join("|"), "utf8");
  }

  function safeContentType(format) {
    if (!Object.prototype.hasOwnProperty.call(FORMATS, String(format || ""))) {
      throw new Error("صيغة ملفّ غير مسموحة");
    }
    return FORMATS[format];
  }

  function assertPathname(pathname) {
    const value = String(pathname || "");
    if (!PATHNAME_RE.test(value)) throw new Error("مسار تخزين غير صالح");
    return value;
  }

  const newPathname = (group) => `${pathPrefix}/${group}/${crypto.randomBytes(16).toString("hex")}`;

  async function putEncrypted({ identity, bytes }) {
    assertIdentity(identity);
    const plain = toBuffer(bytes);
    if (!plain.length) throw new Error("ملفّ فارغ");
    if (plain.length > maxBytes) throw new Error("الملفّ يتجاوز الحدّ المسموح");

    /* الإعداد قبل التشفير: نقصٌ يفشل بلا أي أثر جانبيّ. */
    const tok = token();
    const encKeyId = keyring.activeKeyId();
    const key = keyring.keyFor(encKeyId);

    const plaintextSha256 = sha256hex(plain);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aadFor(identity));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();

    const pathname = newPathname(identity[groupField]);
    const result = await blobApi().put(pathname, ciphertext, {
      access: "private",
      contentType: STORED_CONTENT_TYPE,
      addRandomSuffix: false,
      token: tok,
    });

    /* المتجر صاحب القول الفصل في الاسم؛ واختلافه إعادة تسمية صامتة. */
    const stored = String((result && result.pathname) || "").replace(/^\//, "");
    if (stored !== pathname) {
      try { await blobApi().del(stored || pathname, { token: tok }); } catch (err) { /* أفضل جهد */ }
      throw new Error("المتجر أعاد تسمية الكائن");
    }

    return {
      pathname,
      sizeBytes: plain.length,
      plaintextSha256,
      encAlgo: ALGORITHM,
      encKeyId,
      encIv: iv.toString("hex"),
      encTag: tag.toString("hex"),
    };
  }

  /* لا بثّ للنصّ الصريح: الوسم لا يُتحقَّق منه إلا عند final(). */
  async function getDecrypted({ identity, pathname, encIv, encTag, encKeyId, plaintextSha256 }) {
    assertIdentity(identity);
    const path = assertPathname(pathname);
    const tok = token();

    if (!keyring.has(encKeyId)) throw integrityError("unknown_key");
    const key = keyring.keyFor(encKeyId);

    const iv = Buffer.from(String(encIv || ""), "hex");
    const tag = Buffer.from(String(encTag || ""), "hex");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw integrityError("decrypt_error");

    const result = await blobApi().get(path, { access: "private", token: tok });
    if (!result || !result.stream) throw integrityError("object_missing");
    const ciphertext = await readAllCapped(result.stream, maxBytes);

    let plain;
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aadFor(identity));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      throw integrityError("tag_mismatch");
    }

    if (plaintextSha256 && sha256hex(plain) !== String(plaintextSha256)) throw integrityError("sha_mismatch");
    return plain;
  }

  /* الحذف أفضل جهد: الكائن اليتيم مشفَّر وبلا رابط ولا مسار يبلغه. */
  async function remove(pathname) {
    const path = assertPathname(pathname);
    const tok = token();
    try {
      await blobApi().del(path, { token: tok });
      return { removed: true };
    } catch (err) {
      return { removed: false };
    }
  }

  /* هل التخزين جاهز؟ يُرجع صحيحًا/خطأً فقط، بلا رمي. */
  function ready() {
    try {
      token();
      keyring.load();
      return true;
    } catch (err) {
      return false;
    }
  }

  return {
    putEncrypted, getDecrypted, remove, safeContentType, ready, assertPathname,
    MAX_BYTES: maxBytes, FORMATS, ALGORITHM, AAD_PREFIX: aadPrefix, PATH_PREFIX: pathPrefix,
    STORED_CONTENT_TYPE, INTEGRITY_REASONS,
  };
}

module.exports = { createEncryptedStore, sha256hex, INTEGRITY_REASONS, ALGORITHM, STORED_CONTENT_TYPE };
