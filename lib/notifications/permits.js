const permitsData = require("../data/permits");

/* newest issueDate per iqama wins — a re-uploaded permit supersedes the old one */
function latestByIqama(permits) {
  const map = new Map();
  for (const p of permits) {
    const cur = map.get(p.iqama);
    if (!cur || new Date(p.issueDate) > new Date(cur.issueDate)) map.set(p.iqama, p);
  }
  return map;
}

/* returns Map<iqama, expiryDate> for the latest Ajeer permit per worker.
   Reads from Neon (via lib/data/permits.js) instead of parsing app-shell.html. */
async function loadPermitExpiryByIqama() {
  const raw = await permitsData.list();
  const latest = latestByIqama(raw);
  const map = new Map();
  for (const [iqama, p] of latest) map.set(String(iqama), p.expiryDate);
  return map;
}

module.exports = { loadPermitExpiryByIqama };
