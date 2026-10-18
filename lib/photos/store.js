/* متجر صور الموظفين — Vercel Blob خاصّ ومستقلّ.
   =========================================================================
   ثلاثة متاجر في المشروع، ولكلٍّ توكنه:
     BLOB_READ_WRITE_TOKEN          متجر أجير — **عامّ**. ممنوع هنا.
     DROUA_BLOB_READ_WRITE_TOKEN    متجر قسم المراجعة — خاصّ لكنه ليس لنا.
     EMPLOYEE_PHOTOS_READ_WRITE_TOKEN   هذا المتجر (البادئة EMPLOYEE_PHOTOS
                                    تُضبط عند ربط المتجر بالمشروع).

   `@vercel/blob` يسقط إلى BLOB_READ_WRITE_TOKEN **تلقائيًا** حين لا يُمرَّر
   token — أي إلى المتجر العامّ. فالتوكن يُمرَّر صراحةً في كل نداء، وغيابه
   يُطفئ الميزة، ومطابقته لأحد التوكنين الآخرين خطأ إعداد يرمي.

   غياب التوكن هو الحالة الطبيعية خارج المعاينة: الإنتاج لا يحمله حتى
   يُعتمد، فلا تظهر صورة ويبقى الـPlaceholder — بلا خطأ. */

const { inspectPhoto, sha256hex } = require("./validate");
const manifest = require("./manifest");

const ENV_TOKEN = "EMPLOYEE_PHOTOS_READ_WRITE_TOKEN";
const KEY_RE = /^employee-photos\/[0-9a-f]{32}$/;
const ID_RE = /^[0-9a-f]{16}$/;
/* سقف قراءة من المتجر: أكبر من حدّ الرفع بقليل؛ ما يتجاوزه ليس صورتنا. */
const READ_CAP = 2 * 1024 * 1024 + 1;

function configured() {
  return !!process.env[ENV_TOKEN];
}

function token() {
  const t = process.env[ENV_TOKEN];
  if (!t) throw new Error("متجر صور الموظفين غير مُهيّأ");
  if (t === process.env.BLOB_READ_WRITE_TOKEN) throw new Error("توكن الصور يطابق توكن متجر أجير العامّ");
  if (t === process.env.DROUA_BLOB_READ_WRITE_TOKEN) throw new Error("توكن الصور يطابق توكن متجر قسم المراجعة");
  return t;
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
async function readPhoto(entry) {
  if (!entry || !KEY_RE.test(entry.storageKey)) throw new Error("مدخل صورة غير صالح");
  const res = await blobApi().get(entry.storageKey, { access: "private", token: token() });
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
async function putPhoto(entry, bytes) {
  if (!entry || !KEY_RE.test(entry.storageKey)) throw new Error("مدخل صورة غير صالح");
  const info = inspectPhoto(bytes);
  if (info.sha256 !== entry.sha256) throw new Error("الملفّ لا يطابق بصمة الـmanifest");
  const result = await blobApi().put(entry.storageKey, bytes, {
    access: "private",
    contentType: "application/octet-stream",
    addRandomSuffix: false,
    allowOverwrite: true,
    token: token(),
  });
  const stored = String((result && result.pathname) || "").replace(/^\//, "");
  if (stored !== entry.storageKey) throw new Error("المتجر أعاد تسمية الكائن");
  return result;
}

module.exports = { configured, entryById, readPhoto, putPhoto, ENV_TOKEN, KEY_RE, ID_RE };
