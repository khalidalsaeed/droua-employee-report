/* Add a new role here (plus its label) to extend the system later. */
const ROLES = ["owner", "admin", "hr", "finance", "viewer"];

const ROLE_LABELS = {
  owner: "المالك",
  admin: "مدير النظام",
  hr: "الموارد البشرية",
  finance: "المالية",
  viewer: "قراءة فقط",
};

/* Which page/section keys each role may see. Add a new page key here (and to
   the pages actually gated in index.html / users.html) to extend the system. */
const PAGE_PERMISSIONS = {
  owner: ["kpi", "finance", "employees", "ajeer", "contact", "users"],
  admin: ["kpi", "finance", "employees", "ajeer", "contact", "users"],
  hr: ["kpi", "employees", "ajeer", "contact"],
  finance: ["finance"],
  viewer: ["kpi", "finance", "employees", "ajeer", "contact"],
};

function can(role, page) {
  return (PAGE_PERMISSIONS[role] || []).includes(page);
}

function isValidRole(role) {
  return ROLES.includes(role);
}

/* Only Owner may manage another Owner account; Admin can manage everyone else. */
function canManageUser(actorRole, targetRole) {
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return targetRole !== "owner";
  return false;
}

function isAdminLike(role) {
  return role === "owner" || role === "admin";
}

module.exports = { ROLES, ROLE_LABELS, PAGE_PERMISSIONS, can, isValidRole, canManageUser, isAdminLike };
