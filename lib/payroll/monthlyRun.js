const { getSql } = require("../db");
const { previousMonthPeriod, riyadhToday } = require("../reports/period");
const employeesData = require("../data/employees");
const payrollRunsData = require("../data/payrollRuns");
const { sendMail } = require("../notifications/mailer");
const { logEvent } = require("../auth/audit");
const { notifyEmailAddress, buildEmail } = require("./notify");

/* ─── إنشاء مسير الرواتب الشهري تلقائيًا ───

   يوم واحد في الشهر، وشهرٌ واحد لا غير: الشهر السابق دائمًا. يُنادى من
   الـCron اليومي القائم (api/cron/check-expirations.js) لا من دالّة
   خادمة ثالثة — عددها يبقى اثنتين.

   عدم التكرار محروس في القاعدة لا في منطق التطبيق، بحاجزين مستقلّين:

     الإنشاء →  INSERT INTO payroll_runs ... ON CONFLICT (id) DO NOTHING
                معرّف المسير هو الشهر نفسه ("2026-08") وهو المفتاح
                الأساسي، فالحاجز موجود في المخطّط أصلًا بلا جدول جديد.

     التنبيه →  UPDATE payroll_runs SET notified_at = now()
                 WHERE id = $1 AND notified_at IS NULL RETURNING id
                حجزٌ ذرّي: من يفوز بالصفّ يُرسل، ومن يخسر يتوقّف.

   فتشغيل الـCron مرّتين، أو إعادة محاولة، أو تشغيلان متزامنان — كلّها
   تُنتج مسيرًا واحدًا وتنبيهًا واحدًا.

   نافذة التدارك خمسة أيام (نفس ثابت lib/reports/monthlyReport.js): الفحص
   يومي، فعطلٌ في اليوم الأول يُتدارَك في الثاني بدل أن يضيع الشهر — ولا
   خطر من ذلك، لأن الحاجزين أعلاه لا يسمحان بالثاني أصلًا. */

const CATCH_UP_DAYS = 5;

/* بذرة المرفقات — منسوخة حرفيًا من نموذج الإنشاء اليدوي في
   payroll-shell.html، فالمسير التلقائي والمسير اليدوي يخرجان بالهيكل
   نفسه ولا تتفرّق نسختان من التعريف. */
const SEED_ATTACHMENTS = [
  { key: "payroll_sheet", label: "مسير الرواتب", statusKey: "pending_upload", note: null },
  { key: "damanah_invoice", label: "فاتورة شركة ضمان", statusKey: "pending_upload", note: "لم يتم رفع الفاتورة بعد." },
  { key: "payment_receipt", label: "إيصال السداد", statusKey: "pending_payment", note: "لم يتم إرفاق إيصال السداد بعد." },
];

const SEED_RUN_STATUS = "pending_invoice";

/* حقول سجلّ الموظف — نفس أسماء lib/data/employees.js. */
/* رقم الموظف لدى شركة ضمان (500، 501 …) — معرّفه في هذه المنصّة: عمود
   employees.eid ومفتاح الربط في التذاكر والتصاريح وإثباتات التحويل.
   المفتاح المخزَّن يبقى "الرقم الوظيفي" حرفيًا: تغييره هجرةُ JSONB في كل
   صفّ ومفتاحِ ربطٍ عبر أربعة جداول، بمكسب صفر لأن أحدًا لا يرى مفتاح
   التخزين. الوضوح يقع في الاسم البرمجي وفيما يُعرض للمستخدم.
   لا يُخلط برقم جسر (F_JISR) — ترقيمان مستقلّان يُحفظان معًا. */
const F_DAMANAH = "الرقم الوظيفي";
const F_NAME = "اسم العامل";
const F_JOB = "المهنة";

/* وصف الشهر السابق: المعرّف والاسم العربي معًا، مشتقّان من المصدر نفسه
   (lib/reports/period.js) بتوقيت Asia/Riyadh. لا حساب تواريخ محلّي هنا:
   نفس الدالّة التي تقرّر شهر التقرير الشهري تقرّر شهر المسير، فلا يمكن
   أن يختلف تعريف «الشهر السابق» بين ميزتين في المنصّة نفسها. */
function previousMonthRun(now = new Date()) {
  const period = previousMonthPeriod(now);
  return {
    id: period.start.slice(0, 7), // "2026-08"
    monthLabel: period.label, // "أغسطس 2026"
    year: period.year,
    month: period.month,
    /* تاريخ الإنشاء بتوقيت الرياض — لا new Date().toISOString() الذي قد
       يقع في اليوم السابق قبل الثالثة فجرًا. */
    createdOn: riyadhDateString(now),
  };
}

function riyadhDateString(now) {
  const t = riyadhToday(now);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

/* اللقطة: قائمة الموظفين تُجمَّد وقت الإنشاء ولا تُقرأ حيّة بعده. موظف
   يُضاف في سبتمبر لا يظهر في مسير أغسطس، وموظف يُحذف من السجلّ لا
   يختفي إثبات تحويله من مسير مضى. هذا وحده ما يجعل «لا تُغيَّر مسيرات
   الشهور السابقة» قاعدةً في البيانات لا وعدًا في الواجهة. */
function snapshotOf(employees) {
  const out = [];
  const seen = new Set();
  for (const emp of employees || []) {
    const eid = String((emp && emp[F_DAMANAH]) || "").trim();
    const name = String((emp && emp[F_NAME]) || "").trim();
    if (!eid || !name) continue; // سجلّ ناقص لا يصلح صفًّا في المسير
    if (seen.has(eid)) continue;
    seen.add(eid);
    out.push({ eid, name, jobTitle: String((emp && emp[F_JOB]) || "").trim() || null });
  }
  return out;
}

/* الاعتماديات تُحقن كي تُختبر الدوالّ بلا قاعدة بيانات ولا SMTP. القيم
   الافتراضية هي الوحدات الحقيقية، فالمُنادي في الإنتاج لا يمرّر شيئًا. */
function withDeps(deps) {
  return {
    sql: (deps && deps.sql) || getSql(),
    listEmployees: (deps && deps.listEmployees) || employeesData.list,
    getRun: (deps && deps.getRun) || payrollRunsData.get,
    sendMail: (deps && deps.sendMail) || sendMail,
    sendPush: (deps && deps.sendPush) || ((run) => require("../push/notify").sendPayrollRunCreated(run)),
    log: (deps && deps.log) || logEvent,
  };
}

/* يُنشئ مسير الشهر السابق إن لم يكن موجودًا. لا يُرسل شيئًا — الإرسال
   قرار منفصل في runScheduledPayroll، كي لا يستطيع نداءٌ للإنشاء أن
   يُطلق تنبيهًا كأثر جانبي. */
async function ensureMonthlyRun(now = new Date(), deps) {
  const d = withDeps(deps);
  const descriptor = previousMonthRun(now);

  const claimed = await d.sql`
    INSERT INTO payroll_runs (id, month_label, uploaded_at, status_key, file_url, source)
    VALUES (${descriptor.id}, ${descriptor.monthLabel}, ${descriptor.createdOn}, ${SEED_RUN_STATUS}, ${null}, 'cron')
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;

  if (!claimed[0]) return { created: false, reason: "already_exists", ...descriptor };

  for (const a of SEED_ATTACHMENTS) {
    await d.sql`
      INSERT INTO payroll_attachments (run_id, key, label, status_key, file_url, uploaded_at, note)
      VALUES (${descriptor.id}, ${a.key}, ${a.label}, ${a.statusKey}, ${null}, ${null}, ${a.note})
      ON CONFLICT (run_id, key) DO NOTHING`;
  }

  /* فشل قراءة سجلّ الموظفين لا يُلغي المسير: المسير أُنشئ فعلًا وحُجز
     الشهر، والقائمة يمكن أن تُستكمل. الأثر يُسجَّل كي لا يمرّ صامتًا. */
  let snapshot = [];
  try {
    snapshot = snapshotOf(await d.listEmployees());
  } catch (err) {
    d.log({ type: "payroll_run_snapshot_failed", targetId: descriptor.id, meta: { error: (err && err.message) || String(err) } });
  }

  for (const e of snapshot) {
    await d.sql`
      INSERT INTO payroll_transfer_proofs (run_id, employee_eid, employee_name, job_title)
      VALUES (${descriptor.id}, ${e.eid}, ${e.name}, ${e.jobTitle})
      ON CONFLICT (run_id, employee_eid) DO NOTHING`;
  }

  d.log({
    type: "payroll_run_created_auto",
    targetId: descriptor.id,
    meta: { monthLabel: descriptor.monthLabel, employees: snapshot.length },
  });

  return { created: true, ...descriptor, employees: snapshot.length };
}

/* حجز التنبيه. الفوز بالصفّ هو الإذن بالإرسال. */
async function claimNotification(runId, deps) {
  const d = withDeps(deps);
  const rows = await d.sql`
    UPDATE payroll_runs SET notified_at = now(), notify_error = NULL
     WHERE id = ${runId} AND notified_at IS NULL
     RETURNING id`;
  return !!rows[0];
}

/* يُفرَج عن الحجز حين يفشل البريد: بقاؤه محجوزًا يعني أن التنبيه لن
   يُحاوَل ثانيةً أبدًا فيضيع كليًا بسبب عطل SMTP عابر. المحاولة التالية
   تقع في اليوم التالي داخل نافذة التدارك. */
async function releaseNotification(runId, error, deps) {
  const d = withDeps(deps);
  await d.sql`
    UPDATE payroll_runs
       SET notified_at = NULL, notify_error = ${error ? String(error).slice(0, 500) : null}
     WHERE id = ${runId}`;
}

async function recordNotifyError(runId, error, deps) {
  const d = withDeps(deps);
  await d.sql`UPDATE payroll_runs SET notify_error = ${error ? String(error).slice(0, 500) : null} WHERE id = ${runId}`;
}

/* التنبيه: بريد واحد إلى العنوان المُهيّأ، ودفعٌ إلى أجهزة صاحبه.
   القناتان معزولتان في اتجاه واحد مقصود:

   - فشل البريد يُفرج عن الحجز فيُعاد غدًا. آمنٌ للدفع أيضًا لأن لكل
     جهاز مفتاح عدم تكرار خاصًّا به في push_notification_log، فإعادة
     المحاولة لا تُنتج إشعارًا ثانيًا على جهاز وصله الأول.
   - فشل الدفع وحده لا يُفرج عن الحجز: البريد خرج فعلًا، والإفراج كان
     سيعيد إرساله. إشعارُ دفعٍ ضائع أهون من بريدٍ مكرّر. يُسجَّل في
     notify_error كي يُرى. */
async function notifyRunCreated(run, deps) {
  const d = withDeps(deps);
  const to = notifyEmailAddress();
  const { subject, text } = buildEmail(run);

  let mail;
  try {
    const info = await d.sendMail({ to, subject, text });
    mail = { ok: true, to, messageId: info && info.messageId };
  } catch (err) {
    return { ok: false, stage: "email", to, error: (err && err.message) || "فشل إرسال البريد" };
  }

  let push;
  try {
    push = await d.sendPush(run);
  } catch (err) {
    push = { ok: false, error: (err && err.message) || "فشل إرسال إشعار الدفع" };
  }

  return { ok: true, mail, push };
}

/* نقطة الدخول من الـCron. */
async function runScheduledPayroll(now = new Date(), options = {}) {
  const { catchUpDays = CATCH_UP_DAYS, ...deps } = options;
  const today = riyadhToday(now);
  const descriptor = previousMonthRun(now);

  if (today.day > catchUpDays) {
    return { ran: false, reason: "outside_window", day: today.day, period: descriptor.monthLabel };
  }

  const ensured = await ensureMonthlyRun(now, deps);
  if (!ensured.created) {
    /* موجود مسبقًا — لا إنشاء ولا تنبيه. هذا هو المسار الذي يسلكه كل
       تشغيل يومي بعد اليوم الأول. */
    return { ran: false, reason: "already_exists", period: descriptor.monthLabel, runId: descriptor.id };
  }

  const claimed = await claimNotification(descriptor.id, deps);
  if (!claimed) {
    return { ran: true, created: true, notified: false, reason: "already_notified", period: descriptor.monthLabel, runId: descriptor.id };
  }

  const result = await notifyRunCreated(descriptor, deps);
  if (!result.ok) {
    await releaseNotification(descriptor.id, result.error, deps);
    withDeps(deps).log({ type: "payroll_run_notify_failed", targetId: descriptor.id, meta: { stage: result.stage, error: result.error } });
    return { ran: true, created: true, notified: false, reason: "notify_failed", error: result.error, period: descriptor.monthLabel, runId: descriptor.id };
  }
  if (result.push && result.push.ok === false) {
    await recordNotifyError(descriptor.id, result.push.error, deps);
  }

  withDeps(deps).log({
    type: "payroll_run_notified",
    targetId: descriptor.id,
    meta: { to: result.mail.to, employees: ensured.employees, push: result.push },
  });

  return {
    ran: true, created: true, notified: true,
    period: descriptor.monthLabel, runId: descriptor.id,
    employees: ensured.employees, mail: result.mail, push: result.push,
  };
}

module.exports = {
  CATCH_UP_DAYS, SEED_ATTACHMENTS, SEED_RUN_STATUS,
  previousMonthRun, snapshotOf,
  ensureMonthlyRun, claimNotification, releaseNotification, notifyRunCreated, runScheduledPayroll,
};
