const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DocStatus = require("../doc-status.js");
const DocExpiry = require("../doc-expiry.js");
const { F } = DocStatus;

/* قسم «الوثائق القادمة على انتهاء الصلاحية». التواريخ نسبية لليوم كي لا
   يسقط الاختبار بمرور الوقت (انظر doc-status.test.js). ⛔ بيانات مصنوعة. */
function inDays(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
const emp = (name, iq, lic, extra = {}) => ({ [F.name]: name, [F.iqama]: "2000000001", [F.iqExp]: iq, [F.licExp]: lic, ...extra });
const collect = (data, permits = []) => DocExpiry.collect(data, permits, DocStatus);

test("الفئات: منتهية / 0–10 / 11–30 / 31–90 / خارج النطاق", () => {
  assert.equal(DocExpiry.bucketOf(-1), "expired");
  assert.equal(DocExpiry.bucketOf(0), "d10");
  assert.equal(DocExpiry.bucketOf(10), "d10");
  assert.equal(DocExpiry.bucketOf(11), "d30");
  assert.equal(DocExpiry.bucketOf(30), "d30");
  assert.equal(DocExpiry.bucketOf(31), "d90");
  assert.equal(DocExpiry.bucketOf(90), "d90");
  assert.equal(DocExpiry.bucketOf(91), null);
  assert.deepEqual(DocExpiry.BUCKETS.map((b) => b.label), ["منتهية", "0 – 10 أيام", "11 – 30 يومًا", "31 – 90 يومًا"]);
});

test("العدّ من empDocs نفسها، مرتّبًا بالأكثر إلحاحًا", () => {
  const r = collect([emp("أ", inDays(-3), inDays(5)), emp("ب", inDays(20), inDays(200)), emp("ج", null, inDays(60))]);
  assert.deepEqual(r.docs.map((d) => d.n), [-3, 5, 20, 60]);
  assert.deepEqual(r.counts, { expired: 1, d10: 1, d30: 1, d90: 1 });
  assert.equal(r.total, 4, "مجموع الحلقة = مجموع الفئات");
  assert.equal(r.beyond, 1, "بعد 90 يومًا معدودة وخارج الحلقة");
  assert.equal(r.docs[0].i, 0, "الفهرس يشير إلى الموظف في DATA لفتح ملفه");
});

test("الوثيقة بلا تاريخ لا تُعدّ، و«جاري السداد» تُستبعد وتُعلَن", () => {
  const r = collect([emp("أ", null, inDays(4), { _licPending: true })]);
  assert.equal(r.total, 0);
  assert.equal(r.pending, 1);
});

test("تصريح أجير يدخل بأحدث تصريح للإقامة", () => {
  const permits = [
    { permit: "P-1", iqama: "2000000001", issueDate: inDays(-100), expiryDate: inDays(-40) },
    { permit: "P-2", iqama: "2000000001", issueDate: inDays(-10), expiryDate: inDays(25) },
  ];
  const r = collect([emp("أ", null, null)], permits);
  assert.equal(r.total, 1);
  assert.equal(r.docs[0].tk, "ajeer");
  assert.equal(r.docs[0].bucket, "d30", "التصريح الأقدم المنتهي مُجَبّ بالأحدث");
});

test("المنتهية و0–10 = قائمة المتابعة في المنصّة بالضبط", () => {
  const data = [emp("أ", inDays(-3), inDays(5)), emp("ب", inDays(9), inDays(40)), emp("ج", inDays(11), inDays(0))];
  const r = collect(data);
  assert.equal(r.counts.expired + r.counts.d10, DocStatus.collectFollowUpDocs(data, []).length);
});

test("حسب الموظف: وثائق كل موظف، مرتّبين بأقرب انتهاء", () => {
  const r = collect([emp("أ", inDays(40), inDays(12)), emp("ب", inDays(-2), null), emp("ج", inDays(70), null)]);
  const g = DocExpiry.byEmployee(r.docs);
  assert.deepEqual(g.map((x) => x.emp[F.name]), ["ب", "أ", "ج"]);
  assert.equal(g[1].docs.length, 2);
  assert.equal(g[1].worst.n, 12);
});

test("صياغة المدة المتبقية", () => {
  assert.equal(DocExpiry.remaining(-34), "منذ 34 يومًا");
  assert.equal(DocExpiry.remaining(-5), "منذ 5 أيام");
  assert.equal(DocExpiry.remaining(-2), "منذ يومين");
  assert.equal(DocExpiry.remaining(0), "تنتهي اليوم");
  assert.equal(DocExpiry.remaining(1), "باقي يوم واحد");
  assert.equal(DocExpiry.remaining(3), "باقي 3 أيام");
  assert.equal(DocExpiry.remaining(18), "باقي 18 يومًا");
  assert.equal(DocExpiry.docsPhrase(2), "وثيقتان");
  assert.equal(DocExpiry.docsPhrase(33), "33 وثيقة");
});

test("قراءة محضة: لا نداء شبكة ولا كتابة", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "doc-expiry.js"), "utf8");
  assert.doesNotMatch(src, /fetch\(|AdminUI\.api|XMLHttpRequest|localStorage|sessionStorage/);
});

test("الشريط الزمني القديم أُزيل بالكامل", () => {
  const root = path.join(__dirname, "..");
  for (const f of ["app-shell.html", "dashboard-fx.js", "dashboard-fx.css"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), /docTimeline|dtl-|DashFx\.timeline|timelinePoints/, f);
  }
});
