/* متجر صور الموظفين — Vercel Blob خاصّ ومستقلّ، بمصادقة OIDC.
   =========================================================================
   المتجر مربوط بالمشروع بطريقة Vercel الحالية: معرّف المتجر في
   EMPLOYEE_PHOTOS_STORE_ID (البادئة EMPLOYEE_PHOTOS)، والمصادقة رمز OIDC
   قصير العمر يصدره Vercel للبيئة نفسها — لا توكن قراءة/كتابة دائم.

   مصدر رمز OIDC:
     - داخل دالّة Vercel: ترويسة x-vercel-oidc-token في الطلب نفسه (يمرّرها
       مسار العرض في api/app.js).
     - محليًا (سكربت الرفع): VERCEL_OIDC_TOKEN الذي يحقنه
       `vercel env run -e preview` في العملية وحدها، بلا ملفّ.

   ── لماذا يُمرَّر الرمز صراحةً ولا يُترك للـSDK ──
   حين لا يجد `@vercel/blob` رمز OIDC يبتلع الخطأ و**يسقط إلى
   BLOB_READ_WRITE_TOKEN** — توكن متجر أجير **العامّ**. فتمرير oidcToken
   وstoreId صراحةً في كل نداء يُبقي المصادقة على هذا المتجر أو لا شيء:
   رمزٌ غائب يرمي هنا قبل أي نداء، ولا سقوط ممكن.
   ولا يُمرَّر `token` أبدًا: لا توكن قراءة/كتابة في هذه الوحدة.

   ومعرّف متجر يطابق متجر أجير أو متجر قسم المراجعة خطأ إعداد يرمي.

   غياب EMPLOYEE_PHOTOS_STORE_ID هو الحالة الطبيعية خارج المعاينة: الإنتاج
   لا يحمله حتى يُعتمد، فلا تظهر صورة ويبقى الـPlaceholder — بلا خطأ. */

const { inspectPhoto, sha256hex } = require("./validate");
const manifest = require("./manifest");

const ENV_STORE_ID = "EMPLOYEE_PHOTOS_STORE_ID";
const KEY_RE = /^employee-photos\/[0-9a-f]{32}$/;
const ID_RE = /^[0-9a-f]{16}$/;
const STORE_ID_RE = /^(store_)?[A-Za-z0-9]+$/;
/* سقف قراءة من المتجر: أكبر من حدّ الرفع بقليل؛ ما يتجاوزه ليس صورتنا. */
const READ_CAP = 2 * 1024 * 1024 + 1;

const bareStoreId = (v) => String(v || "").trim().replace(/^store_/, "");
/* معرّف المتجر في توكن قراءة/كتابة: vercel_blob_rw_<storeId>_<secret>.
   يُقرأ للمقارنة وحدها — لا يُستعمل التوكن. */
const storeIdOfRwToken = (t) => (t ? bareStoreId(String(t).split("_")[3]) : "");

function configured() {
  return !!String(process.env[ENV_STORE_ID] || "").trim();
}

function credentials(oidcToken) {
  const raw = String(process.env[ENV_STORE_ID] || "").trim();
  if (!raw) throw new Error("متجر صور الموظفين غير مُهيّأ");
  if (!STORE_ID_RE.test(raw)) throw new Error("معرّف متجر الصور غير صالح");
  const storeId = bareStoreId(raw);
  if (storeId === storeIdOfRwToken(process.env.BLOB_READ_WRITE_TOKEN)) throw new Error("معرّف متجر الصور هو متجر أجير العامّ");
  if (storeId === storeIdOfRwToken(process.env.DROUA_BLOB_READ_WRITE_TOKEN)) throw new Error("معرّف متجر الصور هو متجر قسم المراجعة");
  const token = String(oidcToken || process.env.VERCEL_OIDC_TOKEN || "").trim();
  if (!token) throw new Error("رمز OIDC غير متاح — لا مصادقة لمتجر الصور");
  return { storeId, oidcToken: token };
}

/* طلب كسول: المكتبة لا تُحمَّل في طلبٍ لا يمسّ الصور. */
function blobApi() {
  return require("@vercel/blob");
}

function entryById(photoId) {
  const id = String(photoId || "");
  if (!ID_RE.test(id)) return null;
  return manifest.find((e) => e.photoId === id) || null;
}

async function readCapped(stream) {
  const chunks = [];
  let total = 0;
  const push = (c) => {
    const b = Buffer.from(c);
    total += b.length;
    if (total > READ_CAP) throw new Error("كائن الصورة أكبر من المتوقّع");
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

/* يقرأ بايتات صورةٍ من المتجر الخاصّ ويتحقّق منها قبل أن يسلّمها:
   البصمة يجب أن تطابق الـmanifest، والتوقيع يجب أن يطابق النوع المسجّل.
   كائنٌ استُبدل في المتجر بغير ما اعتُمد لا يُقدَّم أبدًا. */
async function readPhoto(entry, oidcToken) {
  if (!entry || !KEY_RE.test(entry.storageKey)) throw new Error("مدخل صورة غير صالح");
  const res = await blobApi().get(entry.storageKey, { access: "private", ...credentials(oidcToken) });
  if (!res || !res.stream) return null;
  const bytes = await readCapped(res.stream);
  if (sha256hex(bytes) !== entry.sha256) throw new Error("بصمة الصورة لا تطابق المعتمد");
  const info = inspectPhoto(bytes);
  if (info.mime !== entry.mime) throw new Error("نوع الصورة المخزّنة لا يطابق المعتمد");
  return bytes;
}

/* الرفع (سكربت الإعداد وحده يستدعيه): المسار من الـmanifest حرفيًا، بلا
   لاحقة عشوائية، وخاصّ دائمًا. نوع المحتوى المعلن للمتجر عامّ عمدًا:
   النوع الحقيقي يأتي من الـmanifest عند التقديم. */
async function putPhoto(entry, bytes, oidcToken) {
  if (!entry || !KEY_RE.test(entry.storageKey)) throw new Error("مدخل صورة غير صالح");
  const info = inspectPhoto(bytes);
  if (info.sha256 !== entry.sha256) throw new Error("الملفّ لا يطابق بصمة الـmanifest");
  const result = await blobApi().put(entry.storageKey, bytes, {
    access: "private",
    contentType: "application/octet-stream",
    addRandomSuffix: false,
    allowOverwrite: true,
    ...credentials(oidcToken),
  });
  const stored = String((result && result.pathname) || "").replace(/^\//, "");
  if (stored !== entry.storageKey) throw new Error("المتجر أعاد تسمية الكائن");
  return result;
}

module.exports = { configured, credentials, entryById, readPhoto, putPhoto, ENV_STORE_ID, KEY_RE, ID_RE };
