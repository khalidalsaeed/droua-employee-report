/* ─── مطابقة ملفّ التحويل البنكي لمسير شهرٍ واحد ───
   =========================================================================
   الخيط الكامل: ملفّ واحد للشهر → قراءة → استخراج → مطابقة → حفظ النتيجة.

   ── من أين يأتي كل طرف ──
     الموظفون       لقطة المسير نفسه (payroll_transfer_proofs) — من في مسير
                    الشهر لا من في السجلّ اليوم.
     المستحق        صافي الراتب من كشف جسر المرفوع على المسير، عبر
                    lib/payroll/sheetRoster.js كما هو (بحاجز مطابقة
                    الإجمالي) وربط «رقم جسر». لا يُحسب هنا أي راتب.
     الآيبان/الحساب سجلّ الموظف الحيّ (معرّف هوية لا واقعة رواتب، كرقم جسر).
     نقدي           حقل «طريقة صرف الراتب» في سجلّ الموظف، صريحًا لا تخمينًا.

   ── ما لا يحدث هنا ──
   • لا يُخزَّن الملفّ ولا يُرفع إلى Blob: بصمته واسمه وحجمه فقط.
   • لا يُسجَّل محتواه ولا آيبان كامل في أي سجلّ — ولا console.log هنا إطلاقًا.
   • لا يُمسّ payroll_runs ولا الإثباتات القديمة ولا أي حساب رواتب.

   الاعتماديات تُحقن للاختبار؛ القيم الافتراضية هي الوحدات الحقيقية. */

const crypto = require("crypto");
const N = require("./normalize");
const { parseTransferFile, TransferFileError } = require("./parse");
const { periodFits } = require("./extract");
const { reconcile } = require("./match");

const F_IBAN = "IBAN";
const F_ACCOUNT = "رقم الحساب";
const F_BENEF = "اسم المستفيد (كما في البنك)";
const F_DAMANAH = "الرقم الوظيفي";
/* طريقة صرف الراتب: «تحويل بنكي» (الافتراضي حين يغيب الحقل) أو «نقدي». */
const F_PAY_METHOD = "طريقة صرف الراتب";
const SHEET_ATTACHMENT_KEY = "payroll_sheet";

const isCashMethod = (v) => /نقد|كاش|cash/i.test(String(v || ""));

class ReconcileError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

function deps(o = {}) {
  return {
    sql: o.sql || require("../../db").getSql(),
    getRun: o.getRun || require("../../data/payrollRuns").get,
    listEmployees: o.listEmployees || require("../../data/employees").list,
    fetchFile: o.fetchFile || defaultFetch,
    extractRoster: o.extractRoster || require("../sheetRoster").extractRoster,
    log: o.log || require("../../auth/audit").logEvent,
    now: o.now || (() => new Date()),
  };
}

async function defaultFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* جدول غير موجود = الهجرة لم تُطبَّق بعد. الصفحة تعمل وتقول ذلك. */
const isMissingTable = (err) => err && (err.code === "42P01" || /relation .*payroll_transfer_(files|matches).* does not exist/i.test(String(err.message)));

/* ── المستحق من كشف جسر ── */
async function expectedByJisr(run, d) {
  const att = (run.attachments || []).find((a) => a.key === SHEET_ATTACHMENT_KEY && a.fileUrl);
  const url = (att && att.fileUrl) || run.fileUrl;
  if (!url) return { source: "none", reason: "no_sheet", map: new Map() };
  try {
    const roster = await d.extractRoster(await d.fetchFile(url));
    if (!roster.ok) return { source: "none", reason: roster.reason, map: new Map() };
    const map = new Map();
    for (const s of roster.staff) map.set(String(s.jisrNo).replace(/^0+(?=\d)/, ""), Math.round(s.net * 100));
    return { source: "jisr_sheet", reason: null, map };
  } catch (err) {
    return { source: "none", reason: "sheet_unreadable", map: new Map() };
  }
}

async function buildRoster(run, d) {
  const records = new Map();
  for (const r of await d.listEmployees()) records.set(String(r[F_DAMANAH] || "").trim(), r);
  const expected = await expectedByJisr(run, d);
  const employees = (run.employees || []).map((e) => {
    const rec = records.get(String(e.eid)) || {};
    const iban = N.normalizeIban(rec[F_IBAN]);
    const jisr = e.jisrNo ? String(e.jisrNo).replace(/^0+(?=\d)/, "") : null;
    return {
      eid: e.eid,
      jisrNo: e.jisrNo || null,
      name: e.name,
      iban: iban && N.isValidIban(iban) ? iban : null,
      account: N.normalizeAccount(rec[F_ACCOUNT]),
      beneficiaryName: rec[F_BENEF] || null,
      cash: isCashMethod(rec[F_PAY_METHOD]),
      expected: jisr && expected.map.has(jisr) ? expected.map.get(jisr) : null,
    };
  });
  return { employees, expectedSource: expected.source, expectedReason: expected.reason };
}

/* التحويلات كما تُخزَّن: بلا آيبان ولا حساب كامل. */
function storedTransfer(t) {
  return {
    line: t.line, name: t.name, amount: t.amount, reference: t.reference, date: t.date, bank: t.bank, empNo: t.empNo,
    ibanLast4: N.last4(t.iban), ibanHash: N.identifierHash("iban", t.iban),
    accountLast4: N.last4(t.account), accountHash: N.identifierHash("account", t.account),
    flags: t.flags || [],
  };
}

const toSar = (h) => (h === null || h === undefined ? null : (h / 100).toFixed(2));

/* ── الرفع والمطابقة ── */
async function reconcileUpload({ runId, bytes, fileName, replace, actor }, overrides) {
  const d = deps(overrides);
  const run = await d.getRun(runId);
  if (!run) throw new ReconcileError("run_not_found", "مسير الرواتب غير موجود", 404);
  if (!(run.employees || []).length) {
    throw new ReconcileError("no_snapshot", "لا توجد قائمة موظفين لهذا المسير — لا يمكن المطابقة عليه");
  }

  let parsed;
  try {
    parsed = await parseTransferFile(bytes, String(fileName || ""));
  } catch (err) {
    if (err instanceof TransferFileError) throw new ReconcileError(err.code, err.message, 422);
    throw new ReconcileError("unreadable_file", "تعذّرت قراءة الملفّ", 422);
  }

  if (!periodFits(runId, parsed.period)) {
    throw new ReconcileError("wrong_period",
      `تواريخ التحويلات في الملفّ تخصّ ${parsed.period}، وهذا مسير ${runId}. ارفع ملفّ تحويل هذا الشهر — لا تُخلط ملفّات الشهور.`, 422);
  }

  let current;
  try {
    current = (await d.sql`SELECT id, file_sha256 FROM payroll_transfer_files WHERE run_id = ${runId} AND superseded_at IS NULL`)[0];
  } catch (err) {
    if (isMissingTable(err)) throw new ReconcileError("not_setup", "ميزة مطابقة ملفّ التحويل بانتظار تهيئة قاعدة البيانات", 503);
    throw err;
  }
  /* البصمة تكشف رفع الملفّ نفسه مرّة ثانية: لا استبدال ملفٍّ بنفسه ولا سجلّ
     مكرّر. (ملفّ مستبدَل سابقًا يجوز رفعه من جديد — هو تراجعٌ مقصود.) */
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (current && current.file_sha256 === sha) {
    throw new ReconcileError("duplicate_file", "هذا الملف نفسه هو ملف التحويل الحالي لهذا الشهر — لم يتغيّر شيء", 409);
  }
  if (current && !replace) {
    throw new ReconcileError("exists", "يوجد ملف تحويل مرفوع مسبقًا، هل تريد استبداله؟", 409);
  }

  const roster = await buildRoster(run, d);
  const outcome = reconcile({ employees: roster.employees, transfers: parsed.transfers });
  const summary = {
    ...outcome.summary,
    expectedSource: roster.expectedSource,
    expectedReason: roster.expectedReason,
    unassignedList: outcome.unassigned.slice(0, 200),
    warnings: parsed.warnings,
    mode: parsed.mode,
  };

  /* التسمية الداخلية بدل الاسم الأصلي (قد يحمل بيانات شخصية). */
  const label = `transfer-${runId}-${sha.slice(0, 8)}.${parsed.format}`;
  const by = (actor && actor.email) || null;
  const [{ id: fileId }] = await d.sql`SELECT nextval(pg_get_serial_sequence('payroll_transfer_files', 'id'))::bigint AS id`;

  const matches = outcome.results.map((r) => ({
    employee_eid: r.eid,
    status: r.status,
    reason: r.reason,
    expected_amount: toSar(r.expected),
    transferred_amount: r.transfer ? toSar(r.transfer.amount) : null,
    reference: r.transfer ? r.transfer.reference : null,
    transfer_date: r.transfer ? r.transfer.date : null,
    account_masked: r.transfer ? r.transfer.accountMasked : r.suggestion ? r.suggestion.accountMasked : null,
    beneficiary_name: r.transfer ? r.transfer.beneficiaryName : r.suggestion ? r.suggestion.beneficiaryName : null,
    bank: r.transfer ? r.transfer.bank : null,
    match_basis: r.transfer ? r.transfer.basis : r.suggestion ? "name" : null,
    candidate_count: r.candidates || 0,
    name_mismatch: !!(r.transfer && r.transfer.nameMismatch),
  }));

  /* معاملة واحدة: استبدال الحالي (إن وُجد) + الملفّ الجديد + نتائجه. الفهرس
     الجزئي الفريد يمنع ملفّين حاليّين لو تسابق رفعان. */
  const queries = [];
  if (current) {
    queries.push(d.sql`UPDATE payroll_transfer_files SET superseded_at = now(), superseded_by = ${by}
                        WHERE run_id = ${runId} AND superseded_at IS NULL`);
  }
  queries.push(d.sql`
    INSERT INTO payroll_transfer_files
      (id, run_id, file_label, file_format, file_size, file_sha256, detected_period, uploaded_by, transfers, summary)
    VALUES (${fileId}, ${runId}, ${label}, ${parsed.format}, ${bytes.length}, ${sha}, ${parsed.period}, ${by},
            ${JSON.stringify(parsed.transfers.map(storedTransfer))}::jsonb, ${JSON.stringify(summary)}::jsonb)`);
  queries.push(d.sql`
    INSERT INTO payroll_transfer_matches
      (file_id, run_id, employee_eid, status, reason, expected_amount, transferred_amount, reference, transfer_date,
       account_masked, beneficiary_name, bank, match_basis, candidate_count, name_mismatch)
    SELECT ${fileId}, ${runId}, m.employee_eid, m.status, m.reason, m.expected_amount, m.transferred_amount, m.reference,
           m.transfer_date, m.account_masked, m.beneficiary_name, m.bank, m.match_basis, m.candidate_count, m.name_mismatch
      FROM jsonb_to_recordset(${JSON.stringify(matches)}::jsonb) AS m(
        employee_eid text, status text, reason text, expected_amount numeric, transferred_amount numeric, reference text,
        transfer_date date, account_masked text, beneficiary_name text, bank text, match_basis text,
        candidate_count integer, name_mismatch boolean)`);
  if (typeof d.sql.transaction === "function") await d.sql.transaction(queries);
  else for (const q of queries) await q;

  /* الأثر: عدّادات واسم الملفّ وبصمته — لا محتوى ولا آيبان. */
  d.log({
    type: current ? "payroll_transfer_file_replaced" : "payroll_transfer_file_uploaded",
    actorEmail: by,
    actorId: (actor && actor.id) || null,
    targetId: runId,
    meta: { file: label, sha256: sha, format: parsed.format, transfers: parsed.transfers.length,
            matched: summary.matched, amount_mismatch: summary.amount_mismatch, not_found: summary.not_found,
            needs_review: summary.needs_review, cash: summary.cash, unassigned: summary.unassigned,
            replacedFileId: current ? current.id : null },
  });

  return getState(runId, overrides);
}

/* ── القراءة: الحالة الحالية + السجلّ ── */
async function getState(runId, overrides) {
  const d = deps(overrides);
  let files;
  try {
    files = await d.sql`
      SELECT id, file_label, file_format, file_size, file_sha256, detected_period, uploaded_by, uploaded_at, superseded_at, superseded_by, state, summary
        FROM payroll_transfer_files WHERE run_id = ${runId} ORDER BY id DESC`;
  } catch (err) {
    if (isMissingTable(err)) return { setup: false, current: null, matches: {}, history: [] };
    throw err;
  }
  const currentRow = files.find((f) => !f.superseded_at) || null;
  const matches = {};
  if (currentRow) {
    const rows = await d.sql`
      SELECT employee_eid, status, reason, expected_amount, transferred_amount, reference,
             to_char(transfer_date, 'YYYY-MM-DD') AS transfer_date, account_masked, beneficiary_name, bank,
             match_basis, candidate_count, name_mismatch
        FROM payroll_transfer_matches WHERE file_id = ${currentRow.id}`;
    for (const r of rows) {
      const exp = r.expected_amount === null ? null : Number(r.expected_amount);
      const got = r.transferred_amount === null ? null : Number(r.transferred_amount);
      matches[r.employee_eid] = {
        status: r.status, reason: r.reason, expected: exp, transferred: got,
        diff: exp !== null && got !== null ? Math.round((got - exp) * 100) / 100 : null,
        reference: r.reference, date: r.transfer_date, account: r.account_masked,
        beneficiaryName: r.beneficiary_name, bank: r.bank, basis: r.match_basis,
        candidates: r.candidate_count, nameMismatch: r.name_mismatch,
      };
    }
  }
  const view = (f) => {
    const s = f.summary || {};
    return {
      id: Number(f.id), fileName: f.file_label, state: f.state || (f.superseded_at ? "replaced" : "current"), sha256: f.file_sha256 ? f.file_sha256.slice(0, 12) : null, format: f.file_format, size: f.file_size, period: f.detected_period,
      uploadedBy: f.uploaded_by, uploadedAt: f.uploaded_at, replacedAt: f.superseded_at, replacedBy: f.superseded_by,
      counts: { matched: s.matched || 0, amount_mismatch: s.amount_mismatch || 0, not_found: s.not_found || 0,
                needs_review: s.needs_review || 0, cash: s.cash || 0, unassigned: s.unassigned || 0, transfers: s.transfers || 0 },
    };
  };
  return {
    setup: true,
    current: currentRow ? { ...view(currentRow), expectedSource: (currentRow.summary || {}).expectedSource || null,
      warnings: (currentRow.summary || {}).warnings || [],
      unassigned: ((currentRow.summary || {}).unassignedList || []).map((u) => ({
        line: u.line, amount: u.amount === null ? null : u.amount / 100, reference: u.reference, date: u.date,
        beneficiaryName: u.beneficiaryName, account: u.accountMasked, reason: u.reason })) } : null,
    matches,
    history: files.map(view),
  };
}

module.exports = { reconcileUpload, getState, buildRoster, storedTransfer, isCashMethod, isMissingTable, ReconcileError, F_PAY_METHOD };
