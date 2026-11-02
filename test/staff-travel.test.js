const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const T = require("../staff-travel-status.js");
const { makeFakeSql } = require("./helpers/fake-sql");
const { SECTION_BY_KEY, PAGE_PERMISSION, defaultPermissionsForRole, resolvePermissions } = require("../lib/auth/permissions");

/* متابعة سفر موظفي ذروة.
   كل التواريخ ثابتة ومعها «اليوم» ثابتًا (TODAY) — الدوالّ تقبل اليوم معاملًا،
   فلا يسقط اختبار بمرور الوقت. */
const TODAY = "2026-10-28";
const d = (n) => {
  const x = new Date(Date.UTC(2026, 9, 28 + n));
  return x.toISOString().slice(0, 10);
};
let seq = 0;
const trip = (staffId, s, e, v, extra) => ({ id: String(++seq), staffId, startDate: d(s), endDate: d(e), visaExpiryDate: d(v), returnConfirmedAt: null, ...extra });
/* الدليل الموحَّد كما يصل إلى الواجهة. أسماء وأرقام مُختلَقة. */
const PEOPLE = [
  { staffId: "1001", key: "ajeer:1001", source: "ajeer", number: "1001", name: "أحمد محمد علي", job: "عامل", department: "", identity: "2400000001", passport: "P1000001" },
  { staffId: "1002", key: "staff:1002", source: "droua", number: "D-2", name: "سعود عبدالله", job: "سائق", department: "النقل", identity: "2400000002", passport: "" },
];

/* ─── الحالات التلقائية ─── */
test("رحلة مستقبلية بعيدة = مجدولة، وضمن 7 أيام = قريب السفر", () => {
  assert.equal(T.tripStatus(trip("1", 20, 30, 60), TODAY).key, "scheduled");
  assert.equal(T.tripStatus(trip("1", 8, 30, 60), TODAY).key, "scheduled");
  const soon = T.tripStatus(trip("1", 7, 30, 60), TODAY);
  assert.equal(soon.key, "soon");
  assert.equal(soon.daysToStart, 7);
  assert.equal(soon.label, "قريب السفر");
  assert.equal(T.tripStatus(trip("1", 1, 30, 60), TODAY).key, "soon");
});

test("مسافر من يوم البداية حتى يوم النهاية شاملًا", () => {
  assert.equal(T.tripStatus(trip("1", 0, 10, 60), TODAY).key, "traveling");
  const mid = T.tripStatus(trip("1", -5, 5, 60), TODAY);
  assert.equal(mid.key, "traveling");
  assert.equal(mid.progress, 0.5);
  assert.equal(T.tripStatus(trip("1", -10, 0, 60), TODAY).key, "traveling");
});

test("«عاد» يتطلّب تأكيد العودة — مرور تاريخ النهاية وحده = بانتظار تأكيد العودة", () => {
  const late = T.tripStatus(trip("1", -10, -1, 60), TODAY);
  assert.equal(late.key, "overdue");
  assert.equal(late.label, "بانتظار تأكيد العودة");
  assert.equal(late.daysSinceEnd, 1);
  const back = T.tripStatus(trip("1", -10, -1, 60, { returnConfirmedAt: "2026-10-27T10:00:00Z" }), TODAY);
  assert.equal(back.key, "returned");
  assert.equal(back.label, "عاد");
  /* يوم النهاية: مسافر حتى يُؤكَّد، وعاد إن أُكِّد. */
  assert.equal(T.tripStatus(trip("1", -10, 0, 60), TODAY).key, "traveling");
  assert.equal(T.tripStatus(trip("1", -10, 0, 60, { returnConfirmedAt: "x" }), TODAY).key, "returned");
});

test("عودة ضمنية: بدء رحلة لاحقة فعلًا يعني أن السابقة عادت — المجدولة لا تكفي", () => {
  let [g] = T.groupByEmployee([trip("e", -60, -40, 0), trip("e", -10, 10, 90)], [], TODAY);
  const older = g.trips.find((t) => t.endDate === d(-40));
  assert.equal(T.tripStatus(older, TODAY).key, "returned");
  assert.equal(T.tripStatus(older, TODAY).implicit, true);
  [g] = T.groupByEmployee([trip("e", -60, -40, 0), trip("e", 30, 40, 90)], [], TODAY);
  assert.equal(g.status.key, "overdue");
  /* الحسبة على نُسخ — لا تُكتب في بيانات الصفحة. */
  const raw = [trip("e", -60, -40, 0), trip("e", -10, 10, 90)];
  T.groupByEmployee(raw, [], TODAY);
  assert.ok(raw.every((t) => !("implicitReturn" in t)));
});

test("العتبة قابلة للتعديل من الإعدادات، والقيم الفاسدة تُتجاهل", () => {
  assert.equal(T.tripStatus(trip("1", 10, 30, 60), TODAY, { SOON_DAYS: 14 }).key, "soon");
  assert.equal(T.thresholds({ SOON_DAYS: -3, VISA_SOON_DAYS: "abc" }).SOON_DAYS, 7);
  assert.equal(T.thresholds({ VISA_SOON_DAYS: 45 }).VISA_SOON_DAYS, 45);
  assert.equal(T.DEFAULTS.SOON_DAYS, 7);
});

/* ─── التأشيرة ─── */
test("شارة التأشيرة: متبقي / تنتهي بعد / اليوم / منتهية منذ", () => {
  assert.deepEqual([T.visaStatus(d(46), TODAY).key, T.visaStatus(d(46), TODAY).label], ["ok", "متبقي 46 يوم"]);
  assert.deepEqual([T.visaStatus(d(20), TODAY).key, T.visaStatus(d(20), TODAY).label], ["soon", "تنتهي بعد 20 يوم"]);
  assert.deepEqual([T.visaStatus(d(5), TODAY).key, T.visaStatus(d(5), TODAY).label], ["urgent", "تنتهي بعد 5 أيام"]);
  assert.equal(T.visaStatus(d(0), TODAY).label, "تنتهي اليوم");
  assert.deepEqual([T.visaStatus(d(-3), TODAY).key, T.visaStatus(d(-3), TODAY).label], ["expired", "منتهية منذ 3 أيام"]);
  assert.equal(T.visaStatus(d(-1), TODAY).label, "منتهية منذ يوم واحد");
  assert.equal(T.visaStatus("", TODAY).key, "na");
});

test("التأشيرة تنتهي قبل موعد العودة", () => {
  assert.equal(T.visaBeforeReturn(trip("1", -5, 20, 10)), true);
  assert.equal(T.visaBeforeReturn(trip("1", -5, 20, 20)), false);
  assert.equal(T.visaBeforeReturn(trip("1", -5, 20, 21)), false);
});

/* ─── أكثر من رحلة لنفس الموظف ─── */
test("البطاقة تعرض الجارية، وإلا الأقرب قدومًا، وإلا آخر رحلة — والسجلّ الأحدث أولًا", () => {
  const old = trip("1001", -400, -380, -350);
  const recent = trip("1001", -60, -30, 0);
  const next = trip("1001", 40, 60, 90);
  const later = trip("1001", 100, 120, 150);
  let [g] = T.groupByEmployee([old, later, { ...recent, returnConfirmedAt: "x" }, next], PEOPLE, TODAY);
  assert.equal(g.primary.id, next.id);
  assert.equal(g.status.key, "scheduled");
  assert.deepEqual(g.trips.map((t) => t.id), [later.id, next.id, recent.id, old.id]);
  const cur = trip("1001", -2, 5, 30);
  [g] = T.groupByEmployee([old, cur, next], PEOPLE, TODAY);
  assert.equal(g.primary.id, cur.id);
  /* رحلة منتهية بلا تأكيد تتقدّم على المجدولة: تحتاج إجراءً. */
  [g] = T.groupByEmployee([old, recent, next], PEOPLE, TODAY);
  assert.equal(g.primary.id, recent.id);
  assert.equal(g.status.key, "overdue");
  [g] = T.groupByEmployee([old, { ...recent, returnConfirmedAt: "x" }], PEOPLE, TODAY);
  assert.equal(g.status.key, "returned");
  assert.equal(g.employee.name, "أحمد محمد علي");
});

test("ترتيب البطاقات: بانتظار التأكيد ثم مسافر ثم قريب ثم مجدولة ثم عاد", () => {
  const gs = T.groupByEmployee([
    trip("a", -40, -30, 0, { returnConfirmedAt: "x" }), trip("b", 30, 40, 90), trip("c", 3, 9, 90), trip("d", -1, 9, 90), trip("o", -9, -2, 90),
  ], [], TODAY);
  assert.deepEqual(gs.map((g) => g.status.key), ["overdue", "traveling", "soon", "scheduled", "returned"]);
});

/* ─── التنبيهات ─── */
test("التنبيهات: سفر خلال 7 أيام، عودة قريبة، تأشيرة خلال 30 يومًا، تأشيرة منتهية، قبل العودة، تجاوز العودة", () => {
  const gs = T.groupByEmployee([
    trip("s", 3, 20, 90),                 // departure_soon
    trip("r", -10, 4, 90),                // return_soon
    trip("v", -10, 20, 15),               // visa_soon + visa_before_return
    trip("x", -10, 20, -2),               // visa_expired + visa_before_return
    trip("o", -20, -3, 90),               // overdue_return
    trip("c", -20, -3, 30, { returnConfirmedAt: "2026-10-26T10:00:00Z" }), // مؤكَّدة: لا تنبيه
  ], [], TODAY);
  const kinds = (id) => T.alerts(gs, TODAY).filter((a) => a.gid === id).map((a) => a.kind).sort();
  assert.deepEqual(kinds("s"), ["departure_soon"]);
  assert.deepEqual(kinds("r"), ["return_soon"]);
  assert.deepEqual(kinds("v"), ["visa_before_return", "visa_soon"]);
  assert.deepEqual(kinds("x"), ["visa_before_return", "visa_expired"]);
  assert.deepEqual(kinds("o"), ["overdue_return"]);
  assert.deepEqual(kinds("c"), []);
  assert.equal(T.alerts(gs, TODAY)[0].level, "bad");
});

test("لا تنبيه تجاوز لرحلة عادت ضمنيًا ببدء رحلة لاحقة", () => {
  const gs = T.groupByEmployee([trip("o", -60, -40, 0), trip("o", -5, 30, 90)], [], TODAY);
  assert.deepEqual(T.alerts(gs, TODAY).map((a) => a.kind), []);
});

test("الرحلات العائدة لا تُنذر بتأشيرتها", () => {
  const gs = T.groupByEmployee([trip("z", -60, -40, -30, { returnConfirmedAt: "x" })], [], TODAY);
  assert.deepEqual(T.alerts(gs, TODAY), []);
  assert.equal(T.summary(gs, TODAY).visaSoon, 0);
});

test("الملخّص: مسافرون، قريبة، تأشيرات قريبة، مجدولة", () => {
  const gs = T.groupByEmployee([
    trip("a", -1, 5, 60), trip("b", -3, 3, 10), trip("c", 2, 9, 90), trip("d", 30, 40, 90), trip("e", -20, -10, 1),
    trip("f", -20, -10, 1, { returnConfirmedAt: "x" }),
  ], [], TODAY);
  /* e لم تُؤكَّد عودته: تأشيرته ما زالت تهمّ. f عاد: لا تُحسب. */
  assert.deepEqual(T.summary(gs, TODAY), { traveling: 2, soon: 1, scheduled: 1, visaSoon: 2, overdue: 1 });
});

/* ─── البحث ─── */
test("البحث بالاسم والرقم الوظيفي والإقامة والجواز، مع تطبيع العربية والأرقام", () => {
  const [g] = T.groupByEmployee([trip("1001", 1, 2, 3)], PEOPLE, TODAY);
  for (const q of ["أحمد", "احمد", "محمد علي", "1001", "١٠٠١", "2400000001", "p1000001", ""]) assert.ok(T.matches(g, q), q);
  for (const q of ["سعود", "D-2", "9999"]) assert.ok(!T.matches(g, q), q);
});

test("المصدر: ذروة وأجير في مجموعة واحدة لكل شخص، وفلتر المصدر", () => {
  const gs = T.groupByEmployee([trip("1001", 1, 2, 3), trip("1002", 10, 12, 30), trip("1002", 40, 50, 60)], PEOPLE, TODAY);
  assert.equal(gs.length, 2);
  const droua = gs.find((g) => g.employee.source === "droua");
  assert.equal(droua.trips.length, 2);
  assert.equal(droua.employee.name, "سعود عبدالله");
  assert.deepEqual(gs.filter((g) => T.sourceMatches(g.employee, "ajeer")).map((g) => g.id), ["1001"]);
  assert.equal(gs.filter((g) => T.sourceMatches(g.employee, "all")).length, 2);
  assert.deepEqual(T.SOURCES, { droua: "ذروة", ajeer: "أجير" });
  /* شخص غير موجود في الدليل (لا يُفترض): مجموعة باسم بديل، لا انهيار. */
  assert.match(T.groupByEmployee([trip("77", 1, 2, 3)], PEOPLE, TODAY)[0].employee.name, /77/);
});

/* ─── التحقّق ─── */
test("التحقّق: الموظف والتواريخ إلزامية، والنهاية لا تسبق البداية، والاختيارية بحدود", () => {
  const ok = { person: "ajeer:1", startDate: "2026-11-05", endDate: "2026-12-05", visaExpiryDate: "2026-12-30" };
  assert.equal(T.validateTrip(ok), null);
  assert.match(T.validateTrip({ ...ok, person: "" }), /الموظف/);
  assert.equal(T.validateTrip({ ...ok, person: "", staffId: "5" }), null);
  assert.match(T.validateTrip({ ...ok, startDate: "2026-02-30" }), /بداية/);
  assert.match(T.validateTrip({ ...ok, endDate: "2026-11-01" }), /النهاية/);
  assert.match(T.validateTrip({ ...ok, visaExpiryDate: "" }), /التأشيرة/);
  assert.match(T.validateTrip({ ...ok, notes: "x".repeat(1001) }), /الملاحظات/);
  assert.equal(T.validateTrip({ ...ok, endDate: ok.startDate }), null);
  assert.equal(T.overlaps({ staffId: "1", startDate: "2026-01-01", endDate: "2026-01-10" }, { staffId: "1", startDate: "2026-01-10", endDate: "2026-01-20" }), true);
  assert.equal(T.overlaps({ staffId: "1", startDate: "2026-01-01", endDate: "2026-01-10" }, { staffId: "2", startDate: "2026-01-05", endDate: "2026-01-20" }), false);
  /* موظف أجير بلا صفّ دليل بعد (لا رحلات): لا تداخل ممكن. */
  assert.equal(T.overlaps({ staffId: null, startDate: "2026-01-01", endDate: "2026-01-10" }, { staffId: null, startDate: "2026-01-01", endDate: "2026-01-10" }), false);
});

/* ─── الخادم: وحدة البيانات والموجّه على قاعدة مُزيَّفة في الذاكرة ─── */
/* موظفو أجير في employees، وموظف ذروة في الدليل. مُختلَقون. */
const AJEER = [
  { eid: "1001", name: "أحمد محمد علي", job: "عامل", iqama: "2400000001", passport: "P1000001" },
  { eid: "1003", name: "لامين مولا", job: "عامل تحميل وتنزيل", iqama: "2400000003", passport: "" },
];
function memoryDb({ missing = false } = {}) {
  const db = { trips: [], audit: [], nextId: 1, nextDir: 51,
    dir: [{ id: 50, source_type: "droua", source_employee_eid: null, employee_number: "D-1", name: "خالد السعيد", job_title: "مدير الموارد البشرية", department: "الموارد البشرية", identity_number: "1000000001", active: true }] };
  const row = (t) => ({ ...t, id: String(t.id) });
  const empRow = (e) => ({ eid: e.eid, name: e.name, data: { "اسم العامل": e.name, "المهنة": e.job, "رقم الإقامة": e.iqama, "رقم الجواز": e.passport, "الراتب الأساسي": 9999 } });
  const sql = makeFakeSql((call) => {
    const { text, values: v } = call;
    if (/INSERT INTO audit_log/.test(text)) { db.audit.push(v); return []; }
    if (/FROM settings/.test(text)) return [];
    if (missing && /staff_directory|employee_travel/.test(text)) { const e = new Error('relation "staff_directory" does not exist'); e.code = "42P01"; throw e; }
    if (/^SELECT e\.eid, e\.data FROM employees e ORDER BY e\.id/.test(text)) return AJEER.map(empRow);
    if (/^SELECT eid, data FROM employees ORDER BY id/.test(text)) return AJEER.map(empRow);
    if (/FROM staff_directory ORDER BY id/.test(text)) return db.dir.map((d) => ({ ...d }));
    if (/^SELECT id, active FROM staff_directory WHERE id = \?/.test(text)) return db.dir.filter((d) => String(d.id) === String(v[0]));
    if (/^SELECT eid, name, data FROM employees WHERE eid = \?/.test(text)) return AJEER.filter((e) => e.eid === v[0]).map(empRow);
    if (/^INSERT INTO staff_directory/.test(text)) {
      let d = db.dir.find((x) => x.source_employee_eid === v[0]);
      if (d) Object.assign(d, { name: v[1], job_title: v[2] });
      else db.dir.push(d = { id: db.nextDir++, source_type: "ajeer", source_employee_eid: v[0], employee_number: null, name: v[1], job_title: v[2], department: null, identity_number: null, active: true });
      return [{ id: d.id }];
    }
    if (/^SELECT id FROM employee_travel WHERE staff_id = \?::bigint/.test(text)) {
      const [sid, end, start, ex1] = v;
      return db.trips.filter((t) => String(t.staff_id) === String(sid) && t.start_date <= end && t.end_date >= start && (ex1 == null || String(t.id) !== String(ex1))).map((t) => ({ id: t.id }));
    }
    if (/^INSERT INTO employee_travel/.test(text)) {
      const t = { id: db.nextId++, staff_id: v[0], start_date: v[1], end_date: v[2], visa_expiry_date: v[3], visa_number: v[4], visa_type: v[5], destination: v[6], notes: v[7], return_confirmed_at: v[8], created_by: v[10], created_by_name: v[11] };
      db.trips.push(t); return [row(t)];
    }
    if (/^UPDATE employee_travel SET staff_id/.test(text)) {
      const t = db.trips.find((x) => String(x.id) === String(v[v.length - 1])); if (!t) return [];
      Object.assign(t, { staff_id: v[0], start_date: v[1], end_date: v[2], visa_expiry_date: v[3], visa_number: v[4], visa_type: v[5], destination: v[6], notes: v[7] });
      if (v[8]) t.return_confirmed_at = null;
      return [row(t)];
    }
    if (/^UPDATE employee_travel SET return_confirmed_at = now\(\)/.test(text)) {
      const t = db.trips.find((x) => String(x.id) === String(v[v.length - 1])); t.return_confirmed_at = "2026-10-28T00:00:00Z"; return [row(t)];
    }
    if (/^DELETE FROM employee_travel/.test(text)) {
      const i = db.trips.findIndex((x) => String(x.id) === String(v[0])); if (i < 0) return [];
      const [t] = db.trips.splice(i, 1); return [{ id: t.id, staff_id: t.staff_id }];
    }
    if (/FROM employee_travel WHERE id/.test(text)) return db.trips.filter((x) => String(x.id) === String(v[0])).map(row);
    if (/FROM employee_travel ORDER BY/.test(text)) return db.trips.map(row);
    throw new Error("unexpected SQL: " + text);
  });
  return { db, sql };
}

/* api/app.js بجلسة وقاعدة مُزيَّفتين — يُحمَّل مرّة في عملية هذا الملف. */
const harness = { user: null, sql: null };
function stub(rel, exports) {
  const id = require.resolve(path.join(ROOT, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub("lib/db.js", { getSql: () => harness.sql });
stub("lib/auth/requireAuth.js", { requireUser: async () => harness.user });
const handler = require("../api/app.js");

async function call(method, { body, query = {}, role = "hr", permissions } = {}) {
  harness.user = { id: "u1", name: "موظف الموارد", email: "hr@example.com", role };
  harness.user.permissions = permissions || resolvePermissions(harness.user);
  if (permissions) harness.user.permissions = permissions;
  const req = { method, query: { kind: "api", apiPath: "data/staff-travel", ...query }, headers: {}, body };
  const res = { code: 0, json: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.json = o; return this; } };
  await handler(req, res);
  return res;
}

/* الموجّه يحسب «اليوم» بتوقيت الرياض من الساعة الحقيقية، فتواريخه هنا
   نسبية لذلك اليوم لا لـTODAY الثابت. */
const RIYADH_TODAY = require("../lib/data/staffTravel.js").today();
const rd = (n) => { const [y, m, dd] = RIYADH_TODAY.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const NEW = { person: "ajeer:1001", startDate: rd(3), endDate: rd(30), visaExpiryDate: rd(20), visaNumber: "VN-123456789", visaType: "خروج وعودة", destination: "القاهرة" };

test("الموجّه: رحلة لموظف أجير تُجسِّد صفّه في الدليل، والدليل موحَّد بلا تكرار ولا رواتب", async () => {
  const m = memoryDb(); harness.sql = m.sql;
  const r = await call("POST", { body: NEW });
  assert.equal(r.code, 200, JSON.stringify(r.json));
  const ajeerRow = m.db.dir.find((d) => d.source_employee_eid === "1001");
  assert.ok(ajeerRow, "صفّ أجير يُنشأ عند أوّل رحلة");
  assert.equal(r.json.item.staffId, String(ajeerRow.id));
  assert.equal(ajeerRow.name, "أحمد محمد علي");
  /* رحلة ثانية للشخص نفسه لا تُنشئ صفًّا ثانيًا. */
  assert.equal((await call("POST", { body: { ...NEW, startDate: rd(60), endDate: rd(80), visaExpiryDate: rd(90) } })).code, 200);
  assert.equal(m.db.dir.filter((d) => d.source_employee_eid === "1001").length, 1);

  const g = await call("GET");
  assert.equal(g.code, 200);
  assert.equal(g.json.items.length, 2);
  assert.equal(g.json.setupRequired, false);
  assert.equal(g.json.thresholds.SOON_DAYS, 7);
  const people = g.json.people;
  assert.deepEqual(Object.keys(people[0]).sort(), ["active", "department", "identity", "job", "key", "missing", "name", "number", "passport", "source", "staffId"]);
  /* اثنان من أجير + واحد من ذروة — صاحب الرحلات يظهر مرّة واحدة. */
  assert.equal(people.length, 3);
  assert.equal(people.filter((p) => p.number === "1001").length, 1);
  assert.equal(people.find((p) => p.number === "1001").staffId, String(ajeerRow.id));
  assert.equal(people.find((p) => p.number === "1003").staffId, null);
  const droua = people.find((p) => p.source === "droua");
  assert.deepEqual([droua.key, droua.name, droua.job], ["staff:50", "خالد السعيد", "مدير الموارد البشرية"]);
  assert.ok(!JSON.stringify(people).includes("9999"));
});

test("الموجّه: رحلة لموظف ذروة، وتعديل الشخص، ومفاتيح فاسدة", async () => {
  const m = memoryDb(); harness.sql = m.sql;
  const r = await call("POST", { body: { ...NEW, person: "staff:50" } });
  assert.equal(r.code, 200, JSON.stringify(r.json));
  assert.equal(r.json.item.staffId, "50");
  assert.equal(m.db.dir.length, 1, "ذروة: لا صفّ جديد");
  const u = await call("PUT", { body: { id: r.json.item.id, person: "ajeer:1003" } });
  assert.equal(u.code, 200, JSON.stringify(u.json));
  assert.equal(u.json.item.staffId, String(m.db.dir.find((d) => d.source_employee_eid === "1003").id));
  /* تعديل بلا person يُبقي صاحب الرحلة. */
  const u2 = await call("PUT", { body: { id: r.json.item.id, notes: "ملاحظة" } });
  assert.equal(u2.json.item.staffId, u.json.item.staffId);
  for (const [person, re] of [["ajeer:7777", /غير موجود/], ["staff:999", /غير موجود/], ["bogus", /اختر الموظف/], ["staff:1;x", /اختر الموظف/]]) {
    assert.match((await call("POST", { body: { ...NEW, person, startDate: rd(200), endDate: rd(210) } })).json.error, re, person);
  }
});

test("الموجّه: الهوية والجواز في الدليل لمن يملك employees:view فقط", async () => {
  harness.sql = memoryDb().sql;
  const hr = await call("GET");
  assert.equal(hr.json.people.find((p) => p.number === "1001").identity, "2400000001");
  const viewOnly = await call("GET", { role: "viewer", permissions: ["staff_travel:view"] });
  assert.equal(viewOnly.code, 200);
  assert.ok(viewOnly.json.people.every((p) => p.identity === "" && p.passport === ""));
});

test("الموجّه: موظف غير موجود، وتداخل التواريخ، وتواريخ فاسدة — كلها تُرفض", async () => {
  const m = memoryDb(); harness.sql = m.sql;
  assert.equal((await call("POST", { body: NEW })).code, 200);
  assert.match((await call("POST", { body: { ...NEW, person: "ajeer:7777" } })).json.error, /غير موجود/);
  assert.match((await call("POST", { body: { ...NEW, startDate: rd(10), endDate: rd(40) } })).json.error, /تتداخل/);
  assert.match((await call("POST", { body: { ...NEW, endDate: rd(1) } })).json.error, /النهاية/);
  /* رحلة ثانية للموظف نفسه بلا تداخل: مسموحة (Employee → Many). */
  assert.equal((await call("POST", { body: { ...NEW, startDate: rd(60), endDate: rd(80), visaExpiryDate: rd(90) } })).code, 200);
  assert.equal(m.db.trips.length, 2);
});

test("الموجّه: تعديل رحلة وحذفها وتأكيد العودة", async () => {
  const m = memoryDb(); harness.sql = m.sql;
  const id = (await call("POST", { body: NEW })).json.item.id;
  const u = await call("PUT", { body: { id, endDate: rd(45), destination: "عمّان" } });
  assert.equal(u.code, 200, JSON.stringify(u.json));
  assert.equal(u.json.item.endDate, rd(45));
  assert.equal(u.json.item.destination, "عمّان");
  assert.equal(u.json.item.visaNumber, "VN-123456789");
  /* رحلة لم تنتهِ: تأكيد العودة مرفوض. */
  assert.match((await call("POST", { body: { action: "confirm_return", id } })).json.error, /لم يحِن/);
  const past = (await call("POST", { body: { ...NEW, startDate: rd(-200), endDate: rd(-180), visaExpiryDate: rd(-170) } })).json.item;
  assert.ok(past.returnConfirmedAt, "رحلة تُسجَّل بعد انتهائها: يؤكّد مُدخِلها عودتها");
  /* رحلة انتهت اليوم أو قبله ولم تُؤكَّد: التأكيد مقبول. */
  const ending = (await call("POST", { body: { ...NEW, startDate: rd(-10), endDate: rd(0), visaExpiryDate: rd(20) } })).json.item;
  assert.equal(ending.returnConfirmedAt, null);
  const c = await call("POST", { body: { action: "confirm_return", id: ending.id } });
  assert.equal(c.code, 200, JSON.stringify(c.json));
  assert.ok(c.json.item.returnConfirmedAt);
  assert.equal((await call("DELETE", { body: { id: ending.id } })).code, 200);
  assert.equal((await call("DELETE", { body: { id } })).code, 200);
  assert.equal(m.db.trips.length, 1);
  assert.match((await call("DELETE", { body: { id } })).json.error, /غير موجودة/);
  assert.equal((await call("DELETE", { body: { id: "1; DROP TABLE x" } })).code, 400);
});

test("سجلّ التدقيق لا يحمل رقم التأشيرة", async () => {
  const m = memoryDb(); harness.sql = m.sql;
  const id = (await call("POST", { body: NEW })).json.item.id;
  await call("PUT", { body: { id, notes: "ملاحظة" } });
  await call("DELETE", { body: { id } });
  assert.ok(m.db.audit.length >= 3);
  assert.ok(m.db.audit.every((v) => !JSON.stringify(v).includes("VN-123456789")));
  assert.ok(m.db.audit.some((v) => v[0] === "staff_travel_created"));
});

test("قبل هجرة الدليل: القراءة فارغة مع setupRequired وموظفو أجير وحدهم، والكتابة برسالة واضحة", async () => {
  const m = memoryDb({ missing: true }); harness.sql = m.sql;
  const g = await call("GET");
  assert.equal(g.code, 200);
  assert.equal(g.json.setupRequired, true);
  assert.deepEqual(g.json.items, []);
  assert.deepEqual(g.json.people.map((p) => p.key), ["ajeer:1001", "ajeer:1003"]);
  const p = await call("POST", { body: NEW });
  assert.equal(p.code, 400);
  assert.match(p.json.error, /غير مكتملة/);
  /* عمود staff_id غائب (42703) يُعامَل مثل الجدول الغائب. */
  const { isMissingTable } = require("../lib/data/staffTravel.js");
  assert.ok(isMissingTable({ code: "42703", message: 'column "staff_id" does not exist' }));
});

/* ─── الصلاحيات ─── */
test("الصلاحيات: القسم staff_travel، HR كاملة، viewer وfinance بلا وصول", async () => {
  assert.deepEqual(SECTION_BY_KEY.staff_travel.actions, ["view", "create", "edit", "delete"]);
  assert.equal(PAGE_PERMISSION["staff-travel"], "staff_travel:view");
  for (const a of ["view", "create", "edit", "delete"]) assert.ok(defaultPermissionsForRole("hr").includes(`staff_travel:${a}`));
  for (const r of ["viewer", "finance"]) assert.ok(!defaultPermissionsForRole(r).some((p) => p.startsWith("staff_travel")), r);
  assert.ok(defaultPermissionsForRole("admin").includes("staff_travel:delete"));

  const m = memoryDb(); harness.sql = m.sql;
  assert.equal((await call("GET", { role: "viewer" })).code, 403);
  assert.equal((await call("GET", { role: "finance" })).code, 403);
  /* عرض فقط: يقرأ ولا يكتب ولا يؤكّد العودة. */
  const viewOnly = { role: "viewer", permissions: ["staff_travel:view"] };
  assert.equal((await call("GET", viewOnly)).code, 200);
  assert.equal((await call("POST", { ...viewOnly, body: NEW })).code, 403);
  assert.equal((await call("POST", { ...viewOnly, body: { action: "confirm_return", id: "1" } })).code, 403);
  assert.equal((await call("DELETE", { ...viewOnly, body: { id: "1" } })).code, 403);
  /* إضافة بلا حذف. */
  const creator = { role: "viewer", permissions: ["staff_travel:view", "staff_travel:create"] };
  const id = (await call("POST", { ...creator, body: NEW })).json.item.id;
  assert.equal((await call("DELETE", { ...creator, body: { id } })).code, 403);
  assert.equal((await call("PUT", { ...creator, body: { id, notes: "x" } })).code, 403);
  assert.equal(m.db.trips.length, 1);
});

test("الصفحة محروسة بالخادم: بلا صلاحية تحويل إلى الرئيسية", async () => {
  harness.sql = memoryDb().sql;
  const page = async (role, permissions) => {
    harness.user = { id: "u", role, permissions };
    harness.user.permissions = permissions || resolvePermissions(harness.user);
    const res = { headers: null, code: 0, body: "", writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b || ""; }, status(c) { this.code = c; return this; } };
    await handler({ method: "GET", query: { kind: "page", page: "staff-travel" }, headers: {} }, res);
    return res;
  };
  const denied = await page("viewer");
  assert.equal(denied.code, 302);
  assert.equal(denied.headers.Location, "/");
  const ok = await page("hr");
  assert.equal(ok.code, 200);
  assert.match(ok.body, /متابعة موظفي ذروة/);
});

/* ─── الربط والواجهة ─── */
test("الربط: مسار vercel، وصفحة مستقلة، ووجهة في «أقسام هذه الصفحة»، ولا دالّة جديدة", () => {
  const v = JSON.parse(read("vercel.json"));
  assert.ok(v.rewrites.some((r) => r.source === "/staff-travel.html" && r.destination === "/api/app?kind=page&page=staff-travel"));
  assert.deepEqual(Object.keys(v.functions), ["api/app.js"]);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "api")).filter((f) => f.endsWith(".js")), ["app.js"]);
  const nav = read("app-nav.js");
  assert.match(nav, /key: "staffTravel", href: "\/staff-travel\.html", label: "متابعة موظفي ذروة".*perm: "staff_travel:view".*group: "sections"/);
  /* موضعها بعد «الموظفون» مباشرة كما في التصميم المعتمد. */
  assert.ok(nav.indexOf('key: "staffTravel"') > nav.indexOf('key: "employees"') && nav.indexOf('key: "staffTravel"') < nav.indexOf('key: "ajeer"'));
  const shell = read("staff-travel-shell.html");
  for (const s of ["/staff-travel-status.js", "/staff-travel.js", "/staff-travel.css", "/app-nav.js", "/admin-ui.js"]) assert.ok(shell.includes(s), s);
  assert.match(shell, /dir="rtl"/);
});

test("الواجهة لا تحسب الحالة بنفسها، والحذف بتأكيد، ولا تخزين محلّي", () => {
  const js = read("staff-travel.js");
  assert.match(js, /AdminUI\.confirmDanger\(/);
  assert.match(js, /T\.tripStatus\(/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|console\.log/);
  assert.doesNotMatch(js, /new Date\(\)\s*[<>]/);
});

test("الهجرة: جدول مستقلّ بقيود وفهارس وتراجع — لا audit_log", () => {
  const { STATEMENTS, ROLLBACK } = require("../scripts/setup-staff-travel.js");
  const all = STATEMENTS.map((s) => s.sql).join("\n");
  assert.match(all, /CREATE TABLE IF NOT EXISTS employee_travel/);
  assert.match(all, /REFERENCES employees\(eid\) ON UPDATE CASCADE ON DELETE RESTRICT/);
  assert.doesNotMatch(all, /ON DELETE CASCADE|ON DELETE SET NULL/);
  assert.match(all, /CHECK \(end_date >= start_date\)/);
  for (const ix of ["idx_employee_travel_employee", "idx_employee_travel_end", "idx_employee_travel_visa"]) assert.match(all, new RegExp(ix));
  assert.doesNotMatch(all, /audit_log|DROP |DELETE FROM|ALTER TABLE employees/);
  assert.ok(STATEMENTS.every((s) => /IF NOT EXISTS/.test(s.sql)));
  assert.deepEqual(ROLLBACK.map((s) => s.sql), ["DROP TABLE IF EXISTS employee_travel"]);
  assert.doesNotMatch(read("lib/data/staffTravel.js"), /(INSERT INTO|FROM|UPDATE) audit_log/);
});

test("لا بيانات وهمية في الصفحة: لا وضع عرض تجريبي ولا أسماء مضمَّنة", () => {
  const js = read("staff-travel.js");
  assert.doesNotMatch(js, /demo|enterDemo|عرض تجريبي/i);
  assert.doesNotMatch(js, /state\.people = \[/);
  assert.match(js, /state\.people = j\.people/);
});
