/* الاستثناءات والشروط الخاصّة والمزايا الإضافية — نصوصٌ حرّة بمصدرها. */

const crypto = require("crypto");
const V = require("../validate");
const { TEXT } = require("../limits");
const offers = require("./offers");

const KINDS = Object.freeze(["exclusion", "condition", "extra"]);

function view(row) {
  return {
    id: row.id,
    offerId: row.offer_id,
    classId: row.class_id || null,
    kind: row.kind,
    body: row.body,
    severity: V.num(row.severity),
    sourceFileId: row.source_file_id || null,
    sourcePage: V.num(row.source_page),
    sourceExcerpt: row.source_excerpt || null,
    verified: Boolean(row.verified_at),
    createdAt: V.iso(row.created_at),
    updatedAt: V.iso(row.updated_at),
  };
}

function input(body, { partial = false } = {}) {
  V.pick(body, ["classId", "kind", "body", "severity", "sourceFileId", "sourcePage", "sourceExcerpt"]);
  const out = {};
  const want = (k) => !partial || V.has(body, k);
  if (want("classId")) out.classId = V.uuid(body.classId, { label: "الفئة", required: false });
  if (want("kind")) out.kind = V.oneOf(body.kind, KINDS, { label: "النوع" });
  if (want("body")) out.body = V.text(body.body, { label: "النصّ", max: TEXT.TERM_BODY, required: true, multiline: true });
  if (want("severity")) out.severity = V.int(body.severity, { label: "الخطورة", min: 0, max: 3 });
  if (want("sourceFileId")) out.sourceFileId = V.uuid(body.sourceFileId, { label: "ملف المصدر", required: false });
  if (want("sourcePage")) out.sourcePage = V.int(body.sourcePage, { label: "صفحة المصدر", min: 1, max: 2000 });
  if (want("sourceExcerpt")) out.sourceExcerpt = V.text(body.sourceExcerpt, { label: "المقتطف", max: TEXT.SOURCE_EXCERPT, multiline: true });
  return out;
}

async function checkRefs(sql, offerId, v) {
  if (v.kind !== "exclusion" && v.severity !== null && v.severity !== undefined) throw V.bad("الخطورة للاستثناءات وحدها");
  if (v.classId) {
    const c = await sql`SELECT 1 FROM medins_offer_classes WHERE id = ${v.classId}::uuid AND offer_id = ${offerId}::uuid`;
    if (!c[0]) throw V.bad("الفئة ليست من هذا العرض");
  }
  if (v.sourceFileId) {
    const f = await sql`SELECT 1 FROM medins_files WHERE id = ${v.sourceFileId}::uuid AND offer_id = ${offerId}::uuid AND status = 'ready'`;
    if (!f[0]) throw V.bad("ملفّ المصدر ليس من ملفّات هذا العرض");
  }
}

async function loadRow(sql, id) {
  const rows = await sql`SELECT * FROM medins_offer_terms WHERE id = ${id}::uuid`;
  if (!rows[0]) throw new V.ApiError(404, "البند غير موجود");
  return rows[0];
}

async function list({ sql, params }) {
  const offerId = V.uuid(params.id, { label: "العرض" });
  await offers.loadRow(sql, offerId);
  const rows = await sql`SELECT * FROM medins_offer_terms WHERE offer_id = ${offerId}::uuid ORDER BY kind, created_at`;
  return { body: { terms: rows.map(view) } };
}

async function create({ sql, body, params, actor, log }) {
  const offerId = V.uuid(params.id, { label: "العرض" });
  const v = input(body);
  await checkRefs(sql, offerId, v);
  const change = await offers.touch(sql, offerId, actor);
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO medins_offer_terms (id, offer_id, class_id, kind, body, severity, source_file_id, source_page, source_excerpt, created_by)
    VALUES (${id}::uuid, ${offerId}::uuid, ${v.classId}::uuid, ${v.kind}, ${v.body}, ${v.severity},
            ${v.sourceFileId}::uuid, ${v.sourcePage}, ${v.sourceExcerpt}, ${actor.id})
    RETURNING *`;
  await log("term_created", { offerId, termId: id, kind: v.kind });
  await offers.logTouch(log, offerId, change);
  return { status: 201, body: { term: view(rows[0]) } };
}

async function update({ sql, body, params, actor, log }) {
  const id = V.uuid(params.id, { label: "البند" });
  const cur = view(await loadRow(sql, id));
  const v = { ...cur, ...input(body, { partial: true }) };
  await checkRefs(sql, cur.offerId, v);
  const change = await offers.touch(sql, cur.offerId, actor);
  const rows = await sql`
    UPDATE medins_offer_terms SET class_id = ${v.classId}::uuid, kind = ${v.kind}, body = ${v.body}, severity = ${v.severity},
      source_file_id = ${v.sourceFileId}::uuid, source_page = ${v.sourcePage}, source_excerpt = ${v.sourceExcerpt},
      verified_at = NULL, verified_by = NULL, updated_at = now()
    WHERE id = ${id}::uuid RETURNING *`;
  await log("term_updated", { offerId: cur.offerId, termId: id, kind: v.kind });
  await offers.logTouch(log, cur.offerId, change);
  return { body: { term: view(rows[0]) } };
}

async function remove({ sql, params, actor, log }) {
  const id = V.uuid(params.id, { label: "البند" });
  const cur = await loadRow(sql, id);
  const change = await offers.touch(sql, cur.offer_id, actor);
  await sql`DELETE FROM medins_offer_terms WHERE id = ${id}::uuid`;
  await log("term_deleted", { offerId: cur.offer_id, termId: id, kind: cur.kind });
  await offers.logTouch(log, cur.offer_id, change);
  return { body: { deleted: true } };
}

module.exports = { list, create, update, remove, view, KINDS };
