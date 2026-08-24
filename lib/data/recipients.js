const { getSql } = require("../db");

/* Permission section guarding this resource — see lib/data/employees.js. */
const section = "recipients";

/* wants_monthly_report is a SEPARATE opt-in from the daily expiry alerts: the
   monthly report is a management document, so being on the expiry list must not
   silently subscribe anyone to it. It defaults to false in the schema, and only
   this flag decides who the monthly report is emailed to. */
const shape = (r) => ({ name: r.name, email: r.email, wantsMonthlyReport: r.wants_monthly_report === true });

async function list() {
  const sql = getSql();
  const rows = await sql`SELECT name, email, wants_monthly_report FROM recipients ORDER BY id`;
  return rows.map(shape);
}

async function create({ name, email, wantsMonthlyReport }) {
  const sql = getSql();
  if (!name || !email) throw new Error("الاسم والبريد الإلكتروني مطلوبان");
  const rows = await sql`
    INSERT INTO recipients (name, email, wants_monthly_report)
    VALUES (${name}, ${email}, ${wantsMonthlyReport === true})
    ON CONFLICT (email) DO NOTHING RETURNING name, email, wants_monthly_report`;
  if (!rows[0]) throw new Error("هذا البريد الإلكتروني مضاف بالفعل");
  return shape(rows[0]);
}

async function update(email, patch) {
  const sql = getSql();
  /* Absent key = leave the flag alone, so an edit that only renames someone
     can't quietly unsubscribe them. */
  const wants = "wantsMonthlyReport" in patch ? patch.wantsMonthlyReport === true : null;
  const name = typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : null;
  const rows = await sql`
    UPDATE recipients
       SET name = COALESCE(${name}, name),
           wants_monthly_report = COALESCE(${wants}, wants_monthly_report)
     WHERE email = ${email} RETURNING name, email, wants_monthly_report`;
  if (!rows[0]) throw new Error("المستلم غير موجود");
  return shape(rows[0]);
}

async function remove(email) {
  const sql = getSql();
  const rows = await sql`DELETE FROM recipients WHERE email = ${email} RETURNING email`;
  if (!rows[0]) throw new Error("المستلم غير موجود");
}

module.exports = { list, create, update, remove, section };
