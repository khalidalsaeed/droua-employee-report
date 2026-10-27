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

/* ── دمج وثائق الموظف المنتهية في اليوم نفسه ─────────────────────────── */
const rows = (data, permits = []) => DocExpiry.groupSameDay(collect(data, permits).docs);
const types = (row) => row.docs.map((d) => d.type);

test("الدمج: موظف بوثيقتين بالتاريخ نفسه = صفّ واحد بنوعيهما ومدّة واحدة", () => {
  const r = rows([emp("محمد", inDays(7), inDays(7))]);
  assert.equal(r.length, 1);
  assert.deepEqual(types(r[0]), ["إقامة", "رخصة عمل"]);
  assert.equal(r[0].n, 7);
  assert.equal(r[0].bucket, "d10");
  assert.equal(DocExpiry.remaining(r[0].n), "باقي 7 أيام");
  assert.equal(r[0].i, 0, "الصفّ يفتح ملف الموظف نفسه");
});

test("الدمج: ثلاث وثائق بالتاريخ نفسه = صفّ واحد بالأنواع الثلاثة", () => {
  const permits = [{ permit: "P-1", iqama: "2000000001", issueDate: inDays(-30), expiryDate: inDays(7) }];
  const r = rows([emp("محمد", inDays(7), inDays(7))], permits);
  assert.equal(r.length, 1);
  assert.deepEqual(types(r[0]), ["إقامة", "رخصة عمل", "تصريح أجير"]);
});

test("الدمج: الموظف نفسه بتواريخ مختلفة = صفوف منفصلة، وفرق يوم واحد لا يُدمج", () => {
  const r = rows([emp("محمد", inDays(7), inDays(8), { [F.passExp]: inDays(45) })]);
  assert.deepEqual(r.map((x) => x.n), [7, 8, 45]);
  assert.ok(r.every((x) => x.docs.length === 1));
});

test("الدمج: موظفان بالتاريخ نفسه لا يُدمجان", () => {
  const r = rows([emp("محمد", inDays(7), null), emp("سالم", inDays(7), null)]);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.emp[F.name]), ["محمد", "سالم"]);
});

test("الدمج: الإحصائيات تبقى على عدد الوثائق لا الصفوف", () => {
  const data = [emp("محمد", inDays(7), inDays(7), { [F.passExp]: inDays(45) }), emp("سالم", inDays(-3), inDays(-3)), emp("هند", inDays(20), null)];
  const c = collect(data);
  const r = DocExpiry.groupSameDay(c.docs);
  assert.equal(c.total, 6, "إجمالي الوثائق (مركز الحلقة وزرّ «عرض جميع الوثائق») لا يتغيّر بالدمج");
  assert.deepEqual(c.counts, { expired: 2, d10: 2, d30: 1, d90: 1 }, "الفئات تعدّ الوثائق");
  assert.equal(r.length, 4, "الصفوف أقلّ بعد الدمج");
  assert.equal(r.reduce((s, x) => s + x.docs.length, 0), c.total, "كل وثيقة في صفّ واحد بالضبط");
  assert.deepEqual(r.map((x) => x.n), [-3, 7, 20, 45], "الصفوف مرتّبة بالأكثر إلحاحًا");
  assert.equal(c.docs.length, 6, "الدمج لا يمسّ مصدر الوثائق");
});

test("الدمج: «حسب الموظف» مجموعة لكل تاريخ داخل صفّ الموظف", () => {
  const g = DocExpiry.byEmployee(collect([emp("محمد", inDays(7), inDays(7), { [F.passExp]: inDays(45) })]).docs);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].sets.map((s) => [types(s), s.n]), [[["إقامة", "رخصة عمل"], 7], [["الجواز"], 45]]);
  assert.equal(g[0].docs.length, 3);
});

test("العرضان صفّ لكل موظف، والزرّ يعدّ الوثائق", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "doc-expiry.js"), "utf8");
  assert.equal((src.match(/const groups = byEmployee\(docs\);/g) || []).length, 2, "حسب المدة و حسب الموظف");
  assert.match(src, /docBadges\(g\.docs\)/, "حسب المدة: شارة لكل وثيقة");
  assert.match(src, /g\.sets\.map\(/, "حسب الموظف: مدّة اليوم مرّة واحدة");
  assert.match(src, /const totalShown = S\.view === "dur" \? docs\.length : count;/);
  assert.doesNotMatch(src, /<th>المدة المتبقية<\/th>/, "لا عمود مدّة مكرّر");
});

/* ── الدمج بيوم الانتهاء الفعلي لا بالنصّ الخام ─────────────────────────
   المصادر تكتب التاريخ بصيغ مختلفة: الاستيراد M/D/YYYY، والاستخراج من ملفّ
   الإقامة/الرخصة YYYY-MM-DD، وقد يصل طابع زمني. اليوم الواحد يُدمج مهما
   اختلفت كتابته، وفرق يوم فعلي لا يُدمج. ⛔ بيانات مصنوعة. */
const { execFileSync } = require("node:child_process");
const isoDay = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

test("dayKey: الصيغ المختلفة لليوم نفسه تعطي مفتاحًا واحدًا", () => {
  const same = ["11/13/2026", "2026-11-13", "2026-11-13T00:00:00", "2026-11-13T15:45:10.250", "2026-11-13 10:00",
    "11/13/2026 4:00 PM", "2026-11-12T21:00:00.000Z", "2026-11-13T23:30:00+03:00", "2026-11-13T09:00:00+0300", new Date("2026-11-13T05:00:00Z")];
  for (const v of same) assert.equal(DocExpiry.dayKey(v), "2026-11-13", String(v));
});

test("dayKey: لحظة UTC تُقرأ بتوقيت المنصّة (الرياض)، والمنطقة قابلة للتمرير", () => {
  assert.equal(DocExpiry.dayKey("2026-11-12T20:59:59Z"), "2026-11-12", "قبل منتصف الليل في الرياض");
  assert.equal(DocExpiry.dayKey("2026-11-12T21:00:00Z"), "2026-11-13", "منتصف الليل في الرياض");
  assert.equal(DocExpiry.dayKey("2026-11-12T21:00:00Z", "UTC"), "2026-11-12");
});

test("dayKey: التاريخ بلا وقت لا ينزلق يومًا مهما كانت منطقة الجهاز", () => {
  const script = `const X=require(${JSON.stringify(path.join(__dirname, "..", "doc-expiry.js"))});
    process.stdout.write([X.dayKey("2026-11-13"),X.dayKey("11/13/2026"),X.dayKey("2026-11-13T00:00:00"),X.dayKey("2026-11-12T21:00:00Z")].join(","));`;
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Riyadh", "Pacific/Kiritimati"]) {
    const out = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz } }).toString();
    assert.equal(out, "2026-11-13,2026-11-13,2026-11-13,2026-11-13", tz);
  }
});

test("dayKey: غير المفهوم null، والتاريخ المستحيل مرفوض", () => {
  for (const v of [null, "", "—", "لايوجد", "2/31/2026", "2026-13-01", "13/45/2026", 46000]) assert.equal(DocExpiry.dayKey(v), null, String(v));
});

test("الدمج: اليوم نفسه بصيغتين مختلفتين (إقامة YYYY-MM-DD + رخصة M/D/YYYY) = صفّ واحد", () => {
  const r = rows([emp("لامين", isoDay(17), inDays(17))]);
  assert.equal(r.length, 1);
  assert.deepEqual(types(r[0]), ["إقامة", "رخصة عمل"]);
  assert.equal(r[0].n, 17);
});

test("الدمج: اليوم نفسه بطوابع زمنية مختلفة = صفّ واحد", () => {
  const r = rows([emp("شكيب", `${isoDay(19)}T08:15:00`, `${isoDay(19)}T22:40:00`)]);
  assert.equal(r.length, 1);
  assert.deepEqual(types(r[0]), ["إقامة", "رخصة عمل"]);
});

test("الدمج: لحظة UTC تقع في اليوم نفسه بتوقيت الرياض = صفّ واحد", () => {
  /* منتصف ليل يوم 20 في الرياض = 21:00Z من اليوم 19. */
  const [y, m, d] = isoDay(19).split("-");
  const utcEve = `${y}-${m}-${d}T21:00:00.000Z`;
  const docs = collect([emp("ساجر", utcEve, isoDay(20))]).docs;
  assert.deepEqual(docs.map((x) => x.day), [isoDay(20), isoDay(20)]);
  const r = DocExpiry.groupSameDay(docs);
  assert.equal(r.length, 1, "اليوم الفعلي نفسه في الرياض");
});

test("الدمج: فرق يوم فعلي لا يُدمج مهما تشابهت الصيغة أو الوقت", () => {
  assert.equal(rows([emp("أ", isoDay(17), inDays(18))]).length, 2, "صيغتان ويومان");
  assert.equal(rows([emp("أ", `${isoDay(17)}T23:59:59`, `${isoDay(18)}T00:00:00`)]).length, 2, "ثانية واحدة عبر منتصف الليل");
  assert.equal(rows([emp("أ", inDays(17), inDays(19))]).length, 2, "17 و 19 يومًا");
});

test("الدمج بالصيغ المختلطة: الحلقة والإحصائيات وعدد الوثائق لا تتغيّر، الصفوف وحدها تقلّ", () => {
  const plain = [emp("أ", inDays(7), inDays(7)), emp("ب", inDays(17), inDays(17), { [F.passExp]: inDays(45) }), emp("ج", inDays(-3), inDays(20))];
  const mixed = [emp("أ", isoDay(7), `${isoDay(7)}T14:00:00`), emp("ب", isoDay(17), inDays(17), { [F.passExp]: isoDay(45) }), emp("ج", isoDay(-3), inDays(20))];
  const a = collect(plain), b = collect(mixed);
  assert.deepEqual(b.counts, a.counts, "الفئات");
  assert.equal(b.total, a.total, "إجمالي الوثائق");
  assert.equal(b.total, 7);
  const ra = DocExpiry.groupSameDay(a.docs), rb = DocExpiry.groupSameDay(b.docs);
  assert.deepEqual(rb.map((x) => [x.emp[F.name], types(x), x.n]), ra.map((x) => [x.emp[F.name], types(x), x.n]), "الصفوف نفسها بالصيغتين");
  assert.equal(rb.length, 5, "7 وثائق في 5 صفوف");
  assert.equal(rb.reduce((s, x) => s + x.docs.length, 0), b.total, "كل وثيقة في صفّ واحد بالضبط");
});

test("الدمج بالصيغ المختلطة: «حسب الموظف» يجمع اليوم نفسه في مجموعة واحدة", () => {
  const g = DocExpiry.byEmployee(collect([emp("ب", isoDay(17), inDays(17), { [F.passExp]: isoDay(45) }), emp("ج", isoDay(-3), inDays(20))]).docs);
  assert.deepEqual(g.map((x) => x.emp[F.name]), ["ج", "ب"]);
  assert.deepEqual(g[1].sets.map((s) => [types(s), s.n]), [[["إقامة", "رخصة عمل"], 17], [["الجواز"], 45]]);
  assert.deepEqual(g[0].sets.map((s) => [types(s), s.n]), [[["إقامة"], -3], [["رخصة عمل"], 20]]);
});

/* ── صفّ واحد لكل موظف، كل وثيقة بمدّتها ────────────────────────────────
   الهدف: لا يتكرّر الموظف في أكثر من صفّ. العدّ يبقى على الوثائق. */
const empRows = (data, permits = []) => DocExpiry.byEmployee(collect(data, permits).docs);
const badges = (row) => row.docs.map((d) => [d.type, d.n]);

test("صفّ لكل موظف: إقامة ورخصة عمل بالتاريخ نفسه", () => {
  const r = empRows([emp("مد هلال", inDays(7), inDays(7))]);
  assert.equal(r.length, 1);
  assert.deepEqual(badges(r[0]), [["إقامة", 7], ["رخصة عمل", 7]]);
  assert.equal(r[0].sets.length, 1, "«حسب الموظف»: مدّة واحدة للاثنتين");
});

test("صفّ لكل موظف: إقامة ورخصة عمل بفارق يومين — صفّ واحد بمدّتين", () => {
  const r = empRows([emp("لامين", inDays(19), inDays(17))]);
  assert.equal(r.length, 1, "لا صفّان للموظف نفسه");
  assert.deepEqual(badges(r[0]), [["رخصة عمل", 17], ["إقامة", 19]], "الأكثر إلحاحًا أوّلًا");
  assert.deepEqual(r[0].sets.map((g) => [types(g), g.n]), [[["رخصة عمل"], 17], [["إقامة"], 19]]);
});

test("صفّ لكل موظف: ثلاث وثائق بتواريخ مختلفة، مرتّبة بالإلحاح", () => {
  const r = empRows([emp("شكيب", inDays(45), inDays(19), { [F.passExp]: inDays(17) })]);
  assert.equal(r.length, 1);
  assert.deepEqual(badges(r[0]), [["الجواز", 17], ["رخصة عمل", 19], ["إقامة", 45]]);
});

test("صفّ لكل موظف: الوثائق الأربع معًا، بما فيها تصريح أجير", () => {
  const permits = [{ permit: "P-1", iqama: "2000000001", issueDate: inDays(-30), expiryDate: inDays(3) }];
  const r = empRows([emp("أ", inDays(60), inDays(20), { [F.passExp]: inDays(80) })], permits);
  assert.equal(r.length, 1);
  assert.deepEqual(badges(r[0]), [["تصريح أجير", 3], ["رخصة عمل", 20], ["إقامة", 60], ["الجواز", 80]]);
});

test("صفّ لكل موظف: وثيقة منتهية + وثيقة بعد 20 يومًا — الحالة «منتهية»", () => {
  const r = empRows([emp("ساجر", inDays(20), inDays(-4))]);
  assert.equal(r.length, 1);
  assert.deepEqual(badges(r[0]), [["رخصة عمل", -4], ["إقامة", 20]]);
  assert.equal(r[0].bucket, "expired");
  assert.equal(DocExpiry.remaining(r[0].docs[0].n), "منذ 4 أيام");
});

test("حالة الصفّ من أكثر وثائقه إلحاحًا", () => {
  const r = empRows([emp("أ", inDays(19), inDays(7)), emp("ب", inDays(45), inDays(25)), emp("ج", inDays(70), inDays(50))]);
  assert.deepEqual(r.map((x) => [x.emp[F.name], x.n, x.bucket]), [["أ", 7, "d10"], ["ب", 25, "d30"], ["ج", 50, "d90"]]);
  assert.equal(r[0].worst.type, "رخصة عمل");
});

test("الصفوف مرتّبة بأكثر وثيقة إلحاحًا لدى كل موظف، ولا يتكرّر موظف", () => {
  const data = [emp("أ", inDays(40), inDays(30)), emp("ب", inDays(-1), inDays(60)), emp("ج", inDays(12), null)];
  const r = empRows(data);
  assert.deepEqual(r.map((x) => x.emp[F.name]), ["ب", "ج", "أ"]);
  assert.equal(new Set(r.map((x) => x.i)).size, r.length);
});

test("شارة الحالة اسم لا رقم: عاجل / قريب الانتهاء / تحت المتابعة / منتهية", () => {
  assert.deepEqual(DocExpiry.BUCKETS.map((b) => [b.key, b.pill]),
    [["expired", "منتهية"], ["d10", "عاجل"], ["d30", "قريب الانتهاء"], ["d90", "تحت المتابعة"]]);
  for (const b of DocExpiry.BUCKETS) assert.doesNotMatch(b.pill, /\d/, `${b.key}: بلا رقم`);
  assert.deepEqual(DocExpiry.BUCKETS.map((b) => b.label), ["منتهية", "0 – 10 أيام", "11 – 30 يومًا", "31 – 90 يومًا"], "مدى الحلقة كما هو");
});

test("الإحصائيات لا تتغيّر: الحلقة والبطاقات والزرّ على عدد الوثائق، والصفوف وحدها حسب الموظف", () => {
  const data = [emp("لامين", inDays(19), inDays(17)), emp("شكيب", inDays(45), inDays(19), { [F.passExp]: inDays(17) }),
    emp("ساجر", inDays(20), inDays(-4)), emp("مد", inDays(7), inDays(7)), emp("هند", inDays(200), inDays(150))];
  const c = collect(data);
  assert.equal(c.total, 9, "9 وثائق داخل النطاق");
  assert.deepEqual(c.counts, { expired: 1, d10: 2, d30: 5, d90: 1 });
  assert.equal(c.beyond, 2);
  const r = DocExpiry.byEmployee(c.docs);
  assert.equal(r.length, 4, "4 صفوف لأربعة موظفين");
  assert.equal(r.reduce((s2, x) => s2 + x.docs.length, 0), c.total, "كل وثيقة في صفّ واحد بالضبط");
  assert.deepEqual(collect(data).counts, c.counts, "التجميع لا يمسّ المصدر");
});

test("لا تمدّد أفقيًا: شارات الوثائق ومجموعات الأيام تلتفّ على الشاشات كلها", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "doc-expiry.css"), "utf8");
  assert.match(css, /\.dx-docs\{display:flex;flex-wrap:wrap;/);
  assert.match(css, /\.dx-set\{display:flex;flex-wrap:wrap;/);
  assert.match(css, /\.dx-doc\{[^}]*max-width:100%/);
  const mobile = css.slice(css.indexOf("@media(max-width:639px)"));
  assert.match(mobile, /\.dx-doc\{[^}]*white-space:normal/, "الجوال: الشارة نفسها تلتفّ عند الضيق الشديد");
  assert.match(mobile, /\.dx-types\{grid-column:1\/-1\}/, "الجوال: الوثائق بعرض البطاقة");
});
