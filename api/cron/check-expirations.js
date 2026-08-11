const { loadEmployees } = require("../../lib/notifications/employees");
const { loadPermitExpiryByIqama } = require("../../lib/notifications/permits");
const { scanExpirations } = require("../../lib/notifications/scan");
const documentTypesData = require("../../lib/data/documentTypes");
const recipientsData = require("../../lib/data/recipients");
const { buildEmail } = require("../../lib/notifications/templates");
const { sendMail } = require("../../lib/notifications/mailer");

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
  try {
    const [employees, permitExpiryByIqama, documentTypes, recipients] = await Promise.all([
      loadEmployees(),
      loadPermitExpiryByIqama(),
      documentTypesData.list(),
      recipientsData.list(),
    ]);
    for (const emp of employees) emp.ajeerExp = permitExpiryByIqama.get(String(emp.iqama)) || null;
    const alerts = scanExpirations(employees, documentTypes);

    if (!alerts.length) {
      res.status(200).json({ ok: true, sent: 0, alerts: 0 });
      return;
    }

    const results = [];
    for (const recipient of recipients) {
      const email = buildEmail(recipient, alerts);
      const info = await sendMail({ to: recipient.email, subject: email.subject, text: email.text });
      results.push({ to: recipient.email, messageId: info.messageId });
    }

    res.status(200).json({ ok: true, sent: results.length, alerts: alerts.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) || "خطأ داخلي" });
  }
};
