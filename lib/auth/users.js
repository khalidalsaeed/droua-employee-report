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
    /* null = "use role defaults"; an array = custom per-user permissions that
       fully replace the role defaults (see lib/auth/permissions.js). */
    permissions: Array.isArray(row.permissions) ? row.permissions : null,
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
  return { id: ENV_OWNER_ID, name: "Owner", email, passwordHash, role: "owner", status: "active", jobTitle: null, permissions: null, createdAt: null, lastLogin: null };
}
const ENV_HR_SPECIALIST_ID = "env-hr-specialist";
function envHrSpecialistUser() {
  const email = process.env.HR_SPECIALIST_EMAIL;
  const passwordHash = process.env.HR_SPECIALIST_PASSWORD_HASH;
  if (!email || !passwordHash) return null;
  return { id: ENV_HR_SPECIALIST_ID, name: process.env.HR_SPECIALIST_NAME || "HR Specialist", email, passwordHash, role: "hr", status: "active", jobTitle: null, permissions: null, createdAt: null, lastLogin: null };
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

/* ─── legacy HR-specialist migration (transitional) ───
   فراس predates the move to Neon: he only ever existed as HR_SPECIALIST_* env
   vars synthesized per-request by envHrSpecialistUser(), so he could log in but
   never appeared in — or be edited from — إدارة المستخدمين.

   This copies him into the users table ONCE. The password hash is read from
   process.env inside the running function and written straight to the column,
   so his credentials carry over byte-for-byte without the value being printed,
   logged, or handled by anyone. His legacy id is kept deliberately: his current
   session cookie stays valid and his existing audit_log rows stay linked to him.

   Idempotent — it no-ops as soon as a row with that id or email exists. The env
   fallback is intentionally left in place for now; it (and the HR_SPECIALIST_*
   vars, and this function) should only be removed after login from Neon is
   confirmed working. */
const HR_SPECIALIST_JOB_TITLE = "HR Specialist";

async function migrateHrSpecialistToDb() {
  const envUser = envHrSpecialistUser();
  if (!envUser) return; // vars not configured in this environment — nothing to migrate
  try {
    const sql = getSql();
    const existing = await sql`
      SELECT id FROM users WHERE id = ${envUser.id} OR lower(email) = lower(${envUser.email}) LIMIT 1`;
    if (existing[0]) return;
    await sql`
      INSERT INTO users (id, name, email, password_hash, role, status, job_title, permissions)
      VALUES (${envUser.id}, ${envUser.name}, ${envUser.email}, ${envUser.passwordHash},
              ${envUser.role}, 'active', ${HR_SPECIALIST_JOB_TITLE}, NULL)`;
    console.log("migrated legacy HR-specialist account into users table");
  } catch (err) {
    // Never let this break a login or the users page — it retries next call.
    console.error("HR-specialist migration skipped:", err.message);
  }
}

async function listUsers() {
  /* Runs here so the account materializes the moment an Owner opens
     إدارة المستخدمين, rather than waiting for فراس to log in. */
  await migrateHrSpecialistToDb();
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
    /* Miss, but this is a legacy env-only account: migrate it now and serve the
       real row, so the very login that needed the fallback also retires it. */
    const envMatch = findEnvUserByEmail(email);
    if (envMatch && envMatch.id === ENV_HR_SPECIALIST_ID) {
      await migrateHrSpecialistToDb();
      const again = await sql`SELECT * FROM users WHERE lower(email) = lower(${email})`;
      if (again[0]) return toUser(again[0]);
    }
  } catch (err) {
    console.error("findByEmailRaw DB lookup failed, falling back to env accounts", err);
  }
  return findEnvUserByEmail(email);
}
async function findById(id) {
  return stripSecrets(await findByIdRaw(id));
}
/* DB first, env only as a fallback — matching findByEmailRaw. This order
   matters: it used to check env accounts first, which meant a migrated legacy
   account kept resolving to its hardcoded env shape (role hr, no jobTitle, no
   permissions) and any change made in إدارة المستخدمين had no effect on it. */
async function findByIdRaw(id) {
  try {
    const sql = getSql();
    const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
    if (rows[0]) return toUser(rows[0]);
  } catch (err) {
    console.error("findByIdRaw DB lookup failed, falling back to env accounts", err.message);
  }
  return findEnvUserById(id);
}

async function createUser({ name, email, passwordHash, role, status, jobTitle, permissions }) {
  const sql = getSql();
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO users (id, name, email, password_hash, role, status, job_title, permissions)
    VALUES (${id}, ${name}, ${email}, ${passwordHash}, ${role}, ${status || "active"}, ${jobTitle || null},
            ${Array.isArray(permissions) ? JSON.stringify(permissions) : null}::jsonb)
    ON CONFLICT (email) DO NOTHING
    RETURNING *`;
  if (!rows[0]) throw new Error("البريد الإلكتروني مستخدم بالفعل");
  return stripSecrets(toUser(rows[0]));
}

/* DB row wins over any env account of the same id. Previously an env id short-
   circuited to a no-op that only pretended to save, so a migrated legacy account
   silently discarded every edit (including lastLogin) made from the platform. */
async function updateUser(id, patch) {
  const sql = getSql();
  const existingRows = await sql`SELECT * FROM users WHERE id = ${id}`;
  if (!existingRows[0]) {
    const envUser = findEnvUserById(id);
    // Still env-only (not migrated): no writable storage, so reflect the patch
    // back without persisting it, as before.
    if (envUser) return stripSecrets({ ...envUser, ...patch });
    throw new Error("المستخدم غير موجود");
  }
  const existing = toUser(existingRows[0]);
  const merged = { ...existing, ...patch };
  /* patch.permissions is only honoured when the caller passes the key at all:
     an explicit null switches the user back to role defaults, an array stores
     a custom set, and omitting it leaves whatever is already there. */
  const permissions = Array.isArray(merged.permissions) ? JSON.stringify(merged.permissions) : null;
  const rows = await sql`
    UPDATE users SET name = ${merged.name}, email = ${merged.email}, password_hash = ${merged.passwordHash},
      role = ${merged.role}, status = ${merged.status}, job_title = ${merged.jobTitle || null},
      permissions = ${permissions}::jsonb, last_login = ${merged.lastLogin || null}
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
