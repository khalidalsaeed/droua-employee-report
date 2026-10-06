/* ─── طبقة الأمن المشتركة للوحدات السرّية ──────────────────────────────
   =========================================================================
   أدواتٌ عامّة بلا اسم وحدة ولا متغيّر بيئة مضمَّن: كل وحدة تنشئ نُسخها
   بجداولها وأسرارها وكوكيها وأدوارها. فيبقى الفصل بين الوحدات تامًّا في
   البيانات والأسرار، بينما يُكتب المنطق الأمنيّ مرّة واحدة ويُصلَح مرّة.

   ── العلاقة بـlib/droua ──
   Droua لا يستعمل هذه الطبقة بعد، ولم يتغيّر فيه سطر. والطبقة مقيَّدة به
   آليًا: test/secure-kit-parity.test.js يشغّلها بإعداد Droua ويقارنها
   بوحداته بايتًا ببايت (التوكن، الاشتقاق، نصوص SQL، التشفير). فإصلاحٌ في
   أحدهما بلا الآخر يُسقط الاختبار. ونقل Droua إليها تاسكٌ مستقلّ لاحق،
   مواصفته هي ذلك الاختبار نفسه. */

module.exports = {
  identifiers: require("./identifiers"),
  token: require("./token"),
  password: require("./password"),
  config: require("./config"),
  sessions: require("./sessions"),
  rateLimit: require("./rateLimit"),
  audit: require("./audit"),
  context: require("./context"),
  http: require("./http"),
  keyring: require("./keyring"),
  store: require("./store"),
  authz: require("./authz"),
  gate: require("./gate"),
};
