const crypto = require("crypto");
const { getSql } = require("../db");

/* Neon-backed user store. Every function here is async and returns plain
   objects with the same shape/names as before, so requireAuth.js, the
   login route, and lib/data/registry.js's adapter need no changes.

   This replaces the old JSON-file store (data/users.json) which never
   actually persisted in production: Vercel's deployment filesystem is
   read-only outside /tmp, and data/ was gitignored besides. */
function stripSecrets(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    jobTitle: row.job_title,
    createdAt: row.created_at,
    lastLogin: row.last_login,
  };
}

/* Env-backed fallback accounts — kept as-is from the previous implementation
   as a safety net (e.g. if the database is briefly unreachable, these two
   accounts still work since they never touch storage). */
const ENV_OWNER_ID = "env-owner";
function envOwnerUser() {
  const email = process.env.OWNER_EMAIL;
  const passwordHash = process.env.OWNER_PASSWORD_HASH;
  if (!email || !passwordHash) return null;
  return { id: ENV_OWNER_ID, name: "Owner", email, passwordHash, role: "owner", status: "active", jobTitle: null, createdAt: null, lastLogin: null };
}
const ENV_HR_SPECIALIST_ID = "env-hr-specialist";
function envHrSpecialistUser() {
  const email = process.env.HR_SPECIALIST_EMAIL;
  const passwordHash = process.env.HR_SPECIALIST_PASSWORD_HASH;
  if (!email || !passwordHash) return null;
  return { id: ENV_HR_SPECIALIST_ID, name: process.env.HR_SPECIALIST_NAME || "HR Specialist", email, passwordHash, role: "hr", status: "active", jobTitle: null, createdAt: null, lastLogin: null };
}
function envUsers() {
  return [envOwnerUser(), envHrSpecialistUser()].filter(Boolean);
}
function findEnvUserById(id) {
  return envUsers().find((u) => u.id === id) || null;
}
function findEnvUserByEmail(email) {
  return envUsers().find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null;
}

async function listUsers() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM users ORDER BY created_at`;
  return rows.map((r) => stripSecrets(toUser(r)));
}

/* Returns the RAW record (including passwordHash) — for internal login
   verification only. Never send this straight back in an API response.
   DB errors (e.g. DATABASE_URL not configured yet, transient outage) fall
   through to the env-backed accounts instead of failing login outright —
   those two accounts are meant to work even when the database can't. */
async function findByEmailRaw(email) {
  try {
    const sql = getSql();
    const rows = await sql`SELECT * FROM users WHERE lower(email) = lower(${email})`;
    if (rows[0]) return toUser(rows[0]);
  } catch (err) {
    console.error("findByEmailRaw DB lookup failed, falling back to env accounts", err);
  }
  return findEnvUserByEmail(email);
}
async function findById(id) {
  return stripSecrets(await findByIdRaw(id));
}
async function findByIdRaw(id) {
  const envUser = findEnvUserById(id);
  if (envUser) return envUser;
  const sql = getSql();
  const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
  return rows[0] ? toUser(rows[0]) : null;
}

async function createUser({ name, email, passwordHash, role, status, jobTitle }) {
  const sql = getSql();
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO users (id, name, email, password_hash, role, status, job_title)
    VALUES (${id}, ${name}, ${email}, ${passwordHash}, ${role}, ${status || "active"}, ${jobTitle || null})
    ON CONFLICT (email) DO NOTHING
    RETURNING *`;
  if (!rows[0]) throw new Error("البريد الإلكتروني مستخدم بالفعل");
  return stripSecrets(toUser(rows[0]));
}

async function updateUser(id, patch) {
  const envUser = findEnvUserById(id);
  if (envUser) {
    // No writable storage for env-backed accounts — nothing to persist
    // (e.g. lastLogin), just reflect the patch back without saving it.
    return stripSecrets({ ...envUser, ...patch });
  }
  const sql = getSql();
  const existingRows = await sql`SELECT * FROM users WHERE id = ${id}`;
  if (!existingRows[0]) throw new Error("المستخدم غير موجود");
  const existing = toUser(existingRows[0]);
  const merged = { ...existing, ...patch };
  const rows = await sql`
    UPDATE users SET name = ${merged.name}, email = ${merged.email}, password_hash = ${merged.passwordHash},
      role = ${merged.role}, status = ${merged.status}, job_title = ${merged.jobTitle || null}, last_login = ${merged.lastLogin || null}
    WHERE id = ${id}
    RETURNING *`;
  return stripSecrets(toUser(rows[0]));
}

async function deleteUser(id) {
  const sql = getSql();
  const rows = await sql`DELETE FROM users WHERE id = ${id} RETURNING id`;
  if (!rows[0]) throw new Error("المستخدم غير موجود");
}

async function touchLastLogin(id) {
  return updateUser(id, { lastLogin: new Date().toISOString() });
}

module.exports = { listUsers, findByEmailRaw, findById, findByIdRaw, createUser, updateUser, deleteUser, touchLastLogin };
