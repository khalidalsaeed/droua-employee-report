/* Shared ticket vocabulary and presentation helpers.

   Loaded by tickets-shell.html, ticket-detail-shell.html and the dashboard
   widget in app-shell.html, so the Arabic labels, badge colours and the
   "overdue" rule exist in exactly one place. The server validates the keys;
   the labels live here because they are purely presentational.

   Depends on admin-ui.css for the badge classes. */
const TicketsUI = (function () {
  const TYPES = {
    issue_permit: "إصدار تصريح أجير",
    renew_permit: "تجديد تصريح أجير",
    renew_iqama: "تجديد إقامة",
    renew_work_license: "تجديد رخصة عمل",
    edit_data: "تعديل بيانات",
    request_document: "طلب مستند",
    replace_worker: "استبدال عامل",
    objection: "اعتراض / مشكلة",
    other: "أخرى",
  };

  /* cls maps onto the .tk-badge modifiers in admin-ui.css, which reuse the
     page's own --ok/--warn/--bad/--brass tokens so tickets match the identity. */
  const STATUSES = {
    open: { label: "مفتوحة", cls: "open" },
    awaiting_counterparty: { label: "بانتظار ضمان الأعمال", cls: "waiting-them" },
    awaiting_us: { label: "بانتظارنا", cls: "waiting-us" },
    in_progress: { label: "قيد المعالجة", cls: "progress" },
    completed: { label: "مكتملة", cls: "done" },
    cancelled: { label: "ملغاة", cls: "cancelled" },
  };

  const PRIORITIES = {
    normal: { label: "عادية", cls: "p-normal" },
    medium: { label: "متوسطة", cls: "p-medium" },
    high: { label: "عالية", cls: "p-high" },
    urgent: { label: "عاجلة", cls: "p-urgent" },
  };

  const CLOSED = ["completed", "cancelled"];

  const EVENT_LABELS = {
    created: "تم إنشاء التذكرة",
    status_changed: "تم تغيير الحالة",
    priority_changed: "تم تغيير الأولوية",
    assignee_changed: "تم تغيير المسؤول",
    followup: "تمت إضافة متابعة",
    follow_up_date_changed: "تم تعديل موعد المتابعة القادمة",
    edited: "تم تعديل التذكرة",
    closed: "تم إغلاق التذكرة",
    reopened: "تم إعادة فتح التذكرة",
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const typeLabel = (k) => TYPES[k] || k || "—";
  const statusOf = (k) => STATUSES[k] || { label: k || "—", cls: "open" };
  const priorityOf = (k) => PRIORITIES[k] || { label: k || "—", cls: "p-normal" };
  const isClosed = (t) => CLOSED.includes(t.status);

  /* Local midnight, so "today" means the user's today rather than UTC's. */
  function todayMidnight() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function dayDiff(iso) {
    if (!iso) return null;
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return null;
    d.setHours(0, 0, 0, 0);
    return Math.round((d - todayMidnight()) / 86400000);
  }
  /* A ticket is overdue when its next follow-up date has passed and it is still
     active. Derived every time it is displayed — never stored, so it cannot go
     stale the way a cached flag would. */
  function overdueDays(t) {
    if (isClosed(t) || !t.followUpDate) return 0;
    const diff = dayDiff(t.followUpDate);
    return diff !== null && diff < 0 ? Math.abs(diff) : 0;
  }
  const isOverdue = (t) => overdueDays(t) > 0;
  const isDueToday = (t) => !isClosed(t) && t.followUpDate && dayDiff(t.followUpDate) === 0;

  const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d)) return "—";
    return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  function fmtDateTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d)) return "—";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${hh}:${mm}`;
  }

  const statusBadge = (t) => `<span class="tk-badge ${statusOf(t.status).cls}">${esc(statusOf(t.status).label)}</span>`;
  const priorityBadge = (t) => `<span class="tk-badge ${priorityOf(t.priority).cls}">${esc(priorityOf(t.priority).label)}</span>`;
  function overdueBadge(t) {
    const n = overdueDays(t);
    if (n) return `<span class="tk-badge overdue">متأخرة ${n} ${n === 1 ? "يوم" : n === 2 ? "يومان" : n <= 10 ? "أيام" : "يومًا"}</span>`;
    if (isDueToday(t)) return `<span class="tk-badge due-today">متابعة اليوم</span>`;
    return "";
  }

  /* Ordering for anything that shows "tickets needing attention": overdue
     first, then urgency, then due-today, then the rest by soonest follow-up. */
  function attentionRank(t) {
    if (isOverdue(t)) return 0;
    if (t.priority === "urgent") return 1;
    if (isDueToday(t)) return 2;
    return 3;
  }
  function byAttention(a, b) {
    const r = attentionRank(a) - attentionRank(b);
    if (r) return r;
    const ao = overdueDays(a), bo = overdueDays(b);
    if (ao !== bo) return bo - ao;
    const ad = a.followUpDate || "9999-12-31", bd = b.followUpDate || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return Number(b.id) - Number(a.id);
  }

  /* The five figures shown on both the tickets page and the dashboard widget. */
  function summarize(items) {
    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return {
      open: items.filter((t) => !isClosed(t)).length,
      awaitingCounterparty: items.filter((t) => t.status === "awaiting_counterparty").length,
      awaitingUs: items.filter((t) => t.status === "awaiting_us").length,
      overdue: items.filter(isOverdue).length,
      completedThisMonth: items.filter((t) => t.status === "completed" && t.closedAt && String(t.closedAt).startsWith(monthPrefix)).length,
    };
  }

  const typeOptions = (selected) =>
    Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(v)}</option>`).join("");
  const statusOptions = (selected) =>
    Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(v.label)}</option>`).join("");
  const priorityOptions = (selected) =>
    Object.entries(PRIORITIES).map(([k, v]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(v.label)}</option>`).join("");

  return {
    TYPES, STATUSES, PRIORITIES, CLOSED, EVENT_LABELS,
    esc, typeLabel, statusOf, priorityOf, isClosed,
    overdueDays, isOverdue, isDueToday, dayDiff,
    fmtDate, fmtDateTime,
    statusBadge, priorityBadge, overdueBadge,
    byAttention, attentionRank, summarize,
    typeOptions, statusOptions, priorityOptions,
  };
})();
