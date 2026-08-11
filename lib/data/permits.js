const { getSql } = require("../db");

/* Field names on the returned objects intentionally match the old AJEER
   array shape (permit, iqama, nameOnPermit, issueDate, expiryDate, file, qr)
   so app-shell.html's rendering code needs no changes beyond fetching this
   instead of reading a literal array. */
function toItem(row) {
  return {
    permit: row.permit_no,
    iqama: row.iqama,
    nameOnPermit: row.name_on_permit,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    file: row.file_url,
    qr: row.qr_url,
  };
}

/* DATE columns are cast to text (plain YYYY-MM-DD) in every SELECT below —
   letting the driver hand back JS Date objects risks a timezone-shift
   off-by-one-day bug once serialized back to JSON (toISOString() is UTC,
   the driver's Date parsing is not), which would corrupt expiry-day math. */
const COLS = `permit_no, iqama, name_on_permit, to_char(issue_date,'YYYY-MM-DD') as issue_date,
  to_char(expiry_date,'YYYY-MM-DD') as expiry_date, file_url, qr_url`;

async function list() {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM ajeer_permits ORDER BY id`;
  return rows.map(toItem);
}

async function get(permitNo) {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM ajeer_permits WHERE permit_no = ${permitNo}`;
  return rows[0] ? toItem(rows[0]) : null;
}

async function create(item) {
  const sql = getSql();
  if (!item.permit || !item.iqama) throw new Error("رقم التصريح ورقم الإقامة مطلوبان");
  const rows = await sql`
    INSERT INTO ajeer_permits (permit_no, iqama, name_on_permit, issue_date, expiry_date, file_url, qr_url)
    VALUES (${item.permit}, ${item.iqama}, ${item.nameOnPermit || null}, ${item.issueDate || null}, ${item.expiryDate || null}, ${item.file || null}, ${item.qr || null})
    ON CONFLICT (permit_no) DO NOTHING
    RETURNING *`;
  if (!rows[0]) throw new Error("رقم التصريح مستخدم بالفعل");
  return toItem(rows[0]);
}

async function update(permitNo, patch) {
  const sql = getSql();
  const existing = await get(permitNo);
  if (!existing) throw new Error("التصريح غير موجود");
  const merged = { ...existing, ...patch };
  const rows = await sql`
    UPDATE ajeer_permits
    SET iqama = ${merged.iqama}, name_on_permit = ${merged.nameOnPermit}, issue_date = ${merged.issueDate},
        expiry_date = ${merged.expiryDate}, file_url = ${merged.file}, qr_url = ${merged.qr}, updated_at = now()
    WHERE permit_no = ${permitNo}
    RETURNING *`;
  return toItem(rows[0]);
}

async function remove(permitNo) {
  const sql = getSql();
  const rows = await sql`DELETE FROM ajeer_permits WHERE permit_no = ${permitNo} RETURNING permit_no`;
  if (!rows[0]) throw new Error("التصريح غير موجود");
}

module.exports = { list, get, create, update, remove };
