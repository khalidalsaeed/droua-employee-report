const fs = require("fs");
const path = require("path");

const { requireUser } = require("../lib/auth/requireAuth");
const { can, isAdminLike, isValidRole, canManageUser } = require("../lib/auth/roles");
const { findByEmailRaw, findByIdRaw, listUsers, createUser, updateUser, deleteUser, touchLastLogin } = require("../lib/auth/users");
const { verifyPassword, hashPassword, generatePassword } = require("../lib/auth/passwords");
const { issueSessionToken, verify: verifyToken } = require("../lib/auth/tokens");
const { getCookie, sessionCookie, clearSessionCookie } = require("../lib/auth/cookies");
const { logEvent } = require("../lib/auth/audit");
const { parseBody } = require("../lib/auth/parseBody");
const { getResource } = require("../lib/data/registry");
const { uploadFile, deleteFile } = require("../lib/blob");

/* Single Serverless Function for the entire app (pages + auth + generic
   data CRUD + file uploads) — only api/cron/check-expirations.js is
   deployed separately, since it runs on its own trigger with its own
   auth (CRON_SECRET), not a user session. See vercel.json's rewrites for
   how every route lands here. Adding a new platform section later is a
   new lib/data/<name>.js module registered in lib/data/registry.js — this
   file and the function count never need to change. */

const NO_CACHE = { "Cache-Control": "no-store, must-revalidate" };

const PAGE_FILES = {
  home: "app-shell.html",
  users: "users-shell.html",
  payroll: "payroll-shell.html",
  "payroll-detail": "payroll-detail-shell.html",
};
/* Mirrors lib/auth/roles.js's PAGE_PERMISSIONS at the page-serving level. */
const PAGE_AUTH = {
  home: () => true,
  users: (role) => isAdminLike(role),
  payroll: (role) => can(role, "finance"),
  "payroll-detail": (role) => can(role, "finance"),
};

/* Per-resource authorization for /api/data/:resource now lives on each
   lib/data/<resource>.js module itself (module.auth = {read, write}) — see
   lib/data/registry.js. Adding a new section is then just a new module
   file + one registry line; this file never needs to change. "users" is
   handled separately below (its business rules — self-delete guard,
   Owner-only Owner management, generated passwords — don't fit a generic
   CRUD shape). */

module.exports = async function handler(req, res) {
  const { kind } = req.query || {};
  try {
    if (kind === "page") return await handlePage(req, res);
    if (kind === "api") return await handleApi(req, res);
    res.status(404).json({ ok: false, error: "Not found" });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) || "خطأ داخلي" });
  }
};

async function handlePage(req, res) {
  const { page } = req.query || {};
  const file = PAGE_FILES[page];
  const authCheck = PAGE_AUTH[page];
  if (!file || !authCheck) {
    res.status(404).end("Not found");
    return;
  }
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html", ...NO_CACHE });
    res.end();
    return;
  }
  if (!authCheck(user.role)) {
    res.writeHead(302, { Location: "/", ...NO_CACHE });
    res.end();
    return;
  }
  const html = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
  res.end(html);
}

async function handleApi(req, res) {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  const apiPath = String((req.query || {}).apiPath || "");
  const [section, ...rest] = apiPath.split("/").filter(Boolean);

  if (section === "auth") return handleAuth(req, res, rest[0]);
  if (section === "data") return handleData(req, res, rest[0]);
  if (section === "files") return handleFiles(req, res, rest[0]);
  res.status(404).json({ ok: false, error: "Not found" });
}

/* ---------------- auth ---------------- */
async function handleAuth(req, res, action) {
  if (action === "login") return authLogin(req, res);
  if (action === "logout") return authLogout(req, res);
  if (action === "me") return authMe(req, res);
  res.status(404).json({ ok: false, error: "Not found" });
}

async function authLogin(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const { email, password, remember } = parseBody(req);
  if (!email || !password) return res.status(400).json({ ok: false, error: "أدخل البريد الإلكتروني وكلمة المرور" });

  const genericError = "البريد الإلكتروني أو كلمة المرور غير صحيحة";
  const user = await findByEmailRaw(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    logEvent({ type: "login_failed", actorEmail: email });
    return res.status(401).json({ ok: false, error: genericError });
  }
  if (user.status !== "active") {
    logEvent({ type: "login_blocked_disabled", actorEmail: email, actorId: user.id });
    return res.status(403).json({ ok: false, error: "هذا الحساب معطّل. تواصل مع مسؤول النظام." });
  }

  const remembered = !!remember;
  const token = issueSessionToken(user, remembered);
  res.setHeader("Set-Cookie", sessionCookie(token, remembered));
  await touchLastLogin(user.id);
  logEvent({ type: "login_success", actorEmail: user.email, actorId: user.id });
  res.status(200).json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

async function authLogout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const token = getCookie(req, "session");
  const payload = token ? verifyToken(token) : null;
  res.setHeader("Set-Cookie", clearSessionCookie());
  if (payload) logEvent({ type: "logout", actorEmail: payload.email, actorId: payload.sub });
  res.status(200).json({ ok: true });
}

async function authMe(req, res) {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });

  // Slide the idle-timeout window forward on activity (only for non-"remember" sessions).
  const token = getCookie(req, "session");
  const payload = verifyToken(token);
  if (payload && !payload.remember) {
    const fresh = issueSessionToken(user, false);
    res.setHeader("Set-Cookie", sessionCookie(fresh, false));
  }
  res.status(200).json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

/* ---------------- generic data CRUD ---------------- */
async function handleData(req, res, resource) {
  const actor = await requireUser(req);
  if (!actor) return res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });

  if (resource === "users") return handleUsers(req, res, actor);

  const mod = getResource(resource);
  const authRule = mod && mod.auth;
  if (!mod || !authRule) return res.status(404).json({ ok: false, error: "قسم بيانات غير معروف" });

  if (resource === "settings") return handleSettings(req, res, actor, mod, authRule);

  const { id } = req.query || {};
  try {
    if (req.method === "GET") {
      if (!authRule.read(actor.role)) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
      if (id) {
        const item = await mod.get(id);
        if (!item) return res.status(404).json({ ok: false, error: "غير موجود" });
        return res.status(200).json({ ok: true, item });
      }
      return res.status(200).json({ ok: true, items: await mod.list() });
    }
    if (!authRule.write(actor.role)) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
    if (req.method === "POST") {
      const item = await mod.create(parseBody(req));
      logEvent({ type: `${resource}_created`, actorEmail: actor.email, actorId: actor.id });
      return res.status(200).json({ ok: true, item });
    }
    if (req.method === "PUT") {
      const { id: bodyId, ...patch } = parseBody(req);
      const targetId = bodyId || id;
      if (!targetId) return res.status(400).json({ ok: false, error: "المعرّف مطلوب" });
      const item = await mod.update(targetId, patch);
      logEvent({ type: `${resource}_updated`, actorEmail: actor.email, actorId: actor.id, targetId });
      return res.status(200).json({ ok: true, item });
    }
    if (req.method === "DELETE") {
      const body = parseBody(req);
      const targetId = body.id || id;
      if (!targetId) return res.status(400).json({ ok: false, error: "المعرّف مطلوب" });
      await mod.remove(targetId);
      logEvent({ type: `${resource}_deleted`, actorEmail: actor.email, actorId: actor.id, targetId });
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err && err.message) || "تعذّر تنفيذ العملية" });
  }
}

/* settings is key/value, not a list of rows — GET returns the whole merged
   object, PUT upserts a single {key, value} pair. */
async function handleSettings(req, res, actor, mod, authRule) {
  try {
    if (req.method === "GET") {
      if (!authRule.read(actor.role)) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
      return res.status(200).json({ ok: true, settings: await mod.list() });
    }
    if (!authRule.write(actor.role)) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
    if (req.method === "PUT") {
      const { key, value } = parseBody(req);
      if (!key) return res.status(400).json({ ok: false, error: "المفتاح مطلوب" });
      const setting = await mod.set(key, value);
      logEvent({ type: "settings_updated", actorEmail: actor.email, actorId: actor.id, targetId: key });
      return res.status(200).json({ ok: true, setting });
    }
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err && err.message) || "تعذّر تنفيذ العملية" });
  }
}

/* Users keep their original, more specific business rules (Owner-only Owner
   management, self-delete guard, generated passwords, password hashing) —
   ported as-is from the old api/users/{list,create,update,delete}.js. */
async function handleUsers(req, res, actor) {
  if (!isAdminLike(actor.role)) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, users: await listUsers() });
  }

  if (req.method === "POST") {
    const { name, email, role, password } = parseBody(req);
    if (!name || !email || !role) return res.status(400).json({ ok: false, error: "الاسم والبريد الإلكتروني والدور مطلوبة" });
    if (!isValidRole(role)) return res.status(400).json({ ok: false, error: "دور غير صالح" });
    if (!canManageUser(actor.role, role)) return res.status(403).json({ ok: false, error: "فقط المالك يمكنه إنشاء حساب بصلاحية Owner" });
    try {
      const generated = password ? null : generatePassword(14);
      const user = await createUser({ name, email, role, passwordHash: hashPassword(password || generated), status: "active" });
      logEvent({ type: "user_created", actorEmail: actor.email, actorId: actor.id, targetId: user.id, meta: { role } });
      return res.status(200).json({ ok: true, user, generatedPassword: generated || undefined });
    } catch (err) {
      return res.status(400).json({ ok: false, error: (err && err.message) || "تعذر إنشاء المستخدم" });
    }
  }

  if (req.method === "PUT") {
    const { id, name, email, role, status, password } = parseBody(req);
    if (!id) return res.status(400).json({ ok: false, error: "معرّف المستخدم مطلوب" });
    const target = await findByIdRaw(id);
    if (!target) return res.status(404).json({ ok: false, error: "المستخدم غير موجود" });
    if (!canManageUser(actor.role, target.role)) return res.status(403).json({ ok: false, error: "لا يمكنك تعديل حساب Owner" });
    if (role && role !== target.role) {
      if (!isValidRole(role)) return res.status(400).json({ ok: false, error: "دور غير صالح" });
      if ((role === "owner" || target.role === "owner") && actor.role !== "owner") {
        return res.status(403).json({ ok: false, error: "فقط المالك يمكنه تعيين أو تغيير صلاحية Owner" });
      }
    }
    const patch = {};
    if (name) patch.name = name;
    if (email) patch.email = email;
    if (role) patch.role = role;
    if (status) patch.status = status;
    if (password) patch.passwordHash = hashPassword(password);
    try {
      const updated = await updateUser(id, patch);
      logEvent({ type: "user_updated", actorEmail: actor.email, actorId: actor.id, targetId: id, meta: { fields: Object.keys(patch) } });
      return res.status(200).json({ ok: true, user: updated });
    } catch (err) {
      return res.status(400).json({ ok: false, error: (err && err.message) || "تعذر تحديث المستخدم" });
    }
  }

  if (req.method === "DELETE") {
    const { id } = parseBody(req);
    if (!id) return res.status(400).json({ ok: false, error: "معرّف المستخدم مطلوب" });
    if (id === actor.id) return res.status(400).json({ ok: false, error: "لا يمكنك حذف حسابك الخاص" });
    const target = await findByIdRaw(id);
    if (!target) return res.status(404).json({ ok: false, error: "المستخدم غير موجود" });
    if (!canManageUser(actor.role, target.role)) return res.status(403).json({ ok: false, error: "لا يمكنك حذف حساب Owner" });
    await deleteUser(id);
    logEvent({ type: "user_deleted", actorEmail: actor.email, actorId: actor.id, targetId: id, meta: { deletedEmail: target.email } });
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ ok: false, error: "Method not allowed" });
}

/* ---------------- file uploads (Vercel Blob) ----------------
   Server-proxied: the browser POSTs raw file bytes here (same-origin,
   plain fetch — no client-side Blob SDK needed), we pipe them straight
   into Vercel Blob. Reused by every section that uploads a file (permits,
   payroll attachments, future document types) — the caller picks the
   `prefix` (a folder-ish label) so files stay organized in the store. */
async function handleFiles(req, res, action) {
  const actor = await requireUser(req);
  if (!actor) return res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });
  if (!isAdminLike(actor.role)) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });

  if (action === "upload") return filesUpload(req, res, actor);
  if (action === "delete") return filesDelete(req, res, actor);
  res.status(404).json({ ok: false, error: "Not found" });
}

async function filesUpload(req, res, actor) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const prefix = String((req.query || {}).prefix || "uploads").replace(/[^\w\-\/]/g, "");
  const filename = decodeURIComponent(req.headers["x-filename"] || "file");
  const safeName = filename.replace(/[^\w.\-؀-ۿ]/g, "_");
  const contentType = req.headers["content-type"] || "application/octet-stream";
  // Vercel's Node runtime buffers small bodies into req.body regardless of
  // content-type on some versions; fall back to the raw request stream
  // (req itself) when that hasn't happened, so the file is never dropped.
  const body = req.body && (Buffer.isBuffer(req.body) || typeof req.body === "string") ? req.body : req;
  try {
    const url = await uploadFile(`${prefix}/${Date.now()}-${safeName}`, body, contentType);
    logEvent({ type: "file_uploaded", actorEmail: actor.email, actorId: actor.id, meta: { url, prefix } });
    res.status(200).json({ ok: true, url });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err && err.message) || "تعذّر رفع الملف" });
  }
}

async function filesDelete(req, res, actor) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const { url } = parseBody(req);
  if (!url) return res.status(400).json({ ok: false, error: "رابط الملف مطلوب" });
  await deleteFile(url);
  logEvent({ type: "file_deleted", actorEmail: actor.email, actorId: actor.id, meta: { url } });
  res.status(200).json({ ok: true });
}
