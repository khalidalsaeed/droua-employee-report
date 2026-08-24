const nodemailer = require("nodemailer");

function getTransporter() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error("GMAIL_USER أو GMAIL_APP_PASSWORD غير مُهيّأ على الخادم");
  }
  /* Google DISPLAYS an app password in four groups of four ("abcd efgh ijkl
     mnop"), so that is how it gets pasted into an env var — and Gmail's SMTP
     then answers 535 BadCredentials, which reads like a wrong password rather
     than a formatting problem. The password is 16 characters; the spaces are
     presentation only, so they are removed here. */
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: String(GMAIL_USER).trim(), pass: String(GMAIL_APP_PASSWORD).replace(/\s+/g, "") },
  });
}

/* `attachments` is optional and passed straight through to nodemailer
   ([{filename, content}]), so the monthly report can attach its PDF without a
   second transport or a different sender. Existing callers that omit it are
   unaffected. */
async function sendMail({ to, subject, text, attachments }) {
  const transporter = getTransporter();
  const message = { from: process.env.GMAIL_USER, to, subject, text };
  if (attachments && attachments.length) message.attachments = attachments;
  return transporter.sendMail(message);
}

module.exports = { sendMail };
