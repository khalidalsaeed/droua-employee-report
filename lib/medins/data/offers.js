/* ─── عروض التأمين ─────────────────────────────────────────────────────
   =========================================================================
   دورة الحالة:
       draft ⇄ in_review → approved
       approved → in_review      (يدويًا، أو تلقائيًا عند أي تعديل)
       أيّ حالة → archived       archived → draft

   **تعديلُ عرضٍ معتمد يعيده إلى in_review تلقائيًا**: الاعتماد شهادةٌ على
   بيانات بعينها، وتغيير رقمٍ واحد يُسقطها. وPhase 2 لا يبني توصية إلا على
   المعتمد. والعرض المؤرشف لا يُعدَّل حتى يُعاد إلى مسودّة. */

const crypto = require("crypto");
const V = require("../validate");
const { TEXT } = require("../limits");

const STATUSES = Object.freeze(["draft", "in_review", "approved", "archived"]);
const TRANSITIONS = Object.freeze({
  draft: ["in_review", "archived"],
  in_review: ["draft", "approved", "archived"],
  approved: ["in_review", "archived"],
  archived: ["draft"],
});

const FIELDS = ["insurerId", "title", "reference", "submittedOn", "validUntil", "policyStart",
  "policyMonths", "headcount", "dependentsCount", "totalPremium", "vatStatus", "notes"];

/* التواريخ تُقرأ نصًّا (::text) لا كائن Date: تحويل date إلى Date يمرّ
   بالمنطقة الزمنية فيُزيح اليوم على خادمٍ غير UTC. */
const COLS = `o.id, o.insurer_id, o.title, o.reference,
  o.submitted_on::text AS submitted_on, o.valid_until::text AS valid_until, o.policy_start::text AS policy_start,
  o.policy_months, o.headcount, o.dependents_count, o.currency, o.total_premium, o.vat_status,
  o.premium_per_head, o.status, o.approved_at, o.approved_by, o.notes,
  o.created_by, o.created_at, o.updated_at, o.updated_by`;

function view(row) {
  return {
    id: row.id,
    insurerId: row.insurer_id,
    insurerName: row.insurer_name === undefined ? undefined : row.insurer_name,
    title: row.title,
    reference: row.reference || null,
    submittedOn: V.dateOut(row.submitted_on),
    validUntil: V.dateOut(row.valid_until),
    policyStart: V.dateOut(row.policy_start),
    policyMonths: V.num(row.policy_months),
    headcount: V.num(row.headcount),
    dependentsCount: V.num(row.dependents_count),
    currency: row.currency,
    totalPremium: V.num(row.total_premium),
    vatStatus: row.vat_status,
    premiumPerHead: V.num(row.premium_per_head),
    status: row.status,
    approvedAt: V.iso(row.approved_at),
    notes: row.notes || null,
    createdAt: V.iso(row.created_at),
    updatedAt: V.iso(row.updated_at),
    counts: row.classes_count === undefined ? undefined : {
      classes: Number(row.classes_count),
      files: Number(row.files_count),
      knownValues: Number(row.known_count),
      recordedValues: Number(row.values_count),
    },
  };
}

function input(body, { partial = false } = {}) {
  V.pick(body, FIELDS);
  const out = {};
  const want = (k) => !partial || V.has(body, k);
  if (want("insurerId")) out.insurerId = V.uuid(body.insurerId, { label: "الشركة" });
  if (want("title")) out.title = V.text(body.title, { label: "اسم العرض", max: TEXT.OFFER_TITLE, required: true });
  if (want("reference")) out.reference = V.text(body.reference, { label: "رقم العرض", max: TEXT.OFFER_REFERENCE });
  if (want("submittedOn")) out.submittedOn = V.date(body.submittedOn, { label: "تاريخ التقديم" });
  if (want("validUntil")) out.validUntil = V.date(body.validUntil, { label: "صالح حتى" });
  if (want("policyStart")) out.policyStart = V.date(body.policyStart, { label: "بداية الوثيقة" });
  if (want("policyMonths")) out.policyMonths = V.int(body.policyMonths, { label: "مدة الوثيقة بالأشهر", min: 1, max: 36 });
  if (want("headcount")) out.headcount = V.int(body.headcount, { label: "عدد الموظفين", min: 1, max: 100000 });
  if (want("dependentsCount")) out.dependentsCount = V.int(body.dependentsCount, { label: "عدد التابعين", min: 0, max: 100000 });
  if (want("totalPremium")) out.totalPremium = V.money(body.totalPremium, { label: "إجمالي السعر" });
  if (want("vatStatus")) out.vatStatus = V.oneOf(body.vatStatus == null ? "unknown" : body.vatStatus, ["included", "excluded", "unknown"], { label: "حالة الضريبة" });
  if (want("notes")) out.notes = V.text(body.notes, { label: "الملاحظات", max: TEXT.OFFER_NOTES, multiline: true });
  return out;
}

function checkDates(v) {
  if (v.submittedOn && v.validUntil && v.validUntil < v.submittedOn) {
    throw V.bad("تاريخ «صالح حتى» قبل تاريخ التقديم");
  }
}

async function loadRow(sql, id) {
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM medins_offers o WHERE o.id = ${id}::uuid`;
  if (!rows[0]) throw new V.ApiError(404, "العرض غير موجود");
  return rows[0];
}

/* لكل تعديلٍ على العرض أو ما تحته (فئة، قيمة، شرط، ملفّ):
   المؤرشف يُرفض، والمعتمد يرجع إلى in_review. يُرجع الانتقال إن وقع. */
async function touch(sql, offerId, actor) {
  const rows = await sql`
    UPDATE medins_offers SET
      updated_at = now(), updated_by = ${actor.id},
      status = CASE WHEN status = 'approved' THEN 'in_review' ELSE status END,
      approved_at = CASE WHEN status = 'approved' THEN NULL ELSE approved_at END,
      approved_by = CASE WHEN status = 'approved' THEN NULL ELSE approved_by END
    WHERE id = ${offerId}::uuid AND status <> 'archived'
    RETURNING id, status, (SELECT status FROM medins_offers p WHERE p.id = ${offerId}::uuid) AS before_status`;
  if (!rows[0]) {
    const exists = await sql`SELECT status FROM medins_offers WHERE id = ${offerId}::uuid`;
    if (!exists[0]) throw new V.ApiError(404, "العرض غير موجود");
    throw new V.ApiError(409, "العرض مؤرشف — أعده إلى مسودّة قبل التعديل");
  }
  const before = rows[0].before_status;
  return before !== rows[0].status ? { fromStatus: before, toStatus: rows[0].status } : null;
}

async function logTouch(log, offerId, change) {
  if (change) await log("offer_status_changed", { offerId, ...change, reason: "edited_after_approval" });
}

async function list({ sql, query }) {
  const includeArchived = query && query.archived === "1";
  const rows = await sql`
    SELECT ${sql.unsafe(COLS)}, i.name_ar AS insurer_name,
      (SELECT count(*) FROM medins_offer_classes c WHERE c.offer_id = o.id) AS classes_count,
      (SELECT count(*) FROM medins_files f WHERE f.offer_id = o.id AND f.status = 'ready') AS files_count,
      (SELECT count(*) FROM medins_class_benefits b JOIN medins_offer_classes c ON c.id = b.class_id
        WHERE c.offer_id = o.id AND b.value_status = 'known') AS known_count,
      (SELECT count(*) FROM medins_class_benefits b JOIN medins_offer_classes c ON c.id = b.class_id
        WHERE c.offer_id = o.id) AS values_count
    FROM medins_offers o JOIN medins_insurers i ON i.id = o.insurer_id
    WHERE ${includeArchived} OR o.status <> 'archived'
    ORDER BY o.updated_at DESC`;
  return { body: { offers: rows.map(view) } };
}

async function get({ sql, params }) {
  const id = V.uuid(params.id, { label: "المعرّف" });
  const rows = await sql`
    SELECT ${sql.unsafe(COLS)}, i.name_ar AS insurer_name
    FROM medins_offers o JOIN medins_insurers i ON i.id = o.insurer_id WHERE o.id = ${id}::uuid`;
  if (!rows[0]) throw new V.ApiError(404, "العرض غير موجود");
  const classes = require("./classes");
  const terms = require("./terms");
  const files = require("../files");
  const [classRows, valueRows, termRows, fileRows] = await Promise.all([
    sql`SELECT * FROM medins_offer_classes WHERE offer_id = ${id}::uuid ORDER BY sort_order, class_code`,
    sql`SELECT b.* FROM medins_class_benefits b JOIN medins_offer_classes c ON c.id = b.class_id WHERE c.offer_id = ${id}::uuid`,
    sql`SELECT * FROM medins_offer_terms WHERE offer_id = ${id}::uuid ORDER BY kind, created_at`,
    files.listRows(sql, id),
  ]);
  const benefits = require("./benefits");
  return {
    body: {
      offer: view(rows[0]),
      classes: classRows.map(classes.view),
      values: valueRows.map(benefits.view),
      terms: termRows.map(terms.view),
      files: fileRows.map(files.publicView),
    },
  };
}

async function create({ sql, body, actor, log }) {
  const v = input(body);
  checkDates(v);
  const insurer = await sql`SELECT archived_at FROM medins_insurers WHERE id = ${v.insurerId}::uuid`;
  if (!insurer[0]) throw V.bad("الشركة غير موجودة");
  if (insurer[0].archived_at) throw V.bad("الشركة مؤرشفة");
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO medins_offers (id, insurer_id, title, reference, submitted_on, valid_until, policy_start,
      policy_months, headcount, dependents_count, total_premium, vat_status, notes, created_by, updated_by)
    VALUES (${id}::uuid, ${v.insurerId}::uuid, ${v.title}, ${v.reference}, ${v.submittedOn}::date, ${v.validUntil}::date,
      ${v.policyStart}::date, ${v.policyMonths}, ${v.headcount}, ${v.dependentsCount}, ${v.totalPremium}::numeric,
      ${v.vatStatus}, ${v.notes}, ${actor.id}, ${actor.id})`;
  await log("offer_created", { offerId: id, insurerId: v.insurerId });
  return { status: 201, body: { offer: view(await loadRow(sql, id)) } };
}

async function update({ sql, body, params, actor, log }) {
  const id = V.uuid(params.id, { label: "المعرّف" });
  const cur = view(await loadRow(sql, id));
  const patch = input(body, { partial: true });
  if (patch.insurerId && patch.insurerId !== cur.insurerId) throw V.bad("لا يُنقل العرض إلى شركة أخرى — أنشئ عرضًا جديدًا");
  const v = {
    title: cur.title, reference: cur.reference, submittedOn: cur.submittedOn, validUntil: cur.validUntil,
    policyStart: cur.policyStart, policyMonths: cur.policyMonths, headcount: cur.headcount,
    dependentsCount: cur.dependentsCount, totalPremium: cur.totalPremium === null ? null : String(cur.totalPremium),
    vatStatus: cur.vatStatus, notes: cur.notes, ...patch,
  };
  checkDates(v);
  const change = await touch(sql, id, actor);
  await sql`
    UPDATE medins_offers SET title = ${v.title}, reference = ${v.reference},
      submitted_on = ${v.submittedOn}::date, valid_until = ${v.validUntil}::date, policy_start = ${v.policyStart}::date,
      policy_months = ${v.policyMonths}, headcount = ${v.headcount}, dependents_count = ${v.dependentsCount},
      total_premium = ${v.totalPremium}::numeric, vat_status = ${v.vatStatus}, notes = ${v.notes}
    WHERE id = ${id}::uuid`;
  await log("offer_updated", { offerId: id });
  await logTouch(log, id, change);
  return { body: { offer: view(await loadRow(sql, id)) } };
}

async function setStatus({ sql, body, params, actor, log }) {
  const id = V.uuid(params.id, { label: "المعرّف" });
  V.pick(body, ["to"]);
  const to = V.oneOf(body.to, STATUSES, { label: "الحالة" });
  const cur = await loadRow(sql, id);
  if (!TRANSITIONS[cur.status].includes(to)) throw new V.ApiError(409, "انتقال حالة غير مسموح");
  if (to === "approved") {
    await sql`UPDATE medins_offers SET status = 'approved', approved_at = now(), approved_by = ${actor.id},
      updated_at = now(), updated_by = ${actor.id} WHERE id = ${id}::uuid AND status = ${cur.status}`;
  } else {
    await sql`UPDATE medins_offers SET status = ${to}, approved_at = NULL, approved_by = NULL,
      updated_at = now(), updated_by = ${actor.id} WHERE id = ${id}::uuid AND status = ${cur.status}`;
  }
  const after = await loadRow(sql, id);
  if (after.status !== to) throw new V.ApiError(409, "تغيّرت حالة العرض أثناء الطلب — أعد المحاولة");
  await log("offer_status_changed", { offerId: id, fromStatus: cur.status, toStatus: to });
  return { body: { offer: view(after) } };
}

/* الحذف النهائيّ للمسودّة وحدها، وبلا ملفّات حيّة. ما عداها يُؤرشف.
   ملفّاتٌ محذوفة سابقًا تُطهَّر بقاياها قبل الحذف (القيد RESTRICT). */
async function remove({ sql, params, log }) {
  const id = V.uuid(params.id, { label: "المعرّف" });
  const cur = await loadRow(sql, id);
  if (cur.status !== "draft") throw new V.ApiError(409, "لا يُحذف إلا عرضٌ في حالة مسودّة — استخدم الأرشفة");
  const live = await sql`SELECT count(*) AS n FROM medins_files WHERE offer_id = ${id}::uuid AND status <> 'deleted'`;
  if (Number(live[0].n) > 0) throw new V.ApiError(409, "للعرض ملفّات — احذفها أوّلًا أو استخدم الأرشفة");
  const files = require("../files");
  const leftovers = await files.purgeTombstones(sql, id);
  if (leftovers > 0) throw new V.ApiError(409, "تعذّر تنظيف بقايا ملفّات محذوفة — استخدم الأرشفة");
  await sql`DELETE FROM medins_offers WHERE id = ${id}::uuid AND status = 'draft'`;
  await log("offer_deleted", { offerId: id, insurerId: cur.insurer_id });
  return { body: { deleted: true } };
}

module.exports = { list, get, create, update, setStatus, remove, touch, logTouch, loadRow, view, STATUSES, TRANSITIONS };
