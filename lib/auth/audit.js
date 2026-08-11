const { getSql } = require("../db");

/* Neon-backed append-only audit log — replaces data/audit-log.jsonl, which
   never actually persisted in production for the same read-only-filesystem
   reason described in lib/auth/users.js. Call signature is unchanged so
   every existing caller (login, user CRUD, ...) needs no edits. */
async function logEvent({ type, actorEmail, actorId, targetId, meta }) {
  try {
    const sql = getSql();
    await sql`
      INSERT INTO audit_log (type, actor_email, actor_id, target_id, meta)
      VALUES (${type}, ${actorEmail || null}, ${actorId || null}, ${targetId || null}, ${JSON.stringify(meta || {})}::jsonb)`;
  } catch (err) {
    console.error("audit log write failed", err);
  }
}

async function readLog(limit = 200) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    ts: r.ts,
    type: r.type,
    actorEmail: r.actor_email,
    actorId: r.actor_id,
    targetId: r.target_id,
    meta: r.meta,
  }));
}

module.exports = { logEvent, readLog };
