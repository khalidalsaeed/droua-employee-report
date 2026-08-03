const { verify } = require("./tokens");
const { getCookie } = require("./cookies");
const { findByIdRaw } = require("./users");

/* Every protected API route calls this itself — it never trusts a header set
   by the routing middleware, so a bug or bypass at the edge layer can't grant
   access on its own. Returns the raw user record (has passwordHash — strip
   before sending in any response) or null. */
async function requireUser(req) {
  const token = getCookie(req, "session");
  const payload = token ? verify(token) : null;
  if (!payload) return null;
  const user = await findByIdRaw(payload.sub);
  if (!user || user.status !== "active") return null;
  return user;
}

module.exports = { requireUser };
