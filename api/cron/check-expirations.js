const { loadEmployees } = require("../../lib/notifications/employees");
const { loadPermitExpiryByIqama } = require("../../lib/notifications/permits");
const { scanExpirations } = require("../../lib/notifications/scan");
const documentTypesData = require("../../lib/data/documentTypes");
const recipientsData = require("../../lib/data/recipients");
const { buildEmail } = require("../../lib/notifications/templates");
const { sendMail } = require("../../lib/notifications/mailer");
const { runScheduled } = require("../../lib/reports/monthlyReport");

/* The daily expiry scan. Kept as one function on purpose (Hobby caps the
   count), so the monthly report rides along on the same trigger: runScheduled
   decides for itself whether today is a day it should act on, and the database
   claim in monthly_reports guarantees a month is never sent twice.

   The two jobs are isolated from each other — neither one's failure may stop
   the other, which is why each has its own try/catch and its own key in the
   response instead of sharing one. */
async function runExpiryAlerts() {
  const [employees, permitExpiryByIqama, documentTypes, recipients] = await Promise.all([
    loadEmployees(),
    loadPermitExpiryByIqama(),
    documentTypesData.list(),
    recipientsData.list(),
  ]);
  for (const emp of employees) emp.ajeerExp = permitExpiryByIqama.get(String(emp.iqama)) || null;
  const alerts = scanExpirations(employees, documentTypes);
  if (!alerts.length) return { ok: true, sent: 0, alerts: 0 };

  const results = [];
  for (const recipient of recipients) {
    const email = buildEmail(recipient, alerts);
    const info = await sendMail({ to: recipient.email, subject: email.subject, text: email.text });
    results.push({ to: recipient.email, messageId: info.messageId });
  }
  return { ok: true, sent: results.length, alerts: alerts.length, results };
}

module.exports = async function handler(req, res) {
  // Vercel invokes cron jobs with GET — reject anything else before it can
  // reach the scan/send logic.
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  if (process.env.CRON_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
  }
  let expiry, monthly;
  try {
    expiry = await runExpiryAlerts();
  } catch (err) {
    expiry = { ok: false, error: (err && err.message) || "خطأ داخلي" };
  }
  try {
    monthly = await runScheduled(new Date());
  } catch (err) {
    monthly = { ran: false, ok: false, error: (err && err.message) || "خطأ داخلي" };
  }
  /* 500 only if the expiry scan itself failed — that is what this cron is
     primarily for, and what a red run in Vercel's log should mean. */
  res.status(expiry.ok ? 200 : 500).json({ ok: expiry.ok, ...expiry, monthlyReport: monthly });
};
