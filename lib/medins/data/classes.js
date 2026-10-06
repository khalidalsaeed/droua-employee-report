/* الفئات التأمينية داخل عرض (VIP / A / B / C …). */

const crypto = require("crypto");
const V = require("../validate");
const { TEXT } = require("../limits");
const offers = require("./offers");

function view(row) {
  return {
    id: row.id,
    offerId: row.offer_id,
    classCode: row.class_code,
    label: row.label || null,
    memberCount: V.num(row.member_count),
    classPremium: V.num(row.class_premium),
    sortOrder: Number(row.sort_order || 0),
    createdAt: V.iso(row.created_at),
    updatedAt: V.iso(row.updated_at),
  };
}

function input(body, { partial = false } = {}) {
  V.pick(body, ["classCode", "label", "memberCount", "classPremium", "sortOrder"]);
  const out = {};
  const want = (k) => !partial || V.has(body, k);
  if (want("classCode")) {
    const code = V.text(body.classCode, { label: "رمز الفئة", max: 12, required: true });
    if (!/^[A-Za-z0-9+_-]{1,12}$/.test(code)) throw V.bad("رمز الفئة: حروف إنجليزية وأرقام و+ _ - فقط (مثل VIP أو A)");
    out.classCode = code;
  }
  if (want("label")) out.label = V.text(body.label, { label: "وصف الفئة", max: TEXT.CLASS_LABEL });
  if (want("memberCount")) out.memberCount = V.int(body.memberCount, { label: "عدد المشمولين", min: 0, max: 100000 });
  if (want("classPremium")) out.classPremium = V.money(body.classPremium, { label: "سعر الفئة" });
  if (want("sortOrder")) out.sortOrder = V.int(body.sortOrder, { label: "الترتيب", min: 0, max: 1000 }) || 0;
  return out;
}

async function loadRow(sql, id) {
  const rows = await sql`SELECT * FROM medins_offer_classes WHERE id = ${id}::uuid`;
  if (!rows[0]) throw new V.ApiError(404, "الفئة غير موجودة");
  return rows[0];
}

async function create({ sql, body, params, actor, log }) {
  const offerId = V.uuid(params.id, { label: "العرض" });
  const v = input(body);
  const change = await offers.touch(sql, offerId, actor);
  const id = crypto.randomUUID();
  const rows = await sql`
    INSERT INTO medins_offer_classes (id, offer_id, class_code, label, member_count, class_premium, sort_order)
    VALUES (${id}::uuid, ${offerId}::uuid, ${v.classCode}, ${v.label}, ${v.memberCount}, ${v.classPremium}::numeric, ${v.sortOrder})
    RETURNING *`;
  await log("class_created", { offerId, classId: id });
  await offers.logTouch(log, offerId, change);
  return { status: 201, body: { class: view(rows[0]) } };
}

async function update({ sql, body, params, actor, log }) {
  const id = V.uuid(params.id, { label: "الفئة" });
  const cur = view(await loadRow(sql, id));
  const v = {
    classCode: cur.classCode, label: cur.label, memberCount: cur.memberCount,
    classPremium: cur.classPremium === null ? null : String(cur.classPremium), sortOrder: cur.sortOrder,
    ...input(body, { partial: true }),
  };
  const change = await offers.touch(sql, cur.offerId, actor);
  const rows = await sql`
    UPDATE medins_offer_classes SET class_code = ${v.classCode}, label = ${v.label}, member_count = ${v.memberCount},
      class_premium = ${v.classPremium}::numeric, sort_order = ${v.sortOrder}, updated_at = now()
    WHERE id = ${id}::uuid RETURNING *`;
  await log("class_updated", { offerId: cur.offerId, classId: id });
  await offers.logTouch(log, cur.offerId, change);
  return { body: { class: view(rows[0]) } };
}

/* يحذف قيم الفئة وشروطها الخاصّة معها (CASCADE). */
async function remove({ sql, params, actor, log }) {
  const id = V.uuid(params.id, { label: "الفئة" });
  const cur = await loadRow(sql, id);
  const change = await offers.touch(sql, cur.offer_id, actor);
  await sql`DELETE FROM medins_offer_classes WHERE id = ${id}::uuid`;
  await log("class_deleted", { offerId: cur.offer_id, classId: id });
  await offers.logTouch(log, cur.offer_id, change);
  return { body: { deleted: true } };
}

module.exports = { create, update, remove, loadRow, view };
