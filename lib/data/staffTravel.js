const { getSql } = require("../db");
const StaffTravel = require("../../staff-travel-status.js");

/* متابعة سفر موظفي ذروة — /api/data/staff-travel.
   =========================================================================
   جدول تشغيلي مستقلّ (employee_travel — scripts/setup-staff-travel.js)،
   رحلة لكل صفّ، ورحلات كثيرة للموظف الواحد. لا audit_log: ذاك سجلّ أحداث،
   وهذه بيانات يُعمل عليها.

   الربط بـemployees.eid. اسم الموظف ومسمّاه يُقرآن حيّين من سجلّ الموظفين
   عند كل عرض، فلا تُنسخ بياناته في الرحلة ولا تتقادم.

   الحالة لا تُخزَّن — تُشتقّ في staff-travel-status.js من التواريخ.

   قبل إنشاء الجدول (الهجرة تنتظر الاعتماد) تعود القراءة فارغة مع
   setupRequired، وترفض الكتابة برسالة واضحة — لا خطأ 500 ولا صفحة مكسورة.

   الصلاحيات: القسم staff_travel، والموجّه في api/app.js يحوّل الفعل إلى
   view/create/edit/delete. أرقام التأشيرات لا تُكتب في أي سجلّ. */
const section = "staff_travel";
const TABLE_MISSING = "جدول متابعة السفر غير مُنشأ بعد — الهجرة بانتظار الاعتماد";

const F_EID = "الرقم الوظيفي";
const F_NAME = "اسم العامل";
const F_JOB = "المهنة";
const F_IQAMA = "رقم الإقامة";
const F_PASSPORT = "رقم الجواز";

/* 42P01 = undefined_table. */
function isMissingTable(err) {
  return !!err && (err.code === "42P01" || /employee_travel.*does not exist/i.test(String(err.message || "")));
}

const COLS = `id, employee_eid, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
  to_char(visa_expiry_date,'YYYY-MM-DD') AS visa_expiry_date, visa_number, visa_type, destination, notes,
  return_confirmed_at, return_confirmed_by, created_by, created_by_name, updated_by, created_at, updated_at`;

function toItem(r) {
  return {
    id: String(r.id),
    employeeEid: r.employee_eid,
    startDate: r.start_date,
    endDate: r.end_date,
    visaExpiryDate: r.visa_expiry_date,
    visaNumber: r.visa_number || "",
    visaType: r.visa_type || "",
    destination: r.destination || "",
    notes: r.notes || "",
    returnConfirmedAt: r.return_confirmed_at || null,
    createdByName: r.created_by_name || "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const clean = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

function normalize(input) {
  const t = {
    employeeEid: clean(input && input.employeeEid),
    startDate: clean(input && input.startDate),
    endDate: clean(input && input.endDate),
    visaExpiryDate: clean(input && input.visaExpiryDate),
    visaNumber: clean(input && input.visaNumber),
    visaType: clean(input && input.visaType),
    destination: clean(input && input.destination),
    notes: clean(input && input.notes),
  };
  const err = StaffTravel.validateTrip(t);
  if (err) throw new Error(err);
  return t;
}

/* دليل الموظفين المختصر لاختيار الموظف والبحث — لا السجلّ الكامل:
   الصفحة لا تحتاج رواتب ولا حسابات بنكية. */
async function directory(sql) {
  const rows = await sql`SELECT eid, data FROM employees ORDER BY id`;
  return rows.map((r) => ({
    eid: String(r.eid),
    name: (r.data && r.data[F_NAME]) || "",
    job: (r.data && r.data[F_JOB]) || "",
    iqama: (r.data && r.data[F_IQAMA]) ? String(r.data[F_IQAMA]) : "",
    passport: (r.data && r.data[F_PASSPORT]) ? String(r.data[F_PASSPORT]) : "",
  })).filter((e) => e.eid);
}

async function listTrips(sql) {
  try {
    const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM employee_travel ORDER BY start_date DESC, id DESC`;
    return { items: rows.map(toItem), setupRequired: false };
  } catch (err) {
    if (isMissingTable(err)) return { items: [], setupRequired: true };
    throw err;
  }
}

async function readThresholds(sql) {
  try {
    const rows = await sql`SELECT value FROM settings WHERE key = 'staff_travel_thresholds'`;
    return StaffTravel.thresholds(rows[0] && rows[0].value);
  } catch {
    return StaffTravel.thresholds();
  }
}

/* كل ما تحتاجه الصفحة في طلب واحد. */
async function overview(sqlArg) {
  const sql = sqlArg || getSql();
  const [trips, employees, thresholds] = await Promise.all([listTrips(sql), directory(sql), readThresholds(sql)]);
  return { items: trips.items, setupRequired: trips.setupRequired, employees, thresholds };
}

async function list() { return (await listTrips(getSql())).items; }

async function get(id, sqlArg) {
  const sql = sqlArg || getSql();
  const rows = await guard(() => sql`SELECT ${sql.unsafe(COLS)} FROM employee_travel WHERE id = ${id}`);
  return rows[0] ? toItem(rows[0]) : null;
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isMissingTable(err)) throw new Error(TABLE_MISSING);
    throw err;
  }
}

async function assertEmployee(sql, eid) {
  const rows = await sql`SELECT eid FROM employees WHERE eid = ${eid}`;
  if (!rows[0]) throw new Error("الموظف غير موجود في سجلّ الموظفين");
}

async function assertNoOverlap(sql, t, exceptId) {
  const rows = await guard(() => sql`
    SELECT id FROM employee_travel
     WHERE employee_eid = ${t.employeeEid} AND start_date <= ${t.endDate}::date AND end_date >= ${t.startDate}::date
       AND (${exceptId}::bigint IS NULL OR id <> ${exceptId}::bigint)
     LIMIT 1`);
  if (rows[0]) throw new Error("للموظف رحلة أخرى مسجّلة تتداخل مع هذه التواريخ");
}

async function create(input, actor, sqlArg) {
  const sql = sqlArg || getSql();
  const t = normalize(input);
  await assertEmployee(sql, t.employeeEid);
  await assertNoOverlap(sql, t, null);
  /* رحلة تُسجَّل بعد انتهائها سجلٌّ تاريخي: عودتها مؤكَّدة ضمنًا، فلا
     تُطلق تنبيه «تجاوز تاريخ العودة». */
  const past = t.endDate < StaffTravel.todayIso();
  const rows = await guard(() => sql`
    INSERT INTO employee_travel
      (employee_eid, start_date, end_date, visa_expiry_date, visa_number, visa_type, destination, notes,
       return_confirmed_at, return_confirmed_by, created_by, created_by_name, updated_by)
    VALUES (${t.employeeEid}, ${t.startDate}::date, ${t.endDate}::date, ${t.visaExpiryDate}::date,
       ${t.visaNumber}, ${t.visaType}, ${t.destination}, ${t.notes},
       ${past ? new Date().toISOString() : null}::timestamptz, ${past ? actorName(actor) : null},
       ${actorId(actor)}, ${actorName(actor)}, ${actorId(actor)})
    RETURNING ${sql.unsafe(COLS)}`);
  return toItem(rows[0]);
}

async function update(id, input, actor, sqlArg) {
  const sql = sqlArg || getSql();
  const before = await get(id, sql);
  if (!before) throw new Error("الرحلة غير موجودة");
  const t = normalize({ ...before, ...input });
  if (t.employeeEid !== before.employeeEid) await assertEmployee(sql, t.employeeEid);
  await assertNoOverlap(sql, t, id);
  /* تمديد رحلة إلى ما بعد اليوم يعيدها نشطة، فيسقط تأكيد العودة القديم. */
  const reopen = t.endDate >= StaffTravel.todayIso();
  const rows = await guard(() => sql`
    UPDATE employee_travel SET
      employee_eid = ${t.employeeEid}, start_date = ${t.startDate}::date, end_date = ${t.endDate}::date,
      visa_expiry_date = ${t.visaExpiryDate}::date, visa_number = ${t.visaNumber}, visa_type = ${t.visaType},
      destination = ${t.destination}, notes = ${t.notes},
      return_confirmed_at = CASE WHEN ${reopen} THEN NULL ELSE return_confirmed_at END,
      return_confirmed_by = CASE WHEN ${reopen} THEN NULL ELSE return_confirmed_by END,
      updated_by = ${actorId(actor)}, updated_at = now()
    WHERE id = ${id}
    RETURNING ${sql.unsafe(COLS)}`);
  return toItem(rows[0]);
}

/* تأكيد العودة الفعلية — لا يغيّر الحالة، يُسكت تنبيه التأخّر وحده. */
async function confirmReturn(id, actor, sqlArg) {
  const sql = sqlArg || getSql();
  const before = await get(id, sql);
  if (!before) throw new Error("الرحلة غير موجودة");
  if (before.endDate >= StaffTravel.todayIso()) throw new Error("لم يحِن موعد العودة بعد — عدّل تاريخ النهاية إن عاد مبكرًا");
  const rows = await guard(() => sql`
    UPDATE employee_travel SET return_confirmed_at = now(), return_confirmed_by = ${actorName(actor)},
      updated_by = ${actorId(actor)}, updated_at = now()
    WHERE id = ${id} RETURNING ${sql.unsafe(COLS)}`);
  return toItem(rows[0]);
}

async function remove(id, actor, sqlArg) {
  const sql = sqlArg || getSql();
  const rows = await guard(() => sql`DELETE FROM employee_travel WHERE id = ${id} RETURNING id, employee_eid`);
  if (!rows[0]) throw new Error("الرحلة غير موجودة");
  return { id: String(rows[0].id), employeeEid: rows[0].employee_eid };
}

function actorId(a) { return a && a.id != null ? String(a.id) : null; }
function actorName(a) { return a ? a.name || a.email || null : null; }

module.exports = { section, TABLE_MISSING, isMissingTable, normalize, overview, list, get, create, update, confirmReturn, remove };
