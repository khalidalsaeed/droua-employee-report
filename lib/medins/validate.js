/* ─── مدقّقات المدخلات ─────────────────────────────────────────────────
   =========================================================================
   مبدآن:

   ① **قائمة مسموح لكل مسار**: حقلٌ لا يعرفه المسار يُرفض باسمه، وحقلٌ لا
     يُقبل من العميل أبدًا (المعرّفات، والحالة، والمشتقّ، وكل ما يخصّ
     التخزين) يُرفض باسمه أيضًا — برسالة تقول ما الخطأ، واختبار يفشل بوضوح
     يوم يوسّع أحدهم المدخلات بلا انتباه.

   ② **الغياب ليس صفرًا**: حقلٌ رقميّ فارغ يصير null (غير معروف)، ولا
     يتحوّل إلى 0 أبدًا. والصفر المُرسَل صراحةً قيمةٌ صحيحة. */

const { UUID_RE } = require("../secure-kit/identifiers");
const { MONEY_MAX } = require("./limits");

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = "MedinsApiError";
    this.status = status;
    this.extra = extra || null;
  }
}
const bad = (message, extra) => new ApiError(400, message, extra);

/* ما لا يُقبل من أي طلب في الوحدة، مذكورًا بالاسم. */
const CLIENT_FORBIDDEN = Object.freeze([
  "id", "createdBy", "created_by", "createdAt", "created_at", "updatedAt", "updated_at", "updatedBy", "updated_by",
  "approvedAt", "approved_at", "approvedBy", "approved_by", "premiumPerHead", "premium_per_head",
  "verifiedAt", "verified_at", "verifiedBy", "verified_by", "archivedAt", "archived_at",
  "blobPathname", "blob_pathname", "pathname", "encIv", "enc_iv", "encTag", "enc_tag",
  "encKeyId", "enc_key_id", "encAlgo", "enc_algo", "contentType", "content_type",
  "partCount", "part_count", "plaintextSha256", "plaintext_sha256", "status_", "purgedAt", "deletedAt",
  "entryMethod", "entry_method", "userId", "user_id", "role",
]);

function pick(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("طلبٌ غير صالح");
  for (const key of Object.keys(body)) {
    if (CLIENT_FORBIDDEN.includes(key) && !allowed.includes(key)) throw bad(`حقل لا يُقبل من الطلب: ${key}`);
    if (!allowed.includes(key)) throw bad(`حقل غير معروف: ${key}`);
  }
  return body;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/* نصٌّ يُنقّى من محارف التحكّم وقلب الاتجاه — لا يُرفض بسببها، فهي لا
   تُكتب عمدًا إلا للخداع. */
function cleanText(v) {
  return String(v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "")
    .trim();
}

function text(v, { label, max, required = false, multiline = false }) {
  if (isBlank(v)) {
    if (required) throw bad(`${label} مطلوب`);
    return null;
  }
  if (typeof v !== "string" && typeof v !== "number") throw bad(`${label} غير صالح`);
  let s = cleanText(v);
  if (!multiline) s = s.replace(/[\r\n\t]+/g, " ");
  if (!s) {
    if (required) throw bad(`${label} مطلوب`);
    return null;
  }
  if (s.length > max) throw bad(`${label} أطول من ${max} حرفًا`);
  return s;
}

function int(v, { label, min, max }) {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} يجب أن يكون عددًا صحيحًا بين ${min} و${max}`);
  return n;
}

/* مبلغٌ بخانتين عشريّتين على الأكثر. يُعاد نصًّا كي لا يمرّ بتقريب عشريّ. */
function money(v, { label, max = MONEY_MAX }) {
  if (isBlank(v)) return null;
  const s = typeof v === "number" ? String(v) : String(v).trim().replace(/,/g, "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) throw bad(`${label} يجب أن يكون مبلغًا موجبًا بخانتين عشريّتين على الأكثر`);
  if (Number(s) > max) throw bad(`${label} خارج الحدّ`);
  return s;
}

function percent(v, { label }) {
  if (isBlank(v)) return null;
  const s = typeof v === "number" ? String(v) : String(v).trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s) || Number(s) > 100) throw bad(`${label} يجب أن تكون نسبة بين 0 و100`);
  return s;
}

function date(v, { label }) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw bad(`${label} يجب أن يكون تاريخًا بصيغة YYYY-MM-DD`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw bad(`${label} تاريخ غير موجود`);
  }
  if (+m[1] < 2000 || +m[1] > 2100) throw bad(`${label} خارج النطاق`);
  return s;
}

function oneOf(v, values, { label, required = true }) {
  if (isBlank(v)) {
    if (required) throw bad(`${label} مطلوب`);
    return null;
  }
  const s = String(v);
  if (!values.includes(s)) throw bad(`${label} غير مسموح`);
  return s;
}

function bool(v, { label }) {
  if (v === true || v === false) return v;
  throw bad(`${label} يجب أن تكون نعم/لا`);
}

function uuid(v, { label, required = true }) {
  if (isBlank(v)) {
    if (required) throw bad(`${label} مطلوب`);
    return null;
  }
  if (typeof v !== "string" || !UUID_RE.test(v)) throw bad(`${label} غير صالح`);
  return v.toLowerCase();
}

function coordinate(v, { label, min, max }) {
  if (isBlank(v)) throw bad(`${label} مطلوب`);
  const s = typeof v === "number" ? String(v) : String(v).trim();
  if (!/^-?\d{1,3}(\.\d{1,6})?$/.test(s)) throw bad(`${label} يجب أن يكون رقمًا بست خانات عشريّة على الأكثر`);
  const n = Number(s);
  if (n < min || n > max) throw bad(`${label} خارج النطاق`);
  return s;
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const dateOut = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

module.exports = {
  ApiError, bad, pick, has, isBlank, cleanText, CLIENT_FORBIDDEN,
  text, int, money, percent, date, oneOf, bool, uuid, coordinate,
  iso, num, dateOut,
};
