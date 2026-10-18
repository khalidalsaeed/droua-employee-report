const test = require("node:test");
const assert = require("node:assert/strict");

const DashFx = require("../dashboard-fx.js");

/* صياغات التلميح. قسم الوثائق القادمة على الانتهاء في doc-expiry.test.js. */
test("صياغات العدد العربية", () => {
  assert.equal(DashFx.employeesPhrase(1), "موظف واحد");
  assert.equal(DashFx.employeesPhrase(2), "موظفان");
  assert.equal(DashFx.employeesPhrase(4), "4 موظفين");
  assert.equal(DashFx.employeesPhrase(12), "12 موظفًا");
  assert.equal(DashFx.daysPhrase(0), "تنتهي اليوم");
  assert.equal(DashFx.daysPhrase(-2), "منتهية منذ يومين");
  assert.equal(DashFx.daysPhrase(2), "متبقٍّ يومان");
  assert.equal(DashFx.daysPhrase(16), "متبقٍّ 16 يومًا");
});
