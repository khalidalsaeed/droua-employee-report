/* ─── أشهر المراجعة (Runs) ─────────────────────────────────────────────
   =========================================================================
   الشهر هو وحدة العمل كلّها: أربعة ملفّات، ومقارنةٌ داخله، ومقارنةٌ مع
   الشهر الذي قبله. ولذلك `period` نصٌّ `YYYY-MM` **فريد** — لا تاريخ ولا
   نطاق: التفرّد هو ما يمنع «سبتمبر» مرّتين، وهو خطأ لا يظهر عطلًا بل يظهر
   مقارنةً كاذبة.

   ونصًّا لا تاريخًا لأن الشهر ليس لحظة: `2026-09` لا منطقةَ زمنية له،
   وتخزينه `date` يجعل أول الشهر يزحف يومًا عند أول تحويل توقيت. */

const crypto = require("crypto");
const gateContext = require("./gateContext");
const files = require("./files");

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = Object.freeze(["draft", "ready", "analyzed", "closed"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertPeriod(period) {
  const value = String(period || "").trim();
  if (!PERIOD_RE.test(value)) throw fail("الشهر بصيغة غير صالحة", "bad_period");
  return value;
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !UUID_RE.test(runId)) throw fail("runId غير صالح", "bad_run_id");
  return runId;
}

/* الشهر السابق بحساب نصّيّ صرف — لا Date ولا منطقة زمنية. */
function previousPeriod(period) {
  const [year, month] = assertPeriod(period).split("-").map(Number);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${String(prevYear).padStart(4, "0")}-${String(prevMonth).padStart(2, "0")}`;
}

const view = (row) => (row ? {
  runId: row.id,
  period: row.period,
  status: row.status,
  createdAt: row.created_at,
  analyzedAt: row.analyzed_at || null,
  closedAt: row.closed_at || null,
} : null);

async function createRun(sql, period) {
  gateContext.requireGate();
  const value = assertPeriod(period);
  const rows = await sql`INSERT INTO droua_payroll_runs (id, period)
    VALUES (${crypto.randomUUID()}::uuid, ${value}) RETURNING *`;
  return view(rows && rows[0]);
}

async function getRun(sql, runId) {
  gateContext.requireGate();
  const rows = await sql`SELECT * FROM droua_payroll_runs WHERE id = ${assertRunId(runId)}::uuid`;
  return view(rows && rows[0]);
}

async function getByPeriod(sql, period) {
  gateContext.requireGate();
  const rows = await sql`SELECT * FROM droua_payroll_runs WHERE period = ${assertPeriod(period)}`;
  return view(rows && rows[0]);
}

async function listRuns(sql, limit = 36) {
  gateContext.requireGate();
  const rows = await sql`SELECT * FROM droua_payroll_runs
    ORDER BY period DESC LIMIT ${Math.max(1, Math.min(200, Number(limit) || 36))}`;
  return (rows || []).map(view);
}

async function setStatus(sql, runId, status) {
  gateContext.requireGate();
  assertRunId(runId);
  if (!STATUSES.includes(status)) throw fail("حالة غير معروفة", "bad_status");
  const rows = await sql`UPDATE droua_payroll_runs
    SET status = ${status},
        analyzed_at = CASE WHEN ${status} = 'analyzed' THEN now() ELSE analyzed_at END,
        closed_at   = CASE WHEN ${status} = 'closed'   THEN now() ELSE closed_at   END
    WHERE id = ${runId}::uuid RETURNING *`;
  return view(rows && rows[0]);
}

/* ملفّات الشهر الحالية مرتّبة على الأنواع الأربعة، مع الناقص منها.
   وهذا هو «حالة الملفّ» التي تعرضها الواجهة: موجود / ناقص. */
async function fileSlots(sql, runId) {
  gateContext.requireGate();
  const current = await files.listCurrent(sql, assertRunId(runId));
  const byKind = new Map(current.map((f) => [f.kind, f]));
  return files.KINDS.map((kind) => ({
    kind,
    label: files.KIND_LABELS[kind],
    file: byKind.get(kind) || null,
    present: byKind.has(kind),
    required: files.REQUIRED_KINDS.includes(kind),
  }));
}

/* الاكتمال على **اللازم** وحده: خانة العمل الإضافي اختيارية، فشهرٌ بلا
   ملفّ عمل إضافي شهرٌ مكتمل — لا ناقص ينتظر ما لا يأتي. */
const isComplete = (slots) => slots
  .filter((s) => files.REQUIRED_KINDS.includes(s.kind))
  .every((s) => s.present);

/* حذف الشهر: **الملفّات أوّلًا، واحدًا واحدًا، بمسار الحذف الآمن** — فتُمحى
   بايتاتها من المتجر. ثمّ يُحذف الصفّ، فتتكفّل CASCADE بما تبقّى من شواهد
   قبورٍ مطهَّرة ومن ملاحظات.

   والترتيب المعاكس — حذف الشهر أوّلًا والاتّكال على CASCADE — كان سيمحو
   الصفوف ويترك **كل بايتات الشهر في المتجر** بلا أي أثر يدلّ عليها. */
async function deleteRun(sql, runId, ctx = {}) {
  gateContext.requireGate();
  assertRunId(runId);
  const rows = await sql`SELECT * FROM droua_payroll_files WHERE run_id = ${runId}::uuid`;
  let purged = 0;
  let pending = 0;
  for (const row of rows || []) {
    const result = await files.deleteFile(sql, row.id, ctx);
    if (result.purged) purged += 1;
    else if (result.deleted) pending += 1;
  }
  /* لا يُحذف الشهر ما دامت بايتاتٌ لم تُمحَ: شواهد القبور تحتاج صفَّ الشهر
     حيًّا لتبقى مرئيّة للمسح — وحذفه يجعل CASCADE يبتلعها ويصير اليتيم
     يتيمًا فعلًا. */
  if (pending) return { deleted: false, purged, pending };
  await sql`DELETE FROM droua_payroll_runs WHERE id = ${runId}::uuid`;
  return { deleted: true, purged, pending: 0 };
}

module.exports = {
  createRun, getRun, getByPeriod, listRuns, setStatus,
  fileSlots, isComplete, deleteRun,
  previousPeriod, assertPeriod, assertRunId, STATUSES, PERIOD_RE,
};
