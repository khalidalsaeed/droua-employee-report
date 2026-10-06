/* ─── كتالوج بنود المنافع: بياناتٌ لا أعمدة ─────────────────────────────
   =========================================================================
   إضافة بندٍ جديد (مثل «العلاج النفسي») صفٌّ هنا من الواجهة — لا هجرة ولا
   نشر. والمقارنة في Phase 2 تقرأ البنود بالرمز، فتشمل الجديد تلقائيًا.

   ── ما لا يتغيّر بعد الإنشاء ──
   • الرمز (code): ثابتٌ إلى الأبد؛ القيم تشير إليه.
   • نوع القيمة (value_type): ثابتٌ ما دام للبند قيمٌ مسجَّلة — تغييره كان
     سيجعل قيمًا معروفة في العمود الخطأ تبدو «لا قيمة».
   والتعطيل (active=false) يُخفي البند من الإدخال الجديد ولا يمسّ قيمه. */

const V = require("../validate");
const { TEXT } = require("../limits");

const CATEGORIES = Object.freeze(["limits", "inpatient", "outpatient", "cost_sharing", "emergency", "dental",
  "optical", "maternity", "chronic", "pharmacy", "therapy", "mental_health", "evacuation", "network", "other"]);
const VALUE_TYPES = Object.freeze(["amount", "percent", "boolean", "count", "text"]);
const UNITS = Object.freeze(["SAR", "percent", "visit", "session", "day", "item"]);
const BETTER = Object.freeze(["higher", "lower", "none"]);
const CODE_RE = /^[a-z][a-z0-9_]{2,40}$/;

/* الوحدة المسموحة لكل نوع — تطابق قيود القاعدة. */
function checkUnit(valueType, unit) {
  if (unit === null) return;
  if (valueType === "percent" && unit !== "percent") throw V.bad("وحدة النسبة يجب أن تكون percent");
  if ((valueType === "boolean" || valueType === "text") && unit !== null) throw V.bad("هذا النوع بلا وحدة");
  if (valueType === "amount" && unit !== "SAR") throw V.bad("وحدة المبلغ SAR");
  if (valueType === "count" && !["visit", "session", "day", "item"].includes(unit)) throw V.bad("وحدة العدد: visit أو session أو day أو item");
}

function view(row) {
  return {
    code: row.code,
    labelAr: row.label_ar,
    labelEn: row.label_en || null,
    category: row.category,
    valueType: row.value_type,
    unit: row.unit || null,
    better: row.better,
    displayOrder: Number(row.display_order || 0),
    active: row.active === true || row.active === "t",
    valuesCount: row.values_count === undefined ? undefined : Number(row.values_count),
  };
}

function input(body, { creating }) {
  V.pick(body, creating
    ? ["code", "labelAr", "labelEn", "category", "valueType", "unit", "better", "displayOrder", "active"]
    : ["labelAr", "labelEn", "category", "valueType", "unit", "better", "displayOrder", "active"]);
  const out = {};
  const want = (k) => creating || V.has(body, k);
  if (creating) {
    const code = V.text(body.code, { label: "رمز البند", max: 41, required: true });
    if (!CODE_RE.test(code)) throw V.bad("رمز البند: حروف إنجليزية صغيرة وأرقام و_ ويبدأ بحرف (مثل annual_limit)");
    out.code = code;
  }
  if (want("labelAr")) out.labelAr = V.text(body.labelAr, { label: "الاسم العربي", max: TEXT.CATALOG_LABEL, required: true });
  if (want("labelEn")) out.labelEn = V.text(body.labelEn, { label: "الاسم الإنجليزي", max: TEXT.CATALOG_LABEL });
  if (want("category")) out.category = V.oneOf(body.category, CATEGORIES, { label: "التصنيف" });
  if (want("valueType")) out.valueType = V.oneOf(body.valueType, VALUE_TYPES, { label: "نوع القيمة" });
  if (want("unit")) out.unit = V.oneOf(body.unit, UNITS, { label: "الوحدة", required: false });
  if (want("better")) out.better = V.oneOf(body.better, BETTER, { label: "اتّجاه الأفضلية" });
  if (want("displayOrder")) out.displayOrder = V.int(body.displayOrder, { label: "الترتيب", min: 0, max: 100000 }) || 0;
  if (V.has(body, "active")) out.active = V.bool(body.active, { label: "نشط" });
  else if (creating) out.active = true;
  return out;
}

async function loadRow(sql, code) {
  const rows = await sql`SELECT * FROM medins_benefit_catalog WHERE code = ${code}`;
  if (!rows[0]) throw new V.ApiError(404, "البند غير موجود");
  return rows[0];
}

async function list({ sql }) {
  const rows = await sql`
    SELECT c.*, (SELECT count(*) FROM medins_class_benefits b WHERE b.benefit_code = c.code) AS values_count
    FROM medins_benefit_catalog c ORDER BY c.display_order, c.code`;
  return { body: { catalog: rows.map(view), categories: CATEGORIES, valueTypes: VALUE_TYPES, units: UNITS } };
}

async function create({ sql, body, actor, log }) {
  const v = input(body, { creating: true });
  checkUnit(v.valueType, v.unit);
  const rows = await sql`
    INSERT INTO medins_benefit_catalog (code, label_ar, label_en, category, value_type, unit, better, display_order, active, created_by)
    VALUES (${v.code}, ${v.labelAr}, ${v.labelEn}, ${v.category}, ${v.valueType}, ${v.unit}, ${v.better},
            ${v.displayOrder}, ${v.active}, ${actor.id})
    RETURNING *`;
  await log("catalog_item_created", { code: v.code });
  return { status: 201, body: { item: view(rows[0]) } };
}

async function update({ sql, body, params, log }) {
  const code = String(params.code || "");
  if (!CODE_RE.test(code)) throw new V.ApiError(404, "البند غير موجود");
  const cur = view(await loadRow(sql, code));
  const patch = input(body, { creating: false });
  const v = { ...cur, ...patch };
  if (patch.valueType && patch.valueType !== cur.valueType) {
    const used = await sql`SELECT count(*) AS n FROM medins_class_benefits WHERE benefit_code = ${code}`;
    if (Number(used[0].n) > 0) throw new V.ApiError(409, "لا يتغيّر نوع قيمة بندٍ له قيم مسجَّلة");
  }
  checkUnit(v.valueType, v.unit);
  const rows = await sql`
    UPDATE medins_benefit_catalog SET label_ar = ${v.labelAr}, label_en = ${v.labelEn}, category = ${v.category},
      value_type = ${v.valueType}, unit = ${v.unit}, better = ${v.better}, display_order = ${v.displayOrder},
      active = ${v.active}, updated_at = now()
    WHERE code = ${code} RETURNING *`;
  await log("catalog_item_updated", { code });
  return { body: { item: view(rows[0]) } };
}

module.exports = { list, create, update, loadRow, view, CATEGORIES, VALUE_TYPES, UNITS, BETTER, CODE_RE, checkUnit };
