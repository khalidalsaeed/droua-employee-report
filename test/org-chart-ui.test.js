const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const js = read("org-chart.js");
const css = read("org-chart.css");

/* واجهة الهيكل: فحوص ثابتة لما لا يقيسه اختبار DOM هنا — القراءة المحضة،
   وحدود التكبير، وأن الحوم ليس الطريق الوحيد إلى أي معلومة. */

test("قراءة محضة: نداء شبكة واحد، GET لمورد الهيكل", () => {
  const calls = [...js.matchAll(/AdminUI\.api\(\s*"(\w+)",\s*"([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(calls, ["GET /api/data/org-structure"]);
  assert.doesNotMatch(js, /fetch\(|localStorage|sessionStorage/);
});

test("التكبير محصور بين 50% و160%", () => {
  assert.match(js, /ZOOM_MIN = 0\.5, ZOOM_MAX = 1\.6/);
  assert.match(js, /Math\.min\(ZOOM_MAX, Math\.max\(ZOOM_MIN, z\)\)/);
});

test("وسائل التكبير والتحريك كلها موصولة", () => {
  for (const z of ["in", "out", "fit", "reset"]) assert.match(js, new RegExp(`data-z="${z}"`));
  assert.match(js, /addEventListener\("wheel"/, "Ctrl + العجلة");
  assert.match(js, /ev\.key === "\+"/, "لوحة المفاتيح");
  assert.match(js, /pointerType !== "touch"/, "قرصة اللمس");
  assert.match(css, /touch-action:pan-x pan-y/, "التمرير بإصبع للمتصفّح، والقرصة للهيكل");
});

test("الحوم اختصار لا طريق وحيد: النقر يفتح اللوحة نفسها", () => {
  assert.match(js, /addEventListener\("click", \(\) => \{ hidePop\(\); select\(b\.dataset\.select\); \}\)/);
  assert.match(js, /canHover\(\)/, "المعاينة مقصورة على مؤشّر دقيق يحوم");
  assert.match(css, /\.oc-pop\{[^}]*pointer-events:none/, "المعاينة لا تحجب النقر");
});

test("السحب لا يفتح بطاقة انتهى فوقها", () => {
  assert.match(js, /if \(dragged\) \{ ev\.stopPropagation\(\); ev\.preventDefault\(\);/);
});
