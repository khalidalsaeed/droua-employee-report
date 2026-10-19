/* فحص ملفّ صورة الموظف — من البايتات لا من الاسم.
   =========================================================================
   النوع يُقرأ من توقيع الملفّ نفسه (magic bytes)، ثم يُطابَق مع ما أعلنه
   المُرسِل ومع امتداد الاسم. اسم الملفّ لا يقرّر النوع أبدًا: وظيفته
   الوحيدة في هذه الميزة مطابقة الموظف (lib/photos/match.js).

   ولا يكتفي بالتوقيع: يقرأ الأبعاد من ترويسة الصيغة. ملفٌّ مبتور أو تالف
   يحمل توقيعًا صحيحًا ثم لا ترويسة بعده، فيُرفض هنا لا في المتصفّح.

   بلا مكتبات: ثلاث صيغ فقط، وترويساتها ثابتة وموثّقة. */

const crypto = require("crypto");

/* صورة Avatar لا تحتاج أكثر من هذا؛ الصور المعتمدة الحالية بين 13 و32 KB. */
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_BYTES = 64;
const MAX_SIDE = 4096;

const TYPES = Object.freeze({
  "image/jpeg": { exts: ["jpg", "jpeg"] },
  "image/png": { exts: ["png"] },
  "image/webp": { exts: ["webp"] },
});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "image/png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function pngSize(buf) {
  /* IHDR يجب أن يكون أول مقطع مباشرة بعد التوقيع. */
  if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  /* نمشي على المقاطع حتى أول SOFn — ترويسة الإطار التي تحمل الأبعاد. */
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // حشو
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // نهاية أو بيانات قبل أي إطار
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (len < 7) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8 ") {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  return null;
}

/* ملفّ كامل لا ترويسة فقط: JPEG ينتهي بـEOI، وPNG بمقطع IEND. ملفٌّ قُطع
   أثناء النسخ يجتاز التوقيع والترويسة ثم يظهر نصفه رماديًا. */
function looksComplete(buf, mime) {
  if (mime === "image/jpeg") {
    const tail = buf.subarray(Math.max(0, buf.length - 16));
    return tail.includes(Buffer.from([0xff, 0xd9]));
  }
  if (mime === "image/png") return buf.length >= 12 && buf.toString("latin1", buf.length - 8, buf.length - 4) === "IEND";
  if (mime === "image/webp") return buf.readUInt32LE(4) + 8 === buf.length;
  return false;
}

const SIZE_OF = { "image/jpeg": jpegSize, "image/png": pngSize, "image/webp": webpSize };

const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function extOf(fileName) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(fileName || ""));
  return m ? m[1].toLowerCase() : null;
}

/* يرمي برسالة مفهومة عند أي مخالفة؛ ويُرجع وصف الملفّ عند السلامة.
   declaredMime و fileName اختياريّان: إن وُجدا وجب أن يتّفقا مع التوقيع. */
function inspectPhoto(bytes, { declaredMime, fileName } = {}) {
  if (!Buffer.isBuffer(bytes)) throw new Error("الصورة يجب أن تكون Buffer");
  if (bytes.length < MIN_BYTES) throw new Error("ملفّ الصورة فارغ أو تالف");
  if (bytes.length > MAX_BYTES) throw new Error("حجم الصورة يتجاوز الحدّ المسموح (2MB)");

  const mime = sniffMime(bytes);
  if (!mime) throw new Error("الملفّ ليس صورة JPEG أو PNG أو WebP");
  if (declaredMime && String(declaredMime).toLowerCase() !== mime) {
    throw new Error(`نوع الملفّ المُعلن (${declaredMime}) لا يطابق محتواه (${mime})`);
  }
  const ext = fileName != null ? extOf(fileName) : null;
  if (fileName != null && !TYPES[mime].exts.includes(ext)) {
    throw new Error(`امتداد الملفّ (${ext || "بلا امتداد"}) لا يطابق محتواه (${mime})`);
  }

  const size = SIZE_OF[mime](bytes);
  if (!size || !size.width || !size.height) throw new Error("ترويسة الصورة تالفة");
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) throw new Error("أبعاد الصورة أكبر من المسموح");
  if (!looksComplete(bytes, mime)) throw new Error("ملفّ الصورة مبتور");

  return { mime, bytes: bytes.length, width: size.width, height: size.height, sha256: sha256hex(bytes) };
}

/* التكرار بالبصمة لا بالاسم: الصورة نفسها باسمين تُكشف، وصورتان مختلفتان
   بالاسم نفسه لا تُعدّان تكرارًا. يُرجع أزواج الفهارس المكرّرة. */
function findDuplicates(items) {
  const seen = new Map();
  const dups = [];
  items.forEach((it, i) => {
    if (seen.has(it.sha256)) dups.push([seen.get(it.sha256), i]);
    else seen.set(it.sha256, i);
  });
  return dups;
}

module.exports = { inspectPhoto, findDuplicates, sniffMime, sha256hex, MAX_BYTES, TYPES };
