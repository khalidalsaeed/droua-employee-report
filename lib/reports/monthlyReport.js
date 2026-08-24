const { getSql } = require("../db");
const { periodFor, previousMonthPeriod, riyadhToday } = require("./period");
const { buildReportData, summarize } = require("./reportData");
const { renderPdf, pdfFileName } = require("./reportPdf");
const { subjectFor, bodyFor } = require("./reportEmail");
const { sendMail } = require("../notifications/mailer");
const { logEvent } = require("../auth/audit");

/* ─── Monthly report orchestration ───

   Sending is guarded at the DATABASE level, not in application logic: the
   monthly_reports row is claimed with

     INSERT ... ON CONFLICT (period_year, period_month) DO NOTHING RETURNING id

   so a duplicated cron firing, a retry, or two people pressing "send" at once
   produce exactly one claim. Whoever loses the race stops. A claim that then
   fails is marked 'failed' and may be retried; a claim that succeeded is
   'sent' and is never resent.

   The permission section is "reports". */
const section = "reports";

/* Report data + rendered PDF, without touching the send bookkeeping. Used by
   preview/download and by the send path. */
async function generate(year, month, now = new Date()) {
  const data = await buildReportData(year, month, now);
  const pdf = await renderPdf(data);
  return { data, pdf, fileName: pdfFileName(data.period), summary: summarize(data) };
}

async function listReports() {
  const sql = getSql();
  const rows = await sql`
    SELECT id, period_year, period_month, period_start::text, period_end::text, status,
           generated_at, sent_at, recipients, summary, error, trigger, actor_email
      FROM monthly_reports ORDER BY period_year DESC, period_month DESC`;
  return rows.map((r) => ({
    id: String(r.id),
    year: r.period_year,
    month: r.period_month,
    label: periodFor(r.period_year, r.period_month).label,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    generatedAt: r.generated_at,
    sentAt: r.sent_at,
    recipients: r.recipients || [],
    summary: r.summary || null,
    error: r.error,
    trigger: r.trigger,
    actorEmail: r.actor_email,
  }));
}

const getReport = async (year, month) => {
  const sql = getSql();
  const rows = await sql`
    SELECT status, sent_at, recipients FROM monthly_reports
     WHERE period_year = ${Number(year)} AND period_month = ${Number(month)}`;
  return rows[0] || null;
};

/* Recipients who opted in. Deliberately NOT everyone on the expiry-alert list. */
async function monthlyRecipients() {
  const sql = getSql();
  const rows = await sql`SELECT name, email FROM recipients WHERE wants_monthly_report = true ORDER BY id`;
  return rows.map((r) => ({ name: r.name, email: r.email }));
}

/* Sends the report for a period, at most once ever.

   `overrideRecipients` makes it a TEST send to one named address. A test send
   deliberately does NOT claim the month: it is a human checking the output, and
   burning the month's single real send on a test would silently prevent the
   report from ever reaching the actual recipients. It is therefore recorded in
   the audit log only, and may be repeated. The once-ever guarantee applies to
   the real thing — the opted-in list and the cron. */
async function sendReport({ year, month, trigger, actor, overrideRecipients, now = new Date() }) {
  const sql = getSql();
  const period = periodFor(year, month);
  const isTest = !!(overrideRecipients && overrideRecipients.length);

  const targets = isTest ? overrideRecipients : await monthlyRecipients();
  if (!targets.length) return { ok: false, reason: "no_recipients", period };

  if (isTest) {
    const { data, pdf, fileName, summary } = await generate(period.year, period.month, now);
    const subject = subjectFor(period);
    const messageIds = [];
    for (const t of targets) {
      const info = await sendMail({
        to: t.email, subject, text: bodyFor(data),
        attachments: [{ filename: fileName, content: pdf, contentType: "application/pdf" }],
      });
      messageIds.push({ to: t.email, messageId: info && info.messageId });
    }
    logEvent({
      type: "monthly_report_test_sent",
      actorEmail: actor ? actor.email : null, actorId: actor ? actor.id : null,
      targetId: `${period.year}-${String(period.month).padStart(2, "0")}`,
      meta: { recipients: targets.map((t) => t.email), fileName, summary, test: true },
    });
    return { ok: true, test: true, period, fileName, subject, recipients: targets, messageIds, summary };
  }

  /* claim the month — this is the idempotency barrier */
  const claim = await sql`
    INSERT INTO monthly_reports (period_year, period_month, period_start, period_end, status, trigger, actor_email, recipients)
    VALUES (${period.year}, ${period.month}, ${period.start}, ${period.end}, 'generated', ${trigger || "manual"},
            ${actor ? actor.email : null}, ${JSON.stringify(targets.map((t) => t.email))}::jsonb)
    ON CONFLICT (period_year, period_month) DO NOTHING
    RETURNING id`;

  if (!claim[0]) {
    const existing = await getReport(period.year, period.month);
    /* Someone already holds this month. Only a previous FAILURE may be retried. */
    if (existing && existing.status === "failed") {
      const retake = await sql`
        UPDATE monthly_reports SET status = 'generated', error = NULL, trigger = ${trigger || "manual"},
               actor_email = ${actor ? actor.email : null}, recipients = ${JSON.stringify(targets.map((t) => t.email))}::jsonb,
               generated_at = now()
         WHERE period_year = ${period.year} AND period_month = ${period.month} AND status = 'failed'
         RETURNING id`;
      if (!retake[0]) return { ok: false, reason: "already_sent", period, existing };
    } else {
      return { ok: false, reason: "already_sent", period, existing };
    }
  }

  try {
    const { data, pdf, fileName, summary } = await generate(period.year, period.month, now);
    const subject = subjectFor(period);
    const text = bodyFor(data);
    const messageIds = [];
    for (const t of targets) {
      const info = await sendMail({
        to: t.email, subject, text,
        attachments: [{ filename: fileName, content: pdf, contentType: "application/pdf" }],
      });
      messageIds.push({ to: t.email, messageId: info && info.messageId });
    }
    await sql`
      UPDATE monthly_reports
         SET status = 'sent', sent_at = now(), message_ids = ${JSON.stringify(messageIds)}::jsonb,
             summary = ${JSON.stringify(summary)}::jsonb, error = NULL
       WHERE period_year = ${period.year} AND period_month = ${period.month}`;
    logEvent({
      type: trigger === "cron" ? "monthly_report_sent_auto" : "monthly_report_sent_manual",
      actorEmail: actor ? actor.email : null, actorId: actor ? actor.id : null,
      targetId: `${period.year}-${String(period.month).padStart(2, "0")}`,
      meta: { recipients: targets.map((t) => t.email), fileName, summary },
    });
    return { ok: true, period, fileName, subject, recipients: targets, messageIds, summary };
  } catch (err) {
    const message = (err && err.message) || "فشل غير معروف";
    await sql`
      UPDATE monthly_reports SET status = 'failed', error = ${message}
       WHERE period_year = ${period.year} AND period_month = ${period.month}`;
    logEvent({
      type: "monthly_report_send_failed",
      actorEmail: actor ? actor.email : null, actorId: actor ? actor.id : null,
      targetId: `${period.year}-${String(period.month).padStart(2, "0")}`,
      meta: { error: message },
    });
    return { ok: false, reason: "send_failed", period, error: message };
  }
}

/* Called by the existing daily cron. Runs only on the 1st (Riyadh), and only if
   the previous month hasn't been sent. Because it re-checks every day, a missed
   1st is caught up on the 2nd rather than losing the month entirely — the
   database claim still prevents a second send. */
async function runScheduled(now = new Date(), { catchUpDays = 5 } = {}) {
  const today = riyadhToday(now);
  const period = previousMonthPeriod(now);
  if (today.day > catchUpDays) return { ran: false, reason: "outside_window", day: today.day, period: period.label };

  const existing = await getReport(period.year, period.month);
  if (existing && existing.status === "sent") return { ran: false, reason: "already_sent", period: period.label };

  const targets = await monthlyRecipients();
  if (!targets.length) return { ran: false, reason: "no_recipients", period: period.label };

  const result = await sendReport({ year: period.year, month: period.month, trigger: "cron", now });
  return { ran: result.ok, ...result, period: period.label };
}

module.exports = { section, generate, listReports, getReport, monthlyRecipients, sendReport, runScheduled };
