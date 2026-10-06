/* ─── إعداد الوحدة: يُقرأ عند كل نداء، ويُرفض الناقص قبل أي منطق ──────────
   =========================================================================
   أيّ خللٍ هنا يُرجع null، والموجّه يترجمه إلى 404 لكل مستخدم بلا استثناء.
   فالإعداد الناقص لا يُنتج «صفحة تفتح ثم تفشل» تخبر من بلغها أن هنا قسمًا
   معطّلًا. وسبب الخلل يُعرف محلّيًا فقط: scripts/check-medins-config.js
   يطبع **أسماء** الشروط الفاشلة لا قيمها.

   ── ما ليس هنا عمدًا: من هم الأعضاء ──
   الهويّة الأساسية (الحساب المحميّ) تبقى آليّة المنصّة كما هي:
   PROTECTED_USER_IDS. أمّا **عضويّة الوحدة ودور العضو فيها** فصفوفٌ في
   medins_members — تُمنح وتُعطَّل ويتغيّر دورها بلا تعديل متغيّرات Vercel
   ولا إعادة نشر ولا مساسٍ بالحساب الأساسيّ أو كلمة مروره. */

const protectedUsers = require("../auth/protectedUsers");
const { boundedInt, distinctSecret, MIN_SECRET_LENGTH } = require("../secure-kit/config");
const limits = require("./limits");

const ENV = Object.freeze({
  SECRET: "MEDINS_GATE_SECRET",
  PEPPER: "MEDINS_GATE_PEPPER",
  IDLE: "MEDINS_GATE_IDLE_MINUTES",
  ABSOLUTE: "MEDINS_GATE_ABSOLUTE_MINUTES",
  BLOB_TOKEN: "MEDINS_BLOB_READ_WRITE_TOKEN",
  KEY_PREFIX: "MEDINS_FILE_KEY_",
  ACTIVE_KEY: "MEDINS_FILE_ACTIVE_KEY_ID",
});

/* أسرارٌ لا يجوز أن يساويها سرّ الوحدة: تسريب أحدها يجب ألّا يفتح غيره. */
const FOREIGN_SECRETS = Object.freeze(["SESSION_SECRET", "DROUA_GATE_SECRET", "CRON_SECRET"]);
/* متاجر لا يجوز أن يساويها توكن متجر الوحدة. */
const FOREIGN_BLOB_TOKENS = Object.freeze(["BLOB_READ_WRITE_TOKEN", "DROUA_BLOB_READ_WRITE_TOKEN"]);
/* حلقة مفاتيح لا يجوز أن تشاركها مادّة. */
const FOREIGN_KEY_PREFIXES = Object.freeze(["DROUA_FILE_KEY_"]);

/* كل شرطٍ باسمٍ ثابت — يُطبع اسمه محلّيًا عند الفشل، ولا تُطبع قيمة. */
function checks(env = process.env) {
  const foreign = FOREIGN_SECRETS.map((n) => env[n]).filter(Boolean);
  const secret = distinctSecret(env[ENV.SECRET], foreign);
  const pepper = distinctSecret(env[ENV.PEPPER], [...foreign, env[ENV.SECRET]]);
  const idle = boundedInt(env[ENV.IDLE], limits.SESSION.IDLE_MINUTES);
  const absolute = boundedInt(env[ENV.ABSOLUTE], limits.SESSION.ABSOLUTE_MINUTES);
  return {
    values: { secret, pepper, idle, absolute },
    results: [
      ["gate_secret_present_and_long", String(env[ENV.SECRET] || "").length >= MIN_SECRET_LENGTH],
      ["gate_secret_distinct", Boolean(secret)],
      ["gate_pepper_present_and_distinct", Boolean(pepper)],
      ["idle_minutes_in_range", idle !== null],
      ["absolute_minutes_in_range", absolute !== null],
      ["absolute_not_shorter_than_idle", idle !== null && absolute !== null && absolute >= idle],
      ["protected_users_configured", protectedUsers.isConfigured()],
    ],
  };
}

function load() {
  const { values, results } = checks();
  if (results.some(([, ok]) => !ok)) return null;
  return {
    secret: values.secret,
    pepper: values.pepper,
    idleMs: values.idle * 60 * 1000,
    absoluteMs: values.absolute * 60 * 1000,
  };
}

module.exports = { load, checks, ENV, FOREIGN_SECRETS, FOREIGN_BLOB_TOKENS, FOREIGN_KEY_PREFIXES };
