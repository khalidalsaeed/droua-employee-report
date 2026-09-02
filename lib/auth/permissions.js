/* ─── Single source of truth for the platform's permission catalogue ───

   A permission is the string "<section>:<action>" (e.g. "employees:delete").

   To add a new platform section later, add ONE entry to SECTIONS below (and,
   if it has its own page, one line in PAGE_PERMISSION). Everything else is
   derived from this file: the role defaults, the "إدارة الصلاحيات" modal in
   users-shell.html (it renders whatever the catalogue API returns), the page
   gate in api/app.js, and the per-request checks on /api/data/* and
   /api/files/*. No other file needs to change.

   Role is only a *default*: a user row may carry its own `permissions` array
   which replaces the role defaults entirely (see resolvePermissions). Owner
   is special-cased to always hold everything and can never be reduced. */

const ACTION_LABELS = {
  view: "عرض",
  create: "إضافة",
  edit: "تعديل",
  delete: "حذف",
  upload_files: "رفع ملفات",
  delete_files: "حذف/استبدال ملفات",
  manage: "إدارة واعتماد",
  add_followup: "إضافة متابعة",
  close: "إغلاق وإلغاء",
  generate: "إنشاء وتنزيل",
  send: "إرسال بالبريد",
};

/* `actions` lists only what the section actually supports, so the modal never
   offers a toggle that maps to nothing on the backend. */
const SECTIONS = [
  { key: "kpi", label: "المؤشرات التنفيذية", actions: ["view"] },
  { key: "finance", label: "التحليل المالي", actions: ["view"] },
  /* upload_files/delete_files cover the iqama and work-licence documents
     attached to an employee, from which the expiry dates are auto-extracted. */
  { key: "employees", label: "سجل الموظفين", actions: ["view", "create", "edit", "delete", "upload_files", "delete_files"] },
  { key: "payroll", label: "مسير الرواتب", actions: ["view", "create", "edit", "delete", "upload_files", "delete_files"] },
  { key: "ajeer", label: "تصاريح أجير", actions: ["view", "create", "edit", "delete", "upload_files", "delete_files"] },
  /* add_followup and close are separate from edit on purpose: following up on a
     request is the everyday action, while closing/cancelling one is a decision.
     delete exists but cancelling is the intended path. */
  { key: "tickets", label: "التذاكر والمتابعات", actions: ["view", "create", "edit", "add_followup", "close", "delete"] },
  /* generate = build/preview/download a report; send = actually email it. Kept
     apart because far more people need to read a report than to send one. */
  { key: "reports", label: "التقارير الشهرية", actions: ["view", "generate", "send"] },
  { key: "contact", label: "التواصل مع الموارد البشرية", actions: ["view"] },
  { key: "users", label: "إدارة المستخدمين", actions: ["view", "create", "edit", "delete", "manage"] },
  { key: "settings", label: "الإعدادات العامة", actions: ["view", "edit"] },
  { key: "document_types", label: "أنواع المستندات", actions: ["view", "create", "edit", "delete"] },
  { key: "recipients", label: "مستلمو تنبيهات الانتهاء", actions: ["view", "create", "edit", "delete"] },
];

const SECTION_BY_KEY = SECTIONS.reduce((acc, s) => ((acc[s.key] = s), acc), {});

/* Every valid permission string, in catalogue order. */
const ALL_PERMISSIONS = SECTIONS.flatMap((s) => s.actions.map((a) => `${s.key}:${a}`));
const ALL_PERMISSIONS_SET = new Set(ALL_PERMISSIONS);

/* Which permission a whole page requires to be served at all. Sections the
   user can't see are hidden inside the page individually; this is only the
   coarse "may you open this URL" gate. `home` is intentionally open to any
   signed-in user — it hosts several sections and hides them one by one. */
const PAGE_PERMISSION = {
  home: null,
  users: "users:view",
  payroll: "payroll:view",
  "payroll-detail": "payroll:view",
  tickets: "tickets:view",
  "ticket-detail": "tickets:view",
  reports: "reports:view",
  /* صفحة الوثائق قريبة الانتهاء تعرض بيانات سجلّ الموظفين، فتُحرس
     بصلاحيته نفسها التي يفرضها /api/data/employees على بياناتها. */
  expiring: "employees:view",
};

/* Role defaults. "*" = everything. These reproduce the behaviour the platform
   had when authorization was role-only, so switching an existing account to
   "role defaults" changes nothing for it.

   settings:view is granted to every role on purpose: the dashboard reads the
   financial-summary and expiry-threshold config from /api/data/settings. The
   frontend degrades gracefully if it's revoked, but revoking it hides the
   financial totals and falls back to the default expiry window. */
const ROLE_DEFAULT_SPECS = {
  owner: "*",
  admin: "*",
  /* HR runs the follow-up with the Ajeer counterparty, so they get the working
     set for tickets — everything except delete. */
  hr: {
    kpi: ["view"], employees: ["view"], ajeer: ["view"], contact: ["view"], settings: ["view"],
    tickets: ["view", "create", "edit", "add_followup", "close"],
    /* HR reads and produces the report; emailing it stays with Owner/Admin. */
    reports: ["view", "generate"],
  },
  finance: { finance: ["view"], payroll: ["view"], settings: ["view"] },
  viewer: {
    kpi: ["view"], finance: ["view"], employees: ["view"], ajeer: ["view"], contact: ["view"], settings: ["view"],
    tickets: ["view"], reports: ["view"],
  },
};

function expandSpec(spec) {
  if (spec === "*") return [...ALL_PERMISSIONS];
  const out = [];
  for (const [sectionKey, actions] of Object.entries(spec || {})) {
    for (const action of actions) {
      const key = `${sectionKey}:${action}`;
      if (ALL_PERMISSIONS_SET.has(key)) out.push(key);
    }
  }
  return out;
}

const ROLE_DEFAULTS = Object.fromEntries(
  Object.entries(ROLE_DEFAULT_SPECS).map(([role, spec]) => [role, expandSpec(spec)])
);

function defaultPermissionsForRole(role) {
  return ROLE_DEFAULTS[role] ? [...ROLE_DEFAULTS[role]] : [];
}

/* Drops anything that isn't a real permission in the current catalogue, so a
   stale stored array (e.g. a section that was removed) can't grant access and
   can't crash a check either. */
function sanitizePermissions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const raw of list) {
    const key = String(raw);
    if (ALL_PERMISSIONS_SET.has(key)) seen.add(key);
  }
  return ALL_PERMISSIONS.filter((k) => seen.has(k));
}

/* The effective permission list for a user, as a plain array in catalogue
   order. Owner always gets everything regardless of what's stored. A stored
   array (custom mode) fully REPLACES the role defaults; null/absent means
   "use role defaults". */
function resolvePermissions(user) {
  if (!user) return [];
  if (user.role === "owner") return [...ALL_PERMISSIONS];
  if (Array.isArray(user.permissions)) return sanitizePermissions(user.permissions);
  return defaultPermissionsForRole(user.role);
}

function hasPermission(user, section, action) {
  if (!user) return false;
  if (user.role === "owner") return true;
  return resolvePermissions(user).includes(`${section}:${action}`);
}

/* True when this user is on role defaults rather than a custom array — drives
   the radio choice in the permissions modal. Owner is always reported as
   "role defaults" since its permissions are not editable. */
function usesRoleDefaults(user) {
  if (!user || user.role === "owner") return true;
  return !Array.isArray(user.permissions);
}

/* Shipped to the browser so the modal can render sections/actions/labels
   without duplicating any of this in HTML or JS. */
function catalogue() {
  return { sections: SECTIONS, actionLabels: ACTION_LABELS, roleDefaults: ROLE_DEFAULTS };
}

module.exports = {
  ACTION_LABELS,
  SECTIONS,
  SECTION_BY_KEY,
  ALL_PERMISSIONS,
  PAGE_PERMISSION,
  ROLE_DEFAULTS,
  defaultPermissionsForRole,
  sanitizePermissions,
  resolvePermissions,
  hasPermission,
  usesRoleDefaults,
  catalogue,
};
