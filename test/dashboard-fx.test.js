const test = require("node:test");
const assert = require("node:assert/strict");

const DocStatus = require("../doc-status.js");
const DashFx = require("../dashboard-fx.js");
const { F } = DocStatus;

/* الشريط الزمني والصياغات. التواريخ نسبية لليوم (انظر doc-status.test.js). */
function inDays(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
const emp = (name, iq, lic, extra = {}) => ({ [F.name]: name, [F.iqama]: "2000000001", [F.iqExp]: iq, [F.licExp]: lic, ...extra });

test("الخطورة: منتهي / 0–10 / 11–30 / أبعد", () => {
  assert.equal(DashFx.severity(-1), "bad");
  assert.equal(DashFx.severity(0), "today");
  assert.equal(DashFx.severity(10), "today");
  assert.equal(DashFx.severity(11), "warn");
  assert.equal(DashFx.severity(30), "warn");
  assert.equal(DashFx.severity(31), "ok");
});

test("الشريط يقرأ empDocs نفسها: النافذة، والمنتهية، وما بعدها", () => {
  const data = [emp("أ", inDays(-3), inDays(5)), emp("ب", inDays(20), inDays(200)), emp("ج", null, inDays(90))];
  const r = DashFx.timelinePoints(data, [], DocStatus);
  assert.deepEqual(r.points.map((p) => p.n), [-3, 5, 20, 90], "مرتّبة من الأقدم");
  assert.equal(r.expired, 1);
  assert.equal(r.beyond, 1, "رخصة بعد 200 يوم خارج النافذة ومعدودة");
  assert.deepEqual(r.points.map((p) => p.sev), ["bad", "today", "warn", "ok"]);
  assert.equal(r.points[0].i, 0, "الفهرس يشير إلى الموظف في DATA");
});

test("الوثيقة بلا تاريخ لا تظهر، و«جاري السداد» تُميَّز", () => {
  const r = DashFx.timelinePoints([emp("أ", null, inDays(4), { _licPending: true })], [], DocStatus);
  assert.equal(r.points.length, 1);
  assert.equal(r.points[0].sev, "pending");
});

test("المواضع: المنتهية قبل «اليوم» والمستقبل بعده، والطبقات تمنع التراكب", () => {
  assert.ok(DashFx.position(-5) < DashFx.position(0));
  assert.ok(DashFx.position(0) < DashFx.position(10) && DashFx.position(10) < DashFx.position(90));
  const same = [emp("أ", inDays(3), inDays(3)), emp("ب", inDays(3), null)];
  const pts = DashFx.timelinePoints(same, [], DocStatus).points;
  assert.deepEqual(pts.map((p) => p.lvl).sort(), [0, 1, 2]);
});

test("الشريط يطابق عدّاد المتابعة في النافذة القصيرة", () => {
  const data = [emp("أ", inDays(-3), inDays(5)), emp("ب", inDays(9), inDays(40))];
  const follow = DocStatus.collectFollowUpDocs(data, []).length;
  const inShort = DashFx.timelinePoints(data, [], DocStatus).points.filter((p) => p.n <= DocStatus.SOON).length;
  assert.equal(inShort, follow);
});

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
