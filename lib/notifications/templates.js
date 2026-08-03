const SUBJECT = "🔔 تنبيه بقرب انتهاء وثيقة موظف";
const arMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

function fmtDate(d) {
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d)) return "—";
  return `${d.getDate()} ${arMonths[d.getMonth()]} ${d.getFullYear()}`;
}

/* Short "N days left / expires today / overdue since N days" clause, reused in
   both the single-alert body and each line of a batched list. */
function remainingClause(a) {
  if (a.stage === "overdue") return `منتهية منذ ${Math.abs(a.remainingDays)} يوم`;
  if (a.stage === "today") return "تنتهي اليوم";
  return `متبقي ${a.remainingDays} أيام`;
}

function listAlerts(alerts) {
  return alerts
    .map((a, i) => `${i + 1}. ${a.employeeName} — ${a.documentTypeLabel} — ${remainingClause(a)}${a.stage === "overdue" ? " ⚠️ يتطلب إجراءً فوريًا" : ""}`)
    .join("\n");
}

/* Each recipient gets a single-alert wording (stage-aware: 5-day / 2-day / today /
   overdue-daily) and a batch wording for when several documents trigger the same day.
   Add a new key here (matching an email in recipients.js) to onboard a new recipient. */
const TEMPLATES = {
  "hr-manager@droua.com": {
    single: (a) => `السلام عليكم خالد،

نود إشعارك بأن الموظف:

${a.employeeName}

${a.stage === "overdue" ? "منتهية" : "ستنتهي"} ${a.documentTypeLabel}

${a.stage === "overdue" ? `منذ ${Math.abs(a.remainingDays)} يوم` : a.stage === "today" ? "اليوم" : `بعد ${a.remainingDays} أيام`}.

تفاصيل الوثيقة:

• اسم الموظف: ${a.employeeName}
• نوع الوثيقة: ${a.documentTypeLabel}
• تاريخ الانتهاء: ${fmtDate(a.expiryDate)}
• المدة المتبقية: ${remainingClause(a)}
${a.stage === "overdue" ? "\n⚠️ هذه الوثيقة منتهية ولم يتم تحديثها بعد. سيستمر وصول هذا التنبيه يوميًا حتى يتم تجديدها أو رفع وثيقة جديدة.\n" : ""}
يرجى اتخاذ الإجراءات اللازمة ${a.stage === "overdue" ? "فورًا" : "قبل تاريخ الانتهاء"}.

تحياتنا،
نظام التنبيهات
منصة ذروة`,
    batch: (alerts) => `السلام عليكم خالد،

لديك ${alerts.length} تنبيهات جديدة:

${listAlerts(alerts)}

يرجى مراجعة لوحة التحكم واتخاذ الإجراءات اللازمة.

تحياتنا،
نظام التنبيهات
منصة ذروة`,
  },
  "hr-specialist@droua.com": {
    single: (a) => `السلام عليكم فراس،

لديك وثيقة تحتاج إلى المتابعة.

الموظف:

${a.employeeName}

${a.stage === "overdue" ? "منتهية" : "ستنتهي"} ${a.documentTypeLabel}

${a.stage === "overdue" ? `منذ ${Math.abs(a.remainingDays)} يوم` : a.stage === "today" ? "اليوم" : `بعد ${a.remainingDays} أيام`}.

تفاصيل الوثيقة:

• نوع الوثيقة: ${a.documentTypeLabel}
• تاريخ الانتهاء: ${fmtDate(a.expiryDate)}
• المدة المتبقية: ${remainingClause(a)}
${a.stage === "overdue" ? "\n⚠️ هذه الوثيقة منتهية ولم يتم تحديثها بعد. سيستمر وصول هذا التنبيه يوميًا حتى يتم رفع وثيقة جديدة.\n" : ""}
يرجى البدء بإجراءات التجديد${a.stage === "overdue" ? " فورًا" : ""}.

تحياتنا،
نظام التنبيهات
منصة ذروة`,
    batch: (alerts) => `السلام عليكم فراس،

لديك ${alerts.length} تنبيهات جديدة تحتاج إلى المتابعة:

${listAlerts(alerts)}

يرجى البدء بإجراءات التجديد لكل حالة.

تحياتنا،
نظام التنبيهات
منصة ذروة`,
  },
};

function buildEmail(recipient, alerts) {
  const t = TEMPLATES[recipient.email];
  if (!t) throw new Error(`لا يوجد قالب بريد لهذا المستلم: ${recipient.email}`);
  return {
    subject: SUBJECT,
    text: alerts.length === 1 ? t.single(alerts[0]) : t.batch(alerts),
  };
}

module.exports = { buildEmail, fmtDate };
