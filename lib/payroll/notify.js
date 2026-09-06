/* نصوص تنبيه إنشاء مسير الرواتب الشهري — البريد والدفع معًا.
   =========================================================================
   ملفّ نصوص خالص: لا قاعدة بيانات، ولا شبكة، ولا حالة. سببه أن النصوص
   مواصفة متّفق عليها حرفًا بحرف، فوضعها في مكان واحد يجعل اختبارها
   مطابقةً مباشرة بدل انتزاعها من جسد دالّة إرسال.

   المستقبِل واحد حاليًا (مدير الموارد البشرية) وهو في متغيّر بيئة لا
   ثابت مضمَّن: تغييره لاحقًا — أو توسيعه إلى قائمة — لا يستلزم نشر
   شيفرة. القيمة الاحتياطية هي عنوان المنصّة نفسه الظاهر في
   payroll-detail-shell.html، فبيئة بلا المتغيّر تعمل لا تصمت. */

const DEFAULT_NOTIFY_EMAIL = "hr-manager@droua.com";

function notifyEmailAddress() {
  const configured = String(process.env.PAYROLL_NOTIFY_EMAIL || "").trim();
  return configured || DEFAULT_NOTIFY_EMAIL;
}

/* `run` يكفي منه {id, monthLabel} — الشكل الذي تُرجعه previousMonthRun()
   وأيضًا الشكل الذي يُرجعه lib/data/payrollRuns.js. */
function buildEmail(run) {
  return {
    subject: `تم إنشاء مسير رواتب ${run.monthLabel}`,
    text: `تم إنشاء مسير رواتب ${run.monthLabel} تلقائيًا وبانتظار إكمالك ومراجعة بيانات الموظفين وإرفاق إثباتات تحويل الرواتب.`,
  };
}

/* url مسار نسبيّ داخل المنصّة. sw.js يحلّه على أصل الموقع ويرفض أي أصل
   آخر (resolveTarget)، والـrewrite القائم في vercel.json يحوّل
   /payroll/:id إلى صفحة تفصيل المسير — فالضغط يفتح المسير نفسه لا
   الرئيسية، بلا أي تعديل على عامل الخدمة.

   tag يحمل معرّف الشهر: إشعار سبتمبر لا يستبدل إشعار أغسطس لو لم يُقرأ. */
function buildPush(run) {
  return {
    kind: "payroll_run",
    title: `مسير رواتب ${run.monthLabel}`,
    body: "تم إنشاء المسير وبانتظار إكمالك له.",
    url: `/payroll/${run.id}`,
    tag: `droua-payroll-${run.id}`,
  };
}

/* مفتاح عدم التكرار في push_notification_log — بالصيغة المطلوبة
   payroll:2026-08. الشهر هو معرّف المسير نفسه، فلا اشتقاق ثانٍ للتاريخ
   يمكن أن يخالف الأول. */
function dedupKey(runId) {
  return `payroll:${runId}`;
}

module.exports = { DEFAULT_NOTIFY_EMAIL, notifyEmailAddress, buildEmail, buildPush, dedupKey };
