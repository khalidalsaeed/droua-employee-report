const employees = require("./employees");
const permits = require("./permits");
const payrollRuns = require("./payrollRuns");
const documentTypes = require("./documentTypes");
const recipients = require("./recipients");
const settings = require("./settings");
const tickets = require("./tickets");
const users = require("../auth/users");

/* Adapts lib/auth/users.js's differently-named exports (kept there so
   requireAuth.js/login.js don't need to change) to the uniform
   list/get/create/update/remove interface every other resource module uses. */
const usersAdapter = {
  list: users.listUsers,
  get: users.findById,
  create: async ({ name, email, role, status, passwordHash, jobTitle }) => users.createUser({ name, email, role, status, passwordHash, jobTitle }),
  update: (id, patch) => users.updateUser(id, patch),
  remove: (id) => users.deleteUser(id),
};

/* Maps the ":resource" segment of /api/data/:resource to its module. Add a
   new section to the platform (attendance, policies, ...) by adding one
   line here plus a lib/data/<name>.js module — no new Serverless Function. */
const REGISTRY = {
  employees,
  permits,
  "payroll-runs": payrollRuns,
  "document-types": documentTypes,
  recipients,
  users: usersAdapter,
  settings, // special-cased in the router (key/value, not list/id CRUD)
  tickets, // special-cased in the router (extra actions: add_followup, close)
};

function getResource(name) {
  return REGISTRY[name] || null;
}

module.exports = { getResource, REGISTRY };
