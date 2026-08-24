const { arabicDate } = require("./period");

/* ─── The covering email ───

   The body carries a real executive summary so the recipient learns the
   headline without opening the attachment, phrased as prose rather than a dump
   of numbers. Plain text, matching how the platform's existing expiry
   notifications are sent. */

/* Arabic doesn't count by writing "number + noun". One and two are carried by
   the noun's own form (إقامة / إقامتان) with no numeral at all, 3–10 take the
   plural, and 11+ revert to the singular. Callers therefore supply the finished
   phrase for one and two instead of a stem, so nothing here has to infer the
   noun's gender — "إقامة واحدة" vs "عاملٌ واحد" is the caller's business. */
function count(n, f) {
  if (n === 1) return f.one;
  if (n === 2) return f.two;
  if (n >= 3 && n <= 10) return `${n} ${f.few}`;
  return `${n} ${f.many}`;
}

const IQAMA = { one: "إقامة واحدة", two: "إقامتين", few: "إقامات", many: "إقامة" };
const LICENCE = { one: "رخصة عمل واحدة", two: "رخصتي عمل", few: "رخص عمل", many: "رخصة عمل" };
const IQAMA_EXPIRED = { one: "إقامة منتهية", two: "إقامتين منتهيتين", few: "إقامات منتهية", many: "إقامة منتهية" };
const LICENCE_EXPIRED = { one: "رخصة عمل منتهية", two: "رخصتي عمل منتهيتين", few: "رخص عمل منتهية", many: "رخصة عمل منتهية" };
/* تصريح is masculine, unlike the other three — which is exactly why the caller
   supplies the finished phrase instead of a stem. */
const PERMIT = { one: "تصريح أجير واحد", two: "تصريحي أجير", few: "تصاريح أجير", many: "تصريح أجير" };
const PERMIT_EXPIRED = { one: "تصريح منتهٍ", two: "تصريحين منتهيين", few: "تصاريح منتهية", many: "تصريحًا منتهيًا" };
const TICKETS = { one: "تذكرة واحدة", two: "تذكرتين", few: "تذاكر", many: "تذكرة" };
const OVERDUE = { one: "تذكرة متأخرة", two: "تذكرتين متأخرتين", few: "تذاكر متأخرة", many: "تذكرة متأخرة" };

const subjectFor = (period) => `التقرير الشهري لحالة عمالة أجير – ${period.label}`;

function bodyFor(data) {
  const d = data;
  const p = d.period;
  const lines = [];

  lines.push("السلام عليكم ورحمة الله وبركاته،");
  lines.push("");
  lines.push(`مرفق التقرير الشهري لحالة عمالة أجير عن شهر ${p.label} (من ${arabicDate(p.start)} إلى ${arabicDate(p.end)}).`);
  lines.push("");

  /* what happened during the month */
  const renewals = [];
  if (d.iqamaRenewals.length) renewals.push(count(d.iqamaRenewals.length, IQAMA));
  if (d.licenceRenewals.length) renewals.push(count(d.licenceRenewals.length, LICENCE));
  if (d.permitRenewals.length) renewals.push(count(d.permitRenewals.length, PERMIT));
  const activity = renewals.length
    ? `خلال الشهر تم تجديد ${renewals.join(" و")}.`
    : d.historyCoversPeriod
      ? "لم يُسجَّل تجديد لأي إقامة أو رخصة عمل خلال الشهر."
      : "لا يتوفر سجل تجديدات لهذه الفترة، حيث بدأ تسجيل تغييرات التواريخ بعد بدايتها.";
  lines.push(activity);

  /* what needs attention next */
  const due30 = d.upcoming.filter((u) => u.band === 30);
  const iq30 = due30.filter((u) => u.kind === "الإقامة").length;
  const lic30 = due30.filter((u) => u.kind === "رخصة العمل").length;
  const per30 = due30.filter((u) => u.kind === "تصريح أجير").length;
  if (due30.length) {
    const parts = [];
    if (iq30) parts.push(count(iq30, IQAMA));
    if (lic30) parts.push(count(lic30, LICENCE));
    if (per30) parts.push(count(per30, PERMIT));
    lines.push(`ويوجد حاليًا ${parts.join(" و")} تستلزم المتابعة خلال الثلاثين يومًا القادمة.`);
  } else {
    lines.push("ولا توجد استحقاقات تستلزم المتابعة خلال الثلاثين يومًا القادمة.");
  }

  if (d.iqama.expired || d.licence.expired || d.permits.expired) {
    const parts = [];
    if (d.iqama.expired) parts.push(count(d.iqama.expired, IQAMA_EXPIRED));
    if (d.licence.expired) parts.push(count(d.licence.expired, LICENCE_EXPIRED));
    if (d.permits.expired) parts.push(count(d.permits.expired, PERMIT_EXPIRED));
    lines.push(`كما يوجد ${parts.join(" و")} تتطلب معالجة عاجلة.`);
  }

  /* Tickets: two sentences — the standing position, then the month's movement.
     A month with no ticket activity says so in words; "تم فتح 0 وإغلاق 0" is
     not something a person would write. */
  const t = d.tickets;
  if (t.openNow) {
    let openLine = `وبلغ عدد التذاكر المفتوحة حاليًا مع شركة ضمان الأعمال ${count(t.openNow, TICKETS)}`;
    if (t.overdueNow) openLine += `، منها ${count(t.overdueNow, OVERDUE)} تجاوزت موعد المتابعة`;
    lines.push(openLine + ".");
  } else {
    lines.push("ولا توجد تذاكر مفتوحة حاليًا مع شركة ضمان الأعمال.");
  }
  const opened = t.openedInMonth ? `فتح ${count(t.openedInMonth, TICKETS)}` : null;
  const closed = t.closedInMonth ? `إغلاق ${count(t.closedInMonth, TICKETS)}` : null;
  if (!opened && !closed) {
    lines.push("ولم تُفتح أو تُغلق أي تذكرة خلال الشهر.");
  } else {
    let movement = `وخلال الشهر تم ${[opened, closed].filter(Boolean).join(" و")}`;
    if (t.avgCloseDays !== null) movement += `، بمتوسط مدة إغلاق ${t.avgCloseDays} يوم`;
    lines.push(movement + ".");
  }

  lines.push("");
  lines.push("التفاصيل الكاملة موضحة في التقرير المرفق.");
  lines.push("");
  lines.push("مع التحية،");
  lines.push("منصة ذروة لمتابعة عمالة أجير");
  lines.push("شركة ذروة الصعود للتجارة");
  lines.push("");
  lines.push("— هذه رسالة آلية، لا حاجة للرد عليها.");

  return lines.join("\n");
}

module.exports = { subjectFor, bodyFor };
