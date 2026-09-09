#!/usr/bin/env node
/* فحص قدرة: هل يقبل متجر Vercel Blob عندنا access:'private' فعلًا؟
   =========================================================================
   يُشغَّل مرّة واحدة قبل بناء طبقة تخزين ملفّات القسم. الجواب يقرّر التصميم
   كلَّه، وتأجيل السؤال يعني احتمال إعادة بناء الطبقة بعد كتابتها.

   ⚠️ لا يلمس أي بيان حقيقيّ: يرفع ملفًّا نصّيًا تافهًا يولّده بنفسه تحت
   بادئة منفصلة (_capability-check/) ثم يحذفه — حتى عند الفشل.

   ولا يكتفي بأن put تقبل 'private': **الفحص الحاسم هو أن الرابط الناتج لا
   يُفتح بلا مصادقة.** متجرٌ يقبل الكلمة ثم يقدّم الملفّ لأي طالب ليس خاصًّا،
   وهذا بالضبط ما بُني القسم لتجنّبه.

   التشغيل:
     BLOB_READ_WRITE_TOKEN=... node scripts/check-blob-private.js

   على PowerShell (بلا أن يدخل التوكن تاريخ الصدفة):
     $s = Read-Host -AsSecureString
     $env:BLOB_READ_WRITE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
       [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
     node scripts/check-blob-private.js
*/

const crypto = require("crypto");
const { put, get, del } = require("@vercel/blob");

const PREFIX = "_capability-check";
const nonce = crypto.randomBytes(12).toString("hex");
const PATHNAME = `${PREFIX}/${Date.now()}-${nonce}.txt`;
/* محتوى تافه يُولَّد الآن — لا بيان، ولا شيء يخصّ الرواتب. */
const CONTENT = `capability check ${nonce}\n`;

const token = process.env.BLOB_READ_WRITE_TOKEN;

const results = [];
const step = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
};

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (!token) {
    console.error("BLOB_READ_WRITE_TOKEN غير مُهيّأ. صدّره أوّلًا.");
    process.exitCode = 1;
    return;
  }
  console.log(`\nفحص قدرة Private Blob — ملفّ اختباريّ تافه تحت ${PREFIX}/\n`);

  let blob = null;
  let privateSupported = false;

  try {
    /* ①  الرفع بـprivate */
    try {
      blob = await put(PATHNAME, CONTENT, {
        access: "private",
        contentType: "text/plain",
        addRandomSuffix: false,
        token,
      });
      privateSupported = true;
      step("put(access:'private') مقبول", true);
    } catch (err) {
      step("put(access:'private') مقبول", false, `${err.name}: ${err.message}`);
      console.log("\n  ⇒ المتجر لا يدعم الرفع الخاصّ. لا داعي لبقية الخطوات.\n");
      return;
    }

    /* ②  القراءة بالتوكن — يجب أن تُرجع المحتوى نفسه */
    try {
      const res = await get(blob.pathname, { access: "private", token });
      const body = res && res.stream ? await readStream(res.stream) : null;
      step("get(access:'private') يُرجع المحتوى نفسه", body === CONTENT,
        body === CONTENT ? undefined : `المُستلَم ${JSON.stringify(String(body).slice(0, 40))}`);
    } catch (err) {
      step("get(access:'private') يُرجع المحتوى نفسه", false, `${err.name}: ${err.message}`);
    }

    /* ③  الفحص الحاسم: الرابط بلا مصادقة يجب ألّا يُقدّم الملفّ */
    try {
      const r = await fetch(blob.url);
      const body = r.ok ? await r.text() : "";
      const leaked = r.ok && body === CONTENT;
      step("الرابط بلا مصادقة لا يُقدّم الملفّ", !leaked,
        leaked ? `⚠️ HTTP ${r.status} وأعاد المحتوى كاملًا — ليس خاصًّا` : `HTTP ${r.status}`);
    } catch (err) {
      /* رفضٌ على مستوى الشبكة نتيجة مقبولة أيضًا. */
      step("الرابط بلا مصادقة لا يُقدّم الملفّ", true, `الطلب رُفض: ${err.message.slice(0, 60)}`);
    }

    /* ④  والرابط المُنزَّل كذلك، إن اختلف */
    if (blob.downloadUrl && blob.downloadUrl !== blob.url) {
      try {
        const r = await fetch(blob.downloadUrl);
        const body = r.ok ? await r.text() : "";
        const leaked = r.ok && body === CONTENT;
        step("downloadUrl بلا مصادقة لا يُقدّم الملفّ", !leaked, `HTTP ${r.status}`);
      } catch (err) {
        step("downloadUrl بلا مصادقة لا يُقدّم الملفّ", true, "الطلب رُفض");
      }
    }
  } finally {
    /* ⑤  التنظيف — يقع دائمًا، حتى لو فشل ما قبله. */
    if (blob) {
      try {
        await del(blob.url, { token });
        step("del — لم يبقَ أثر", true);
      } catch (err) {
        step("del — لم يبقَ أثر", false,
          `${err.message} · احذفه يدويًا: ${PATHNAME}`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n  الحكم: ${privateSupported && failed.length === 0
      ? "Private Blob مدعوم ويعمل كما يجب ✅"
      : "راجع الإخفاقات أعلاه ❌"}\n`
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nفشل الفحص:", (err && err.message) || err);
  console.error(`قد يكون بقي ملفّ اختباريّ — احذفه إن وُجد: ${PATHNAME}`);
  process.exitCode = 1;
});
