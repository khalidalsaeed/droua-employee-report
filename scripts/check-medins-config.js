#!/usr/bin/env node
/* فحص إعداد الوحدة محلّيًا — يطبع **أسماء** الشروط ونتيجتها، لا القيم.
   =========================================================================
   الإعداد الناقص يظهر عبر HTTP 404 صامتًا للجميع (عمدًا: لا يُكشف أن هنا
   قسمًا معطّلًا). فهذا السكربت هو الطريق الوحيد لمعرفة السبب: يُشغَّل على
   جهازك بعد سحب متغيّرات البيئة (vercel env pull)، ولا يتّصل بأي شبكة. */

const config = require("../lib/medins/config");

function storageChecks(env = process.env) {
  const security = require("../lib/medins/security");
  const token = env[config.ENV.BLOB_TOKEN];
  let ringOk = false;
  try { security.keyring.load(); ringOk = true; } catch (err) { ringOk = false; }
  let shared = true;
  try { shared = config.FOREIGN_KEY_PREFIXES.some((p) => security.keyring.sharesMaterialWith(p)); } catch (err) { shared = true; }
  return [
    ["blob_token_present", Boolean(token)],
    ["blob_token_distinct", Boolean(token) && !config.FOREIGN_BLOB_TOKENS.some((n) => env[n] && env[n] === token)],
    ["file_keyring_valid", ringOk],
    ["file_keys_not_shared_with_other_modules", ringOk && !shared],
  ];
}

if (require.main === module) {
  const gate = config.checks().results;
  const storage = storageChecks();
  let failed = 0;
  console.log("— البوابة (إلزاميّ: أيّ فشل يُخفي الوحدة بـ404) —");
  for (const [name, ok] of gate) { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) failed += 1; }
  console.log("\n— التخزين الخاصّ (إلزاميّ للملفّات فقط) —");
  for (const [name, ok] of storage) { console.log(`${ok ? "✓" : "✗"} ${name}`); if (!ok) failed += 1; }
  console.log("\nملاحظة: العضويّة والأدوار في medins_members لا في البيئة — scripts/medins-members.js list");
  process.exitCode = failed ? 1 : 0;
}

module.exports = { storageChecks };
