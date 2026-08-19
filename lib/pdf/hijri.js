/* ─── Umm al-Qura ⇄ Gregorian conversion ───

   Uses the `islamic-umalqura` calendar built into Node's ICU as the ONLY source
   of truth. The inverse (Hijri → Gregorian) is a binary search over Gregorian
   days, which is exact because the mapping is strictly monotonic — deliberately
   not an arithmetic approximation, since those drift by a day or more against
   the official Umm al-Qura tables and a one-day error changes an expiry status.

   Verified against known references (1 Muharram 1444/1445/1446/1447) and
   against live employee records where the Hijri and Gregorian expiry were both
   already known. */

const DAY = 86400000;

const HIJRI_FMT = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "UTC",
});

/* Guard: if a build of Node ever ships without full ICU, islamic-umalqura won't
   resolve and every conversion must refuse rather than silently fall back to
   some other calendar. */
const UMALQURA_AVAILABLE = HIJRI_FMT.resolvedOptions().calendar === "islamic-umalqura";

function hijriPartsOf(ms) {
  const p = HIJRI_FMT.formatToParts(new Date(ms)).reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  return { y: parseInt(String(p.year).replace(/[^0-9]/g, ""), 10), m: +p.month, d: +p.day };
}

const cmp = (a, b) => a.y - b.y || a.m - b.m || a.d - b.d;

/* "YYYY-MM-DD" Gregorian for the given Hijri date, or null if it doesn't exist
   in the Umm al-Qura calendar (e.g. day 30 of a 29-day month). */
function hijriToGregorian(hy, hm, hd) {
  if (!UMALQURA_AVAILABLE) return null;
  if (!(hy >= 1300 && hy <= 1600) || hm < 1 || hm > 12 || hd < 1 || hd > 30) return null;
  const target = { y: hy, m: hm, d: hd };
  let lo = Date.UTC(1880, 0, 1);
  let hi = Date.UTC(2200, 0, 1);
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / (2 * DAY)) * DAY;
    const c = cmp(hijriPartsOf(mid), target);
    if (c === 0) {
      // land on the first Gregorian day that maps to this Hijri day
      let m = mid;
      while (cmp(hijriPartsOf(m - DAY), target) === 0) m -= DAY;
      return new Date(m).toISOString().slice(0, 10);
    }
    if (c < 0) lo = mid + DAY;
    else hi = mid - DAY;
  }
  return null;
}

/* "YYYY-MM-DD" Hijri for a Gregorian date — used to record the Hijri form when
   a document only gave a Gregorian one. */
function gregorianToHijri(iso) {
  if (!UMALQURA_AVAILABLE) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const p = hijriPartsOf(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

module.exports = { hijriToGregorian, gregorianToHijri, UMALQURA_AVAILABLE };
