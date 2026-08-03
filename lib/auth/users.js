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

async function listUsers() {
  return readAll().map(stripSecrets);
}

/* Returns the RAW record (including passwordHash) — for internal login
   verification only. Never send this straight back in an API response. */
async function findByEmailRaw(email) {
  return readAll().find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null;
}
async function findById(id) {
  const u = readAll().find((u) => u.id === id) || null;
  return stripSecrets(u);
}
async function findByIdRaw(id) {
  return readAll().find((u) => u.id === id) || null;
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
  if (idx === -1) throw new Error("المستخدم غير موجود");
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
