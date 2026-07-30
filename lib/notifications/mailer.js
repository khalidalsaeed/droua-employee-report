const nodemailer = require("nodemailer");

function getTransporter() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("GMAIL_USER أو GMAIL_APP_PASSWORD غير مُهيّأ على الخادم");
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
}

async function sendMail({ to, subject, text }) {
  const transporter = getTransporter();
  return transporter.sendMail({ from: process.env.GMAIL_USER, to, subject, text });
}

module.exports = { sendMail };
