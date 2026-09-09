/* ─── الملاحظات: ما يبقى بين تحليلٍ وتحليل ─────────────────────────────
   =========================================================================
   دورة العمل كلّها: رفع ← تحليل ← ملاحظات ← تصحيح وإعادة رفع ← إعادة تحليل.
   والسؤال الذي يقرّر هل النظام صالح للاستعمال أصلًا هو: **ماذا يحدث لعمل
   المستخدم عند إعادة التحليل؟**

   لو أنشأت إعادةُ التحليل ملاحظاتٍ جديدة لضاعت كل حالةٍ ضبطها المستخدم وكل
   ملاحظةٍ كتبها — فيصير النظام يعاقبه على التصحيح. ولذلك لكل ملاحظة
   **بصمة** ثابتة (قاعدة + نطاق + موظّف + حقل)، والتحليل التالي **يُحدِّث**
   ما تطابق بصمته ويُبقي `status` و`user_note` كما هما.

   وما اختفى لا يُحذف بل يُعلَّم `resolved_at`: اختفاءُ ملاحظةٍ حدثٌ يعني أن
   الرفع الجديد عالجها، وهو بالضبط ما يريد المدقّق أن يراه.

   ⛔ ولا رقم حساب كاملًا يدخل هذا الجدول: القيم تمرّ بـ`maskIban` أوّلًا. */

const crypto = require("crypto");
const gateContext = require("./gateContext");

const STATUSES = Object.freeze(["needs_review", "verified", "approved_change", "needs_fix"]);
const STATUS_LABELS = Object.freeze({
  needs_review: "تحتاج مراجعة",
  verified: "تم التحقق",
  approved_change: "تغيير معتمد",
  needs_fix: "يحتاج تصحيح",
});
const SEVERITIES = Object.freeze(["info", "warn", "critical"]);
/* رُتَب العرض: الحرج أوّلًا. تُستعمل في الترتيب داخل القاعدة وفي الذاكرة
   معًا، فلا يفترق ما يراه المستخدم عمّا يفترضه الكود. */
const SEVERITY_RANK = Object.freeze({ critical: 0, warn: 1, info: 2 });
/* ⚠️ ولا يُكتب هذا الترتيب في ثابتٍ يُدرَج في القالب: القالب الموسوم يجعل
   كل ${...} **معاملًا مربوطًا**، فيصير «ORDER BY $1» — أي ترتيبًا بثابتٍ لا
   بعمود، وهو لا يرتّب شيئًا ولا يُصدر خطأً. فيُكتب حرفيًّا في الاستعلامين. */
const SCOPES = Object.freeze(["within_month", "vs_previous"]);

const MAX_VALUE = 120;
const MAX_TEXT = 400;
const MAX_NOTE = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* رقم حساب بصيغة IBAN: حرفان ورقمان ثمّ خانات. يُقنَّع إلى آخر أربع خانات.
   والقناع يقع **هنا** — في الطبقة التي تكتب في القاعدة — لا في المُنتِج:
   قاعدةُ مقارنةٍ تُكتب بعد سنة لن تتذكّر، وهذه ستتذكّر عنها. */
const IBAN_RE = /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}\b/gi;

function maskIban(text) {
  return String(text).replace(IBAN_RE, (match) => `****${match.slice(-4)}`);
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function value(raw, limit = MAX_VALUE) {
  if (raw === null || raw === undefined || raw === "") return null;
  return maskIban(String(raw)).replace(/\s+/g, " ").trim().slice(0, limit) || null;
}

/* البصمة تُبنى من الهويّة الثابتة للملاحظة — لا من قيمتها. فتغيّرُ الراتب
   بين تحليلين يُحدِّث الملاحظة نفسها ولا يُنشئ ثانيةً بجانبها. */
function fingerprintOf({ rule, scope, employeeRef, field }) {
  return crypto.createHash("sha256")
    .update([rule, scope, employeeRef || "", field || ""].join("|"), "utf8")
    .digest("hex").slice(0, 32);
}

function normalize(finding) {
  const rule = String(finding.rule || "").trim();
  if (!rule) throw fail("قاعدة بلا اسم", "bad_rule");
  const scope = String(finding.scope || "");
  if (!SCOPES.includes(scope)) throw fail("نطاق غير معروف", "bad_scope");
  const severity = String(finding.severity || "warn");
  if (!SEVERITIES.includes(severity)) throw fail("شدّة غير معروفة", "bad_severity");

  const employeeRef = value(finding.employeeRef, 64);
  const field = value(finding.field, 64);
  const delta = finding.delta === null || finding.delta === undefined || finding.delta === ""
    ? null : Number(finding.delta);
  if (delta !== null && !Number.isFinite(delta)) throw fail("فرقٌ ليس عددًا", "bad_delta");

  return {
    fingerprint: fingerprintOf({ rule, scope, employeeRef, field }),
    rule, scope, severity,
    title: value(finding.title, MAX_VALUE) || rule,
    employeeRef,
    employeeName: value(finding.employeeName, MAX_VALUE),
    field,
    previousValue: value(finding.previousValue),
    currentValue: value(finding.currentValue),
    delta,
    description: value(finding.description, MAX_TEXT),
  };
}

const view = (row) => (row ? {
  findingId: row.id,
  runId: row.run_id,
  rule: row.rule,
  scope: row.scope,
  severity: row.severity,
  title: row.title,
  employeeRef: row.employee_ref || null,
  employeeName: row.employee_name || null,
  field: row.field || null,
  previousValue: row.previous_value || null,
  currentValue: row.current_value || null,
  delta: row.delta === null || row.delta === undefined ? null : Number(row.delta),
  description: row.description || null,
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  userNote: row.user_note || null,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  resolvedAt: row.resolved_at || null,
} : null);

/* ─── المزامنة: قلب دورة «أعد الرفع ثمّ أعد التحليل» ─────────────────── */

async function sync(sql, runId, produced) {
  gateContext.requireGate();
  if (!UUID_RE.test(String(runId || ""))) throw fail("runId غير صالح", "bad_run_id");
  const at = new Date().toISOString();
  const items = (produced || []).map(normalize);

  /* بصمة مكرّرة داخل التحليل نفسه = قاعدتان تُنتجان الملاحظة ذاتها. تُبقى
     الأولى: الثانية ستكتب فوقها بلا فائدة، وقد تفقد وصفًا أدقّ. */
  const seen = new Set();
  const unique = items.filter((f) => (seen.has(f.fingerprint) ? false : seen.add(f.fingerprint)));

  const existingRows = await sql`SELECT id, fingerprint FROM droua_payroll_findings
    WHERE run_id = ${runId}::uuid`;
  const existing = new Map((existingRows || []).map((r) => [r.fingerprint, r.id]));

  /* ── لماذا لا تُكتب واحدةً بعد واحدة ──
   كل ملاحظة كتابةٌ مستقلّة، وسائقُ Neon يمرّ عبر HTTP: فالكتابة المتسلسلة
   تدفع زمن الذهاب والإياب **مرّة لكل ملاحظة**. وشهرٌ بألف موظّف يُنتج
   قرابة ألفٍ وسبع مئة ملاحظة — أي دقائق على السلك، والدالّة تُقتل قبل أن
   تُنهي، فيبقى التحليل نصفَ مكتوب.

   والصفوف مستقلّة تمامًا — البصمات فريدة بعد التصفية أعلاه، فلا صفَّان
   يتزاحمان — فتُرسل على دفعات متوازية. والعبارات **نفسها** حرفًا بحرف:
   لا `status` ولا `user_note` في أيٍّ منها، وهو الشرط الذي يحمي عمل
   المستخدم. التوازي يغيّر الزمن لا ما يُكتب.

   والحدّ ثابتٌ صغير: التوازي بلا حدّ يفتح ألف اتّصال دفعةً واحدة فيرتدّ
   الخادم أو يخنق التجمّع — وهو استبدالُ عطلٍ بعطل. */
  const WRITE_CONCURRENCY = 8;
  async function inBatches(list, task) {
    for (let i = 0; i < list.length; i += WRITE_CONCURRENCY) {
      await Promise.all(list.slice(i, i + WRITE_CONCURRENCY).map(task));
    }
  }

  let created = 0;
  let updated = 0;
  for (const f of unique) {
    if (existing.has(f.fingerprint)) updated += 1; else created += 1;
  }
  await inBatches(unique, async (f) => {
    if (existing.has(f.fingerprint)) {
      /* ⚠️ لا `status` ولا `user_note` في قائمة الأعمدة — وهذا هو الشرط
         الذي يجعل إعادة التحليل غير مدمِّرة. */
      await sql`UPDATE droua_payroll_findings SET
          severity = ${f.severity}, title = ${f.title},
          employee_name = ${f.employeeName}, previous_value = ${f.previousValue},
          current_value = ${f.currentValue}, delta = ${f.delta},
          description = ${f.description},
          last_seen_at = ${at}::timestamptz, resolved_at = NULL
        WHERE id = ${existing.get(f.fingerprint)}::uuid`;
    } else {
      await sql`INSERT INTO droua_payroll_findings
          (id, run_id, fingerprint, rule, scope, severity, title, employee_ref,
           employee_name, field, previous_value, current_value, delta, description,
           first_seen_at, last_seen_at)
        VALUES (${crypto.randomUUID()}::uuid, ${runId}::uuid, ${f.fingerprint}, ${f.rule},
                ${f.scope}, ${f.severity}, ${f.title}, ${f.employeeRef}, ${f.employeeName},
                ${f.field}, ${f.previousValue}, ${f.currentValue}, ${f.delta}, ${f.description},
                ${at}::timestamptz, ${at}::timestamptz)`;
    }
  });

  /* ما لم يره هذا التحليل: عولج. ويُعلَّم ولا يُحذف. */
  const resolvedRows = await sql`UPDATE droua_payroll_findings
      SET resolved_at = ${at}::timestamptz
      WHERE run_id = ${runId}::uuid AND resolved_at IS NULL
        AND last_seen_at < ${at}::timestamptz
      RETURNING id`;

  return { created, updated, resolved: (resolvedRows || []).length, total: unique.length };
}

async function listFindings(sql, runId, { includeResolved = false } = {}) {
  gateContext.requireGate();
  if (!UUID_RE.test(String(runId || ""))) throw fail("runId غير صالح", "bad_run_id");
  /* ⚠️ الترتيب بـ«severity DESC» **أبجديّ**: warn ثمّ info ثمّ critical —
     أي أن الحرج يهبط إلى آخر القائمة. وهو عطلٌ لا يُسقط شيئًا ولا يُرمى
     له استثناء: كل شيء يعمل، والمستخدم وحده هو من يدفع الثمن حين يقرأ
     العشرين الأولى ولا يرى فيها ما يجب أن يراه أوّلًا.

     فالترتيب صريح بالرُّتَب لا بالحروف. */
  const rows = includeResolved
    ? await sql`SELECT * FROM droua_payroll_findings WHERE run_id = ${runId}::uuid
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                 employee_ref NULLS FIRST, first_seen_at`
    : await sql`SELECT * FROM droua_payroll_findings WHERE run_id = ${runId}::uuid
        AND resolved_at IS NULL
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                 employee_ref NULLS FIRST, first_seen_at`;
  return (rows || []).map(view);
}

/* ما يملكه المستخدم من الملاحظة: حالتُها وتعليقُه. لا شيء غيرهما — القيم
   والوصف من التحليل وحده، وتحريرها يدويًّا يجعل التقرير يكذب. */
async function updateFinding(sql, findingId, patch) {
  gateContext.requireGate();
  if (!UUID_RE.test(String(findingId || ""))) throw fail("findingId غير صالح", "bad_finding_id");
  const keys = Object.keys(patch || {});
  for (const key of keys) {
    if (key !== "status" && key !== "userNote") throw fail(`حقل لا يُقبل: ${key}`, "forbidden_field");
  }
  if (!keys.length) throw fail("لا تغيير", "empty_patch");

  const current = await sql`SELECT * FROM droua_payroll_findings WHERE id = ${findingId}::uuid`;
  const row = current && current[0];
  if (!row) throw fail("غير موجودة", "not_found");

  const status = "status" in patch ? String(patch.status) : row.status;
  if (!STATUSES.includes(status)) throw fail("حالة غير معروفة", "bad_status");
  const userNote = "userNote" in patch
    ? (patch.userNote === null ? null : maskIban(String(patch.userNote)).slice(0, MAX_NOTE))
    : (row.user_note || null);

  const rows = await sql`UPDATE droua_payroll_findings
    SET status = ${status}, user_note = ${userNote}
    WHERE id = ${findingId}::uuid RETURNING *`;
  return view(rows && rows[0]);
}

/* ملخّص كل الأشهر في استعلام واحد — للسبب نفسه في files.countsByRun. */
async function summaryByRun(sql) {
  gateContext.requireGate();
  const rows = await sql`SELECT run_id,
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
      count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'critical')::int AS critical,
      count(*) FILTER (WHERE resolved_at IS NULL AND status = 'needs_review')::int AS needs_review
    FROM droua_payroll_findings GROUP BY run_id`;
  const out = new Map();
  for (const row of rows || []) {
    out.set(row.run_id, {
      total: Number(row.total), open: Number(row.open),
      critical: Number(row.critical), needsReview: Number(row.needs_review),
    });
  }
  return out;
}

async function summary(sql, runId) {
  const list = await listFindings(sql, runId, { includeResolved: true });
  const open = list.filter((f) => !f.resolvedAt);
  const count = (predicate) => open.filter(predicate).length;
  return {
    total: list.length,
    open: open.length,
    resolved: list.length - open.length,
    critical: count((f) => f.severity === "critical"),
    needsReview: count((f) => f.status === "needs_review"),
    needsFix: count((f) => f.status === "needs_fix"),
  };
}

module.exports = {
  sync, listFindings, updateFinding, summary, summaryByRun,
  fingerprintOf, normalize, maskIban, view,
  STATUSES, STATUS_LABELS, SEVERITIES, SEVERITY_RANK, SCOPES, MAX_NOTE,
};
