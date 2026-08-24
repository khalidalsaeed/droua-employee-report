const { getSql } = require("../db");
const { deleteFile } = require("../blob");

/* Permission section guarding this resource — see lib/data/employees.js. */
const section = "ajeer";

/* Field names on the returned objects intentionally match the old AJEER
   array shape (permit, iqama, nameOnPermit, issueDate, expiryDate, file, qr)
   so app-shell.html's rendering code needs no changes beyond fetching this
   instead of reading a literal array. */
/* `qr` is what the UI renders as an image. Two sources feed it:
     - qr_url  — a QR image a user uploaded by hand (the fallback path)
     - qr_text — the payload auto-decoded from the permit PDF; no image is
                 stored for it, the QR is regenerated on demand by
                 GET /api/files/qr, so there's no redundant Blob object.
   A hand-uploaded image wins when present, because it's an explicit human
   override. `qrAuto` lets the UI tell the two apart without extra requests. */
function toItem(row) {
  const generated = row.qr_text ? `/api/files/qr?permit=${encodeURIComponent(row.permit_no)}` : null;
  return {
    permit: row.permit_no,
    iqama: row.iqama,
    nameOnPermit: row.name_on_permit,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    file: row.file_url,
    qr: row.qr_url || generated,
    qrText: row.qr_text || null,
    qrAuto: !row.qr_url && !!row.qr_text,
  };
}

/* DATE columns are cast to text (plain YYYY-MM-DD) in every SELECT below —
   letting the driver hand back JS Date objects risks a timezone-shift
   off-by-one-day bug once serialized back to JSON (toISOString() is UTC,
   the driver's Date parsing is not), which would corrupt expiry-day math. */
const COLS = `permit_no, iqama, name_on_permit, to_char(issue_date,'YYYY-MM-DD') as issue_date,
  to_char(expiry_date,'YYYY-MM-DD') as expiry_date, file_url, qr_url, qr_text`;

async function list() {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM ajeer_permits ORDER BY id`;
  return rows.map(toItem);
}

async function get(permitNo) {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM ajeer_permits WHERE permit_no = ${permitNo}`;
  return rows[0] ? toItem(rows[0]) : null;
}

/* The RAW row, before toItem() derives `qr`. update()/remove() must use this:
   toItem().qr can be the generated /api/files/qr path, and writing that into
   qr_url (or handing it to deleteFile) would corrupt the record. */
async function getRaw(permitNo) {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM ajeer_permits WHERE permit_no = ${permitNo}`;
  return rows[0] || null;
}

/* qr_url must only ever hold a real uploaded-image URL. Anything else (notably
   the generated /api/files/qr path, if a caller echoes `qr` back at us) is
   treated as "no stored image". */
function asStoredImageUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
}

/* The QR payload we decoded from the PDF. Stored as opaque text — never
   fetched or executed anywhere (see lib/pdf/qrFromPdf.js). */
function asQrText(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, 4096) : null;
}

/* ─── permit history ───

   An Ajeer permit runs for a month, and renewing one issues a NEW permit
   number — so the thing being renewed is the WORKER, not the permit. Worse, the
   established way of recording a renewal here has been to delete the old permit
   and create the new one (the audit log shows 11 deletions against 15
   creations), which destroys the very row a before/after comparison would need.

   Hence a journal. Two consequences follow from the deletion habit, and both
   matter:

   - the previous expiry is read from the JOURNAL, never from ajeer_permits, so
     it survives the old row being deleted first;
   - it is the FURTHEST expiry the worker has ever had (max), not the most
     recently written one, so entering permits out of order cannot make a
     renewal look like a step backwards.

   `eid` is resolved and stored at write time: permits are keyed by iqama, and
   name_on_permit is unreliable (transliterated, sometimes wrong — "راسل ديولن"
   for "راسل ديوان"), so the report reads the employee's real name via eid.

   Journalling must never break a permit operation, so every failure here is
   logged and swallowed. */
async function lastKnownExpiry(sql, iqama) {
  const rows = await sql`
    SELECT permit_no, to_char(new_expiry,'YYYY-MM-DD') AS expiry
      FROM ajeer_permit_history
     WHERE iqama = ${iqama} AND new_expiry IS NOT NULL AND event <> 'deleted'
     ORDER BY new_expiry DESC, id DESC
     LIMIT 1`;
  return rows[0] || null;
}

async function recordPermitEvent(sql, e) {
  try {
    const eid = await sql`SELECT eid FROM employees WHERE iqama = ${e.iqama} LIMIT 1`;
    await sql`
      INSERT INTO ajeer_permit_history
        (permit_no, iqama, eid, event, previous_permit_no, old_expiry, new_expiry, source, actor_id, actor_name)
      VALUES (${e.permitNo}, ${e.iqama}, ${eid[0] ? eid[0].eid : null}, ${e.event},
              ${e.previousPermitNo || null}, ${e.oldExpiry || null}, ${e.newExpiry || null},
              ${e.source || null}, ${e.actor ? e.actor.id || null : null}, ${e.actor ? e.actor.name || null : null})`;
  } catch (err) {
    console.error("permit history not recorded:", err && err.message);
  }
}

const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/* create/update re-fetch via get() rather than trusting INSERT/UPDATE's
   RETURNING clause — RETURNING hands back a raw driver-parsed Date for
   issue_date/expiry_date (not run through the to_char cast above), which
   reintroduces the exact timezone-shift bug COLS exists to prevent. */
async function create(item, actor) {
  const sql = getSql();
  if (!item.permit || !item.iqama) throw new Error("رقم التصريح ورقم الإقامة مطلوبان");
  /* Read the previous expiry BEFORE inserting, so the new row can't be mistaken
     for the worker's own predecessor. */
  const previous = await lastKnownExpiry(sql, item.iqama);
  const rows = await sql`
    INSERT INTO ajeer_permits (permit_no, iqama, name_on_permit, issue_date, expiry_date, file_url, qr_url, qr_text)
    VALUES (${item.permit}, ${item.iqama}, ${item.nameOnPermit || null}, ${item.issueDate || null}, ${item.expiryDate || null},
            ${item.file || null}, ${asStoredImageUrl(item.qr)}, ${asQrText(item.qrText)})
    ON CONFLICT (permit_no) DO NOTHING
    RETURNING permit_no`;
  if (!rows[0]) throw new Error("رقم التصريح مستخدم بالفعل");

  /* A renewal is a new permit that carries the worker FURTHER than any permit
     they have held. A first-ever permit, or one that doesn't extend the cover,
     is an issue — recorded, but never counted as a renewal (old_expiry stays
     NULL, which is exactly what the report filters on). */
  const newExpiry = isIsoDate(item.expiryDate) ? item.expiryDate : null;
  const renewed = !!(previous && newExpiry && newExpiry > previous.expiry);
  await recordPermitEvent(sql, {
    permitNo: item.permit, iqama: item.iqama,
    event: renewed ? "renewed" : "issued",
    previousPermitNo: renewed ? previous.permit_no : null,
    oldExpiry: renewed ? previous.expiry : null,
    newExpiry,
    source: "permit_created", actor,
  });
  return get(item.permit);
}

/* Replacing `file` or `qr` deletes the superseded Blob object so nothing is
   orphaned. QR bookkeeping, all driven from the raw columns:

   - patch.qrText set to text  → a fresh QR was decoded from a newly uploaded
     PDF. Any hand-uploaded qr_url is now stale (it was the fallback for the
     PDF that just got replaced), so it's dropped and its Blob deleted.
   - patch.file set to null    → the PDF is gone, so the QR that was decoded
     from it goes too. A hand-uploaded image is left alone: the user put it
     there deliberately and it doesn't depend on the PDF.
   - patch.qr set to null      → the user removed the QR image explicitly;
     the caller clears qrText alongside it when that's the intent. */
async function update(permitNo, patch, actor) {
  const sql = getSql();
  const raw = await getRaw(permitNo);
  if (!raw) throw new Error("التصريح غير موجود");

  const merged = { ...toItem(raw), ...patch };
  let nextQrUrl = patch.qr !== undefined ? asStoredImageUrl(patch.qr) : raw.qr_url;
  let nextQrText = patch.qrText !== undefined ? asQrText(patch.qrText) : raw.qr_text;

  const freshlyExtracted = patch.qrText !== undefined && nextQrText;
  if (freshlyExtracted) nextQrUrl = null;
  if (patch.file !== undefined && !patch.file) nextQrText = null;

  await sql`
    UPDATE ajeer_permits
    SET iqama = ${merged.iqama}, name_on_permit = ${merged.nameOnPermit}, issue_date = ${merged.issueDate},
        expiry_date = ${merged.expiryDate}, file_url = ${merged.file},
        qr_url = ${nextQrUrl}, qr_text = ${nextQrText}, updated_at = now()
    WHERE permit_no = ${permitNo}`;

  /* An expiry edited on the SAME permit is the other way a renewal is recorded.
     Journalled whichever way it moved; the report counts only the forward ones,
     so a correction backwards is preserved as evidence without being reported
     as a renewal. */
  if (patch.expiryDate !== undefined && String(raw.expiry_date || "") !== String(merged.expiryDate || "")) {
    await recordPermitEvent(sql, {
      permitNo, iqama: merged.iqama, event: "expiry_changed",
      oldExpiry: isIsoDate(raw.expiry_date) ? raw.expiry_date : null,
      newExpiry: isIsoDate(merged.expiryDate) ? merged.expiryDate : null,
      source: "permit_updated", actor,
    });
  }

  if (patch.file !== undefined && raw.file_url && raw.file_url !== merged.file) await deleteFile(raw.file_url);
  if (raw.qr_url && raw.qr_url !== nextQrUrl) await deleteFile(raw.qr_url);
  return get(permitNo);
}

async function remove(permitNo, actor) {
  const sql = getSql();
  const raw = await getRaw(permitNo);
  if (!raw) throw new Error("التصريح غير موجود");
  await sql`DELETE FROM ajeer_permits WHERE permit_no = ${permitNo}`;
  /* Recorded so that deleting the old permit before entering the new one — the
     established habit here — still leaves the trail the next renewal needs. */
  await recordPermitEvent(sql, {
    permitNo, iqama: raw.iqama, event: "deleted",
    oldExpiry: isIsoDate(raw.expiry_date) ? raw.expiry_date : null,
    newExpiry: null, source: "permit_deleted", actor,
  });
  await deleteFile(raw.file_url);
  await deleteFile(raw.qr_url); // qr_text needs no cleanup — nothing is stored for it
}

module.exports = { list, get, create, update, remove, section };
