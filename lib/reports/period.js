/* ─── Reporting periods in Saudi local time ───

   The platform's day boundaries are Asia/Riyadh (UTC+3, no DST). Deriving month
   bounds from UTC would pull the last evening of a month into the next one and
   push the first hours of a month back into the previous — exactly the
   off-by-one that would misfile a renewal recorded late on the 31st.

   Everything here works in whole local days: a period is [start, end] inclusive
   as YYYY-MM-DD, and comparisons against timestamps use the UTC instants that
   correspond to local midnight. */

const RIYADH_OFFSET_HOURS = 3;
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

const pad = (n) => String(n).padStart(2, "0");

/* Today's calendar date in Riyadh, as {year, month, day}. */
function riyadhToday(now = new Date()) {
  const shifted = new Date(now.getTime() + RIYADH_OFFSET_HOURS * 3600000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/* The month before the one containing `now` — December of the previous year when
   run in January. */
function previousMonthOf(now = new Date()) {
  const { year, month } = riyadhToday(now);
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/* Full descriptor for a reporting month. */
function periodFor(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!(y >= 2000 && y <= 2200) || !(m >= 1 && m <= 12)) throw new Error("شهر أو سنة غير صالحة");
  const last = daysInMonth(y, m);
  const start = `${y}-${pad(m)}-01`;
  const end = `${y}-${pad(m)}-${pad(last)}`;
  return {
    year: y,
    month: m,
    start,
    end,
    label: `${AR_MONTHS[m - 1]} ${y}`,
    /* UTC instants for local midnight at each edge; endExclusive is the first
       instant of the following month, so timestamp filters are [start, endEx). */
    startUtc: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - RIYADH_OFFSET_HOURS * 3600000),
    endExclusiveUtc: new Date(Date.UTC(y, m, 1, 0, 0, 0) - RIYADH_OFFSET_HOURS * 3600000),
  };
}

const previousMonthPeriod = (now = new Date()) => {
  const { year, month } = previousMonthOf(now);
  return periodFor(year, month);
};

/* Local calendar date as YYYY-MM-DD, used for "days remaining" maths. */
function riyadhDateString(now = new Date()) {
  const t = riyadhToday(now);
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

/* Whole days from today (Riyadh) to an ISO date; negative means past. */
function daysUntil(iso, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return null;
  const a = Date.parse(`${riyadhDateString(now)}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

const arabicDate = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${AR_MONTHS[m - 1]} ${y}`;
};

module.exports = {
  AR_MONTHS, RIYADH_OFFSET_HOURS,
  riyadhToday, riyadhDateString, previousMonthOf, previousMonthPeriod,
  periodFor, daysInMonth, daysUntil, arabicDate,
};
