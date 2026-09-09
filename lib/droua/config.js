/* ─── إعداد بوابة القسم — يُقرأ ويُتحقّق منه في مكان واحد ───────────────
   =========================================================================
   تُحمَّل الإعدادات كلّها هنا، ويُرفض الإعداد الناقص أو التالف **قبل** أن
   يبلغ أي منطق آخر. سبب هذا التمركز أمنيّ لا تنظيميّ:

   لو فُحصت صيغة الهاش عند التحقّق من كلمة المرور — كما يبدو طبيعيًا —
   لأنتج الإعدادُ التالف فشلًا **مميّزًا** عند الفتح: صفحةٌ تُعرض ثم فشلٌ
   دائم. وذلك يُخبر من بلغها أن هناك قسمًا موجودًا ومعطّلًا. أمّا الفحص هنا
   فيجعل الإعداد الناقص أو التالف يُخفي القسم كلَّه بـ404 — لا يميّزه أحد
   عن مسار غير موجود.

   والقراءة عند كل نداء لا عند تحميل الوحدة: بلا ذلك يتجمّد الإعداد على ما
   كان وقت أول require، فيعمى أي اختبار ينتقل بين حالتَي ضبط. */

const protectedUsers = require("../auth/protectedUsers");

/* الحدّ الأدنى لطول سرّ التوقيع. 32 محرفًا = 128 بت على الأقلّ بترميز hex. */
const MIN_SECRET_LENGTH = 32;

function splitList(raw) {
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/* الصيغة: scrypt$<log2N>$<r>$<p>$<salt-hex>$<hash-hex>
   مكتفية ذاتيًا عمدًا — تحمل الخوارزمية ومعاملات الاشتقاق والـsalt والهاش
   معًا. فترقية المعاملات لاحقًا لا تُبطل هاشًا قديمًا: كل هاش يحمل معاملاته. */
function parseHash(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6) return null;
  const [scheme, logN, r, p, salt, hash] = parts;
  if (scheme !== "scrypt") return null;
  const nums = { logN: Number(logN), r: Number(r), p: Number(p) };
  if (!Number.isInteger(nums.logN) || nums.logN < 12 || nums.logN > 20) return null;
  if (!Number.isInteger(nums.r) || nums.r < 1 || nums.r > 32) return null;
  if (!Number.isInteger(nums.p) || nums.p < 1 || nums.p > 16) return null;
  if (!/^[0-9a-f]{16,}$/i.test(salt) || !/^[0-9a-f]{32,}$/i.test(hash)) return null;
  if (salt.length % 2 || hash.length % 2) return null;
  return { ...nums, salt, hash };
}

/* يُرجع كائن الإعداد، أو null إن اختلّ شرطٌ واحد. المُنادي يترجم null إلى
   404 — لا إلى رسالة خطأ تشرح ما الناقص. */
function load() {
  const userIds = splitList(process.env.DROUA_AUDIT_USER_IDS);
  const emails = splitList(process.env.DROUA_AUDIT_EMAILS).map((e) => e.toLowerCase());
  const secret = String(process.env.DROUA_GATE_SECRET || "");
  const passwordHash = parseHash(process.env.DROUA_AUDIT_GATE_PASSWORD_HASH);

  if (!userIds.length || !emails.length) return null;
  if (secret.length < MIN_SECRET_LENGTH) return null;
  if (!passwordHash) return null;

  /* الشرط الثاني: كل مصرَّح له يجب أن يكون محميًّا أيضًا.
     حماية الحساب وحدها لا تمنح وصولًا، ونزعُها يقفل القسم ولا يكشفه. */
  if (!protectedUsers.isConfigured()) return null;
  if (!userIds.every((id) => protectedUsers.isProtected(id))) return null;

  return {
    userIds,
    emails,
    secret,
    passwordHash,
    /* اختياريّ. غيابه يعني اشتقاقًا بلا فلفل — يعمل، ويكلّف مقاومةَ الهجوم
       على الهاش المسرَّب وحدها. */
    pepper: String(process.env.DROUA_AUDIT_GATE_PEPPER || ""),
  };
}

module.exports = { load, parseHash, splitList, MIN_SECRET_LENGTH };
