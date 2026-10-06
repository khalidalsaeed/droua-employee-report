/* ─── قيم المنافع لكل فئة: known / unknown / not_applicable ───────────────
   =========================================================================
   القاعدة الحاكمة: **Missing input ≠ zero**.

     known           قيمةٌ واحدة صالحة لنوع البند — و0 قيمةٌ صحيحة (تحمّل 0%).
     unknown         لا قيمة. «لم يُذكر» أو «لم يُقرأ بعد».
     not_applicable  لا قيمة. البند لا ينطبق على هذه الفئة.
     (لا صفّ)        = unknown.

   والقاعدة مفروضة في طبقتين: هنا (القيمة تطابق نوع البند في الكتالوج)،
   وفي القاعدة (num_nonnulls = 1 لـknown و0 لغيره) — فلا يكتب «صفرًا خفيًّا»
   حتى كاتبٌ يتجاوز هذه الوحدة.

   وأيّ تغيير في قيمة يُسقط اعتمادها (verified_at)، ويُسجَّل حدثًا بالرمز
   والحالتين — لا بالقيمة: المبالغ بيانات عرضٍ تجاريّ لا واصف. */

const V = require("../validate");
const { TEXT } = require("../limits");
const offers = require("./offers");
const classes = require("./classes");

const STATUSES = Object.freeze(["known", "unknown", "not_applicable"]);
const MAX_BATCH = 200;
const VALUE_COLUMNS = Object.freeze({
  amount: "amount_value", percent: "percent_value", boolean: "bool_value", count: "count_value", text: "text_value",
});

function valueOf(row) {
  if (row.value_status !== "known") return null;
  if (row.amount_value !== null && row.amount_value !== undefined) return Number(row.amount_value);
  if (row.percent_value !== null && row.percent_value !== undefined) return Number(row.percent_value);
  if (row.bool_value !== null && row.bool_value !== undefined) return row.bool_value === true || row.bool_value === "t";
  if (row.count_value !== null && row.count_value !== undefined) return Number(row.count_value);
  if (row.text_value !== null && row.text_value !== undefined) return row.text_value;
  return null;
}

function view(row) {
  return {
    classId: row.class_id,
    code: row.benefit_code,
    status: row.value_status,
    value: valueOf(row),
    note: row.note || null,
    sourceFileId: row.source_file_id || null,
    sourcePage: V.num(row.source_page),
    sourceExcerpt: row.source_excerpt || null,
    verified: Boolean(row.verified_at),
    verifiedAt: V.iso(row.verified_at),
    updatedAt: V.iso(row.updated_at),
  };
}

/* القيمة حسب نوع البند. يُرجع { column, value } أو يرمي. */
function typedValue(valueType, raw, label) {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    throw V.bad(`${label}: الحالة «معروف» تحتاج قيمة — وإلّا فاختر «غير معروف»`);
  }
  switch (valueType) {
    case "amount": return { column: "amount_value", value: V.money(raw, { label }) };
    case "percent": return { column: "percent_value", value: V.percent(raw, { label }) };
    case "boolean": return { column: "bool_value", value: V.bool(raw, { label }) };
    case "count": return { column: "count_value", value: V.int(raw, { label, min: 0, max: 100000 }) };
    case "text": return { column: "text_value", value: V.text(raw, { label, max: TEXT.BENEFIT_TEXT, required: true }) };
    default: throw V.bad(`${label}: نوع غير معروف`);
  }
}

function parseEntry(entry, catalogByCode) {
  V.pick(entry, ["code", "status", "value", "note", "sourceFileId", "sourcePage", "sourceExcerpt"]);
  const code = String(entry.code || "");
  const item = catalogByCode.get(code);
  if (!item) throw V.bad(`بندٌ غير موجود في الكتالوج: ${code.slice(0, 41)}`);
  const status = V.oneOf(entry.status, STATUSES, { label: `حالة ${item.label_ar}` });
  const out = {
    code, status, label: item.label_ar,
    amount: null, percent: null, bool: null, count: null, text: null,
    note: V.text(entry.note, { label: "الملاحظة", max: 500, multiline: true }),
    sourceFileId: V.uuid(entry.sourceFileId, { label: "ملف المصدر", required: false }),
    sourcePage: V.int(entry.sourcePage, { label: "صفحة المصدر", min: 1, max: 2000 }),
    sourceExcerpt: V.text(entry.sourceExcerpt, { label: "المقتطف", max: TEXT.SOURCE_EXCERPT, multiline: true }),
  };
  if (status === "known") {
    const { column, value } = typedValue(item.value_type, entry.value, item.label_ar);
    out[{ amount_value: "amount", percent_value: "percent", bool_value: "bool", count_value: "count", text_value: "text" }[column]] = value;
  } else if (entry.value !== undefined && entry.value !== null && entry.value !== "") {
    /* لا قيمة مخفيّة خلف unknown/not_applicable — تُرفض لا تُتجاهل، كي لا
       يظنّ المُرسل أنها حُفظت. */
    throw V.bad(`${item.label_ar}: لا تُرسل قيمة مع حالة «${status === "unknown" ? "غير معروف" : "لا ينطبق"}»`);
  }
  if (!item.active && status === "known") throw V.bad(`${item.label_ar}: بندٌ معطَّل`);
  return out;
}

const sameValue = (row, e) =>
  row.value_status === e.status &&
  String(row.amount_value ?? "") === String(e.amount ?? "") &&
  String(row.percent_value ?? "") === String(e.percent ?? "") &&
  String(row.bool_value ?? "") === String(e.bool ?? "") &&
  String(row.count_value ?? "") === String(e.count ?? "") &&
  String(row.text_value ?? "") === String(e.text ?? "");

/* تطبيع المبالغ للمقارنة: "100" و"100.00" قيمةٌ واحدة. */
function normalizeRow(row) {
  const n = (v) => (v === null || v === undefined ? null : String(Number(v)));
  return { ...row, amount_value: n(row.amount_value), percent_value: n(row.percent_value), count_value: n(row.count_value) };
}
function normalizeEntry(e) {
  const n = (v) => (v === null || v === undefined ? null : String(Number(v)));
  return { ...e, amount: n(e.amount), percent: n(e.percent), count: n(e.count) };
}

async function listForClass({ sql, params }) {
  const classId = V.uuid(params.id, { label: "الفئة" });
  const cls = await classes.loadRow(sql, classId);
  const rows = await sql`SELECT * FROM medins_class_benefits WHERE class_id = ${classId}::uuid ORDER BY benefit_code`;
  return { body: { class: classes.view(cls), values: rows.map(view) } };
}

async function save({ sql, body, params, actor, log }) {
  const classId = V.uuid(params.id, { label: "الفئة" });
  V.pick(body, ["values"]);
  if (!Array.isArray(body.values) || !body.values.length) throw V.bad("لا قيم في الطلب");
  if (body.values.length > MAX_BATCH) throw V.bad(`الحدّ ${MAX_BATCH} قيمة في الطلب الواحد`);

  const cls = await classes.loadRow(sql, classId);
  const catalogRows = await sql`SELECT * FROM medins_benefit_catalog`;
  const catalogByCode = new Map(catalogRows.map((r) => [r.code, r]));
  const entries = body.values.map((e) => parseEntry(e, catalogByCode));
  const codes = new Set();
  for (const e of entries) {
    if (codes.has(e.code)) throw V.bad(`البند مكرّر في الطلب: ${e.code}`);
    codes.add(e.code);
  }

  /* ملفّ المصدر يجب أن يكون من العرض نفسه وجاهزًا — لا إشارة إلى ملفّ عرضٍ آخر. */
  const sourceIds = [...new Set(entries.map((e) => e.sourceFileId).filter(Boolean))];
  if (sourceIds.length) {
    const ok = await sql`SELECT id FROM medins_files WHERE offer_id = ${cls.offer_id}::uuid AND status = 'ready'
      AND id = ANY(${sourceIds}::uuid[])`;
    if (ok.length !== sourceIds.length) throw V.bad("ملفّ المصدر ليس من ملفّات هذا العرض");
  }

  const existing = await sql`SELECT * FROM medins_class_benefits WHERE class_id = ${classId}::uuid`;
  const byCode = new Map(existing.map((r) => [r.benefit_code, normalizeRow(r)]));
  const changed = entries.filter((e) => {
    const row = byCode.get(e.code);
    const ne = normalizeEntry(e);
    const metaSame = row && String(row.note ?? "") === String(e.note ?? "") &&
      String(row.source_file_id ?? "") === String(e.sourceFileId ?? "") &&
      String(row.source_page ?? "") === String(e.sourcePage ?? "") &&
      String(row.source_excerpt ?? "") === String(e.sourceExcerpt ?? "");
    return !row || !sameValue(row, ne) || !metaSame;
  });
  if (!changed.length) return { body: { saved: 0 } };

  const change = await offers.touch(sql, cls.offer_id, actor);
  /* القيمة المتغيّرة تفقد اعتمادها، والمتطابقة لا تُمسّ. */
  const queries = changed.map((e) => sql`
    INSERT INTO medins_class_benefits (class_id, benefit_code, value_status, amount_value, percent_value, bool_value,
      count_value, text_value, note, source_file_id, source_page, source_excerpt, entry_method,
      verified_at, verified_by, updated_by, updated_at)
    VALUES (${classId}::uuid, ${e.code}, ${e.status}, ${e.amount}::numeric, ${e.percent}::numeric, ${e.bool}::boolean,
      ${e.count}::integer, ${e.text}, ${e.note}, ${e.sourceFileId}::uuid, ${e.sourcePage}, ${e.sourceExcerpt}, 'manual',
      NULL, NULL, ${actor.id}, now())
    ON CONFLICT (class_id, benefit_code) DO UPDATE SET
      value_status = EXCLUDED.value_status, amount_value = EXCLUDED.amount_value, percent_value = EXCLUDED.percent_value,
      bool_value = EXCLUDED.bool_value, count_value = EXCLUDED.count_value, text_value = EXCLUDED.text_value,
      note = EXCLUDED.note, source_file_id = EXCLUDED.source_file_id, source_page = EXCLUDED.source_page,
      source_excerpt = EXCLUDED.source_excerpt, entry_method = 'manual',
      verified_at = NULL, verified_by = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  await sql.transaction(queries);

  for (const e of changed) {
    const before = byCode.get(e.code);
    await log("benefit_value_changed", {
      offerId: cls.offer_id, classId, code: e.code,
      fromStatus: before ? before.value_status : "missing", toStatus: e.status,
    });
  }
  await offers.logTouch(log, cls.offer_id, change);
  return { body: { saved: changed.length } };
}

async function verify({ sql, body, params, actor, log }) {
  const classId = V.uuid(params.id, { label: "الفئة" });
  V.pick(body, ["codes"]);
  if (!Array.isArray(body.codes) || !body.codes.length || body.codes.length > MAX_BATCH) throw V.bad("قائمة البنود غير صالحة");
  const codes = body.codes.map((c) => String(c));
  const cls = await classes.loadRow(sql, classId);
  const exists = await sql`SELECT status FROM medins_offers WHERE id = ${cls.offer_id}::uuid`;
  if (exists[0] && exists[0].status === "archived") throw new V.ApiError(409, "العرض مؤرشف");
  const rows = await sql`
    UPDATE medins_class_benefits SET verified_at = now(), verified_by = ${actor.id}
    WHERE class_id = ${classId}::uuid AND benefit_code = ANY(${codes}::text[]) AND verified_at IS NULL
    RETURNING benefit_code`;
  await log("benefit_values_verified", { offerId: cls.offer_id, classId, count: rows.length });
  return { body: { verified: rows.length } };
}

module.exports = { listForClass, save, verify, view, parseEntry, typedValue, STATUSES, VALUE_COLUMNS, MAX_BATCH };
