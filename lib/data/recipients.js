const { getSql } = require("../db");

/* Permission section guarding this resource — see lib/data/employees.js. */
const section = "recipients";

async function list() {
  const sql = getSql();
  return sql`SELECT name, email FROM recipients ORDER BY id`;
}

async function create({ name, email }) {
  const sql = getSql();
  if (!name || !email) throw new Error("الاسم والبريد الإلكتروني مطلوبان");
  const rows = await sql`
    INSERT INTO recipients (name, email) VALUES (${name}, ${email})
    ON CONFLICT (email) DO NOTHING RETURNING name, email`;
  if (!rows[0]) throw new Error("هذا البريد الإلكتروني مضاف بالفعل");
  return rows[0];
}

async function update(email, patch) {
  const sql = getSql();
  const rows = await sql`
    UPDATE recipients SET name = ${patch.name}
    WHERE email = ${email} RETURNING name, email`;
  if (!rows[0]) throw new Error("المستلم غير موجود");
  return rows[0];
}

async function remove(email) {
  const sql = getSql();
  const rows = await sql`DELETE FROM recipients WHERE email = ${email} RETURNING email`;
  if (!rows[0]) throw new Error("المستلم غير موجود");
}

module.exports = { list, create, update, remove, section };
