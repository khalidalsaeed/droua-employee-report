const { getSql } = require("../db");
const StaffTravel = require("../../staff-travel-status.js");
const directory = require("./staffDirectory");

/* متابعة سفر موظفي ذروة — /api/data/staff-travel.
   =========================================================================
   جدول تشغيلي مستقلّ (employee_travel — scripts/setup-staff-travel.js)،
   رحلة لكل صفّ، ورحلات كثيرة للموظف الواحد. لا audit_log: ذاك سجلّ أحداث،
   وهذه بيانات يُعمل عليها.

   الربط بـstaff_directory.id (staff_id) — الدليل الموحَّد لموظفي ذروة وأجير
   (lib/data/staffDirectory.js). الواجهة ترسل مفتاح الشخص ("ajeer:<eid>" أو
   "staff:<id>") والخادم يحوّله إلى staff_id قبل الكتابة.

   الحالة لا تُخزَّن — تُشتقّ في staff-travel-status.js من التواريخ.

   قبل اكتمال البنية (الجدول، أو الدليل وعمود staff_id) تعود القراءة فارغة مع
   setupRequired، وترفض الكتابة برسالة واضحة — لا خطأ 500 ولا صفحة مكسورة.

   الصلاحيات: القسم staff_travel، والموجّه في api/app.js يحوّل الفعل إلى
   view/create/edit/delete. أرقام التأشيرات لا تُكتب في أي سجلّ. */
const section = "staff_travel";
const TABLE_MISSING = "بنية متابعة السفر غير مكتملة بعد — الهجرة بانتظار التطبيق";

/* «اليوم» بتوقيت الرياض لا بتوقيت الخادم (UTC على Vercel): رحلة تنتهي
   اليوم في الرياض لا تُعامَل كأنها انتهت أمس. */
function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
}

/* 42P01 = undefined_table (الجدول أو الدليل)، 42703 = undefined_column
   (staff_id قبل هجرة الدليل). */
function isMissingTable(err) {
  return !!err && (err.code === "42P01" || err.code === "42703"
    || /(employee_travel|staff_directory|staff_id).*does not exist/i.test(String(err.message || "")));
}

const COLS = `id, staff_id, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
  to_char(visa_expiry_date,'YYYY-MM-DD') AS visa_expiry_date, visa_number, visa_type, destination, notes,
  return_confirmed_at, return_confirmed_by, created_by, created_by_name, updated_by, created_at, updated_at`;

function toItem(r) {
  return {
    id: String(r.id),
    staffId: String(r.staff_id),
    startDate: r.start_date,
    endDate: r.end_date,
    visaExpiryDate: r.visa_expiry_date,
    visaNumber: r.visa_number || "",
    visaType: r.visa_type || "",
    destination: r.destination || "",
    notes: r.notes || "",
    returnConfirmedAt: r.return_confirmed_at || null,
    returnConfirmedBy: r.return_confirmed_by || "",
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
    person: clean(input && input.person),
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

/* الدليل الموحَّد المختصر (ذروة + أجير) — لا السجلّ الكامل: لا رواتب ولا
   حسابات. قبل هجرة الدليل: موظفو أجير وحدهم، ليبقى العرض سليمًا. */
async function people(sql, opts) {
  try {
    return await directory.listPeople(sql, opts);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    const rows = await sql`SELECT eid, data FROM employees ORDER BY id`;
    return rows.map((r) => ({
      key: `ajeer:${r.eid}`, staffId: null, source: "ajeer", number: String(r.eid),
      name: (r.data && r.data["اسم العامل"]) || "", job: (r.data && r.data["المهنة"]) || "",
      department: "", identity: "", passport: "", active: true, missing: false,
    }));
  }
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

/* كل ما تحتاجه الصفحة في طلب واحد. includeIdentity: لمن يملك employees:view. */
async function overview(sqlArg, opts = {}) {
  const sql = sqlArg || getSql();
  const [trips, list, thresholds] = await Promise.all([listTrips(sql), people(sql, opts), readThresholds(sql)]);
  return { items: trips.items, setupRequired: trips.setupRequired, people: list, thresholds };
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

async function assertNoOverlap(sql, t, staffId, exceptId) {
  const rows = await guard(() => sql`
    SELECT id FROM employee_travel
     WHERE staff_id = ${staffId}::bigint AND start_date <= ${t.endDate}::date AND end_date >= ${t.startDate}::date
       AND (${exceptId}::bigint IS NULL OR id <> ${exceptId}::bigint)
     LIMIT 1`);
  if (rows[0]) throw new Error("للموظف رحلة أخرى مسجّلة تتداخل مع هذه التواريخ");
}

async function create(input, actor, sqlArg) {
  const sql = sqlArg || getSql();
  const t = normalize(input);
  const staffId = await guard(() => directory.resolvePerson(sql, t.person));
  await assertNoOverlap(sql, t, staffId, null);
  /* رحلة تُسجَّل بعد انتهائها سجلٌّ تاريخي: يؤكّد عودتَها مُدخِلُها نفسه
     عند الإضافة (return_confirmed_by = اسمه)، فتظهر «عاد» لا «بانتظار التأكيد». */
  const past = t.endDate < today();
  const rows = await guard(() => sql`
    INSERT INTO employee_travel
      (staff_id, start_date, end_date, visa_expiry_date, visa_number, visa_type, destination, notes,
       return_confirmed_at, return_confirmed_by, created_by, created_by_name, updated_by)
    VALUES (${staffId}::bigint, ${t.startDate}::date, ${t.endDate}::date, ${t.visaExpiryDate}::date,
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
  const t = normalize({ person: `staff:${before.staffId}`, ...before, ...input });
  const staffId = await guard(() => directory.resolvePerson(sql, t.person));
  await assertNoOverlap(sql, t, staffId, id);
  /* تمديد رحلة إلى ما بعد اليوم يعيدها نشطة، فيسقط تأكيد العودة القديم. */
  const reopen = t.endDate > today();
  const rows = await guard(() => sql`
    UPDATE employee_travel SET
      staff_id = ${staffId}::bigint, start_date = ${t.startDate}::date, end_date = ${t.endDate}::date,
      visa_expiry_date = ${t.visaExpiryDate}::date, visa_number = ${t.visaNumber}, visa_type = ${t.visaType},
      destination = ${t.destination}, notes = ${t.notes},
      return_confirmed_at = CASE WHEN ${reopen} THEN NULL ELSE return_confirmed_at END,
      return_confirmed_by = CASE WHEN ${reopen} THEN NULL ELSE return_confirmed_by END,
      updated_by = ${actorId(actor)}, updated_at = now()
    WHERE id = ${id}
    RETURNING ${sql.unsafe(COLS)}`);
  return toItem(rows[0]);
}

/* تأكيد العودة الفعلية: ينقل الرحلة من «بانتظار تأكيد العودة» إلى «عاد».
   متاح من يوم النهاية فصاعدًا؛ العودة المبكرة تُسجَّل بتعديل تاريخ النهاية. */
async function confirmReturn(id, actor, sqlArg) {
  const sql = sqlArg || getSql();
  const before = await get(id, sql);
  if (!before) throw new Error("الرحلة غير موجودة");
  if (before.endDate > today()) throw new Error("لم يحِن موعد العودة بعد — عدّل تاريخ النهاية إن عاد مبكرًا");
  const rows = await guard(() => sql`
    UPDATE employee_travel SET return_confirmed_at = now(), return_confirmed_by = ${actorName(actor)},
      updated_by = ${actorId(actor)}, updated_at = now()
    WHERE id = ${id} RETURNING ${sql.unsafe(COLS)}`);
  return toItem(rows[0]);
}

async function remove(id, actor, sqlArg) {
  const sql = sqlArg || getSql();
  const rows = await guard(() => sql`DELETE FROM employee_travel WHERE id = ${id} RETURNING id, staff_id`);
  if (!rows[0]) throw new Error("الرحلة غير موجودة");
  return { id: String(rows[0].id), staffId: String(rows[0].staff_id) };
}

function actorId(a) { return a && a.id != null ? String(a.id) : null; }
function actorName(a) { return a ? a.name || a.email || null : null; }

module.exports = { today, section, TABLE_MISSING, isMissingTable, normalize, overview, list, get, create, update, confirmReturn, remove };
