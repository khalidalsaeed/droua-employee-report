/* شركات التأمين. لا حذف نهائيّ: شركةٌ لها عروض تُؤرشف ولا تُمحى (RESTRICT). */

const crypto = require("crypto");
const V = require("../validate");
const { TEXT } = require("../limits");

function view(row) {
  return {
    id: row.id,
    nameAr: row.name_ar,
    nameEn: row.name_en || null,
    archived: Boolean(row.archived_at),
    offersCount: row.offers_count === undefined ? undefined : Number(row.offers_count),
    createdAt: V.iso(row.created_at),
    updatedAt: V.iso(row.updated_at),
  };
}

function input(body, { partial = false } = {}) {
  V.pick(body, ["nameAr", "nameEn"]);
  const out = {};
  if (!partial || V.has(body, "nameAr")) out.nameAr = V.text(body.nameAr, { label: "اسم الشركة", max: TEXT.INSURER_NAME, required: true });
  if (!partial || V.has(body, "nameEn")) out.nameEn = V.text(body.nameEn, { label: "الاسم الإنجليزي", max: TEXT.INSURER_NAME });
  return out;
}

async function load(sql, id) {
  const rows = await sql`SELECT * FROM medins_insurers WHERE id = ${id}::uuid`;
  if (!rows[0]) throw new V.ApiError(404, "الشركة غير موجودة");
  return rows[0];
}

async function list({ sql }) {
  const rows = await sql`
    SELECT i.*, (SELECT count(*) FROM medins_offers o WHERE o.insurer_id = i.id) AS offers_count
    FROM medins_insurers i ORDER BY i.archived_at NULLS FIRST, i.name_ar`;
  return { body: { insurers: rows.map(view) } };
}

async function create({ sql, body, actor, log }) {
  const v = input(body);
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO medins_insurers (id, name_ar, name_en, created_by)
    VALUES (${id}::uuid, ${v.nameAr}, ${v.nameEn}, ${actor.id}) RETURNING *`;
  await log("insurer_created", { insurerId: id });
  return { status: 201, body: { insurer: view(rows[0]) } };
}

async function update({ sql, body, params, log }) {
  const id = V.uuid(params.id, { label: "المعرّف" });
  const current = await load(sql, id);
  const v = { nameAr: current.name_ar, nameEn: current.name_en, ...input(body, { partial: true }) };
  const rows = await sql`
    UPDATE medins_insurers SET name_ar = ${v.nameAr}, name_en = ${v.nameEn}, updated_at = now()
    WHERE id = ${id}::uuid RETURNING *`;
  await log("insurer_updated", { insurerId: id });
  return { body: { insurer: view(rows[0]) } };
}

async function setArchived({ sql, params, log }, archived) {
  const id = V.uuid(params.id, { label: "المعرّف" });
  await load(sql, id);
  const rows = archived
    ? await sql`UPDATE medins_insurers SET archived_at = coalesce(archived_at, now()), updated_at = now() WHERE id = ${id}::uuid RETURNING *`
    : await sql`UPDATE medins_insurers SET archived_at = NULL, updated_at = now() WHERE id = ${id}::uuid RETURNING *`;
  await log(archived ? "insurer_archived" : "insurer_unarchived", { insurerId: id });
  return { body: { insurer: view(rows[0]) } };
}

module.exports = {
  list, create, update, load,
  archive: (ctx) => setArchived(ctx, true),
  unarchive: (ctx) => setArchived(ctx, false),
  view,
};
