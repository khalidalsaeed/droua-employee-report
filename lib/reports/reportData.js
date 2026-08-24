const { getSql } = require("../db");
const { periodFor, daysUntil, riyadhDateString } = require("./period");

/* The driver hands timestamps back as JS Date objects, so the calendar day has
   to be derived deliberately — and in Riyadh time, since an edit made at 01:00
   local is 22:00 UTC the previous day. Returning a plain YYYY-MM-DD here keeps
   every consumer (PDF, email, API) from having to guess at the shape. */
const recordedDate = (ts) => (ts ? riyadhDateString(new Date(ts)) : null);

/* ─── Gathers everything the monthly report states ───

   Two different kinds of question are answered here and they use different
   sources on purpose:

   - "What is the situation NOW?" (valid / expiring / expired counts, upcoming
     dues, open and overdue tickets) reads current state.
   - "What HAPPENED during the month?" (renewals, tickets opened/closed) reads
     history. A renewal is only counted when employee_date_history proves the
     expiry actually moved FORWARD and records when that was seen. Inferring it
     from "the current expiry is in the future" would count every valid worker
     as renewed every month.

   Because that history table starts empty, months before it existed report zero
   renewals. That is stated in the report itself rather than papered over. */

const F = {
  eid: "الرقم الوظيفي",
  name: "اسم العامل",
  iqama: "رقم الإقامة",
  iqamaExpiry: "تاريخ انتهاء الإقامة",
  licenceExpiry: "تاريخ انتهاء رخصة العمل",
};

const SOON_DAYS = 60; // "قريبة الانتهاء" threshold, matching the dashboard
const HISTORY_FIELDS = { iqama_expiry: F.iqamaExpiry, work_license_expiry: F.licenceExpiry };

const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/* current-state buckets for one date per employee; `pick` reads that date, so
   the same counting rule serves fields stored on the employee record and the
   permit expiry that lives in another table. */
function bucket(employees, pick, now) {
  let valid = 0, soon = 0, expired = 0, missing = 0;
  for (const e of employees) {
    const v = typeof pick === "function" ? pick(e) : e[pick];
    if (!isIso(v)) { missing++; continue; }
    const d = daysUntil(v, now);
    if (d === null) { missing++; continue; }
    if (d < 0) expired++;
    else if (d <= SOON_DAYS) soon++;
    else valid++;
  }
  return { valid, soon, expired, missing };
}

/* Renewals proven by history: the expiry moved forward, inside the period. */
async function renewalsFor(sql, period, field) {
  const rows = await sql`
    SELECT h.eid, h.old_value::text AS old_value, h.new_value::text AS new_value,
           h.changed_at, h.source, h.actor_name,
           e.name AS employee_name, e.iqama AS employee_iqama
      FROM employee_date_history h
      /* INNER, not LEFT: the journal outlives the employee record, and a
         renewal for somebody who is no longer on the platform has no place in a
         report of the current workforce — it would print as a nameless row. */
      JOIN employees e ON e.eid = h.eid
     WHERE h.field = ${field}
       AND h.changed_at >= ${period.startUtc.toISOString()}
       AND h.changed_at <  ${period.endExclusiveUtc.toISOString()}
       AND h.old_value IS NOT NULL
       AND h.new_value IS NOT NULL
       AND h.new_value > h.old_value
     ORDER BY h.changed_at ASC`;
  /* One line per employee: if an expiry moved more than once in the month, the
     report shows the span from the first old value to the last new value. */
  const byEid = new Map();
  for (const r of rows) {
    const cur = byEid.get(r.eid);
    if (!cur) {
      byEid.set(r.eid, {
        eid: r.eid, name: r.employee_name || "—", iqama: r.employee_iqama || "—",
        previous: r.old_value, next: r.new_value, recordedAt: recordedDate(r.changed_at), source: r.source, changes: 1,
      });
    } else {
      cur.next = r.new_value;
      cur.recordedAt = recordedDate(r.changed_at);
      cur.changes += 1;
    }
  }
  return [...byEid.values()];
}

/* Ajeer permit renewals, proven by ajeer_permit_history the same way employee
   renewals are proven: the cover moved FORWARD, inside the period.

   Two things differ from the employee journal and both come from how permits
   work. The identity is the WORKER (iqama), because renewing issues a new
   permit number — so the pair of permit numbers is part of the answer, not
   noise. And the join to employees is what supplies the name and the employee
   number: name_on_permit is a transliteration and sometimes simply wrong. */
async function permitRenewalsFor(sql, period) {
  const rows = await sql`
    SELECT h.iqama, h.permit_no, h.previous_permit_no,
           to_char(h.old_expiry,'YYYY-MM-DD') AS old_expiry,
           to_char(h.new_expiry,'YYYY-MM-DD') AS new_expiry,
           h.changed_at, h.source, h.actor_name, h.event,
           e.eid, e.name AS employee_name
      FROM ajeer_permit_history h
      JOIN employees e ON e.iqama = h.iqama
     WHERE h.changed_at >= ${period.startUtc.toISOString()}
       AND h.changed_at <  ${period.endExclusiveUtc.toISOString()}
       AND h.old_expiry IS NOT NULL
       AND h.new_expiry IS NOT NULL
       AND h.new_expiry > h.old_expiry
     ORDER BY h.changed_at ASC`;
  /* One line per worker: a permit renewed twice in a month shows the span from
     the first previous permit to the last new one. */
  const byIqama = new Map();
  for (const r of rows) {
    const cur = byIqama.get(r.iqama);
    if (!cur) {
      byIqama.set(r.iqama, {
        eid: r.eid, name: r.employee_name || "—", iqama: r.iqama,
        previousPermit: r.previous_permit_no || "—", permit: r.permit_no,
        previous: r.old_expiry, next: r.new_expiry,
        recordedAt: recordedDate(r.changed_at), source: r.source, changes: 1,
      });
    } else {
      cur.permit = r.permit_no;
      cur.next = r.new_expiry;
      cur.recordedAt = recordedDate(r.changed_at);
      cur.changes += 1;
    }
  }
  return [...byIqama.values()];
}

/* The permit each worker is actually covered by right now: the furthest expiry
   they hold, keyed by iqama since that is how permits are keyed. */
async function permitExpiryByIqama(sql) {
  const rows = await sql`
    SELECT iqama, to_char(max(expiry_date),'YYYY-MM-DD') AS expiry
      FROM ajeer_permits WHERE expiry_date IS NOT NULL GROUP BY iqama`;
  return new Map(rows.map((r) => [String(r.iqama), r.expiry]));
}

/* Upcoming dues, each employee in the NEAREST band only so nobody is listed
   three times. A worker can appear once per document kind (iqama, work licence,
   Ajeer permit) — each in its own nearest band — never twice for the same one. */
function upcomingDues(employees, permitExpiry, now) {
  const BANDS = [30, 60, 90];
  const out = [];
  for (const e of employees) {
    const candidates = [
      { kind: "الإقامة", date: e[F.iqamaExpiry] },
      { kind: "رخصة العمل", date: e[F.licenceExpiry] },
      { kind: "تصريح أجير", date: permitExpiry.get(String(e[F.iqama])) || null },
    ];
    for (const c of candidates) {
      if (!isIso(c.date)) continue;
      const d = daysUntil(c.date, now);
      if (d === null || d < 0) continue;
      const band = BANDS.find((b) => d <= b);
      if (!band) continue;
      out.push({
        eid: e[F.eid], name: e[F.name] || "—", iqama: e[F.iqama] || "—",
        kind: c.kind, expiry: c.date, daysLeft: d, band,
      });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

async function ticketSummary(sql, period, now) {
  const CLOSED = ["completed", "cancelled"];
  const opened = await sql`
    SELECT count(*)::int AS n FROM tickets
     WHERE opened_at >= ${period.startUtc.toISOString()} AND opened_at < ${period.endExclusiveUtc.toISOString()}`;
  const closedRows = await sql`
    SELECT status, closed_at, opened_at FROM tickets
     WHERE closed_at IS NOT NULL
       AND closed_at >= ${period.startUtc.toISOString()} AND closed_at < ${period.endExclusiveUtc.toISOString()}`;
  const current = await sql`SELECT status, follow_up_date::text AS follow_up_date, priority, ticket_no,
                                   employee_eid, title FROM tickets`;

  const closedInMonth = closedRows.length;
  const completedInMonth = closedRows.filter((r) => r.status === "completed").length;
  const cancelledInMonth = closedRows.filter((r) => r.status === "cancelled").length;
  /* average days from opening to closing, for tickets closed this month */
  const spans = closedRows
    .map((r) => (new Date(r.closed_at) - new Date(r.opened_at)) / 86400000)
    .filter((d) => Number.isFinite(d) && d >= 0);
  const avgClose = spans.length ? Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10 : null;

  const active = current.filter((t) => !CLOSED.includes(t.status));
  const overdue = active.filter((t) => isIso(t.follow_up_date) && daysUntil(t.follow_up_date, now) < 0);

  return {
    openedInMonth: opened[0].n,
    closedInMonth,
    completedInMonth,
    cancelledInMonth,
    openNow: active.length,
    awaitingCounterparty: active.filter((t) => t.status === "awaiting_counterparty").length,
    awaitingUs: active.filter((t) => t.status === "awaiting_us").length,
    overdueNow: overdue.length,
    avgCloseDays: avgClose,
    /* the shortlist the manager should act on: overdue, then urgent, then due soon */
    needingAttention: active
      .map((t) => ({
        ticketNo: t.ticket_no,
        title: t.title,
        employeeEid: t.employee_eid,
        status: t.status,
        priority: t.priority,
        followUpDate: t.follow_up_date,
        overdueDays: isIso(t.follow_up_date) && daysUntil(t.follow_up_date, now) < 0 ? Math.abs(daysUntil(t.follow_up_date, now)) : 0,
        dueInDays: isIso(t.follow_up_date) ? daysUntil(t.follow_up_date, now) : null,
      }))
      .filter((t) => t.overdueDays > 0 || t.priority === "urgent" || t.priority === "high" || (t.dueInDays !== null && t.dueInDays <= 7))
      .sort((a, b) => {
        const rank = (x) => (x.overdueDays ? 0 : x.priority === "urgent" ? 1 : x.priority === "high" ? 2 : 3);
        return rank(a) - rank(b) || b.overdueDays - a.overdueDays || (a.dueInDays ?? 999) - (b.dueInDays ?? 999);
      })
      .slice(0, 12),
  };
}

/* Whether the history table has enough coverage to compare with the month
   before. Without two months of history a comparison would be misleading, so
   the report omits that section entirely rather than print zeros. */
async function comparisonFor(sql, period) {
  const prev = periodFor(period.month === 1 ? period.year - 1 : period.year, period.month === 1 ? 12 : period.month - 1);
  const earliest = await sql`SELECT min(changed_at) AS t FROM employee_date_history`;
  if (!earliest[0].t || new Date(earliest[0].t) > prev.startUtc) return null;
  const [iqama, licence] = await Promise.all([
    renewalsFor(sql, prev, "iqama_expiry"),
    renewalsFor(sql, prev, "work_license_expiry"),
  ]);
  const closed = await sql`
    SELECT count(*)::int AS n FROM tickets
     WHERE closed_at >= ${prev.startUtc.toISOString()} AND closed_at < ${prev.endExclusiveUtc.toISOString()}`;
  /* The permit journal started later than the employee one, so its comparison
     figure is offered only when it genuinely covers the earlier month. */
  const permitStart = await sql`SELECT min(changed_at) AS t FROM ajeer_permit_history`;
  const permitsCovered = !!permitStart[0].t && new Date(permitStart[0].t) <= prev.startUtc;
  const permits = permitsCovered ? await permitRenewalsFor(sql, prev) : null;
  return {
    label: prev.label,
    iqamaRenewals: iqama.length,
    licenceRenewals: licence.length,
    permitRenewals: permits ? permits.length : null,
    ticketsClosed: closed[0].n,
  };
}

/* Everything the PDF and the email need, for one month. */
async function buildReportData(year, month, now = new Date()) {
  const sql = getSql();
  const period = periodFor(year, month);

  const empRows = await sql`SELECT data FROM employees ORDER BY eid`;
  const employees = empRows.map((r) => r.data);

  const permitExpiry = await permitExpiryByIqama(sql);

  const iqama = bucket(employees, F.iqamaExpiry, now);
  const licence = bucket(employees, F.licenceExpiry, now);
  const permits = bucket(employees, (e) => permitExpiry.get(String(e[F.iqama])) || null, now);
  const [iqamaRenewals, licenceRenewals, permitRenewals] = await Promise.all([
    renewalsFor(sql, period, "iqama_expiry"),
    renewalsFor(sql, period, "work_license_expiry"),
    permitRenewalsFor(sql, period),
  ]);
  const tickets = await ticketSummary(sql, period, now);
  const comparison = await comparisonFor(sql, period);

  const historyStarted = (await sql`SELECT min(changed_at) AS t FROM employee_date_history`)[0].t;
  /* Flag months that predate the history table so the report can say so. */
  const historyCoversPeriod = !!historyStarted && new Date(historyStarted) <= period.startUtc;

  return {
    period,
    generatedAtIso: riyadhDateString(now),
    totals: { employees: employees.length },
    iqama,
    licence,
    permits,
    iqamaRenewals,
    licenceRenewals,
    permitRenewals,
    upcoming: upcomingDues(employees, permitExpiry, now),
    tickets,
    comparison,
    historyCoversPeriod,
    historyStartedAt: historyStarted || null,
  };
}

/* Compact figures reused by the email summary and stored on monthly_reports. */
function summarize(d) {
  return {
    employees: d.totals.employees,
    iqamaValid: d.iqama.valid, iqamaSoon: d.iqama.soon, iqamaExpired: d.iqama.expired,
    licenceValid: d.licence.valid, licenceSoon: d.licence.soon, licenceExpired: d.licence.expired,
    permitValid: d.permits.valid, permitSoon: d.permits.soon, permitExpired: d.permits.expired,
    iqamaRenewals: d.iqamaRenewals.length, licenceRenewals: d.licenceRenewals.length,
    permitRenewals: d.permitRenewals.length,
    ticketsOpened: d.tickets.openedInMonth, ticketsClosed: d.tickets.closedInMonth,
    ticketsOpenNow: d.tickets.openNow, ticketsOverdueNow: d.tickets.overdueNow,
    dueIn30: d.upcoming.filter((u) => u.band === 30).length,
  };
}

module.exports = { buildReportData, summarize, F, SOON_DAYS, HISTORY_FIELDS };
