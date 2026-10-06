/* ─── كلمة مرور البوابة: اشتقاق وتحقّق ثابت الزمن ─────────────────────
   =========================================================================
   الصيغة: scrypt$<log2N>$<r>$<p>$<salt-hex>$<hash-hex>
   مكتفية ذاتيًا — تحمل معاملاتها، فترقيتها لاحقًا لا تُبطل هاشًا قديمًا.

   الفلفل يُدمج قبل الاشتقاق: من يسرّب الهاش وحده لا يهاجمه بلا الفلفل.

   السلوك مطابق لـlib/droua/gatePassword.js و lib/droua/config.js:parseHash
   — والتكافؤ مُثبَت باختبار، فالهاش الذي يولّده scripts/hash-gate-password.js
   صالحٌ هنا كما هو. */

const crypto = require("crypto");

const MAX_INPUT_LENGTH = 256;
const KEY_LENGTH = 64;
const MAX_MEMORY = 256 * 1024 * 1024;

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

/* صحيحٌ أو خطأ فقط — لا يرمي، ولا يفرّق بين «خاطئة» و«مدخل غير صالح». */
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
    return false;
  }

  const expected = Buffer.from(parsedHash.hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/* للسكربتات والاختبارات — لا لمسار الطلب. */
function derive(password, { logN = 17, r = 8, p = 1, pepper = "", salt } = {}) {
  const saltHex = salt || crypto.randomBytes(16).toString("hex");
  const peppered = crypto.createHmac("sha256", String(pepper || "")).update(password, "utf8").digest();
  const hash = crypto.scryptSync(peppered, Buffer.from(saltHex, "hex"), KEY_LENGTH, {
    N: 1 << logN, r, p, maxmem: MAX_MEMORY,
  });
  return `scrypt$${logN}$${r}$${p}$${saltHex}$${hash.toString("hex")}`;
}

/* هاشٌ صالح الصيغة لا يطابق أي كلمة: يُستعمل حين لا هاش للعضو، فيُنفَّذ
   الاشتقاق نفسه ويبقى زمن الفشل واحدًا. يُولَّد مرّة لكل نسخة دالّة. */
let dummy = null;
function dummyHash() {
  if (!dummy) {
    dummy = parseHash(`scrypt$17$8$1$${crypto.randomBytes(16).toString("hex")}$${crypto.randomBytes(64).toString("hex")}`);
  }
  return dummy;
}

module.exports = { verify, derive, parseHash, dummyHash, MAX_INPUT_LENGTH };
