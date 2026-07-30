const SUBJECT = "🔔 تنبيه بقرب انتهاء وثيقة موظف";
const arMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

function fmtDate(d) {
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d)) return "—";
  return `${d.getDate()} ${arMonths[d.getMonth()]} ${d.getFullYear()}`;
}

function listAlerts(alerts) {
  return alerts.map((a, i) => `${i + 1}. ${a.employeeName} — ${a.documentTypeLabel} — متبقي ${a.remainingDays} أيام`).join("\n");
}

/* Each recipient gets a single-alert wording and a batch (multi-alert) wording.
   Add a new key here (matching an email in recipients.js) to onboard a new recipient. */
const TEMPLATES = {
  "hr-manager@droua.com": {
    single: (a) => `السلام عليكم خالد،

نود إشعارك بأن الموظف:

${a.employeeName}

ستنتهي ${a.documentTypeLabel}

بعد ${a.remainingDays} أيام.

تفاصيل الوثيقة:

• اسم الموظف: ${a.employeeName}
• نوع الوثيقة: ${a.documentTypeLabel}
• تاريخ الانتهاء: ${fmtDate(a.expiryDate)}
• المدة المتبقية: ${a.remainingDays} أيام

يرجى اتخاذ الإجراءات اللازمة قبل تاريخ الانتهاء.

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

ستنتهي ${a.documentTypeLabel}

بعد ${a.remainingDays} أيام.

تفاصيل الوثيقة:

• نوع الوثيقة: ${a.documentTypeLabel}
• تاريخ الانتهاء: ${fmtDate(a.expiryDate)}
• المدة المتبقية: ${a.remainingDays} أيام

يرجى البدء بإجراءات التجديد.

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
