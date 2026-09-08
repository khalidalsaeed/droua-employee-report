/* ─── كلمة مرور البوابة — اشتقاق وتحقّق ثابت الزمن ────────────────────
   =========================================================================
   كلمة المرور لا توجد في أي مكان: لا في الشيفرة، ولا في Git، ولا في قاعدة
   البيانات، ولا في متغيّرات البيئة. الموجود في البيئة هو ناتج اشتقاقها.

   الفلفل (pepper) يُدمج قبل الاشتقاق: من يسرّب الهاش وحده — لقطة شاشة،
   نسخة قديمة من متغيّرات البيئة — لا يستطيع مهاجمته دون الفلفل أيضًا. */

const crypto = require("crypto");

/* مدخل أطول من هذا لا يُشتقّ منه شيء: يُعامل فشلًا عاديًا بلا حساب.
   الغرض منع استهلاك المعالج بمدخل ضخم — و HMAC على عشرة ميغابايت مكلف
   وإن كان scrypt لا يتأثّر بالطول. */
const MAX_INPUT_LENGTH = 256;

const KEY_LENGTH = 64;
const MAX_MEMORY = 256 * 1024 * 1024;

/* يُرجع صحيحًا/خطأً فقط. لا يرمي، ولا يفرّق في مخرجه بين «خاطئة» و«مدخل
   غير صالح» — التمييز هو ما يُبنى عليه هجومُ استكشاف. */
function verify(input, parsedHash, pepper) {
  if (!parsedHash) return false;
  if (typeof input !== "string" || !input.length || input.length > MAX_INPUT_LENGTH) return false;

  let candidate;
  try {
    const peppered = crypto.createHmac("sha256", String(pepper || "")).update(input, "utf8").digest();
    candidate = crypto.scryptSync(peppered, Buffer.from(parsedHash.salt, "hex"), KEY_LENGTH, {
      N: 1 << parsedHash.logN,
      r: parsedHash.r,
      p: parsedHash.p,
      maxmem: MAX_MEMORY,
    });
  } catch (err) {
    /* معاملات مرفوضة من libsodium/openssl أو ذاكرة غير كافية. لا تفصيل
       يخرج إلى المُنادي — الفشل فشل. */
    return false;
  }

  const expected = Buffer.from(parsedHash.hash, "hex");
  /* الطول يُقارن أولًا لأن timingSafeEqual يرمي على طولين مختلفين. وهو
     ليس تسريبًا: طول الهاش المخزَّن ثابت ومعروف من الصيغة أصلًا. */
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/* يُستعمل في scripts/hash-gate-password.js وفي الاختبارات — لا في مسار
   الطلب: الخادم يتحقّق ولا يشتقّ هاشًا جديدًا أبدًا. */
function derive(password, { logN = 17, r = 8, p = 1, pepper = "", salt } = {}) {
  const saltHex = salt || crypto.randomBytes(16).toString("hex");
  const peppered = crypto.createHmac("sha256", String(pepper || "")).update(password, "utf8").digest();
  const hash = crypto.scryptSync(peppered, Buffer.from(saltHex, "hex"), KEY_LENGTH, {
    N: 1 << logN, r, p, maxmem: MAX_MEMORY,
  });
  return `scrypt$${logN}$${r}$${p}$${saltHex}$${hash.toString("hex")}`;
}

module.exports = { verify, derive, MAX_INPUT_LENGTH };
