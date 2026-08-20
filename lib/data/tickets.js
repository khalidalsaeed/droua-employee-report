const { getSql } = require("../db");

/* ─── Tickets & follow-ups ───

   Tracks the requests we raise with our Ajeer counterparty (issue a permit,
   renew an iqama, request a document, ...) and every step taken on them.

   Shape notes:
   - The timeline and the follow-ups are the SAME table (ticket_events). A
     follow-up is just an event of kind "followup" that carries a body, so the
     timeline never has to merge two sources and stay in order.
   - A ticket links to ONE employee by `employee_eid` for now. The iqama is
     snapshotted at creation because it is part of the historical record, but
     the employee's NAME is resolved live so a later rename doesn't leave stale
     copies around. Supporting several employees later means adding a
     ticket_employees join table and treating employee_eid as the primary one —
     no change to this module's callers.
   - "Overdue" is never stored. It is derived from follow_up_date against the
     current date, the same way employee expiry status is, so it can't go stale.

   Permission section is "tickets"; the router maps GET/POST/PUT/DELETE to
   view/create/edit/delete, and api/app.js's handleTickets adds the two actions
   that don't fit a verb: tickets:add_followup and tickets:close. */
const section = "tickets";

const TYPES = [
  "issue_permit", "renew_permit", "renew_iqama", "renew_work_license",
  "edit_data", "request_document", "replace_worker", "objection", "other",
];
const PRIORITIES = ["normal", "medium", "high", "urgent"];
const STATUSES = ["open", "awaiting_counterparty", "awaiting_us", "in_progress", "completed", "cancelled"];
/* Statuses that take a ticket out of the active/overdue reckoning. */
const CLOSED_STATUSES = ["completed", "cancelled"];
const DEFAULT_COUNTERPARTY = "شركة ضمان الأعمال";

const EVENT_KINDS = [
  "created", "status_changed", "priority_changed", "assignee_changed",
  "followup", "follow_up_date_changed", "edited", "closed", "reopened",
];

/* Dates come back as plain YYYY-MM-DD text for the same reason as
   lib/data/permits.js: letting the driver hand back Date objects reintroduces
   a timezone-shift off-by-one-day once serialized to JSON, which would corrupt
   the overdue maths. Timestamps keep full precision for the timeline. */
const COLS = `id, ticket_no, title, description, type, priority, status, counterparty,
  employee_eid, employee_iqama_at_creation, created_by_id, created_by_name, assignee_id,
  opened_at, last_followup_at, to_char(follow_up_date,'YYYY-MM-DD') as follow_up_date,
  closed_at, notes, created_at, updated_at`;

function toItem(row) {
  return {
    id: String(row.id),
    ticketNo: row.ticket_no,
    title: row.title,
    description: row.description,
    type: row.type,
    priority: row.priority,
    status: row.status,
    counterparty: row.counterparty,
    employeeEid: row.employee_eid,
    employeeIqamaAtCreation: row.employee_iqama_at_creation,
    createdById: row.created_by_id,
    createdByName: row.created_by_name,
    assigneeId: row.assignee_id,
    openedAt: row.opened_at,
    lastFollowupAt: row.last_followup_at,
    followUpDate: row.follow_up_date,
    closedAt: row.closed_at,
    notes: row.notes,
    isClosed: CLOSED_STATUSES.includes(row.status),
  };
}

function toEvent(row) {
  return {
    id: String(row.id),
    kind: row.kind,
    body: row.body,
    from: row.from_value,
    to: row.to_value,
    actorId: row.actor_id,
    actorName: row.actor_name,
    at: row.at,
  };
}

const clean = (v, max = 4000) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const oneOf = (v, allowed, fallback) => (allowed.includes(String(v)) ? String(v) : fallback);
const asDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/* ---------- ticket number ----------
   Atomic: the UPSERT increments and returns in one statement, so concurrent
   creates get distinct sequences. ticket_no also carries a UNIQUE constraint as
   a second line of defence. */
async function nextTicketNo(sql, year) {
  const rows = await sql`
    INSERT INTO ticket_counters (year, last_seq) VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last_seq = ticket_counters.last_seq + 1
    RETURNING last_seq`;
  return `TKT-${year}-${String(rows[0].last_seq).padStart(4, "0")}`;
}

/* ---------- reads ----------
   Employee and assignee display names are resolved in bulk (two small queries)
   rather than stored on the ticket, so they can't drift. */
async function decorate(sql, items) {
  if (!items.length) return items;
  const eids = [...new Set(items.map((t) => t.employeeEid).filter(Boolean))];
  const assignees = [...new Set(items.map((t) => t.assigneeId).filter(Boolean))];

  const empByEid = new Map();
  if (eids.length) {
    const rows = await sql`SELECT eid, name, iqama FROM employees WHERE eid = ANY(${eids})`;
    rows.forEach((r) => empByEid.set(r.eid, r));
  }
  const userById = new Map();
  if (assignees.length) {
    const rows = await sql`SELECT id, name FROM users WHERE id = ANY(${assignees})`;
    rows.forEach((r) => userById.set(r.id, r.name));
  }
  for (const t of items) {
    const emp = t.employeeEid ? empByEid.get(t.employeeEid) : null;
    t.employeeName = emp ? emp.name : null;
    /* Current iqama for display; the creation-time snapshot stays separate. */
    t.employeeIqama = emp ? emp.iqama : t.employeeIqamaAtCreation;
    t.employeeExists = !!emp;
    t.assigneeName = t.assigneeId ? userById.get(t.assigneeId) || null : null;
  }
  return items;
}

async function list(filter = {}) {
  const sql = getSql();
  let rows;
  if (filter.employeeEid) {
    rows = await sql`SELECT ${sql.unsafe(COLS)} FROM tickets WHERE employee_eid = ${filter.employeeEid} ORDER BY id DESC`;
  } else {
    rows = await sql`SELECT ${sql.unsafe(COLS)} FROM tickets ORDER BY id DESC`;
  }
  return decorate(sql, rows.map(toItem));
}

/* Accepts either the numeric id or the human ticket number. */
async function get(idOrNo) {
  const sql = getSql();
  const key = String(idOrNo);
  const rows = /^\d+$/.test(key)
    ? await sql`SELECT ${sql.unsafe(COLS)} FROM tickets WHERE id = ${key}`
    : await sql`SELECT ${sql.unsafe(COLS)} FROM tickets WHERE ticket_no = ${key}`;
  if (!rows[0]) return null;
  const [item] = await decorate(sql, [toItem(rows[0])]);
  const events = await sql`SELECT * FROM ticket_events WHERE ticket_id = ${rows[0].id} ORDER BY at ASC, id ASC`;
  item.events = events.map(toEvent);
  return item;
}

async function listEvents(ticketId) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM ticket_events WHERE ticket_id = ${ticketId} ORDER BY at ASC, id ASC`;
  return rows.map(toEvent);
}

async function addEvent(sql, ticketId, kind, { body, from, to, actor } = {}) {
  await sql`
    INSERT INTO ticket_events (ticket_id, kind, body, from_value, to_value, actor_id, actor_name, actor_email)
    VALUES (${ticketId}, ${oneOf(kind, EVENT_KINDS, "edited")}, ${clean(body)}, ${clean(from, 200)}, ${clean(to, 200)},
            ${actor ? actor.id : null}, ${actor ? actor.name : null}, ${actor ? actor.email : null})`;
}

/* ---------- writes ---------- */
async function create(input, actor) {
  const sql = getSql();
  const title = clean(input.title, 300);
  if (!title) throw new Error("عنوان التذكرة مطلوب");
  const type = oneOf(input.type, TYPES, null);
  if (!type) throw new Error("نوع التذكرة غير صالح");

  /* Snapshot the iqama only when the employee actually exists, so a typo can't
     invent historical data. */
  let employeeEid = clean(input.employeeEid, 60);
  let iqamaSnapshot = null;
  if (employeeEid) {
    const emp = await sql`SELECT eid, iqama FROM employees WHERE eid = ${employeeEid}`;
    if (!emp[0]) throw new Error("الموظف المحدد غير موجود");
    iqamaSnapshot = emp[0].iqama || null;
  }

  const year = new Date().getUTCFullYear();
  const ticketNo = await nextTicketNo(sql, year);
  const rows = await sql`
    INSERT INTO tickets (ticket_no, title, description, type, priority, status, counterparty,
                         employee_eid, employee_iqama_at_creation, created_by_id, created_by_name,
                         assignee_id, follow_up_date, notes)
    VALUES (${ticketNo}, ${title}, ${clean(input.description)}, ${type},
            ${oneOf(input.priority, PRIORITIES, "normal")}, ${oneOf(input.status, STATUSES, "open")},
            ${clean(input.counterparty, 200) || DEFAULT_COUNTERPARTY},
            ${employeeEid}, ${iqamaSnapshot}, ${actor ? actor.id : null}, ${actor ? actor.name : null},
            ${clean(input.assigneeId, 60)}, ${asDate(input.followUpDate)}, ${clean(input.notes)})
    RETURNING id`;
  await addEvent(sql, rows[0].id, "created", { actor, to: ticketNo });
  return get(rows[0].id);
}

/* Field edits. Every meaningful change writes its own timeline entry so the
   history explains itself without diffing rows. */
const TRACKED = [
  { key: "status", column: "status", allowed: STATUSES, kind: "status_changed" },
  { key: "priority", column: "priority", allowed: PRIORITIES, kind: "priority_changed" },
  { key: "assigneeId", column: "assignee_id", kind: "assignee_changed" },
  { key: "followUpDate", column: "follow_up_date", kind: "follow_up_date_changed", date: true },
];
const PLAIN = [
  { key: "title", column: "title", max: 300 },
  { key: "description", column: "description" },
  { key: "counterparty", column: "counterparty", max: 200 },
  { key: "notes", column: "notes" },
  { key: "type", column: "type", allowed: TYPES },
];

async function update(idOrNo, patch, actor) {
  const sql = getSql();
  const existing = await get(idOrNo);
  if (!existing) throw new Error("التذكرة غير موجودة");
  const id = existing.id;

  const sets = [];
  const events = [];

  for (const f of TRACKED) {
    if (!(f.key in patch)) continue;
    const next = f.date ? asDate(patch[f.key]) : (f.allowed ? oneOf(patch[f.key], f.allowed, null) : clean(patch[f.key], 60));
    if (f.allowed && next === null) throw new Error("قيمة غير صالحة");
    const prev = existing[f.key] ?? null;
    if (String(prev ?? "") === String(next ?? "")) continue;
    sets.push({ column: f.column, value: next });
    events.push({ kind: f.kind, from: prev, to: next });
  }

  for (const f of PLAIN) {
    if (!(f.key in patch)) continue;
    const next = f.allowed ? oneOf(patch[f.key], f.allowed, null) : clean(patch[f.key], f.max || 4000);
    if (f.allowed && next === null) throw new Error("قيمة غير صالحة");
    if (String(existing[f.key] ?? "") === String(next ?? "")) continue;
    sets.push({ column: f.column, value: next });
    events.push({ kind: "edited", from: `${f.key}`, to: next === null ? "—" : String(next).slice(0, 200) });
  }

  /* Entering a closed status stamps closed_at and logs the specific event;
     leaving one clears it and logs a reopen. */
  const nextStatus = sets.find((s) => s.column === "status");
  if (nextStatus) {
    const wasClosed = CLOSED_STATUSES.includes(existing.status);
    const willClose = CLOSED_STATUSES.includes(nextStatus.value);
    if (willClose && !wasClosed) {
      sets.push({ column: "closed_at", value: new Date().toISOString() });
      events.push({ kind: "closed", to: nextStatus.value });
    } else if (!willClose && wasClosed) {
      sets.push({ column: "closed_at", value: null });
      events.push({ kind: "reopened", from: existing.status, to: nextStatus.value });
    }
  }

  if (!sets.length) return existing;

  /* Built as one UPDATE with a parameter per column — the column names come
     from the whitelists above, never from the request. */
  const assignments = sets.map((s, i) => `${s.column} = $${i + 1}`).join(", ");
  const values = sets.map((s) => s.value);
  await sql.query(`UPDATE tickets SET ${assignments}, updated_at = now() WHERE id = $${values.length + 1}`, [...values, id]);

  for (const e of events) await addEvent(sql, id, e.kind, { ...e, actor });
  return get(id);
}

/* A follow-up is the normal way a ticket moves forward: it appends to the
   timeline, stamps last_followup_at, and optionally reschedules (or clears) the
   next follow-up date in the same step. */
async function addFollowup(idOrNo, { body, nextFollowUpDate, status }, actor) {
  const sql = getSql();
  const existing = await get(idOrNo);
  if (!existing) throw new Error("التذكرة غير موجودة");
  const text = clean(body);
  if (!text) throw new Error("نص المتابعة مطلوب");

  await addEvent(sql, existing.id, "followup", { body: text, actor });
  await sql`UPDATE tickets SET last_followup_at = now(), updated_at = now() WHERE id = ${existing.id}`;

  const patch = {};
  if (nextFollowUpDate !== undefined) patch.followUpDate = nextFollowUpDate;
  if (status !== undefined) patch.status = status;
  if (Object.keys(patch).length) return update(existing.id, patch, actor);
  return get(existing.id);
}

async function remove(idOrNo) {
  const sql = getSql();
  const existing = await get(idOrNo);
  if (!existing) throw new Error("التذكرة غير موجودة");
  await sql`DELETE FROM tickets WHERE id = ${existing.id}`; // events cascade
  return existing;
}

module.exports = {
  list, get, create, update, remove, addFollowup, listEvents, section,
  TYPES, PRIORITIES, STATUSES, CLOSED_STATUSES, EVENT_KINDS, DEFAULT_COUNTERPARTY,
};
