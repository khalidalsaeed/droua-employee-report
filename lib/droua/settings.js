/* ─── إعدادات الشهر: قاسمُ ساعة العمل الإضافي، وإجازات الشهر ───────────
   =========================================================================
   بيانان يُدخلهما المستخدم بيده، ولا يُستنتجان من الملفّات:

   ① **قاسم الساعة** (8 أو 10). سياسةُ الموظّف لا واقعُ يومه. وعمود
     «إجمالي الساعات المقرّرة» في ملفّ العمل الإضافي يحمل 0 و8 و10 و11 و12
     في العيّنة الواحدة — فاستنتاجُه منه يُنتج أجرَ ساعةٍ خاطئًا يبدو
     صحيحًا، ثمّ فرقًا ماليًّا مخترَعًا يُطارده محاسبٌ لا وجود له. فمن لا
     قاسم له **لا تُقيَّم** قاعدتُه المالية.
     ويعيش خارج الشهر: سياسةٌ تثبت للموظّف حتى تُغيَّر.

   ② **إجازات الشهر**. غرضُها واحد لا يتعدّاه: أن يُفسَّر غيابُ الموظّف من
     المسير بإجازةٍ مسجَّلة بدل أن يُبلَّغ عنه خطأً. وتعيش **داخل الشهر**:
     الإجازة واقعةٌ في شهرٍ بعينه لا سمةٌ دائمة.

   ⛔ ولا اسم هنا ولا هويّة ولا حساب: الرقم الوظيفيّ وحده. */

const crypto = require("crypto");
const gateContext = require("./gateContext");

const DIVISORS = Object.freeze([8, 10]);
const EMP_NO_RE = /^\S{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NOTE = 500;

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const assertEmpNo = (raw) => {
  const value = String(raw || "").trim();
  if (!EMP_NO_RE.test(value)) throw fail("رقم وظيفيّ غير صالح", "bad_emp_no");
  return value;
};
const assertRunId = (raw) => {
  const value = String(raw || "");
  if (!UUID_RE.test(value)) throw fail("runId غير صالح", "bad_run_id");
  return value;
};
/* تاريخٌ نصًّا بصيغة ISO لا كائن Date: المناطق الزمنية تُزحزح اليوم يومًا
   كاملًا، وإجازةٌ تنتهي «أمس» تُسكت غيابًا لا تفسّره أو تفشل في تفسير ما
   تفسّره. والمقارنة نصّية فتبقى في التقويم الذي كُتبت فيه. */
const assertDate = (raw) => {
  const value = String(raw || "").trim();
  if (!DATE_RE.test(value)) throw fail("تاريخ غير صالح", "bad_date");
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw fail("تاريخ غير صالح", "bad_date");
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw fail("تاريخ غير صالح", "bad_date");
  return value;
};

/* ── قاسم الساعة ─────────────────────────────────────────────────────── */

async function listDivisors(sql) {
  gateContext.requireGate();
  const rows = await sql`SELECT emp_no, overtime_divisor, updated_at
    FROM droua_employee_settings ORDER BY emp_no`;
  return (rows || []).map((r) => ({
    empNo: r.emp_no,
    overtimeDivisor: Number(r.overtime_divisor),
    updatedAt: r.updated_at || null,
  }));
}

/* خريطةٌ للمحرّك: رقمٌ ← قاسم. ومن ليس فيها لا قاسم له. */
async function divisorMap(sql) {
  const out = new Map();
  for (const row of await listDivisors(sql)) out.set(row.empNo, row.overtimeDivisor);
  return out;
}

async function setDivisor(sql, { empNo, overtimeDivisor }, ctx = {}) {
  gateContext.requireGate();
  const no = assertEmpNo(empNo);
  const divisor = Number(overtimeDivisor);
  if (!DIVISORS.includes(divisor)) throw fail("القاسم إمّا 8 أو 10", "bad_divisor");
  const rows = await sql`
    INSERT INTO droua_employee_settings (emp_no, overtime_divisor, updated_at, updated_by)
    VALUES (${no}, ${divisor}, now(), ${ctx.actorId || null})
    ON CONFLICT (emp_no) DO UPDATE
      SET overtime_divisor = ${divisor}, updated_at = now(), updated_by = ${ctx.actorId || null}
    RETURNING emp_no, overtime_divisor`;
  const row = rows && rows[0];
  return { empNo: row.emp_no, overtimeDivisor: Number(row.overtime_divisor) };
}

async function clearDivisor(sql, empNo) {
  gateContext.requireGate();
  const no = assertEmpNo(empNo);
  const rows = await sql`DELETE FROM droua_employee_settings
    WHERE emp_no = ${no} RETURNING emp_no`;
  return { deleted: Boolean(rows && rows.length) };
}

/* ── إجازات الشهر ────────────────────────────────────────────────────── */

async function listLeaves(sql, runId) {
  gateContext.requireGate();
  const rows = await sql`SELECT id, emp_no, start_date, end_date, note
    FROM droua_run_leaves WHERE run_id = ${assertRunId(runId)}::uuid
    ORDER BY emp_no, start_date`;
  return (rows || []).map((r) => ({
    leaveId: r.id,
    empNo: r.emp_no,
    /* التاريخ نصًّا دائمًا — ولو أعادته القاعدة كائنًا. */
    startDate: isoDate(r.start_date),
    endDate: isoDate(r.end_date),
    note: r.note || null,
  }));
}

function isoDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function addLeave(sql, { runId, empNo, startDate, endDate, note }, ctx = {}) {
  gateContext.requireGate();
  const run = assertRunId(runId);
  const no = assertEmpNo(empNo);
  const from = assertDate(startDate);
  const to = assertDate(endDate);
  if (to < from) throw fail("نهاية الإجازة قبل بدايتها", "bad_range");
  const text = note === null || note === undefined || note === ""
    ? null : String(note).slice(0, MAX_NOTE);
  const rows = await sql`
    INSERT INTO droua_run_leaves (id, run_id, emp_no, start_date, end_date, note, created_by)
    VALUES (${crypto.randomUUID()}::uuid, ${run}::uuid, ${no},
            ${from}::date, ${to}::date, ${text}, ${ctx.actorId || null})
    RETURNING id`;
  return { leaveId: rows && rows[0] && rows[0].id, empNo: no, startDate: from, endDate: to };
}

async function removeLeave(sql, leaveId) {
  gateContext.requireGate();
  const id = String(leaveId || "");
  if (!UUID_RE.test(id)) throw fail("معرّف غير صالح", "bad_leave_id");
  const rows = await sql`DELETE FROM droua_run_leaves WHERE id = ${id}::uuid RETURNING id`;
  return { deleted: Boolean(rows && rows.length) };
}

/* ── ما يستعمله المحرّك ──────────────────────────────────────────────── */

/* حدودُ الشهر نصًّا: «2026-08» ← من 2026-08-01 إلى 2026-08-31. */
function monthBounds(period) {
  const [y, m] = String(period || "").split("-").map(Number);
  if (!y || !m) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  return { first: `${y}-${pad(m)}-01`, last: `${y}-${pad(m)}-${pad(last)}` };
}

/* هل تغطّي إجازاتُ الموظّف الشهر **كلَّه**؟
   والتغطية الجزئية لا تُسكِت شيئًا: من كان في إجازة نصف الشهر يُتوقَّع له
   نصفُ راتب، وغيابُه من المسير يبقى سؤالًا مشروعًا. فالسكوت لا يقع إلا
   على ما تفسّره الإجازة كاملًا — وما دون ذلك يُقال صراحةً. */
function leaveCoverage(leaves, period) {
  const bounds = monthBounds(period);
  const out = new Map();
  if (!bounds) return out;
  for (const leave of leaves || []) {
    const from = leave.startDate > bounds.first ? leave.startDate : bounds.first;
    const to = leave.endDate < bounds.last ? leave.endDate : bounds.last;
    if (from > to) continue; // إجازةٌ خارج الشهر كلّها
    const current = out.get(leave.empNo) || { spans: [], full: false };
    current.spans.push({ from, to });
    out.set(leave.empNo, current);
  }
  for (const [, value] of out) {
    /* دمجُ الفترات ثمّ فحصُ تغطيتها للشهر من أوّله إلى آخره. */
    const spans = value.spans.slice().sort((a, b) => (a.from < b.from ? -1 : 1));
    let reach = null;
    for (const span of spans) {
      if (reach === null) { if (span.from > bounds.first) break; reach = span.to; continue; }
      if (span.from > nextDay(reach)) break;         // فجوةٌ في التغطية
      if (span.to > reach) reach = span.to;
    }
    value.full = reach !== null && reach >= bounds.last;
  }
  return out;
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  DIVISORS, MAX_NOTE,
  listDivisors, divisorMap, setDivisor, clearDivisor,
  listLeaves, addLeave, removeLeave,
  monthBounds, leaveCoverage,
};
