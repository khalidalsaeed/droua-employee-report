const { getSql } = require("../db");

/* Which permission section guards this resource — the router turns the HTTP
   method into the action (GET→view, POST→create, PUT→edit, DELETE→delete) and
   checks it against the actor's effective permissions. See
   lib/auth/permissions.js. */
const section = "employees";

/* Each employee row stores its full Arabic-keyed record (identical shape to
   the old app-shell.html DATA array) in `data` JSONB — eid/iqama/name are
   duplicated as plain columns only for indexing/uniqueness, never edited
   independently of `data`. This lets the wide, semi-structured employee
   record (30+ fields, some ad hoc like _cost/_licPending) live in Postgres
   without a rigid column-per-field schema. */
const F_EID = "الرقم الوظيفي";
const F_IQAMA = "رقم الإقامة";
const F_NAME = "اسم العامل";

/* Where an auto-extracted expiry lands, per document type. The Gregorian value
   is the authoritative one — status, the countdown on the card, and the
   expiry-notification cron all read it. The Hijri form is kept only as a record
   of what the document actually printed. `file` holds the uploaded document. */
const DOC_TARGETS = {
  iqama: {
    gregorian: "تاريخ انتهاء الإقامة",
    hijri: "تاريخ انتهاء الاقامة بالهجري",
    file: "ملف الإقامة",
    label: "الإقامة",
    verifyAgainst: F_IQAMA, // muqeem reports carry the iqama number
  },
  work_license: {
    gregorian: "تاريخ انتهاء رخصة العمل",
    hijri: "تاريخ انتهاء رخصة العمل بالهجري",
    file: "ملف رخصة العمل",
    label: "رخصة العمل",
    verifyAgainst: F_IQAMA,
  },
};

const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/* Applies an extracted expiry to an employee, enforcing the rules that must not
   be bypassable from the browser:

   - the document's identifier (iqama number) must match the employee's, when
     the document carries one;
   - a NEWER date is applied; an EQUAL one is a no-op; an OLDER one is REFUSED,
     because re-uploading a stale document must never walk an expiry backwards
     and make a valid worker look expired.

   Manual editing is untouched by this — the ordinary update() path still lets a
   human set any date, which is the documented fallback.

   Returns a verdict the UI turns into a message; never throws for a business
   rejection. */
async function applyExtractedExpiry(eid, docType, extracted, fileUrl, actor) {
  const target = DOC_TARGETS[docType];
  if (!target) return { applied: false, reason: "unknown_document_type" };
  const employee = await get(eid);
  if (!employee) return { applied: false, reason: "employee_not_found" };

  const verdict = {
    applied: false,
    reason: null,
    field: target.gregorian,
    label: target.label,
    previous: employee[target.gregorian] || null,
    extracted: extracted ? { calendar: extracted.calendar, hijri: extracted.hijri, gregorian: extracted.gregorian } : null,
  };

  if (extracted && target.verifyAgainst && extracted.documentId) {
    const onRecord = String(employee[target.verifyAgainst] || "").replace(/\D/g, "");
    const inDocument = String(extracted.documentId).replace(/\D/g, "");
    if (onRecord && inDocument && onRecord !== inDocument) {
      verdict.reason = "identity_mismatch";
      verdict.documentId = inDocument;
      verdict.employeeId = onRecord;
      /* The file is still attached — the upload itself succeeded and the user
         may well want to keep the document — but no date is written. */
      if (fileUrl) await patchFields(eid, { [target.file]: fileUrl });
      return verdict;
    }
  }

  if (!extracted || !isIsoDate(extracted.gregorian)) {
    verdict.reason = "no_date";
    if (fileUrl) await patchFields(eid, { [target.file]: fileUrl });
    return verdict;
  }

  const previous = verdict.previous;
  if (isIsoDate(previous)) {
    if (extracted.gregorian < previous) {
      verdict.reason = "older_than_current";
      if (fileUrl) await patchFields(eid, { [target.file]: fileUrl });
      return verdict;
    }
    if (extracted.gregorian === previous) {
      verdict.reason = "unchanged";
      const same = { [target.file]: fileUrl || employee[target.file] || null };
      if (extracted.hijri) same[target.hijri] = extracted.hijri;
      await patchFields(eid, same);
      return verdict;
    }
  }

  const patch = { [target.gregorian]: extracted.gregorian };
  if (extracted.hijri) patch[target.hijri] = extracted.hijri;
  if (fileUrl) patch[target.file] = fileUrl;
  await patchFields(eid, patch);
  await recordDateChanges(eid, employee, patch, "document_extraction", actor);
  verdict.applied = true;
  verdict.reason = isIsoDate(previous) ? "updated" : "set";
  return verdict;
}

/* Merges a few keys into the JSONB record without disturbing the rest. */
async function patchFields(eid, fields) {
  const sql = getSql();
  const rows = await sql`
    UPDATE employees SET data = data || ${JSON.stringify(fields)}::jsonb, updated_at = now()
    WHERE eid = ${eid} RETURNING data`;
  if (!rows[0]) throw new Error("الموظف غير موجود");
  return rows[0].data;
}

/* ─── expiry-change history ───
   The monthly report can only claim "this iqama was renewed in August" if there
   is evidence the date actually MOVED and when that was recorded. audit_log
   doesn't carry old/new values for employee edits, so every change to the two
   expiry fields is journalled here instead — from both the document-extraction
   path and ordinary manual edits. Purely additive: a failure to journal must
   never block the edit itself. */
const HISTORY_FIELDS = {
  "تاريخ انتهاء الإقامة": "iqama_expiry",
  "تاريخ انتهاء رخصة العمل": "work_license_expiry",
};

async function recordDateChanges(eid, before, after, source, actor) {
  try {
    const sql = getSql();
    for (const [key, field] of Object.entries(HISTORY_FIELDS)) {
      const oldValue = isIsoDate(before && before[key]) ? before[key] : null;
      const newValue = isIsoDate(after && after[key]) ? after[key] : null;
      if (oldValue === newValue) continue;
      if (!(key in (after || {}))) continue; // field wasn't part of this write
      await sql`
        INSERT INTO employee_date_history (eid, field, old_value, new_value, source, actor_id, actor_name)
        VALUES (${eid}, ${field}, ${oldValue}, ${newValue}, ${source},
                ${actor ? actor.id || null : null}, ${actor ? actor.name || null : null})`;
    }
  } catch (err) {
    console.error("expiry history not recorded:", err && err.message);
  }
}

async function list() {
  const sql = getSql();
  const rows = await sql`SELECT data FROM employees ORDER BY id`;
  return rows.map((r) => r.data);
}

async function get(eid) {
  const sql = getSql();
  const rows = await sql`SELECT data FROM employees WHERE eid = ${eid}`;
  return rows[0] ? rows[0].data : null;
}

async function create(data) {
  const sql = getSql();
  const eid = data[F_EID];
  const iqama = data[F_IQAMA];
  const name = data[F_NAME];
  if (!eid || !name) throw new Error("الرقم الوظيفي واسم العامل مطلوبان");
  const rows = await sql`
    INSERT INTO employees (eid, iqama, name, data)
    VALUES (${eid}, ${iqama}, ${name}, ${JSON.stringify(data)}::jsonb)
    ON CONFLICT (eid) DO NOTHING
    RETURNING data`;
  if (!rows[0]) throw new Error("رقم وظيفي مستخدم بالفعل");
  return rows[0].data;
}

/* Shallow-merges patch into the existing record, then re-syncs the mirror
   columns from the merged object so lookups by iqama/name stay correct. */
async function update(eid, patch, actor) {
  const sql = getSql();
  const existing = await get(eid);
  if (!existing) throw new Error("الموظف غير موجود");
  const merged = { ...existing, ...patch };
  const rows = await sql`
    UPDATE employees
    SET data = ${JSON.stringify(merged)}::jsonb, iqama = ${merged[F_IQAMA]}, name = ${merged[F_NAME]}, updated_at = now()
    WHERE eid = ${eid}
    RETURNING data`;
  /* Journal manual expiry edits too — they're the most common way a renewal
     gets recorded, and the monthly report depends on this evidence. */
  await recordDateChanges(eid, existing, patch, "manual_edit", actor);
  return rows[0].data;
}

async function remove(eid) {
  const sql = getSql();
  const rows = await sql`DELETE FROM employees WHERE eid = ${eid} RETURNING eid`;
  if (!rows[0]) throw new Error("الموظف غير موجود");
}

module.exports = { list, get, create, update, remove, section, applyExtractedExpiry, DOC_TARGETS };
