const fs = require("fs");
const path = require("path");
const { arLine, arBlock } = require("./arabicText");
const { arabicDate } = require("./period");

/* ─── Monthly report PDF ───

   The approved formal layout: restrained palette with colour on figures only,
   one section-heading treatment, defined table header bands with hairline row
   separators and no vertical rules, larger figures with quiet captions, and a
   formal footer line.

   All Arabic goes through ./arabicText — reversed word order, per-word
   fragments so inter-word spaces keep full width, direction-run splitting
   inside words, punctuation mirroring, and line breaking measured against the
   same font pdfmake uses. Do not pass raw strings to pdfmake here.

   pdfmake is required lazily so pages that never build a report don't pay for
   loading it. */

const FONT_DIR = path.join(__dirname, "..", "..", "assets", "fonts");
const FILES = {
  sans: { normal: path.join(FONT_DIR, "thmanyah-sans-400.ttf"), bold: path.join(FONT_DIR, "thmanyah-sans-700.ttf") },
  serif: { normal: path.join(FONT_DIR, "thmanyah-serif-display-700.ttf"), bold: path.join(FONT_DIR, "thmanyah-serif-display-700.ttf") },
};

const C = {
  ink: "#1A1917", soft: "#6B665C", faint: "#8C877C",
  slate: "#16283B", brass: "#A98544",
  rule: "#DAD4C7", ruleLight: "#EAE5DA", band: "#F3F0E9",
  ok: "#1F6E4E", bad: "#A6382C", warn: "#8A5E11",
};
const PAGE_W = 515;
const CELL_PAD = 5;
const FOOTER_LINE = "شركة ذروة الصعود للتجارة | تقرير آلي | منصة ذروة لمتابعة عمالة أجير";

const STATUS_AR = {
  open: "مفتوحة", awaiting_counterparty: "بانتظار ضمان الأعمال", awaiting_us: "بانتظارنا",
  in_progress: "قيد المعالجة", completed: "مكتملة", cancelled: "ملغاة",
};
const PRIORITY_AR = { normal: "عادية", medium: "متوسطة", high: "عالية", urgent: "عاجلة" };

const L = (t, style = {}) => ({ text: arLine(t), alignment: "right", ...style });

/* A day count in correct Arabic: one and two are carried by the word itself,
   3–10 take the plural, 11+ revert to the singular accusative. "1 أيام" would
   be wrong in every one of those cases. */
function days(n) {
  if (n === 1) return "يوم واحد";
  if (n === 2) return "يومان";
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يومًا`;
}

const section = (title) => ({
  unbreakable: true,
  stack: [
    { text: arLine(title), font: "ThmanyahSerif", fontSize: 12.5, color: C.slate, alignment: "right", margin: [0, 0, 0, 4] },
    { canvas: [{ type: "line", x1: 0, y1: 0, x2: PAGE_W, y2: 0, lineWidth: 0.7, lineColor: C.rule }] },
  ],
  margin: [0, 13, 0, 8],
});

function figure(n, label, tone) {
  const fg = tone === "bad" ? C.bad : tone === "warn" ? C.warn : tone === "ok" ? C.ok : C.slate;
  return {
    table: { widths: ["*"], body: [[{
      stack: [
        { text: String(n), fontSize: 23, bold: true, color: fg, alignment: "center", margin: [0, 3, 0, 0] },
        { ...arBlock(label, { available: 104, fontSize: 7.2, fonts: FILES.sans }), alignment: "center", color: C.faint, margin: [0, 1, 0, 3] },
      ],
    }]] },
    layout: { hLineWidth: () => 0.7, vLineWidth: () => 0.7, hLineColor: () => C.ruleLight, vLineColor: () => C.ruleLight },
  };
}
const figureRow = (items, top = 0) => ({ columns: items, columnGap: 7, margin: [0, top, 0, 0] });

const rtlRow = (cells) => [...cells].reverse();
/* pdfmake's `widths` are content widths and padding is added on top, so the
   budget must exclude padding for every column or the table overflows and the
   flexible column collapses. */
function resolveWidths(widths, total = PAGE_W) {
  const budget = total - widths.length * CELL_PAD * 2;
  const fixed = widths.filter((w) => typeof w === "number").reduce((a, b) => a + b, 0);
  const stars = widths.filter((w) => w === "*").length;
  const each = stars ? Math.max(40, (budget - fixed) / stars) : 0;
  return widths.map((w) => (w === "*" ? each : w));
}
function table(headers, rows, widths, { muted = [] } = {}) {
  const resolved = resolveWidths(widths);
  const head = headers.map((h, i) => ({
    ...arBlock(h, { available: resolved[i], fontSize: 8.4, bold: true, fonts: FILES.sans }),
    color: C.slate, fillColor: C.band,
  }));
  const body = rows.map((r) => r.map((c, i) => ({
    ...arBlock(c, { available: resolved[i], fontSize: 8.8, fonts: FILES.sans }),
    color: muted.includes(i) ? C.soft : C.ink,
  })));
  return {
    table: { headerRows: 1, dontBreakRows: true, widths: [...resolved].reverse(), body: [rtlRow(head), ...body.map(rtlRow)] },
    layout: {
      hLineWidth: (i, node) => (i === 0 ? 0.7 : i === 1 ? 0.9 : i === node.table.body.length ? 0.7 : 0.4),
      vLineWidth: () => 0,
      hLineColor: (i) => (i === 1 ? C.slate : i === 0 ? C.rule : C.ruleLight),
      paddingTop: () => 4.5, paddingBottom: () => 4.5, paddingLeft: () => CELL_PAD, paddingRight: () => CELL_PAD,
    },
    margin: [0, 0, 0, 2],
  };
}
const note = (t) => L(t, { fontSize: 8.4, color: C.soft, margin: [0, 0, 0, 5] });
const emptyRow = (msg) => L(msg, { fontSize: 8.6, color: C.faint, margin: [0, 2, 0, 6] });

const RENEW_W = [56, "*", 66, 62, 62, 60];
const UPCOMING_W = [56, "*", 66, 58, 58, 44, 40];
const TICKET_W = [74, "*", 76, 84, 42, 60];
/* Eight columns is the tightest table in the report: the permit pair and both
   expiry dates all have to be shown side by side. Everything except the name is
   fixed, and the name takes what is left — wrapping to a second line the way
   the dates already do elsewhere.

   The iqama column is deliberately generous. A 10-digit number is a single
   token with nothing to break on, so a column even slightly too narrow makes
   pdfmake split the identifier itself across two lines ("258435816" / "8") —
   which is not a cosmetic problem, it is an unreadable number. Dates may wrap;
   identifiers may not. */
const PERMIT_W = [30, "*", 60, 50, 50, 54, 54, 52];

function buildDocDefinition(d) {
  const p = d.period;
  const content = [];

  content.push(
    { text: arLine("التقرير الشهري لحالة عمالة أجير"), font: "ThmanyahSerif", fontSize: 19, color: C.slate, alignment: "right", margin: [0, 2, 0, 1] },
    { text: arLine(p.label), font: "ThmanyahSerif", fontSize: 13, color: C.brass, alignment: "right", margin: [0, 0, 0, 5] },
    {
      columns: [
        { text: arLine(`تاريخ إنشاء التقرير: ${arabicDate(d.generatedAtIso)}`), fontSize: 8.2, color: C.soft, alignment: "left" },
        { text: arLine(`فترة التقرير: من ${arabicDate(p.start)} إلى ${arabicDate(p.end)}`), fontSize: 8.2, color: C.soft, alignment: "right" },
      ],
    }
  );

  /* ── executive summary ── */
  content.push(section("الملخص التنفيذي"));
  content.push(figureRow([
    figure(d.totals.employees, "إجمالي موظفي أجير"),
    figure(d.iqama.valid, "إقامات سارية"),
    figure(d.iqama.soon, "إقامات قريبة الانتهاء", d.iqama.soon ? "warn" : null),
    figure(d.iqama.expired, "إقامات منتهية", d.iqama.expired ? "bad" : null),
  ]));
  content.push(figureRow([
    figure(d.licence.valid, "رخص عمل سارية"),
    figure(d.licence.soon, "رخص قريبة الانتهاء", d.licence.soon ? "warn" : null),
    figure(d.licence.expired, "رخص منتهية", d.licence.expired ? "bad" : null),
    figure(d.iqamaRenewals.length, "إقامات جُدّدت خلال الشهر", d.iqamaRenewals.length ? "ok" : null),
  ], 7));
  content.push(figureRow([
    figure(d.licenceRenewals.length, "رخص جُدّدت خلال الشهر", d.licenceRenewals.length ? "ok" : null),
    figure(d.tickets.openedInMonth, "تذاكر فُتحت"),
    figure(d.tickets.closedInMonth, "تذاكر أُغلقت"),
    figure(d.tickets.overdueNow, "تذاكر متأخرة", d.tickets.overdueNow ? "bad" : null),
  ], 7));
  /* Ajeer permits get the same four-figure treatment as iqamas and licences —
     they run monthly, so they move more than either. */
  content.push(figureRow([
    figure(d.permits.valid, "تصاريح أجير سارية"),
    figure(d.permits.soon, "تصاريح قريبة الانتهاء", d.permits.soon ? "warn" : null),
    figure(d.permits.expired, "تصاريح منتهية", d.permits.expired ? "bad" : null),
    figure(d.permitRenewals.length, "تصاريح جُدّدت خلال الشهر", d.permitRenewals.length ? "ok" : null),
  ], 7));

  /* ── renewals ── */
  const renewCols = ["الرقم الوظيفي", "اسم الموظف", "رقم الإقامة", "الانتهاء السابق", "الانتهاء الجديد", "تاريخ التسجيل"];
  /* recordedAt already arrives as a Riyadh-local YYYY-MM-DD from reportData —
     it must not be re-derived from a Date here, which is what silently printed
     "—" in place of every registration date. */
  const renewRow = (r) => [r.eid, r.name, r.iqama, arabicDate(r.previous), arabicDate(r.next), arabicDate(r.recordedAt)];

  content.push(section("الإقامات التي تم تجديدها خلال الشهر"));
  content.push(note(`عدد الإقامات المجدّدة: ${d.iqamaRenewals.length}`));
  if (d.iqamaRenewals.length) content.push(table(renewCols, d.iqamaRenewals.map(renewRow), RENEW_W, { muted: [3, 5] }));
  else content.push(emptyRow(d.historyCoversPeriod
    ? "لا توجد إقامات تم تجديدها خلال هذه الفترة."
    : "لا يوجد سجل تغييرات لهذه الفترة — بدأ تسجيل تغييرات التواريخ بعد بدايتها."));

  content.push(section("رخص العمل التي تم تجديدها خلال الشهر"));
  content.push(note(`عدد الرخص المجدّدة: ${d.licenceRenewals.length}`));
  if (d.licenceRenewals.length) content.push(table(renewCols, d.licenceRenewals.map(renewRow), RENEW_W, { muted: [3, 5] }));
  else content.push(emptyRow(d.historyCoversPeriod
    ? "لا توجد رخص عمل تم تجديدها خلال هذه الفترة."
    : "لا يوجد سجل تغييرات لهذه الفترة — بدأ تسجيل تغييرات التواريخ بعد بدايتها."));

  /* ── Ajeer permit renewals ── */
  content.push(section("تصاريح أجير التي تم تجديدها خلال الشهر"));
  content.push(note(`عدد التصاريح المجدّدة: ${d.permitRenewals.length}`));
  if (d.permitRenewals.length) {
    content.push(table(
      ["الرقم الوظيفي", "اسم الموظف", "رقم الإقامة", "التصريح السابق", "التصريح الجديد", "الانتهاء السابق", "الانتهاء الجديد", "تاريخ التسجيل"],
      d.permitRenewals.map((r) => [
        r.eid || "—", r.name, r.iqama, r.previousPermit, r.permit,
        arabicDate(r.previous), arabicDate(r.next), arabicDate(r.recordedAt),
      ]),
      PERMIT_W, { muted: [5, 7] }
    ));
  } else {
    content.push(emptyRow("لا توجد تصاريح أجير تم تجديدها خلال هذه الفترة."));
  }

  /* ── upcoming dues ── */
  content.push(section("الاستحقاقات القادمة"));
  content.push(note("تشمل الإقامة ورخصة العمل وتصريح أجير. كل حالة تظهر في الفئة الأقرب فقط، فلا تتكرر بين 30 و60 و90 يومًا."));
  if (d.upcoming.length) {
    content.push(table(
      ["الرقم الوظيفي", "اسم الموظف", "رقم الإقامة", "نوع المستند", "تاريخ الانتهاء", "المتبقي", "الفئة"],
      d.upcoming.map((u) => [u.eid, u.name, u.iqama, u.kind, arabicDate(u.expiry), days(u.daysLeft), `${u.band} يومًا`]),
      UPCOMING_W, { muted: [6] }
    ));
  } else content.push(emptyRow("لا توجد استحقاقات خلال التسعين يومًا القادمة."));

  /* ── tickets ── */
  content.push(section("ملخص التذاكر والمتابعات"));
  content.push(figureRow([
    figure(d.tickets.openedInMonth, "فُتحت خلال الشهر"),
    figure(d.tickets.closedInMonth, "أُغلقت خلال الشهر"),
    figure(d.tickets.cancelledInMonth, "ملغاة"),
    figure(d.tickets.openNow, "مفتوحة حاليًا"),
  ]));
  content.push(figureRow([
    figure(d.tickets.awaitingCounterparty, "بانتظار ضمان الأعمال", d.tickets.awaitingCounterparty ? "warn" : null),
    figure(d.tickets.awaitingUs, "بانتظارنا"),
    figure(d.tickets.overdueNow, "متأخرة حاليًا", d.tickets.overdueNow ? "bad" : null),
    figure(d.tickets.completedInMonth, "مكتملة خلال الشهر", d.tickets.completedInMonth ? "ok" : null),
  ], 7));
  if (d.tickets.avgCloseDays !== null) {
    content.push(L(`متوسط مدة إغلاق التذكرة خلال الشهر: ${d.tickets.avgCloseDays} يوم`, { fontSize: 8.4, color: C.soft, margin: [0, 7, 0, 9] }));
  }

  if (d.tickets.needingAttention.length) {
    content.push(L("حالات تحتاج تدخلًا حاليًا", { fontSize: 10, bold: true, color: C.slate, margin: [0, 0, 0, 5] }));
    content.push(table(
      ["رقم التذكرة", "العنوان", "الموظف", "الحالة", "الأولوية", "المتابعة"],
      d.tickets.needingAttention.map((t) => [
        t.ticketNo, t.title || "—", t.employeeEid || "—",
        STATUS_AR[t.status] || t.status, PRIORITY_AR[t.priority] || t.priority,
        t.overdueDays ? `متأخرة ${days(t.overdueDays)}` : t.dueInDays === 0 ? "متابعة اليوم" : t.dueInDays !== null ? `بعد ${days(t.dueInDays)}` : "—",
      ]),
      TICKET_W, { muted: [2] }
    ));
  }

  /* ── month-on-month, only when the history genuinely covers both months ── */
  if (d.comparison) {
    content.push(section("مقارنة بالشهر السابق"));
    content.push(table(
      ["البند", `${p.label}`, `${d.comparison.label}`],
      [
        ["إقامات مجدّدة", String(d.iqamaRenewals.length), String(d.comparison.iqamaRenewals)],
        ["رخص عمل مجدّدة", String(d.licenceRenewals.length), String(d.comparison.licenceRenewals)],
        /* Only when the permit journal reaches back that far; "—" says so
           rather than implying last month had none. */
        ["تصاريح أجير مجدّدة", String(d.permitRenewals.length),
          d.comparison.permitRenewals === null ? "—" : String(d.comparison.permitRenewals)],
        ["تذاكر أُغلقت", String(d.tickets.closedInMonth), String(d.comparison.ticketsClosed)],
      ],
      ["*", 110, 110]
    ));
  }

  if (!d.historyCoversPeriod) {
    content.push(L("ملاحظة: تسجيل تغييرات تواريخ الإقامات ورخص العمل بدأ حديثًا، لذلك قد لا تظهر تجديدات لفترات سابقة لبدء التسجيل.",
      { fontSize: 7.8, color: C.faint, margin: [0, 14, 0, 0] }));
  }
  content.push({ text: arLine("انتهى التقرير"), fontSize: 8, color: C.faint, alignment: "center", margin: [0, 16, 0, 0] });

  return {
    pageSize: "A4",
    pageMargins: [40, 78, 40, 46],
    defaultStyle: { font: "Thmanyah", fontSize: 9.5, color: C.ink, alignment: "right" },
    info: { title: `التقرير الشهري لحالة عمالة أجير — ${p.label}`, author: "شركة ذروة الصعود للتجارة" },
    header: () => ({
      margin: [40, 24, 40, 0],
      stack: [
        {
          columns: [
            { text: arLine("منصة ذروة لمتابعة عمالة أجير"), fontSize: 7.6, color: C.faint, alignment: "left", width: "*" },
            { text: arLine("شركة ذروة الصعود للتجارة"), font: "ThmanyahSerif", fontSize: 11.5, color: C.slate, alignment: "right", width: "auto" },
          ],
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: PAGE_W, y2: 0, lineWidth: 1.1, lineColor: C.slate }], margin: [0, 6, 0, 0] },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: PAGE_W, y2: 0, lineWidth: 0.5, lineColor: C.brass }], margin: [0, 1.4, 0, 0] },
      ],
    }),
    footer: (page, total) => ({
      margin: [40, 8, 40, 0],
      stack: [
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: PAGE_W, y2: 0, lineWidth: 0.5, lineColor: C.ruleLight }], margin: [0, 0, 0, 5] },
        {
          columns: [
            { text: arLine(`صفحة ${page} من ${total}`), fontSize: 7.4, color: C.faint, alignment: "left", width: "auto" },
            { text: arLine(FOOTER_LINE), fontSize: 7.4, color: C.faint, alignment: "right", width: "*" },
          ],
        },
      ],
    }),
    content,
  };
}

/* Renders to a Buffer. */
function renderPdf(data) {
  const PdfPrinter = require("pdfmake/src/printer");
  const printer = new PdfPrinter({ Thmanyah: FILES.sans, ThmanyahSerif: FILES.serif });
  const pdf = printer.createPdfKitDocument(buildDocDefinition(data));
  return new Promise((resolve, reject) => {
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.end();
  });
}

/* Stable, descriptive filename: التقرير-الشهري-أجير-2026-08.pdf */
const pdfFileName = (period) => `التقرير-الشهري-أجير-${period.year}-${String(period.month).padStart(2, "0")}.pdf`;

module.exports = { renderPdf, pdfFileName, buildDocDefinition, FONT_DIR };
