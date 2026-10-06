/* ─── مواقع الشركة: نقاط القياس للمحاكي ─────────────────────────────────
   =========================================================================
   لا إحداثيات في الشيفرة إطلاقًا — ولا للرياض. كل موقعٍ صفٌّ يُدخل من
   الواجهة، وموقعٌ افتراضيّ واحدٌ على الأكثر في كل لحظة (فهرسٌ فريد جزئيّ
   في القاعدة)، والمحاكي في Phase 3 يختار نقطة القياس منها.

   لا حذف: التعطيل يكفي ويحفظ أثر ما قيس منه لاحقًا. والافتراضيّ لا يُعطَّل
   وهو افتراضيّ (قيد القاعدة) — التعطيل يُسقط عنه الافتراض في العبارة نفسها. */

const crypto = require("crypto");
const V = require("../validate");
const { TEXT } = require("../limits");

function view(row) {
  return {
    id: row.id,
    label: row.label,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    isDefault: row.is_default === true || row.is_default === "t",
    active: row.active === true || row.active === "t",
    createdAt: V.iso(row.created_at),
    updatedAt: V.iso(row.updated_at),
  };
}

function input(body, { partial = false } = {}) {
  V.pick(body, ["label", "latitude", "longitude", "active", "isDefault"]);
  const out = {};
  const want = (k) => !partial || V.has(body, k);
  if (want("label")) out.label = V.text(body.label, { label: "اسم الموقع", max: TEXT.LOCATION_LABEL, required: true });
  if (want("latitude")) out.latitude = V.coordinate(body.latitude, { label: "خط العرض", min: -90, max: 90 });
  if (want("longitude")) out.longitude = V.coordinate(body.longitude, { label: "خط الطول", min: -180, max: 180 });
  if (V.has(body, "active")) out.active = V.bool(body.active, { label: "نشط" });
  if (V.has(body, "isDefault")) out.isDefault = V.bool(body.isDefault, { label: "افتراضي" });
  return out;
}

async function loadRow(sql, id) {
  const rows = await sql`SELECT * FROM medins_company_locations WHERE id = ${id}::uuid`;
  if (!rows[0]) throw new V.ApiError(404, "الموقع غير موجود");
  return rows[0];
}

async function list({ sql }) {
  const rows = await sql`SELECT * FROM medins_company_locations ORDER BY is_default DESC, active DESC, label`;
  return { body: { locations: rows.map(view) } };
}

/* تعيين الافتراضيّ: إسقاطُ السابق ثم رفعُ الجديد في معاملةٍ واحدة — بهذا
   الترتيب، وإلّا اصطدم الفهرس الفريد بصفّين افتراضيّين لحظةً. */
function setDefaultQueries(sql, id) {
  return [
    sql`UPDATE medins_company_locations SET is_default = false, updated_at = now() WHERE is_default AND id <> ${id}::uuid`,
    sql`UPDATE medins_company_locations SET is_default = true, updated_at = now() WHERE id = ${id}::uuid AND active`,
  ];
}

async function create({ sql, body, actor, log }) {
  const v = input(body);
  if (v.active === false && v.isDefault) throw V.bad("الموقع الافتراضيّ يجب أن يكون نشطًا");
  const id = crypto.randomUUID();
  const insert = sql`
    INSERT INTO medins_company_locations (id, label, latitude, longitude, active, created_by)
    VALUES (${id}::uuid, ${v.label}, ${v.latitude}::numeric, ${v.longitude}::numeric, ${v.active !== false}, ${actor.id})`;
  if (v.isDefault) await sql.transaction([insert, ...setDefaultQueries(sql, id)]);
  else await insert;
  await log("location_created", { locationId: id, action: v.isDefault ? "default" : "create" });
  return { status: 201, body: { location: view(await loadRow(sql, id)) } };
}

async function update({ sql, body, params, log }) {
  const id = V.uuid(params.id, { label: "الموقع" });
  const cur = view(await loadRow(sql, id));
  const patch = input(body, { partial: true });
  const v = { ...cur, latitude: String(cur.latitude), longitude: String(cur.longitude), ...patch };
  if (v.active === false && patch.isDefault) throw V.bad("الموقع الافتراضيّ يجب أن يكون نشطًا");
  const keepDefault = v.active && (patch.isDefault === undefined ? cur.isDefault : patch.isDefault);
  const write = sql`
    UPDATE medins_company_locations SET label = ${v.label}, latitude = ${v.latitude}::numeric, longitude = ${v.longitude}::numeric,
      active = ${v.active}, is_default = ${Boolean(keepDefault && cur.isDefault)}, updated_at = now()
    WHERE id = ${id}::uuid`;
  if (keepDefault && !cur.isDefault) await sql.transaction([write, ...setDefaultQueries(sql, id)]);
  else await write;
  await log("location_updated", { locationId: id, action: !v.active ? "deactivate" : keepDefault ? "default" : "update" });
  return { body: { location: view(await loadRow(sql, id)) } };
}

async function makeDefault({ sql, params, log }) {
  const id = V.uuid(params.id, { label: "الموقع" });
  const cur = view(await loadRow(sql, id));
  if (!cur.active) throw new V.ApiError(409, "لا يكون الموقع المعطَّل افتراضيًّا");
  await sql.transaction(setDefaultQueries(sql, id));
  await log("location_updated", { locationId: id, action: "default" });
  return { body: { location: view(await loadRow(sql, id)) } };
}

module.exports = { list, create, update, makeDefault, view };
