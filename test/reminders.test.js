const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DocStatus = require("../doc-status.js");
const R = require("../reminders.js");
const { F } = DocStatus;

/* قسم «التذكيرات». اليوم مثبَّت (الثلاثاء 17 نوفمبر 2026) ويُمرَّر صراحةً،
   فلا يسقط اختبار بمرور الوقت. ⛔ كل البيانات مصنوعة. */
const TODAY = "2026-11-17";
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const day = (n) => { const t = new Date(Date.UTC(2026, 10, 17 + n)); return t.toISOString().slice(0, 10); };
const mdy = (n) => { const [y, m, d] = day(n).split("-").map(Number); return `${m}/${d}/${y}`; };

const ALL = new Set(["employees:view", "employees:edit", "ajeer:view", "ajeer:manage", "municipal:view", "municipal:manage", "staff_travel:view"]);
const canOf = (set) => (s, a) => set.has(`${s}:${a}`);
const without = (...keys) => { const s = new Set(ALL); keys.forEach((k) => s.delete(k)); return canOf(s); };

const emp = (eid, name, extra = {}) => ({ [F.damanah]: eid, [F.name]: name, [F.iqama]: `2${eid}000000`, [F.job]: "فني", ...extra });
const permit = (no, iqama, exp, issue = "2026-10-01", extra = {}) => ({ permit: no, iqama, nameOnPermit: "اسم على التصريح", issueDate: issue, expiryDate: exp, file: "https://x/f.pdf", ...extra });
const card = (id, eid, exp, extra = {}) => ({ cardId: id, employeeEid: eid, certificateNumber: `C${id.slice(0, 4)}`, expiryDate: exp, nameOnCard: "اسم على البطاقة", occupation: "عامل", hasQr: true, ...extra });

function fixture() {
  const employees = [
    emp("500", "محمد أحمد", { [F.iqExp]: day(3), [F.licExp]: day(12), [F.passExp]: day(400) }),
    emp("501", "سالم علي", { [F.iqExp]: mdy(-11), [F.licExp]: day(45), _licPending: false }),
    emp("502", "خالد حسن", { [F.iqExp]: day(200), [F.licExp]: day(-2), _licPending: true }),
  ];
  const permits = [
    permit("TQ1", employees[0][F.iqama], day(44)),
    permit("TQ0", employees[0][F.iqama], day(-30), "2026-08-01"), // أقدم — يَجُبّه TQ1
    permit("TQ9", "2999999999", day(5), "2026-10-01", { nameOnPermit: "عامل غير مربوط", file: null }),
  ];
  const municipal = [card("aaaaaaaaaaaaaaaa", "501", day(20)), card("bbbbbbbbbbbbbbbb", "999", day(-1), { hasQr: false })];
  const travel = {
    people: [{ staffId: "7", source: "ajeer", number: "502", name: "خالد حسن" }, { staffId: "8", source: "droua", number: "D1", name: "موظف ذروة" }],
    items: [
      { id: "1", staffId: "7", startDate: day(-5), endDate: day(10), visaExpiryDate: day(8), visaType: "خروج وعودة" },
      { id: "2", staffId: "8", startDate: day(-40), endDate: day(-20), visaExpiryDate: day(-10), returnConfirmedAt: "2026-10-30" },
      { id: "3", staffId: "8", startDate: day(30), endDate: day(50), visaExpiryDate: day(60), visaType: "خروج وعودة" },
    ],
  };
  return { employees, permits, municipal, travel };
}
const build = (can = canOf(ALL), input = fixture()) => R.build(input, { can, today: TODAY });
const find = (items, type, name) => items.find((x) => x.type === type && (!name || x.name === name));

/* ── الحالات والمدد ── */
test("الحالة: منتهي / 0–10 عاجل / 11–30 قريب الانتهاء / 31–90 تحت المتابعة / أبعد = ساري", () => {
  assert.equal(R.statusKey(-1), "expired");
  assert.equal(R.statusKey(-400), "expired");
  for (const n of [0, 1, 3, 10]) assert.equal(R.statusKey(n), "urgent", String(n));
  for (const n of [11, 20, 30]) assert.equal(R.statusKey(n), "soon", String(n));
  for (const n of [31, 44, 90]) assert.equal(R.statusKey(n), "watch", String(n));
  assert.equal(R.statusKey(91), "ok");
});

test("نصّ الحالة يُظهر المدة الحقيقية دائمًا", () => {
  assert.equal(R.statusDetail(-11), "منذ 11 يومًا");
  assert.equal(R.statusDetail(-1), "منذ يوم واحد");
  assert.equal(R.statusDetail(-2), "منذ يومين");
  assert.equal(R.statusDetail(0), "ينتهي اليوم");
  assert.equal(R.statusDetail(3), "ينتهي خلال 3 أيام");
  assert.equal(R.statusDetail(10), "ينتهي خلال 10 أيام");
  assert.equal(R.statusDetail(20), "ينتهي بعد 20 يومًا");
  assert.equal(R.statusDetail(44), "باقي 44 يومًا");
  assert.equal(R.statusDetail(2 * 1), "ينتهي خلال يومين");
});

test("منتهي: إقامة انتهت قبل 11 يومًا (بصيغة M/D/YYYY) = منتهي — منذ 11 يومًا", () => {
  const it = find(build(), "iqama", "سالم علي");
  assert.equal(it.n, -11);
  assert.equal(it.status, "expired");
  assert.equal(it.day, day(-11));
});

test("0–10: إقامة بعد 3 أيام عاجلة · 11–30: رخصة بعد 12 يومًا · 31–90: رخصة بعد 45 يومًا", () => {
  const items = build();
  assert.equal(find(items, "iqama", "محمد أحمد").status, "urgent");
  assert.equal(find(items, "work_license", "محمد أحمد").status, "soon");
  assert.equal(find(items, "work_license", "سالم علي").status, "watch");
});

test("تاريخ الانتهاء بصيغة عربية: «الخميس 19 نوفمبر»، والسنة إن لم تكن الحالية", () => {
  assert.equal(R.fmtDay("2026-11-19", TODAY), "الخميس 19 نوفمبر");
  assert.equal(R.fmtDay("2027-01-05", TODAY), "الثلاثاء 5 يناير 2027");
  assert.equal(R.fmtDay(null, TODAY), "—");
});

/* ── الموظف الواحد: كل وثيقة صفّ ── */
test("أكثر من وثيقة لنفس الموظف = صفوف منفصلة (إقامة 3 أيام، تصريح أجير 44 يومًا، رخصة 12 يومًا)", () => {
  const rows = R.filter(build(), { period: "all" }, TODAY).rows.filter((x) => x.name === "محمد أحمد");
  assert.deepEqual(rows.map((x) => [x.type, x.n]), [["iqama", 3], ["work_license", 12], ["ajeer", 44]]);
  assert.equal(new Set(rows.map((x) => x.key)).size, 3);
});

test("الترتيب: الأقدم انتهاءً أولًا، ثم المنتهي حديثًا، ثم الأقل أيامًا فالأبعد", () => {
  const ns = build().map((x) => x.n);
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b));
  assert.ok(ns[0] < 0 && ns[ns.length - 1] > 0);
  /* المنتهية في الصدارة */
  const rows = R.filter(build(), { period: "all" }, TODAY).rows;
  const firstNonExpired = rows.findIndex((x) => x.status !== "expired");
  assert.ok(rows.slice(firstNonExpired).every((x) => x.status !== "expired"));
});

test("الاستبعاد: رخصة «جاري السداد»، والوثيقة بلا تاريخ، والتصريح الأقدم لنفس الإقامة", () => {
  const items = build();
  assert.equal(find(items, "work_license", "خالد حسن"), undefined);
  assert.equal(items.filter((x) => x.type === "passport").length, 1); // 500 وحده له تاريخ
  assert.ok(!items.some((x) => x.docNo === "TQ0"));
});

test("تأشيرة السفر: الرحلات القائمة وحدها — رحلة عاد صاحبها لا تُذكَّر", () => {
  const visas = build().filter((x) => x.type === "visa");
  assert.deepEqual(visas.map((v) => v.ref.tripId).sort(), ["1", "3"]);
  const v = visas.find((x) => x.ref.tripId === "1");
  assert.equal(v.name, "خالد حسن");
  assert.equal(v.empIndex, 2, "موظف أجير يُربط بسجلّه");
  assert.equal(v.visaType, "خروج وعودة");
  /* رحلة سابقة لم تُؤكَّد عودتها لكن بدأت بعدها رحلة أخرى = عاد ضمنيًا */
  const input = fixture();
  input.travel.items.push({ id: "4", staffId: "7", startDate: day(-60), endDate: day(-50), visaExpiryDate: day(-45) });
  assert.ok(!build(canOf(ALL), input).some((x) => x.type === "visa" && x.ref.tripId === "4"));
});

/* ── البحث والفلاتر ── */
test("البحث: بالاسم، ورقم الموظف، ورقم الهوية، ورقم المستند — بتطبيع عربي", () => {
  const items = build();
  const q = (s) => R.filter(items, { q: s }, TODAY).rows;
  assert.ok(q("محمد").every((x) => x.name === "محمد أحمد") && q("محمد").length === 3);
  assert.ok(q("501").every((x) => x.number === "501"));
  assert.ok(q("2502000000").length >= 1);
  assert.ok(q("2502000000").every((x) => x.iqama === "2502000000"));
  assert.equal(q("TQ9")[0].type, "ajeer");
  assert.equal(q("٥٠١").length, q("501").length, "أرقام هندية");
  assert.equal(q("سالم  علي").length, q("سالم علي").length);
  assert.equal(q("لا أحد بهذا الاسم").length, 0);
});

test("فلتر نوع الوثيقة: متعدد، والعدّ بجانب كل نوع من النتائج الحالية", () => {
  const items = build();
  const all = R.filter(items, { period: "all" }, TODAY);
  const counted = Object.values(all.counts).reduce((a, b) => a + b, 0);
  assert.equal(counted, all.total);
  assert.equal(all.rows.length, all.total);
  const two = R.filter(items, { period: "all", types: ["iqama", "ajeer"] }, TODAY);
  assert.ok(two.rows.every((x) => x.type === "iqama" || x.type === "ajeer"));
  assert.equal(two.rows.length, all.counts.iqama + all.counts.ajeer);
  /* العدّ لا يتأثّر بفلتر النوع نفسه، ويتأثّر بالبحث */
  assert.deepEqual(two.counts, all.counts);
  const searched = R.filter(items, { period: "all", q: "محمد" }, TODAY);
  assert.equal(searched.counts.iqama, 1);
  assert.equal(searched.counts.municipal, 0);
});

test("الأنواع في الفلتر: ما له بيانات فعلية فقط — بلا عقد ولا تأمين ولا أي نوع بلا مصدر", () => {
  const keys = R.TYPES.map((t) => t.key);
  assert.deepEqual(keys, ["iqama", "work_license", "passport", "ajeer", "municipal", "visa"]);
  assert.ok(!R.TYPES.some((t) => /عقد|تأمين/.test(t.label)));
  const onlyIq = R.build({ employees: [emp("600", "س", { [F.iqExp]: day(5) })] }, { can: canOf(ALL), today: TODAY });
  assert.deepEqual(R.availableTypes(onlyIq).map((t) => t.key), ["iqama"]);
});

test("المدة: جميع الحالات = كل المنتهية + خلال 90 يومًا", () => {
  const rows = R.filter(build(), { period: "all" }, TODAY).rows;
  assert.ok(rows.every((x) => x.n <= 90));
  assert.ok(rows.some((x) => x.n < -10));
  assert.ok(!rows.some((x) => x.type === "passport"), "الجواز بعد 400 يوم خارج النافذة");
});

test("المدة: هذا الأسبوع (الأحد–السبت)", () => {
  assert.deepEqual(R.periodRange("week", TODAY), { from: "2026-11-15", to: "2026-11-21" });
  const rows = R.filter(build(), { period: "week" }, TODAY).rows;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((x) => x.day >= "2026-11-15" && x.day <= "2026-11-21"));
  assert.ok(rows.some((x) => x.n === 3));
});

test("المدة: هذا الشهر والشهر القادم (وحدود السنة)", () => {
  assert.deepEqual(R.periodRange("month", TODAY), { from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(R.periodRange("next_month", TODAY), { from: "2026-12-01", to: "2026-12-31" });
  assert.deepEqual(R.periodRange("next_month", "2026-12-10"), { from: "2027-01-01", to: "2027-01-31" });
  assert.deepEqual(R.periodRange("month", "2028-02-10"), { from: "2028-02-01", to: "2028-02-29" });
  const month = R.filter(build(), { period: "month" }, TODAY).rows;
  assert.ok(month.every((x) => x.day.startsWith("2026-11")));
  const next = R.filter(build(), { period: "next_month" }, TODAY).rows;
  assert.ok(next.length > 0 && next.every((x) => x.day.startsWith("2026-12")));
});

test("المدة: مدة محددة شاملة الطرفين، وتصل أبعد من 90 يومًا، ومقلوبة تُصحَّح", () => {
  const items = build();
  const r = R.filter(items, { period: "custom", custom: { from: day(12), to: day(20) } }, TODAY).rows;
  assert.deepEqual(r.map((x) => x.n), [12, 20]);
  const far = R.filter(items, { period: "custom", custom: { from: day(300), to: day(500) } }, TODAY).rows;
  assert.equal(far.length, 1);
  assert.equal(far[0].type, "passport");
  assert.equal(far[0].status, "ok");
  const swapped = R.filter(items, { period: "custom", custom: { from: day(20), to: day(12) } }, TODAY).rows;
  assert.deepEqual(swapped.map((x) => x.n), [12, 20]);
  const open = R.filter(items, { period: "custom", custom: { from: day(100) } }, TODAY).rows;
  assert.ok(open.every((x) => x.n >= 100));
});

/* ── الصلاحيات: البيانات نفسها لا تظهر، لا الزرّ وحده ── */
test("مستخدم لا يرى أجير: لا صفوف أجير ولا عدّ لها في الفلتر", () => {
  const items = build(without("ajeer:view", "ajeer:manage"));
  assert.equal(items.filter((x) => x.type === "ajeer").length, 0);
  assert.equal(R.filter(items, {}, TODAY).counts.ajeer, 0);
  assert.ok(!R.availableTypes(items).some((t) => t.key === "ajeer"));
  assert.ok(items.some((x) => x.type === "iqama"));
});

test("مستخدم لا يرى البلدية: لا صفوف بطاقات بلدية ولا عدّ", () => {
  const items = build(without("municipal:view", "municipal:manage"));
  assert.equal(items.filter((x) => x.type === "municipal").length, 0);
  assert.ok(!R.availableTypes(items).some((t) => t.key === "municipal"));
});

test("مستخدم بلا employees:view: لا إقامة ولا رخصة ولا جواز — وأجير يظهر بالاسم المطبوع على التصريح", () => {
  const input = fixture();
  const items = build(without("employees:view", "employees:edit"), { ...input, employees: [] });
  assert.ok(!items.some((x) => ["iqama", "work_license", "passport"].includes(x.type)));
  const aj = items.find((x) => x.docNo === "TQ1");
  assert.equal(aj.name, "اسم على التصريح");
  assert.equal(aj.empIndex, -1);
  /* ولو وصلت بيانات الموظفين خطأً، لا تُعرض بلا الصلاحية */
  assert.ok(!build(without("employees:view"), input).some((x) => x.type === "iqama"));
});

test("مستخدم بلا staff_travel:view: لا تأشيرات", () => {
  assert.equal(build(without("staff_travel:view")).filter((x) => x.type === "visa").length, 0);
});

test("صلاحيات الإجراءات: التجديد بـmanage وحده، والعرض فقط بلاها", () => {
  const H = { openEmployee() {}, editEmployee() {}, renewAjeer() {}, ajeerDoc() {}, ajeerQr() {}, renewMunicipal() {}, municipalQr() {} };
  const items = build();
  const acts = (it, can) => R.actionsFor(it, can, H).map((a) => a.act);
  const aj = find(items, "ajeer", "محمد أحمد");
  assert.deepEqual(acts(aj, canOf(ALL)), ["renew", "doc", "qr", "emp"]);
  assert.deepEqual(acts(aj, without("ajeer:manage")), ["doc", "qr", "emp"]);
  const mc = find(items, "municipal", "سالم علي");
  assert.deepEqual(acts(mc, canOf(ALL)), ["renew", "qr", "emp"]);
  assert.deepEqual(acts(mc, without("municipal:manage")), ["qr", "emp"]);
  /* الإقامة: لا زرّ «تجديد» مخترع — تحديث البيانات (نموذج التعديل القائم) أو عرض الموظف */
  const iq = find(items, "iqama", "محمد أحمد");
  assert.deepEqual(acts(iq, canOf(ALL)), ["edit", "emp"]);
  assert.deepEqual(acts(iq, without("employees:edit")), ["emp"]);
  assert.ok(!acts(iq, canOf(ALL)).includes("renew"));
  /* تصريح غير مربوط وبلا ملف: لا إجراء عرض له */
  const lone = items.find((x) => x.docNo === "TQ9");
  assert.deepEqual(acts(lone, without("ajeer:manage")), []);
  /* بطاقة بلا رمز: لا زرّ باركود */
  const noQr = items.find((x) => x.type === "municipal" && x.ref.cardId.startsWith("b"));
  assert.ok(!acts(noQr, canOf(ALL)).includes("qr"));
  /* التأشيرة: رابط صفحة متابعة السفر القائمة */
  const v = items.find((x) => x.type === "visa");
  assert.equal(R.actionsFor(v, canOf(ALL), H)[0].href, "/staff-travel.html");
});

/* ── التحديث بعد التجديد ── */
test("التجديد ثم التحديث: بطاقة بلدية باقٍ عليها 3 أيام تُجدَّد لسنة فتخرج من «جميع الحالات»", () => {
  const input = fixture();
  input.municipal[0] = card("aaaaaaaaaaaaaaaa", "501", day(3));
  let rows = R.filter(build(canOf(ALL), input), { period: "all" }, TODAY).rows;
  assert.equal(rows.find((x) => x.key === "municipal:aaaaaaaaaaaaaaaa").status, "urgent");
  /* ما يُمرّره MunicipalCards بعد applyRenewed: المدخل نفسه بتاريخه الجديد */
  input.municipal[0] = card("aaaaaaaaaaaaaaaa", "501", day(365));
  const items = build(canOf(ALL), input);
  rows = R.filter(items, { period: "all" }, TODAY).rows;
  assert.ok(!rows.some((x) => x.key === "municipal:aaaaaaaaaaaaaaaa"));
  assert.equal(items.find((x) => x.key === "municipal:aaaaaaaaaaaaaaaa").status, "ok");
});

test("التجديد ثم التحديث: تصريح أجير جديد يَجُبّ السابق — صفّ واحد بالمدة الجديدة", () => {
  const input = fixture();
  input.permits.push(permit("TQ2", input.employees[0][F.iqama], day(75), "2026-11-17"));
  const aj = build(canOf(ALL), input).filter((x) => x.type === "ajeer" && x.name === "محمد أحمد");
  assert.equal(aj.length, 1);
  assert.equal(aj[0].docNo, "TQ2");
  assert.equal(aj[0].status, "watch");
});

/* ── التواريخ: الرياض لا الجهاز (منقولة من اختبارات doc-expiry) ── */
test("dayKey: الصيغ المختلفة لليوم نفسه تعطي مفتاحًا واحدًا", () => {
  const same = ["11/13/2026", "2026-11-13", "2026-11-13T00:00:00", "2026-11-13T15:45:10.250", "2026-11-13 10:00",
    "11/13/2026 4:00 PM", "2026-11-12T21:00:00.000Z", "2026-11-13T23:30:00+03:00", "2026-11-13T09:00:00+0300", new Date("2026-11-13T05:00:00Z")];
  for (const v of same) assert.equal(R.dayKey(v), "2026-11-13", String(v));
});

test("dayKey: لحظة UTC تُقرأ بتوقيت الرياض، وغير المفهوم null", () => {
  assert.equal(R.dayKey("2026-11-12T20:59:59Z"), "2026-11-12");
  assert.equal(R.dayKey("2026-11-12T21:00:00Z"), "2026-11-13");
  for (const v of [null, "", "—", "لايوجد", "2/31/2026", "2026-13-01", 46000]) assert.equal(R.dayKey(v), null, String(v));
});

test("todayKey: اليوم بتوقيت الرياض مهما كانت منطقة الجهاز", () => {
  assert.equal(R.todayKey(new Date("2026-11-16T20:59:00Z")), "2026-11-16");
  assert.equal(R.todayKey(new Date("2026-11-16T21:00:00Z")), "2026-11-17");
  const script = `const R=require(${JSON.stringify(path.join(ROOT, "reminders.js"))});
    process.stdout.write([R.todayKey(new Date("2026-11-16T22:00:00Z")),R.dayKey("2026-11-19"),R.dayKey("11/19/2026"),
      R.daysBetween(R.todayKey(new Date("2026-11-16T22:00:00Z")),R.dayKey("11/19/2026"))].join(","));`;
  for (const tz of ["UTC", "America/Los_Angeles", "Asia/Riyadh", "Pacific/Kiritimati"]) {
    const out = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz } }).toString();
    assert.equal(out, "2026-11-17,2026-11-19,2026-11-19,2", tz);
  }
});

/* ── الربط في الصفحة الرئيسية ── */
test("الصفحة الرئيسية: النظام القديم أُزيل والتذكيرات مربوطة", () => {
  const shell = read("app-shell.html");
  assert.doesNotMatch(shell, /doc-expiry|DocExpiry|id="docExpiry"|أكثر الوثائق إلحاحًا|عرض حسب المدة|عرض حسب الموظف/);
  assert.match(shell, /<link rel="stylesheet" href="\/reminders\.css\?v=\d+">/);
  assert.match(shell, /<script src="\/reminders\.js\?v=\d+"><\/script>/);
  assert.match(shell, /<section class="block wrap" id="remindersSec"[^>]*>[\s\S]*<h2>التذكيرات<\/h2>[\s\S]*id="docReminders"/);
  /* كل رسم للمؤشّرات (بعد refreshEmployees / refreshPermits) يحدّث التذكيرات */
  assert.match(shell, /function renderDashboardTop\(\)\{[\s\S]*Reminders\.update\(\{employees:DATA,permits:AJEER\}\)/);
  /* البلدية: كل تحميل وتجديد يمرّ إلى التذكيرات */
  assert.match(shell, /onItems:items=>syncLateSource\(\{municipal:items\}\)/);
  assert.match(shell, /function syncLateSource\(partial\)\{\s*Object\.assign\(REM_SRC,partial\);\s*Reminders\.update\(partial\);\s*if\(redrawFollowUp\) redrawFollowUp\(\);/);
  /* تجديد أجير من التذكيرات يمرّ بالمسار القائم الذي يعيد قراءة التصاريح */
  assert.match(shell, /renewAjeer:permit=>openAjeerRenew\(permit\)/);
  assert.match(shell, /function openAjeerRenew[\s\S]*?onSuccess:async item=>\{\s*await refreshPermits\(\);/);
  assert.match(shell, /async function refreshPermits\(\)\{[\s\S]*?renderDashboardTop\(\);/);
  /* القسم يظهر لمن يرى نوعًا واحدًا على الأقل */
  assert.match(shell, /const REMINDER_VIEWS=\[\["employees","view"\],\["ajeer","view"\],\["municipal","view"\],\["staff_travel","view"\]\]/);
  /* لوحتا الإقامة والرخصة خارج النطاق — باقيتان */
  assert.match(shell, /id="chartIqama"/);
});

test("municipal-cards.js: يمرّر البطاقات بعد التحميل والتجديد، ويكشف نافذتي التجديد والباركود", () => {
  const js = read("municipal-cards.js");
  assert.match(js, /function applyRenewed[\s\S]*?S\.items\[i\] = item;[\s\S]*?notify\(\);/);
  assert.match(js, /root\.MunicipalCards = \{[^}]*openRenew[^}]*openQr/);
  assert.match(js, /onItems\(S\.items\.slice\(\)\)/);
});

test("reminders.js لا يجلب شيئًا من الشبكة ولا يذكر جسر", () => {
  const js = read("reminders.js");
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|AdminUI\.api/);
  assert.doesNotMatch(js, /jisr/i);
});

test("CSS: الجوال بطاقات مكدّسة بلا تمرير أفقي ولا صندوق تمرير داخلي", () => {
  const css = read("reminders.css");
  assert.match(css, /@media\(max-width:760px\)\{[\s\S]*\.rm-table thead\{display:none\}/);
  assert.doesNotMatch(css, /overflow(-x|-y)?:(auto|scroll)/);
  assert.doesNotMatch(css, /max-height/);
});

/* ── «بحاجة إلى متابعة»: بطاقة الرئيسية و/expiring.html من التذكيرات نفسها ── */
test("followUp = منتهي + عاجل (0–10) من التذكيرات نفسها، بكل الأنواع", () => {
  const items = build();
  const fu = R.followUp(items);
  assert.deepEqual(fu, items.filter((x) => x.n <= 10));
  assert.ok(fu.some((x) => x.type === "municipal") && fu.some((x) => x.type === "visa"));
  /* يطابق ما يعرضه قسم التذكيرات بحالتيه */
  const shown = R.filter(items, { period: "all" }, TODAY).rows.filter((x) => x.status === "expired" || x.status === "urgent");
  assert.deepEqual(fu.map((x) => x.key), shown.map((x) => x.key));
  assert.equal(R.URGENT_DAYS, 10);
  assert.equal(R.summarize(fu), "إقامات 2 · تصاريح أجير 1 · بطاقات بلدية 1 · تأشيرات 1");
  assert.equal(R.summarize([]), "");
});

test("بطاقة «وثائق بحاجة إلى متابعة» وتنبيهها من Reminders.followUp بكل المصادر", () => {
  const shell = read("app-shell.html");
  assert.doesNotMatch(shell, /DocStatus\.(collectFollowUpDocs|collectExpiredDocs|summarizeDocs)/);
  assert.match(shell, /const followUpDocs=Reminders\.followUp\(Reminders\.build\(\s*\{employees:DATA,permits:AJEER,municipal:REM_SRC\.municipal,travel:REM_SRC\.travel\}/);
  assert.match(shell, /lbl:"وثائق بحاجة إلى متابعة",big:followUpDocs\.length/);
  assert.match(shell, /renderSoonCallout\(followUpDocs\);\s*\}\s*drawFollowUp\(\);\s*redrawFollowUp=drawFollowUp;/);
});

test("/expiring.html يبني قائمته بـReminders.followUp من المصادر نفسها", () => {
  const page = read("expiring-shell.html");
  assert.match(page, /<script src="\/doc-status\.js\?v=\d+"><\/script>\s*<script src="\/reminders\.js\?v=\d+"><\/script>/);
  assert.doesNotMatch(page, /collectFollowUpDocs|summarizeDocs/);
  for (const u of ["/api/data/employees", "/api/data/permits", "/api/data/municipal-cards", "/api/data/staff-travel"]) assert.ok(page.includes(u), u);
  assert.match(page, /const items=Reminders\.followUp\(Reminders\.build\(/);
  assert.match(page, /loadOptional\("municipal","\/api\/data\/municipal-cards"\)/);
});
