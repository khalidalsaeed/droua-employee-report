const DOCUMENT_TYPES = require("./documentTypes");

function parseDate(s) {
  if (s == null) return null;
  if (typeof s === "string" && s.includes("/")) {
    const [m, d, y] = s.split("/").map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function daysLeft(s, now) {
  const d = parseDate(s);
  if (!d) return null;
  d.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

/* Fires once, the day a document's remaining days exactly matches thresholdDays. */
function scanExpirations(employees, thresholdDays, now = new Date()) {
  now = new Date(now);
  now.setHours(0, 0, 0, 0);
  const alerts = [];
  for (const emp of employees) {
    for (const doc of DOCUMENT_TYPES) {
      const expiry = doc.getExpiry(emp);
      const remaining = daysLeft(expiry, now);
      if (remaining === thresholdDays) {
        alerts.push({
          employeeName: emp.name,
          documentTypeLabel: doc.label,
          expiryDate: expiry,
          remainingDays: remaining,
        });
      }
    }
  }
  return alerts;
}

module.exports = { scanExpirations, parseDate, daysLeft };
