const fs = require("fs");
const path = require("path");

/* Append-only audit log, one JSON object per line. The call signature is
   intentionally the only thing callers depend on — swapping this for a real
   database table later means rewriting just this one function. */
const LOG_PATH = path.join(process.cwd(), "data", "audit-log.jsonl");

function logEvent({ type, actorEmail, actorId, targetId, meta }) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    actorEmail: actorEmail || null,
    actorId: actorId || null,
    targetId: targetId || null,
    meta: meta || {},
  };
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("audit log write failed", err);
  }
}

function readLog(limit = 200) {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
}

module.exports = { logEvent, readLog };
