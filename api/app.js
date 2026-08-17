const fs = require("fs");
const path = require("path");

const { requireUser } = require("../lib/auth/requireAuth");
const { isValidRole, canManageUser } = require("../lib/auth/roles");
const {
  PAGE_PERMISSION,
  SECTION_BY_KEY,
  hasPermission,
  resolvePermissions,
  usesRoleDefaults,
  sanitizePermissions,
  catalogue,
} = require("../lib/auth/permissions");
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
/* Which permission each page needs is declared once, in
   lib/auth/permissions.js (PAGE_PERMISSION) — not duplicated here.

   Per-resource authorization for /api/data/:resource is derived from the
   resource module's own `section` (see lib/data/employees.js) plus the HTTP
   method, via METHOD_ACTION below. Adding a new platform section is then a
   new lib/data/<name>.js module + one registry line + one SECTIONS entry;
   this file never needs to change. "users" is handled separately below (its
   business rules — self-delete guard, Owner-only Owner management, generated
   passwords, permission management — don't fit a generic CRUD shape). */
const METHOD_ACTION = { GET: "view", POST: "create", PUT: "edit", DELETE: "delete" };

const FORBIDDEN = { ok: false, error: "صلاحيات غير كافية" };

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
  if (!file || !(page in PAGE_PERMISSION)) {
    res.status(404).end("Not found");
    return;
  }
  const user = await requireUser(req);
  if (!user) {
    res.writeHead(302, { Location: "/login.html", ...NO_CACHE });
    res.end();
    return;
  }
  const required = PAGE_PERMISSION[page];
  if (required && !hasPermission(user, ...required.split(":"))) {
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
  if (action === "permissions-catalogue") return authCatalogue(req, res);
  res.status(404).json({ ok: false, error: "Not found" });
}

/* The shape every page's client code sees for the signed-in user. `permissions`
   is the RESOLVED effective list (role defaults or the custom set, with Owner
   always full), so the frontend never has to reimplement the resolution rules
   — it just checks membership to decide what to show. */
function sessionUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    jobTitle: user.jobTitle,
    permissions: resolvePermissions(user),
  };
}

/* Section/action catalogue for the "إدارة الصلاحيات" modal. Requires
   users:manage — there's no reason for anyone else to enumerate it. */
async function authCatalogue(req, res) {
  const actor = await requireUser(req);
  if (!actor) return res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });
  if (!hasPermission(actor, "users", "manage")) return res.status(403).json(FORBIDDEN);
  res.status(200).json({ ok: true, ...catalogue() });
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
  res.status(200).json({ ok: true, user: sessionUser(user) });
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
  res.status(200).json({ ok: true, user: sessionUser(user) });
}

/* ---------------- generic data CRUD ---------------- */
async function handleData(req, res, resource) {
  const actor = await requireUser(req);
  if (!actor) return res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });

  if (resource === "users") return handleUsers(req, res, actor);

  const mod = getResource(resource);
  if (!mod || !mod.section) return res.status(404).json({ ok: false, error: "قسم بيانات غير معروف" });

  if (resource === "settings") return handleSettings(req, res, actor, mod);

  /* One gate for every method — the action is derived from the verb, so a
     resource can never accidentally ship without a check on one of them. */
  const action = METHOD_ACTION[req.method];
  if (!action) return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (!hasPermission(actor, mod.section, action)) return res.status(403).json(FORBIDDEN);

  const { id } = req.query || {};
  try {
    if (req.method === "GET") {
      if (id) {
        const item = await mod.get(id);
        if (!item) return res.status(404).json({ ok: false, error: "غير موجود" });
        return res.status(200).json({ ok: true, item });
      }
      return res.status(200).json({ ok: true, items: await mod.list() });
    }
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
async function handleSettings(req, res, actor, mod) {
  try {
    if (req.method === "GET") {
      if (!hasPermission(actor, mod.section, "view")) return res.status(403).json(FORBIDDEN);
      return res.status(200).json({ ok: true, settings: await mod.list() });
    }
    if (!hasPermission(actor, mod.section, "edit")) return res.status(403).json(FORBIDDEN);
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

/* Returns null when the actor may apply `next` to `target`, or {status, error}
   explaining the refusal. Four rules, in order:

   1. Changing anyone's permissions needs users:manage — a plain users:edit
      holder can rename a user but not widen their access.
   2. Owner is always full-access and immutable, so any attempt to pin a
      permission set on an Owner is rejected outright (rather than silently
      ignored, which would look like it worked).
   3. Nobody edits their own permissions. This closes self-escalation without
      having to reason about which individual grants are safe.
   4. A non-Owner cannot grant a permission they don't themselves hold, so
      users:manage can delegate but never manufacture new authority. */
function guardPermissionChange(actor, target, next) {
  if (!hasPermission(actor, "users", "manage")) {
    return { status: 403, error: "لا تملك صلاحية إدارة صلاحيات المستخدمين" };
  }
  if (target.role === "owner") {
    return { status: 403, error: "لا يمكن تعديل صلاحيات حساب المالك — المالك يملك كامل الصلاحيات دائمًا" };
  }
  if (target.id === actor.id) {
    return { status: 403, error: "لا يمكنك تعديل صلاحيات حسابك الخاص" };
  }
  if (next !== null && !Array.isArray(next)) {
    return { status: 400, error: "صيغة الصلاحيات غير صالحة" };
  }
  if (actor.role !== "owner" && Array.isArray(next)) {
    const actorHolds = new Set(resolvePermissions(actor));
    const escalated = sanitizePermissions(next).filter((p) => !actorHolds.has(p));
    if (escalated.length) {
      return { status: 403, error: `لا يمكنك منح صلاحيات لا تملكها: ${escalated.join(", ")}` };
    }
  }
  return null;
}

/* Users keep their original, more specific business rules (Owner-only Owner
   management, self-delete guard, generated passwords, password hashing) —
   ported as-is from the old api/users/{list,create,update,delete}.js. */
async function handleUsers(req, res, actor) {
  const action = METHOD_ACTION[req.method];
  if (!action) return res.status(405).json({ ok: false, error: "Method not allowed" });
  /* PUT covers two different jobs: editing a user's details (users:edit) and
     changing their permissions (users:manage). They're independent — someone
     may be allowed to delegate access without being able to rename accounts,
     or vice versa — so the coarse gate accepts either and the PUT branch below
     enforces whichever one this particular request actually needs. */
  const gate =
    req.method === "PUT"
      ? hasPermission(actor, "users", "edit") || hasPermission(actor, "users", "manage")
      : hasPermission(actor, "users", action);
  if (!gate) return res.status(403).json(FORBIDDEN);

  if (req.method === "GET") {
    /* Each row carries its resolved permission list and whether it's on role
       defaults, so the modal can open pre-filled without a second request. */
    const users = await listUsers();
    return res.status(200).json({
      ok: true,
      users: users.map((u) => ({ ...u, effectivePermissions: resolvePermissions(u), usesRoleDefaults: usesRoleDefaults(u) })),
    });
  }

  if (req.method === "POST") {
    const { name, email, role, password, jobTitle } = parseBody(req);
    if (!name || !email || !role) return res.status(400).json({ ok: false, error: "الاسم والبريد الإلكتروني والدور مطلوبة" });
    if (!isValidRole(role)) return res.status(400).json({ ok: false, error: "دور غير صالح" });
    if (!canManageUser(actor.role, role)) return res.status(403).json({ ok: false, error: "فقط المالك يمكنه إنشاء حساب بصلاحية Owner" });
    try {
      const generated = password ? null : generatePassword(14);
      const user = await createUser({ name, email, role, jobTitle, passwordHash: hashPassword(password || generated), status: "active" });
      logEvent({ type: "user_created", actorEmail: actor.email, actorId: actor.id, targetId: user.id, meta: { role } });
      return res.status(200).json({ ok: true, user, generatedPassword: generated || undefined });
    } catch (err) {
      return res.status(400).json({ ok: false, error: (err && err.message) || "تعذر إنشاء المستخدم" });
    }
  }

  if (req.method === "PUT") {
    const body = parseBody(req);
    const { id, name, email, role, status, password, jobTitle } = body;
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
    if (jobTitle) patch.jobTitle = jobTitle;
    if (password) patch.passwordHash = hashPassword(password);

    /* Detail edits need users:edit specifically — holding only users:manage
       lets you change permissions, not rename or re-role an account. */
    if (Object.keys(patch).length && !hasPermission(actor, "users", "edit")) {
      return res.status(403).json(FORBIDDEN);
    }

    /* Permission changes ride on the same PUT but are gated separately: only
       "permissions" being present in the body counts as an attempt to change
       them, so the ordinary edit form (which never sends the key) can't clear
       a custom set by omission. */
    if ("permissions" in body) {
      const guard = guardPermissionChange(actor, target, body.permissions);
      if (guard) return res.status(guard.status).json({ ok: false, error: guard.error });
      patch.permissions = body.permissions === null ? null : sanitizePermissions(body.permissions);
    }
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
   `prefix` (a folder-ish label) so files stay organized in the store, and
   names the `section` whose upload_files/delete_files permission should be
   checked. The section is validated against the catalogue, so a caller can't
   invent one to dodge the check; and because attaching an uploaded URL to a
   record is itself a PUT on that record, a stray upload can never become
   visible data without the matching edit permission too. */
async function handleFiles(req, res, action) {
  const actor = await requireUser(req);
  if (!actor) return res.status(401).json({ ok: false, error: "غير مسجّل الدخول" });

  const fileAction = action === "upload" ? "upload_files" : action === "delete" ? "delete_files" : null;
  if (!fileAction) return res.status(404).json({ ok: false, error: "Not found" });

  const section = String((req.query || {}).section || "");
  const known = SECTION_BY_KEY[section];
  if (!known || !known.actions.includes(fileAction)) {
    return res.status(400).json({ ok: false, error: "قسم غير صالح لعمليات الملفات" });
  }
  if (!hasPermission(actor, section, fileAction)) return res.status(403).json(FORBIDDEN);

  if (action === "upload") return filesUpload(req, res, actor);
  return filesDelete(req, res, actor);
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
