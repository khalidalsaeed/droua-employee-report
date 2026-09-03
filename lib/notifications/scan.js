/* Escalation ladder applied to every document type (iqama, license, ajeer):
   fires at exactly these many days before expiry, then every single day
   once the document is overdue (remaining < 0) until it's renewed. */
const UPCOMING_TRIGGER_DAYS = [5, 2, 0];

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

function stageFor(remaining) {
  if (remaining < 0) return "overdue";
  if (!UPCOMING_TRIGGER_DAYS.includes(remaining)) return null;
  if (remaining === 0) return "today";
  if (remaining === 2) return "2day";
  return "5day";
}

/* documentTypes: rows from lib/data/documentTypes.js — {key,label,employeeField}.
   employeeField picks out the matching key on each employee object returned
   by lib/notifications/employees.js (iqExp | licExp | ajeerExp). */
function scanExpirations(employees, documentTypes, now = new Date()) {
  now = new Date(now);
  now.setHours(0, 0, 0, 0);
  const alerts = [];
  for (const emp of employees) {
    for (const doc of documentTypes) {
      const expiry = emp[doc.employeeField];
      const remaining = daysLeft(expiry, now);
      if (remaining === null) continue;
      const stage = stageFor(remaining);
      if (!stage) continue;
      alerts.push({
        /* employeeId و documentTypeKey مُضافان ليكون لكل تنبيه هويّة
           ثابتة لا تعتمد على نصّ معروض: قناة الدفع تحتاجهما للتجميع
           ولتتبّع ما أُرسل. لا يغيّران شرط التنبيه ولا سلّم التصعيد،
           وقالب البريد يتجاهل ما لا يستعمله. */
        employeeId: emp.eid,
        employeeName: emp.name,
        documentTypeKey: doc.key,
        documentTypeLabel: doc.label,
        expiryDate: expiry,
        remainingDays: remaining,
        stage,
      });
    }
  }
  return alerts;
}

module.exports = { scanExpirations, parseDate, daysLeft };
