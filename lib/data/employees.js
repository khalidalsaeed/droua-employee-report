const { getSql } = require("../db");

/* Which permission section guards this resource — the router turns the HTTP
   method into the action (GET→view, POST→create, PUT→edit, DELETE→delete) and
   checks it against the actor's effective permissions. See
   lib/auth/permissions.js. */
const section = "employees";

/* Each employee row stores its full Arabic-keyed record (identical shape to
   the old app-shell.html DATA array) in `data` JSONB — eid/iqama/name are
   duplicated as plain columns only for indexing/uniqueness, never edited
   independently of `data`. This lets the wide, semi-structured employee
   record (30+ fields, some ad hoc like _cost/_licPending) live in Postgres
   without a rigid column-per-field schema. */
const F_EID = "الرقم الوظيفي";
const F_IQAMA = "رقم الإقامة";
const F_NAME = "اسم العامل";

async function list() {
  const sql = getSql();
  const rows = await sql`SELECT data FROM employees ORDER BY id`;
  return rows.map((r) => r.data);
}

async function get(eid) {
  const sql = getSql();
  const rows = await sql`SELECT data FROM employees WHERE eid = ${eid}`;
  return rows[0] ? rows[0].data : null;
}

async function create(data) {
  const sql = getSql();
  const eid = data[F_EID];
  const iqama = data[F_IQAMA];
  const name = data[F_NAME];
  if (!eid || !name) throw new Error("الرقم الوظيفي واسم العامل مطلوبان");
  const rows = await sql`
    INSERT INTO employees (eid, iqama, name, data)
    VALUES (${eid}, ${iqama}, ${name}, ${JSON.stringify(data)}::jsonb)
    ON CONFLICT (eid) DO NOTHING
    RETURNING data`;
  if (!rows[0]) throw new Error("رقم وظيفي مستخدم بالفعل");
  return rows[0].data;
}

/* Shallow-merges patch into the existing record, then re-syncs the mirror
   columns from the merged object so lookups by iqama/name stay correct. */
async function update(eid, patch) {
  const sql = getSql();
  const existing = await get(eid);
  if (!existing) throw new Error("الموظف غير موجود");
  const merged = { ...existing, ...patch };
  const rows = await sql`
    UPDATE employees
    SET data = ${JSON.stringify(merged)}::jsonb, iqama = ${merged[F_IQAMA]}, name = ${merged[F_NAME]}, updated_at = now()
    WHERE eid = ${eid}
    RETURNING data`;
  return rows[0].data;
}

async function remove(eid) {
  const sql = getSql();
  const rows = await sql`DELETE FROM employees WHERE eid = ${eid} RETURNING eid`;
  if (!rows[0]) throw new Error("الموظف غير موجود");
}

module.exports = { list, get, create, update, remove, section };
