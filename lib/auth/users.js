const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* JSON-file backed user store. Every function here is async and returns
   plain objects, specifically so that swapping this file's internals for a
   real database (Postgres, Supabase, ...) later requires zero changes to
   any calling code — only this module would be rewritten. */
const DB_PATH = path.join(process.cwd(), "data", "users.json");

function readAll() {
  if (!fs.existsSync(DB_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeAll(users) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}
function stripSecrets(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

/* Vercel's production filesystem is read-only, so data/users.json (gitignored,
   local-only) can't exist there. This lets specific accounts log in on any
   deployment purely from env vars, with zero secrets ever committed to Git.
   Each is a temporary stand-in until real database-backed user management is
   wired up. Used only as a fallback when the email isn't found in the
   file-backed store. Add a new ENV_*_ID + builder here to add another. */
const ENV_OWNER_ID = "env-owner";
function envOwnerUser() {
  const email = process.env.OWNER_EMAIL;
  const passwordHash = process.env.OWNER_PASSWORD_HASH;
  if (!email || !passwordHash) return null;
  return {
    id: ENV_OWNER_ID,
    name: "Owner",
    email,
    passwordHash,
    role: "owner",
    status: "active",
    createdAt: null,
    lastLogin: null,
  };
}

const ENV_HR_SPECIALIST_ID = "env-hr-specialist";
function envHrSpecialistUser() {
  const email = process.env.HR_SPECIALIST_EMAIL;
  const passwordHash = process.env.HR_SPECIALIST_PASSWORD_HASH;
  if (!email || !passwordHash) return null;
  return {
    id: ENV_HR_SPECIALIST_ID,
    name: process.env.HR_SPECIALIST_NAME || "HR Specialist",
    email,
    passwordHash,
    role: "hr",
    status: "active",
    createdAt: null,
    lastLogin: null,
  };
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
  return readAll().map(stripSecrets);
}

/* Returns the RAW record (including passwordHash) — for internal login
   verification only. Never send this straight back in an API response. */
async function findByEmailRaw(email) {
  const fromFile = readAll().find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  if (fromFile) return fromFile;
  return findEnvUserByEmail(email);
}
async function findById(id) {
  return stripSecrets(await findByIdRaw(id));
}
async function findByIdRaw(id) {
  const fromFile = readAll().find((u) => u.id === id);
  if (fromFile) return fromFile;
  return findEnvUserById(id);
}

async function createUser({ name, email, passwordHash, role, status }) {
  const users = readAll();
  if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    throw new Error("البريد الإلكتروني مستخدم بالفعل");
  }
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash,
    role,
    status: status || "active",
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };
  users.push(user);
  writeAll(users);
  return stripSecrets(user);
}

async function updateUser(id, patch) {
  const users = readAll();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) {
    const envUser = findEnvUserById(id);
    if (envUser) {
      // No writable storage for env-backed accounts — nothing to persist
      // (e.g. lastLogin), just reflect the patch back without saving it.
      return stripSecrets({ ...envUser, ...patch });
    }
    throw new Error("المستخدم غير موجود");
  }
  users[idx] = { ...users[idx], ...patch };
  writeAll(users);
  return stripSecrets(users[idx]);
}

async function deleteUser(id) {
  const users = readAll();
  const next = users.filter((u) => u.id !== id);
  if (next.length === users.length) throw new Error("المستخدم غير موجود");
  writeAll(next);
}

async function touchLastLogin(id) {
  return updateUser(id, { lastLogin: new Date().toISOString() });
}

module.exports = { listUsers, findByEmailRaw, findById, findByIdRaw, createUser, updateUser, deleteUser, touchLastLogin };
