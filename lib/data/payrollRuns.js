const { getSql } = require("../db");
const { deleteFile } = require("../blob");
const { logEvent } = require("../auth/audit");

/* Permission section guarding this resource — see lib/data/employees.js. */
const section = "payroll";

/* Field names on the returned objects match the old lib/payroll/runs.js
   mock shape exactly (id, monthLabel, uploadedAt, statusKey, fileUrl,
   attachments[]) so payroll-shell.html / payroll-detail-shell.html need no
   rendering changes beyond fetching this instead of a hardcoded array. */
function toRun(row, attachments, proofs) {
  return {
    id: row.id,
    monthLabel: row.month_label,
    uploadedAt: row.uploaded_at,
    statusKey: row.status_key,
    fileUrl: row.file_url,
    attachments: (attachments || []).map((a) => ({
      key: a.key,
      label: a.label,
      statusKey: a.status_key,
      fileUrl: a.file_url,
      uploadedAt: a.uploaded_at,
      note: a.note,
    })),
    /* لقطة موظفي هذا الشهر وإثبات تحويل كل واحد منهم. تُبذَر مرّة واحدة
       عند إنشاء المسير (lib/payroll/monthlyRun.js) ولا تُقرأ حيّة من
       سجلّ الموظفين بعدها، فمسير شهرٍ مضى لا يتغيّر بتغيّر السجلّ.

       المسيرات التي أُنشئت قبل هذه الميزة لا صفوف لها، فتُرجع مصفوفة
       فارغة والواجهة لا ترسم القسم أصلًا — لا تُمسّ ولا تُهاجَر. */
    employees: (proofs || []).map((p) => ({
      /* eid هو رقم ضمان — معرّف الموظف في المنصّة ومفتاح هذا الجدول.
         jisrNo رقمه في نظام جسر، يُعرض بجانبه ولا يحلّ محلّه. */
      eid: p.employee_eid,
      jisrNo: p.jisr_no || null,
      name: p.employee_name,
      jobTitle: p.job_title,
      /* راتب المسير: صافي الموظف في كشف رواتب هذا الشهر، مُلقَطًا من
         الكشف نفسه لا مقروءًا حيًّا من سجلّه — الراتب يتغيّر شهرًا بعد
         شهر، فراتب سبتمبر ليس مرجعًا لأغسطس.

         numeric يعود من المُشغّل نصًّا كي لا تُفقد المنزلتان في تحويل
         عائم، فيُحوَّل هنا صراحةً. وnull يبقى null لا صفرًا: «لم تُزامَن
         بعد» و«راتبه صفر» ليسا الشيء نفسه، والواجهة تفرّق بينهما. */
      sheetAmount: p.sheet_amount === null || p.sheet_amount === undefined ? null : Number(p.sheet_amount),
      proof: p.file_url
        ? { fileUrl: p.file_url, fileName: p.file_name, uploadedAt: p.uploaded_at, uploadedBy: p.uploaded_by }
        : null,
    })),
  };
}

/* DATE columns cast to text (plain YYYY-MM-DD) — see the same note in
   lib/data/permits.js on why this matters for expiry/date-math correctness. */
const RUN_COLS = `id, month_label, to_char(uploaded_at,'YYYY-MM-DD') as uploaded_at, status_key, file_url`;
const ATTACHMENT_COLS = `key, label, status_key, file_url, to_char(uploaded_at,'YYYY-MM-DD') as uploaded_at, note`;
/* uploaded_at هنا timestamptz لا DATE (نعرف اللحظة لا اليوم فقط)، فيُحوَّل
   إلى Asia/Riyadh قبل الاقتطاع: بلا ذلك يظهر إثبات رُفع الواحدة ليلًا
   بتاريخ اليوم السابق، لأن جلسة القاعدة تعمل بـUTC. */
const PROOF_COLS = `p.employee_eid, p.employee_name, p.job_title, p.file_url, p.file_name, to_char(p.uploaded_at AT TIME ZONE 'Asia/Riyadh','YYYY-MM-DD') as uploaded_at, p.uploaded_by, p.sheet_amount, e.data->>'رقم جسر' AS jisr_no`;

/* رقم جسر يُقرأ بربطٍ حيّ مع سجلّ الموظف لا يُخزَّن في هذا الجدول:
   إضافة عمود كانت ستعني هجرة مخطّط لحقل عرضٍ محض. LEFT JOIN كي لا يسقط
   صفّ إثبات لموظف حُذف سجلّه — يظهر بلا رقم جسر لا أن يختفي.

   استثناء مقصود من مبدأ اللقطة: الاسم والمهنة مجمّدان لأنهما بيانات
   المسير وقت إنشائه، أمّا رقم جسر فمعرّف هوية لا واقعة رواتب، وعرضه
   حيًّا هو الصحيح — يتغيّر إن صُحّح الربط، وهو ما نريده. */
const PROOF_JOIN = `FROM payroll_transfer_proofs p LEFT JOIN employees e ON e.eid = p.employee_eid`;

/* أنواع ملفّات إثبات التحويل المسموح بها. الفحص هنا لا في المتصفّح وحده:
   سمة accept على حقل الملف تحسين للتجربة يمكن تجاوزه بنداء مباشر
   للـAPI، فالرفض النهائي يقع على الخادم عند ربط الرابط بالسجلّ. */
const PROOF_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];

function assertProofFile(fileUrl) {
  if (fileUrl === null || fileUrl === undefined || fileUrl === "") return; // إزالة الإثبات
  let pathname;
  try {
    pathname = new URL(String(fileUrl)).pathname;
  } catch (err) {
    pathname = String(fileUrl);
  }
  const lower = pathname.toLowerCase();
  if (!PROOF_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error("صيغة الملف غير مسموحة — إثبات التحويل يجب أن يكون PDF أو JPG أو JPEG أو PNG");
  }
}

async function attachmentsFor(sql, runId) {
  return sql`SELECT ${sql.unsafe(ATTACHMENT_COLS)} FROM payroll_attachments WHERE run_id = ${runId} ORDER BY id`;
}

async function proofsFor(sql, runId) {
  return sql`SELECT ${sql.unsafe(PROOF_COLS)} ${sql.unsafe(PROOF_JOIN)} WHERE p.run_id = ${runId} ORDER BY p.id`;
}

async function list() {
  const sql = getSql();
  const runs = await sql`SELECT ${sql.unsafe(RUN_COLS)} FROM payroll_runs ORDER BY id DESC`;
  /* استعلام واحد لكل الإثباتات ثم تجميعها في الذاكرة — لا استعلام لكل
     مسير. المرفقات بقيت كما كانت عمدًا: عددها ثابت صغير لكل مسير. */
  const allProofs = runs.length
    ? await sql`SELECT p.run_id, ${sql.unsafe(PROOF_COLS)} ${sql.unsafe(PROOF_JOIN)} ORDER BY p.id`
    : [];
  const proofsByRun = new Map();
  for (const p of allProofs) {
    if (!proofsByRun.has(p.run_id)) proofsByRun.set(p.run_id, []);
    proofsByRun.get(p.run_id).push(p);
  }
  const out = [];
  for (const run of runs) out.push(toRun(run, await attachmentsFor(sql, run.id), proofsByRun.get(run.id)));
  return out;
}

async function get(id) {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(RUN_COLS)} FROM payroll_runs WHERE id = ${id}`;
  if (!rows[0]) return null;
  return toRun(rows[0], await attachmentsFor(sql, id), await proofsFor(sql, id));
}

async function create({ id, monthLabel, uploadedAt, statusKey, fileUrl, attachments }) {
  const sql = getSql();
  if (!id || !monthLabel) throw new Error("معرّف الشهر واسمه مطلوبان");
  const rows = await sql`
    INSERT INTO payroll_runs (id, month_label, uploaded_at, status_key, file_url)
    VALUES (${id}, ${monthLabel}, ${uploadedAt || null}, ${statusKey || "pending_invoice"}, ${fileUrl || null})
    ON CONFLICT (id) DO NOTHING
    RETURNING *`;
  if (!rows[0]) throw new Error("يوجد مسير رواتب بهذا المعرّف بالفعل");
  for (const a of attachments || []) await upsertAttachment(sql, id, a);
  return get(id);
}

async function upsertAttachment(sql, runId, a) {
  await sql`
    INSERT INTO payroll_attachments (run_id, key, label, status_key, file_url, uploaded_at, note)
    VALUES (${runId}, ${a.key}, ${a.label}, ${a.statusKey}, ${a.fileUrl || null}, ${a.uploadedAt || null}, ${a.note || null})
    ON CONFLICT (run_id, key) DO UPDATE SET
      label = EXCLUDED.label, status_key = EXCLUDED.status_key, file_url = EXCLUDED.file_url,
      uploaded_at = EXCLUDED.uploaded_at, note = EXCLUDED.note`;
}

/* تحديث إثبات تحويل موظف واحد داخل مسير واحد.
   =========================================================================
   شرط WHERE يحمل المفتاحين معًا — run_id و employee_eid — وهو ما يمنع
   اختلاط إثبات بموظف آخر بنيويًا لا بالانضباط: لا يوجد في هذه الدالّة
   مسارٌ يكتب صفًّا لم يُسمَّ صاحبه صراحةً. والصفّ يجب أن يكون موجودًا
   أصلًا (لقطة وقت الإنشاء)، فلا يستطيع طلبٌ أن يدسّ موظفًا ليس في
   المسير ولا أن يُنشئ صفًّا في مسير شهرٍ مضى. */
async function upsertProof(sql, runId, existingProofs, p, actor) {
  const eid = String((p && p.eid) || "").trim();
  if (!eid) throw new Error("الرقم الوظيفي مطلوب لإثبات التحويل");

  const base = (existingProofs || []).find((e) => e.eid === eid);
  if (!base) throw new Error("هذا الموظف ليس ضمن مسير الرواتب");

  const previousUrl = base.proof ? base.proof.fileUrl : null;
  const nextUrl = p.fileUrl === undefined ? previousUrl : p.fileUrl || null;
  assertProofFile(nextUrl);

  const nextName = nextUrl
    ? (p.fileName !== undefined ? p.fileName || null : base.proof && base.proof.fileName) || null
    : null;
  const uploadedBy = nextUrl ? (actor && actor.email) || (base.proof && base.proof.uploadedBy) || null : null;

  await sql`
    UPDATE payroll_transfer_proofs
       SET file_url = ${nextUrl},
           file_name = ${nextName},
           uploaded_at = ${nextUrl ? new Date().toISOString() : null},
           uploaded_by = ${uploadedBy}
     WHERE run_id = ${runId} AND employee_eid = ${eid}`;

  /* الاستبدال والحذف كلاهما يُخلّف ملفًّا في Blob لا يشير إليه شيء. */
  if (previousUrl && previousUrl !== nextUrl) await deleteFile(previousUrl);

  /* التسجيل هنا لا في api/app.js: الموجّه العام يسجّل payroll-runs_updated
     لكل تعديل بلا تمييز، وإثبات تحويل راتبٍ بعينه يستحقّ أثرًا يحمل اسم
     الموظف. ووضعه هنا يُبقي الموجّه العام بلا منطق خاصّ بقسم. */
  logEvent({
    type: nextUrl ? (previousUrl ? "payroll_proof_replaced" : "payroll_proof_uploaded") : "payroll_proof_removed",
    actorEmail: (actor && actor.email) || null,
    actorId: (actor && actor.id) || null,
    targetId: `${runId}/${eid}`,
    meta: { employeeName: base.name, fileName: nextName },
  });
}

/* patch may contain run-level fields (monthLabel/uploadedAt/statusKey/fileUrl)
   and/or an `attachments` array of partial attachment objects to upsert.
   Whenever a fileUrl is replaced or cleared (upload/replace/delete-file),
   the old Blob object is deleted so no orphaned files accumulate.

   `proofs` هو المفتاح الثالث: مصفوفة {eid, fileUrl, fileName} لإثباتات
   تحويل الرواتب، كل عنصر منها مقيّد بموظفه وحده. */
async function update(id, patch, actor) {
  const sql = getSql();
  const existing = await get(id);
  if (!existing) throw new Error("مسير الرواتب غير موجود");
  const merged = { ...existing, ...patch };
  await sql`
    UPDATE payroll_runs
    SET month_label = ${merged.monthLabel}, uploaded_at = ${merged.uploadedAt || null},
        status_key = ${merged.statusKey}, file_url = ${merged.fileUrl || null}, updated_at = now()
    WHERE id = ${id}`;
  if (patch.fileUrl !== undefined && existing.fileUrl && existing.fileUrl !== merged.fileUrl) {
    await deleteFile(existing.fileUrl);
  }
  if (Array.isArray(patch.attachments)) {
    for (const a of patch.attachments) {
      const base = existing.attachments.find((x) => x.key === a.key) || {};
      const mergedAttachment = { ...base, ...a };
      await upsertAttachment(sql, id, mergedAttachment);
      if (a.fileUrl !== undefined && base.fileUrl && base.fileUrl !== mergedAttachment.fileUrl) {
        await deleteFile(base.fileUrl);
      }
    }
  }
  if (Array.isArray(patch.proofs)) {
    for (const p of patch.proofs) await upsertProof(sql, id, existing.employees, p, actor);
  }
  return get(id);
}

async function remove(id) {
  const sql = getSql();
  const existing = await get(id);
  if (!existing) throw new Error("مسير الرواتب غير موجود");
  await sql`DELETE FROM payroll_runs WHERE id = ${id}`;
  await deleteFile(existing.fileUrl);
  for (const a of existing.attachments) await deleteFile(a.fileUrl);
  /* صفوف payroll_transfer_proofs تسقط مع المسير عبر ON DELETE CASCADE،
     أمّا ملفّاتها في Blob فلا يحذفها شيء غير هذا السطر. */
  for (const e of existing.employees) if (e.proof) await deleteFile(e.proof.fileUrl);
}

module.exports = { list, get, create, update, remove, section, assertProofFile, PROOF_EXTENSIONS };
