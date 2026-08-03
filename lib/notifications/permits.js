const { loadHtml } = require("./htmlSource");

function extractAjeerArray(html) {
  const m = html.match(/const AJEER\s*=\s*(\[[\s\S]*\]);\s*\nconst SOON/);
  if (!m) throw new Error("تعذر العثور على AJEER داخل app-shell.html");
  return JSON.parse(m[1]);
}

/* newest issueDate per iqama wins — a re-uploaded permit supersedes the old one */
function latestByIqama(permits) {
  const map = new Map();
  for (const p of permits) {
    const cur = map.get(p.iqama);
    if (!cur || new Date(p.issueDate) > new Date(cur.issueDate)) map.set(p.iqama, p);
  }
  return map;
}

/* returns Map<iqama, expiryDate> for the latest Ajeer permit per worker */
async function loadPermitExpiryByIqama() {
  const html = loadHtml();
  const raw = extractAjeerArray(html);
  const latest = latestByIqama(raw);
  const map = new Map();
  for (const [iqama, p] of latest) map.set(String(iqama), p.expiryDate);
  return map;
}

module.exports = { loadPermitExpiryByIqama };
