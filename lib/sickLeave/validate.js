/* ─── فحص ملفّ الإجازة المرضية قبل أي قراءة ───
   =========================================================================
   يُحكم على الملفّ من بايتاته لا من اسمه ولا من Content-Type الذي يرسله
   المتصفّح: التوقيع (magic bytes) هو النوع الحقيقي، والنوع المُعلَن يجب أن
   يتّفق معه وإلا يُرفض الملفّ. الاسم لا يُستعمل مسارًا إطلاقًا — لا كتابة
   على القرص ولا في أي متجر — ويُعقَّم للعرض فقط.

   الحدود هنا مقصودة صغيرة: تقرير الإجازة صفحة أو صفحتان بحجم كيلوبايتات.
   ما فوقها ليس إجازة مرضية، فرفضه مبكرًا يحمي الدالّة من ملفّات مُفخَّخة. */

const LIMITS = {
  maxBytes: 4 * 1024 * 1024, // تحت حدّ Vercel لجسم الطلب (4.5MB) كي يصل خطأ واضح لا 413
  minBytes: 64,
  maxNameLength: 120,
};

const SIGNATURES = [
  { kind: "pdf", mime: "application/pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { kind: "png", mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: "jpeg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

/* ما يُقبل إعلانه لكل نوع. application/octet-stream مقبول لأن بعض المتصفّحات
   ترسله لملفّات بلا امتداد معروف — والتوقيع هو الحَكَم في كل الأحوال. */
const DECLARED_OK = {
  pdf: ["application/pdf", "application/x-pdf"],
  png: ["image/png"],
  jpeg: ["image/jpeg", "image/jpg", "image/pjpeg"],
};

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  return SIGNATURES.find((s) => s.test(buf)) || null;
}

/* اسم للعرض فقط: بلا مسارات ولا محارف تحكّم، بطول محدود. */
function displayName(raw) {
  let name = "";
  try { name = decodeURIComponent(String(raw || "")); } catch { name = String(raw || ""); }
  name = name.split(/[\\/]/).pop() || "";
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/^\.+/, "").trim();
  if (name.length > LIMITS.maxNameLength) name = name.slice(0, LIMITS.maxNameLength);
  return name || "ملف";
}

function validateUpload(buf, declaredType) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: "empty" };
  if (buf.length > LIMITS.maxBytes) return { ok: false, reason: "too_large" };
  if (buf.length < LIMITS.minBytes) return { ok: false, reason: "too_small" };
  const sig = sniff(buf);
  if (!sig) return { ok: false, reason: "unsupported_type" };
  const declared = String(declaredType || "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && !DECLARED_OK[sig.kind].includes(declared)) {
    return { ok: false, reason: "type_mismatch" };
  }
  if (sig.kind === "pdf") {
    /* ملفّ PDF مكتمل ينتهي بـ%%EOF في ذيله؛ غيابه يعني ملفًّا مقطوعًا أو تالفًا. */
    const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString("latin1");
    if (!tail.includes("%%EOF")) return { ok: false, reason: "malformed" };
  }
  return { ok: true, kind: sig.kind, mime: sig.mime };
}

module.exports = { validateUpload, displayName, sniff, LIMITS };
