/* ─── تخزين ملفّات القسم: بايتات مشفَّرة، لا أكثر ──────────────────────
   =========================================================================
   الوحدة **لا تعرف Neon، ولا تعرف HTTP**. تأخذ بايتات وتُرجع بايتات، ومعها
   واصفٌ يحفظه غيرها. فتُختبر بلا قاعدة وبلا خادم، ويبقى لها سطحٌ واحد ضيّق.

   ولا ترى `fileName` أصلًا — لا وسيطًا ولا مخرجًا. الاسم يعيش في القاعدة
   وحدها، والموجّه يقرؤه من الصفّ عند التنزيل. **وما لا يبلغ الوحدة لا
   يتسرّب منها**، ولا يظهر في قائمة المتجر.

   ── الرابط غير موجود هنا ──
   لا دالّة تُرجع رابطًا، ولا دالّة تقبل رابطًا. المرجع الوحيد هو pathname.

   ── وما تحرسه هذه الوحدة تحديدًا ──
   ① توكن متجر القسم صراحةً في كل نداء — لا سقوط إلى متجر أجير العامّ.
   ② AAD يربط الشيفرة بهويّة الملفّ — فلا يُقرأ ملفّ في موضع آخر.
   ③ لا بايت نصٍّ صريح يخرج قبل نجاح final() — أي قبل التحقّق من الوسم. */

const crypto = require("crypto");
const keyring = require("./keyring");

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/* عشرة ميغابايت. وهو أيضًا ما يجعل القراءة الكاملة في الذاكرة قرارًا
   سليمًا لا تنازلًا — انظر السبب عند getDecrypted. */
const MAX_BYTES = 10 * 1024 * 1024;

/* بادئة الـAAD: فصل مجال + نسخة صيغة. **تغييرها حرفًا واحدًا يجعل كل ملفّ
   مخزَّن غير قابل للقراءة**، ولذلك تُثبَّت باختبار صريح. */
const AAD_PREFIX = "droua-payroll-file|v1";

const PATH_PREFIX = "droua-payroll-audit";

/* الأنواع المسموح تقديمها. قائمة مغلقة: نوع المحتوى لا يأتي من العميل ولا
   من الملفّ نفسه. */
const SAFE_CONTENT_TYPES = Object.freeze({
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
});

/* أمّا المخزَّن في المتجر فشيفرةٌ لا غير — ولا يُعلن نوعًا حقيقيًّا: إعلانه
   يخبر من يرى قائمة المتجر بصيغة الملفّ بلا فكّ تشفير، وهو تسريبٌ صغير بلا
   أي مقابل. */
const STORED_CONTENT_TYPE = "application/octet-stream";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/* الشرطة السفلية والحروف والأرقام فقط. **والمهمّ هنا منع «|»**: هو فاصل
   أجزاء الـAAD، وقيمةٌ تحمله تجعل تركيبين مختلفين ينتجان AAD واحدًا. */
const KIND_RE = /^[a-z0-9_]{1,32}$/;

const INTEGRITY_REASONS = Object.freeze([
  "tag_mismatch", "sha_mismatch", "unknown_key", "object_missing", "decrypt_error",
]);

/* ─── التوكن: أربع طبقات تمنع الكتابة في متجر أجير العامّ ─────────────
   `@vercel/blob` يقرأ توكن المتجر العامّ **تلقائيًا** حين لا يُمرَّر token.
   فالنسيان يقع في اتجاه الخطر: ملفّ رواتب سرّيّ يُكتب في متجر عامّ، بلا
   خطأ وبلا تحذير وبرابط يفتحه أي أحد. ولذلك: الغياب يرمي، والتساوي يرمي،
   والتمرير صريح في كل نداء، ويحرس الأمرَ اختبارُ عزل. */
function blobToken() {
  const token = process.env.DROUA_BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("تخزين القسم غير مُهيّأ");
  if (token === process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("توكن تخزين القسم يطابق توكن المتجر العامّ");
  }
  return token;
}

/* طلبٌ متأخّر عمدًا: لا تُحمَّل المكتبة إلا عند أول نداء فعليّ. */
function blobApi() {
  return require("@vercel/blob");
}

function integrityError(reason) {
  /* رسالة واحدة لكل الأسباب: ما يخرج إلى المُنادي لا يميّز. والسبب يُقرأ
     من الخاصيّة `reason` ويُسجَّل داخليًّا وحده. */
  const err = new Error("تعذّر التحقّق من سلامة الملفّ");
  err.name = "DrouaIntegrityError";
  err.reason = reason;
  return err;
}

function aadFor({ fileId, runId, kind }) {
  return Buffer.from(`${AAD_PREFIX}|${fileId}|${runId}|${kind}`, "utf8");
}

/* الهويّة تُفحص قبل أي عمل. ولا جزء منها يأتي من العميل: في الرفع يولّد
   الخادم fileId، وفي التنزيل تُقرأ الأجزاء من صفّ القاعدة. */
function assertIdentity({ fileId, runId, kind }) {
  if (!UUID_RE.test(String(fileId || ""))) throw new Error("fileId غير صالح");
  if (!UUID_RE.test(String(runId || ""))) throw new Error("runId غير صالح");
  if (!KIND_RE.test(String(kind || ""))) throw new Error("kind غير صالح");
}

function assertFormat(format) {
  if (!Object.prototype.hasOwnProperty.call(SAFE_CONTENT_TYPES, String(format || ""))) {
    throw new Error("صيغة ملفّ غير مسموحة");
  }
}

function safeContentType(format) {
  assertFormat(format);
  return SAFE_CONTENT_TYPES[format];
}

/* المسار **موضع لا هويّة**: عند إعادة التشفير بمفتاح جديد يُكتب كائن جديد
   بمسار جديد بينما fileId لا يتغيّر — فيبقى الـAAD صالحًا ولا شيء في
   الهويّة يتحرّك. ولو كان المسار هو الهويّة لوجبت الكتابة فوق الكائن نفسه،
   وهي العملية التي لا تملك تراجعًا إن انقطعت.

   والتجميع بـrunId لا بـ«YYYY-MM»: يعطي التجميع التشغيليّ نفسه، ولا يخبر
   من يرى قائمة المتجر بأي شهر. */
const PATHNAME_RE = new RegExp(`^${PATH_PREFIX}/[0-9a-f-]{36}/[0-9a-f]{32}$`, "i");

function newPathname(runId) {
  return `${PATH_PREFIX}/${runId}/${crypto.randomBytes(16).toString("hex")}`;
}

function assertPathname(pathname) {
  const value = String(pathname || "");
  if (!PATHNAME_RE.test(value)) throw new Error("مسار تخزين غير صالح");
  return value;
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  /* لا نصوص: ترميزها ضمنيًّا يجعل بصمة النصّ الصريح تعتمد على افتراضٍ
     غير معلن. المُنادي يقرّر الترميز ويمرّر بايتات. */
  throw new Error("bytes يجب أن تكون Buffer أو Uint8Array");
}

const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* ─── الرفع ──────────────────────────────────────────────────────────── */
async function putEncrypted({ fileId, runId, kind, bytes, format }) {
  assertIdentity({ fileId, runId, kind });
  assertFormat(format);

  const plain = toBuffer(bytes);
  if (!plain.length) throw new Error("ملفّ فارغ");
  /* الحدّ **قبل** التشفير وقبل أي نداء شبكة: لا نُنفق معالجًا ولا نرفع
     شيئًا لنكتشف بعدها أنه ممنوع. */
  if (plain.length > MAX_BYTES) throw new Error("الملفّ يتجاوز الحدّ المسموح");

  /* التوكن والمفتاح قبل التشفير أيضًا: إعدادٌ ناقص يفشل بلا أي أثر جانبيّ. */
  const token = blobToken();
  const encKeyId = keyring.activeKeyId();
  const key = keyring.keyFor(encKeyId);

  const plaintextSha256 = sha256hex(plain);

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor({ fileId, runId, kind }));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  const pathname = newPathname(runId);
  const result = await blobApi().put(pathname, ciphertext, {
    access: "private",
    contentType: STORED_CONTENT_TYPE,
    addRandomSuffix: false,
    token,
  });

  /* المتجر هو صاحب القول الفصل في الاسم. واختلافه عمّا طلبناه يعني إعادة
     تسمية صامتة — فلا يُحفظ مسارٌ لا يوجد. ننظّف ثمّ نرمي. */
  const stored = String((result && result.pathname) || "").replace(/^\//, "");
  if (stored !== pathname) {
    try { await blobApi().del(stored || pathname, { token }); } catch (err) { /* أفضل جهد */ }
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

/* ─── القراءة ────────────────────────────────────────────────────────── */
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

/* **لا بثّ للنصّ الصريح.** وسم GCM لا يُتحقَّق منه إلا عند final() — أي بعد
   آخر بايت. فالبثّ أثناء الفكّ يعني إرسال نصٍّ صريح غير متحقَّق منه؛ ولو
   فشل الوسم بعدها لكان المتلقّي قد استلم بايتات مزوَّرة بالفعل ولا سبيل
   لسحبها. فالبثّ هنا يُبطل الغرض من GCM، والحدّ 10 MB هو ما يجعل البديل
   بسيطًا وآمنًا. */
async function getDecrypted({
  fileId, runId, kind, pathname, encIv, encTag, encKeyId, plaintextSha256,
}) {
  assertIdentity({ fileId, runId, kind });
  const path = assertPathname(pathname);
  const token = blobToken();

  /* مجهول ⇒ حدث سلامة، لا سقوط إلى المفتاح النشط. أمّا الحلقة التالفة
     فترمي عطلَ إعداد من keyring نفسها — وهما حالتان تُعالَجان مختلفتين. */
  if (!keyring.has(encKeyId)) throw integrityError("unknown_key");
  const key = keyring.keyFor(encKeyId);

  const iv = Buffer.from(String(encIv || ""), "hex");
  const tag = Buffer.from(String(encTag || ""), "hex");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw integrityError("decrypt_error");

  const result = await blobApi().get(path, { access: "private", token });
  if (!result || !result.stream) throw integrityError("object_missing");

  const ciphertext = await readAllCapped(result.stream, MAX_BYTES);

  let plain;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor({ fileId, runId, kind }));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    /* هنا يقع تبديل الملفّات: شيفرةٌ سليمة بهويّة أخرى تفشل عند final(). */
    throw integrityError("tag_mismatch");
  }

  /* بصمة النصّ الصريح: تحقّقٌ من طرف إلى طرف ضدّ عطلٍ في كودنا — لا ضدّ
     مهاجم، فذاك يمسكه الوسم قبلها. */
  if (plaintextSha256 && sha256hex(plain) !== String(plaintextSha256)) {
    throw integrityError("sha_mismatch");
  }

  return plain;
}

/* ─── الحذف: أفضل جهد ────────────────────────────────────────────────
   الكائن اليتيم غير ضارّ بحكم التصميم — لا رابط له، ومشفَّر، ولا مسار
   يبلغه (القراءة تبدأ دائمًا من صفٍّ في القاعدة). فلا يُسقط فشلُ الحذف
   العمليةَ التي استدعته. */
async function remove(pathname) {
  const path = assertPathname(pathname);
  const token = blobToken();
  try {
    await blobApi().del(path, { token });
    return { removed: true };
  } catch (err) {
    return { removed: false };
  }
}

module.exports = {
  putEncrypted, getDecrypted, remove, safeContentType,
  MAX_BYTES, SAFE_CONTENT_TYPES, ALGORITHM, AAD_PREFIX,
  INTEGRITY_REASONS, PATH_PREFIX, STORED_CONTENT_TYPE,
};
