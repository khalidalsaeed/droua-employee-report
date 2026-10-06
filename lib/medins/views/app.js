/* صفحة الوحدة بعد فتح البوابة. الدور يُمرَّر سمةً للعرض فقط — الخادم يفرض
   الصلاحية في كل مسار بمعزلٍ عمّا تُظهره الواجهة. */
const { page } = require("./layout");
const { appClient } = require("./client");

const ROLES = new Set(["editor", "viewer"]);

module.exports = (nonce, { role }) => page({
  nonce,
  title: "المقارنة",
  body: '<div class="wrap"><main id="app"></main></div>',
  script: `(${appClient.toString()})();`,
  attrs: ` data-role="${ROLES.has(role) ? role : "viewer"}"`,
});
