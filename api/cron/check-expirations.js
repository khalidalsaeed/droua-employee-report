const { loadEmployees } = require("../../lib/notifications/employees");
const { loadPermitExpiryByIqama } = require("../../lib/notifications/permits");
const { scanExpirations } = require("../../lib/notifications/scan");
const RECIPIENTS = require("../../lib/notifications/recipients");
const { buildEmail } = require("../../lib/notifications/templates");
const { sendMail } = require("../../lib/notifications/mailer");

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
  }
  try {
    const employees = await loadEmployees();
    const permitExpiryByIqama = await loadPermitExpiryByIqama();
    for (const emp of employees) emp.ajeerExp = permitExpiryByIqama.get(String(emp.iqama)) || null;
    const alerts = scanExpirations(employees);

    if (!alerts.length) {
      res.status(200).json({ ok: true, sent: 0, alerts: 0 });
      return;
    }

    const results = [];
    for (const recipient of RECIPIENTS) {
      const email = buildEmail(recipient, alerts);
      const info = await sendMail({ to: recipient.email, subject: email.subject, text: email.text });
      results.push({ to: recipient.email, messageId: info.messageId });
    }

    res.status(200).json({ ok: true, sent: results.length, alerts: alerts.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) || "خطأ داخلي" });
  }
};
