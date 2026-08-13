const { getSql } = require("../db");
const { isAdminLike, can } = require("../auth/roles");
const { deleteFile } = require("../blob");

/* Viewing payroll matches the existing "finance" page permission; only
   Owner/Admin can add/edit/delete runs or attachments. */
const auth = { read: (role) => can(role, "finance"), write: isAdminLike };

/* Field names on the returned objects match the old lib/payroll/runs.js
   mock shape exactly (id, monthLabel, uploadedAt, statusKey, fileUrl,
   attachments[]) so payroll-shell.html / payroll-detail-shell.html need no
   rendering changes beyond fetching this instead of a hardcoded array. */
function toRun(row, attachments) {
  return {
    id: row.id,
    monthLabel: row.month_label,
    uploadedAt: row.uploaded_at,
    statusKey: row.status_key,
    fileUrl: row.file_url,
    attachments: (attachments || []).map((a) => ({
      key: a.key,
      label: a.label,
      statusKey: a.status_key,
      fileUrl: a.file_url,
      uploadedAt: a.uploaded_at,
      note: a.note,
    })),
  };
}

/* DATE columns cast to text (plain YYYY-MM-DD) — see the same note in
   lib/data/permits.js on why this matters for expiry/date-math correctness. */
const RUN_COLS = `id, month_label, to_char(uploaded_at,'YYYY-MM-DD') as uploaded_at, status_key, file_url`;
const ATTACHMENT_COLS = `key, label, status_key, file_url, to_char(uploaded_at,'YYYY-MM-DD') as uploaded_at, note`;

async function attachmentsFor(sql, runId) {
  return sql`SELECT ${sql.unsafe(ATTACHMENT_COLS)} FROM payroll_attachments WHERE run_id = ${runId} ORDER BY id`;
}

async function list() {
  const sql = getSql();
  const runs = await sql`SELECT ${sql.unsafe(RUN_COLS)} FROM payroll_runs ORDER BY id DESC`;
  const out = [];
  for (const run of runs) out.push(toRun(run, await attachmentsFor(sql, run.id)));
  return out;
}

async function get(id) {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(RUN_COLS)} FROM payroll_runs WHERE id = ${id}`;
  if (!rows[0]) return null;
  return toRun(rows[0], await attachmentsFor(sql, id));
}

async function create({ id, monthLabel, uploadedAt, statusKey, fileUrl, attachments }) {
  const sql = getSql();
  if (!id || !monthLabel) throw new Error("معرّف الشهر واسمه مطلوبان");
  const rows = await sql`
    INSERT INTO payroll_runs (id, month_label, uploaded_at, status_key, file_url)
    VALUES (${id}, ${monthLabel}, ${uploadedAt || null}, ${statusKey || "pending_invoice"}, ${fileUrl || null})
    ON CONFLICT (id) DO NOTHING
    RETURNING *`;
  if (!rows[0]) throw new Error("يوجد مسير رواتب بهذا المعرّف بالفعل");
  for (const a of attachments || []) await upsertAttachment(sql, id, a);
  return get(id);
}

async function upsertAttachment(sql, runId, a) {
  await sql`
    INSERT INTO payroll_attachments (run_id, key, label, status_key, file_url, uploaded_at, note)
    VALUES (${runId}, ${a.key}, ${a.label}, ${a.statusKey}, ${a.fileUrl || null}, ${a.uploadedAt || null}, ${a.note || null})
    ON CONFLICT (run_id, key) DO UPDATE SET
      label = EXCLUDED.label, status_key = EXCLUDED.status_key, file_url = EXCLUDED.file_url,
      uploaded_at = EXCLUDED.uploaded_at, note = EXCLUDED.note`;
}

/* patch may contain run-level fields (monthLabel/uploadedAt/statusKey/fileUrl)
   and/or an `attachments` array of partial attachment objects to upsert.
   Whenever a fileUrl is replaced or cleared (upload/replace/delete-file),
   the old Blob object is deleted so no orphaned files accumulate. */
async function update(id, patch) {
  const sql = getSql();
  const existing = await get(id);
  if (!existing) throw new Error("مسير الرواتب غير موجود");
  const merged = { ...existing, ...patch };
  await sql`
    UPDATE payroll_runs
    SET month_label = ${merged.monthLabel}, uploaded_at = ${merged.uploadedAt || null},
        status_key = ${merged.statusKey}, file_url = ${merged.fileUrl || null}, updated_at = now()
    WHERE id = ${id}`;
  if (patch.fileUrl !== undefined && existing.fileUrl && existing.fileUrl !== merged.fileUrl) {
    await deleteFile(existing.fileUrl);
  }
  if (Array.isArray(patch.attachments)) {
    for (const a of patch.attachments) {
      const base = existing.attachments.find((x) => x.key === a.key) || {};
      const mergedAttachment = { ...base, ...a };
      await upsertAttachment(sql, id, mergedAttachment);
      if (a.fileUrl !== undefined && base.fileUrl && base.fileUrl !== mergedAttachment.fileUrl) {
        await deleteFile(base.fileUrl);
      }
    }
  }
  return get(id);
}

async function remove(id) {
  const sql = getSql();
  const existing = await get(id);
  if (!existing) throw new Error("مسير الرواتب غير موجود");
  await sql`DELETE FROM payroll_runs WHERE id = ${id}`;
  await deleteFile(existing.fileUrl);
  for (const a of existing.attachments) await deleteFile(a.fileUrl);
}

module.exports = { list, get, create, update, remove, auth };
