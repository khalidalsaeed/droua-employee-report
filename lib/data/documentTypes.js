const { getSql } = require("../db");
const { isAdminLike } = require("../auth/roles");

const auth = { read: isAdminLike, write: isAdminLike };

function toItem(row) {
  return { key: row.key, label: row.label, employeeField: row.employee_field, sortOrder: row.sort_order };
}

async function list() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM document_types ORDER BY sort_order, key`;
  return rows.map(toItem);
}

async function create({ key, label, employeeField, sortOrder }) {
  const sql = getSql();
  if (!key || !label || !employeeField) throw new Error("المفتاح والتسمية وحقل الموظف مطلوبة");
  const rows = await sql`
    INSERT INTO document_types (key, label, employee_field, sort_order)
    VALUES (${key}, ${label}, ${employeeField}, ${sortOrder || 0})
    ON CONFLICT (key) DO NOTHING
    RETURNING *`;
  if (!rows[0]) throw new Error("نوع المستند موجود بالفعل");
  return toItem(rows[0]);
}

async function update(key, patch) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM document_types WHERE key = ${key}`;
  if (!rows[0]) throw new Error("نوع المستند غير موجود");
  const merged = { ...toItem(rows[0]), ...patch };
  const updated = await sql`
    UPDATE document_types SET label = ${merged.label}, employee_field = ${merged.employeeField}, sort_order = ${merged.sortOrder}
    WHERE key = ${key} RETURNING *`;
  return toItem(updated[0]);
}

async function remove(key) {
  const sql = getSql();
  const rows = await sql`DELETE FROM document_types WHERE key = ${key} RETURNING key`;
  if (!rows[0]) throw new Error("نوع المستند غير موجود");
}

module.exports = { list, create, update, remove, auth };
