const { getSql } = require("../db");

/* Permission section guarding this resource — see lib/data/employees.js.
   settings has no create/delete, so the router only ever checks
   settings:view (GET) and settings:edit (PUT). */
const section = "settings";

/* Key/value store for small pieces of config that don't warrant their own
   table (financial summary totals, sidebar identity card, the "expiring
   soon" day threshold, ...). list() merges every row into one object keyed
   by `key` — the shape app-shell.html's loadAppData() expects. */
async function list() {
  const sql = getSql();
  const rows = await sql`SELECT key, value FROM settings`;
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function get(key) {
  const sql = getSql();
  const rows = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return rows[0] ? rows[0].value : null;
}

async function set(key, value) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    RETURNING key, value`;
  return rows[0];
}

module.exports = { list, get, set, section };
