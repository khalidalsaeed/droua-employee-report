const { hijriToGregorian } = require("../pdf/hijri");
const { extractQrTextFromPdf } = require("../pdf/qrFromPdf");

/* ─── قراءة تقرير الإجازة المرضية من ملفّ PDF، على الخادم وفي الذاكرة ───
   =========================================================================
   طبقة النصّ في الملفّ أوّلًا (pdfjs، اعتمادية قائمة) — لا OCR، ولا خدمة
   خارجية، ولا ذكاء اصطناعي. ملفّ بلا طبقة نصّ (ممسوح ضوئيًا) أو صورة لا
   يُخمَّن محتواه: يُعاد needs_manual فيُدخل المستخدم الحقول بنفسه.

   تقرير «صحة» جدولٌ من ثلاثة أعمدة في كل سطر: العنوان الإنجليزي، القيمة،
   العنوان العربي. فالقيمة هي ما يبقى في السطر بعد حذف العناوين. والعنوان
   الإنجليزي هو المرجع لأن طبقة النصّ العربي في ملفّات PDF كثيرًا ما تأتي
   بترتيب حروف مقلوب أو كلمات ملتصقة.

   لا تخمين على المفاتيح الحاسمة: رقم إجازة أو هوية يظهر بقيمتين مختلفتين
   يُترك فارغًا مع تحذير، ولا يُختار أحدهما. */

const LIMITS = {
  maxPages: 4,           // تقرير الإجازة صفحة أو صفحتان
  rejectAbovePages: 10,  // أكثر من هذا ليس تقرير إجازة — يُرفض قبل القراءة
  maxItems: 5000,
  maxField: 120,
  timeoutMs: 8000,
  lineTolerance: 3,
};

const LEAVE_ID_RE = /\b((?:GSL|PSL|SL)\d{6,16})\b/gi;
const ID_RE = /(?<!\d)([12]\d{9})(?!\d)/g;

/* العناوين الإنجليزية — مطابقة كاملة للعنصر بعد تطبيعه. */
const EN_LABELS = [
  { key: "leaveId", re: /^(leave\s*(id|no\.?|number|code)|service\s*code|sick\s*leave\s*(id|no\.?|number))\s*:?$/i },
  { key: "duration", re: /^(leave\s*duration|duration)\s*:?$/i },
  { key: "start", re: /^(admission\s*date|start\s*date|leave\s*start(\s*date)?|from(\s*date)?)\s*:?$/i },
  { key: "end", re: /^(discharge\s*date|end\s*date|leave\s*end(\s*date)?|to(\s*date)?)\s*:?$/i },
  { key: "issueDate", re: /^(issue\s*date|date\s*of\s*issue)\s*:?$/i },
  { key: "name", re: /^((patient|beneficiary)\s*)?name\s*:?$/i },
  { key: "idNumber", re: /^(national\s*id(\s*\/\s*iqama)?|iqama(\s*(no\.?|number))?|id\s*(no\.?|number)|national\s*id\s*\/\s*iqama\s*(no\.?|number)?)\s*:?$/i },
  { key: "nationality", re: /^nationality\s*:?$/i },
  { key: "employer", re: /^(employer|work\s*place|workplace)\s*:?$/i },
  { key: "practitioner", re: /^(practitioner\s*name|physician(\s*name)?|doctor(\s*name)?)\s*:?$/i },
  { key: "position", re: /^(position|practitioner\s*position|speciality|specialty)\s*:?$/i },
  { key: "facility", re: /^(hospital(\s*name)?|facility(\s*name)?|health\s*facility)\s*:?$/i },
];

/* العناوين العربية بصورتها المطبَّعة. تُطابق بلا مسافات وبأي ترتيب للكلمات:
   ملفّات PDF تُخرج «رمز الإجازة» أحيانًا «الإجازةرمز». */
const AR_LABELS = [
  { key: "leaveId", words: ["رمز", "الاجازه"] },
  { key: "leaveId", words: ["رمز", "الخدمه"] },
  { key: "leaveId", words: ["رقم", "الاجازه"] },
  { key: "duration", words: ["مده", "الاجازه"] },
  { key: "start", words: ["تاريخ", "الدخول"] },
  { key: "start", words: ["تاريخ", "البدايه"] },
  { key: "start", words: ["بدايه", "الاجازه"] },
  { key: "end", words: ["تاريخ", "الخروج"] },
  { key: "end", words: ["تاريخ", "النهايه"] },
  { key: "end", words: ["نهايه", "الاجازه"] },
  { key: "issueDate", words: ["تاريخ", "اصدار", "التقرير"] },
  { key: "issueDate", words: ["تاريخ", "الاصدار"] },
  { key: "name", words: ["الاسم"] },
  { key: "name", words: ["اسم", "المستفيد"] },
  { key: "name", words: ["اسم", "المريض"] },
  { key: "idNumber", words: ["رقم", "الهويه", "/", "الاقامه"] },
  { key: "idNumber", words: ["رقم", "الهويه"] },
  { key: "idNumber", words: ["رقم", "الاقامه"] },
  { key: "nationality", words: ["الجنسيه"] },
  { key: "employer", words: ["جهه", "العمل"] },
  { key: "practitioner", words: ["اسم", "الممارس"] },
  { key: "practitioner", words: ["اسم", "الطبيب"] },
  { key: "position", words: ["المسمي", "الوظيفي"] },
  { key: "facility", words: ["اسم", "المنشاه"] },
  { key: "facility", words: ["المنشاه"] },
];

function normalizeArabic(s) {
  return String(s == null ? "" : s)
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
}

const AR_INDEX = AR_LABELS.flatMap((l) => permutations(l.words).map((p) => ({ key: l.key, flat: p.join("") })));

function labelOf(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  for (const l of EN_LABELS) if (l.re.test(t)) return { key: l.key, lang: "en" };
  const flat = normalizeArabic(t).replace(/[\s:：]/g, "");
  if (flat) for (const l of AR_INDEX) if (l.flat === flat) return { key: l.key, lang: "ar" };
  return null;
}

/* ---------- التواريخ ---------- */

const pad = (n) => String(n).padStart(2, "0");

function validGregorian(y, m, d) {
  if (!(y >= 1900 && y <= 2200) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/* يُعيد { iso, calendar } أو null. dd-mm-yyyy هو تنسيق «صحة»؛ yyyy-mm-dd مقبول
   أيضًا. السنة 13xx–15xx هجرية وتُحوَّل بأم القرى. لا تُفسَّر صيغة mm-dd. */
function parseDate(raw) {
  const s = toAsciiDigits(String(raw || "")).trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  let y, mo, d;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else return null;
  if (y >= 1300 && y <= 1600) {
    const iso = hijriToGregorian(y, mo, d);
    return iso ? { iso, calendar: "hijri", hijri: `${y}-${pad(mo)}-${pad(d)}` } : null;
  }
  const iso = validGregorian(y, mo, d);
  return iso ? { iso, calendar: "gregorian" } : null;
}

const DATE_TOKEN_RE = /(\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/g;

function datesIn(text) {
  return (toAsciiDigits(text).match(DATE_TOKEN_RE) || []).map(parseDate).filter(Boolean);
}

function toAsciiDigits(s) {
  return String(s).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0));
}

function daysBetweenInclusive(startIso, endIso) {
  const a = Date.parse(startIso + "T00:00:00Z");
  const b = Date.parse(endIso + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000) + 1;
}

/* ---------- طبقة النصّ ---------- */

class ExtractError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ExtractError("timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function readLines(buf, opts) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,   // لا تنفيذ لشيفرة من محتوى الملفّ
    disableFontFace: true,
    enableXfa: false,
    stopAtErrors: true,       // ملفّ تالف يُرفض لا يُرمَّم تخمينًا
    verbosity: 0,
  });
  const work = (async () => {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      if (err && err.name === "PasswordException") throw new ExtractError("encrypted");
      throw new ExtractError("malformed");
    }
    if (doc.numPages > LIMITS.rejectAbovePages) throw new ExtractError("too_many_pages");
    const items = [];
    const pages = Math.min(doc.numPages, LIMITS.maxPages);
    for (let p = 1; p <= pages; p++) {
      let content;
      try { content = await (await doc.getPage(p)).getTextContent(); } catch { throw new ExtractError("malformed"); }
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        items.push({ page: p, x: it.transform[4], y: it.transform[5], text: it.str.replace(/\s+/g, " ").trim() });
        if (items.length > LIMITS.maxItems) throw new ExtractError("too_complex");
      }
    }
    return items;
  })();
  try {
    return groupLines(await withTimeout(work, (opts && opts.timeoutMs) || LIMITS.timeoutMs));
  } finally {
    try { await task.destroy(); } catch {}
  }
}

function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= LIMITS.lineTolerance) last.items.push(it);
    else lines.push({ page: it.page, y: it.y, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map((i) => i.text).join(" ");
  }
  return lines;
}

/* ---------- الحقول ---------- */

function clip(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, LIMITS.maxField) : null;
}

/* لكل سطر فيه عنوان معروف: { key, value } حيث القيمة ما تبقّى بعد حذف العناوين. */
function labelledValues(lines) {
  const out = [];
  for (const line of lines) {
    const tagged = line.items.map((i) => ({ item: i, label: labelOf(i.text) }));
    const labels = tagged.filter((t) => t.label);
    if (!labels.length) continue;
    const key = (labels.find((t) => t.label.lang === "en") || labels[0]).label.key;
    const value = tagged.filter((t) => !t.label).map((t) => t.item.text).join(" ");
    out.push({ key, value: clip(value), line });
  }
  return out;
}

/* قيمة واحدة لمفتاح حاسم، أو null مع ambiguous إن ظهرت قيمتان مختلفتان. */
function single(values) {
  const uniq = [...new Set(values.filter(Boolean))];
  if (uniq.length === 1) return { value: uniq[0] };
  if (uniq.length > 1) return { value: null, ambiguous: true };
  return { value: null };
}

function parseFields(lines) {
  const fullText = lines.map((l) => l.text).join("\n");
  const labelled = labelledValues(lines);
  const byKey = (k) => labelled.filter((l) => l.key === k).map((l) => l.value).filter(Boolean);
  const warnings = [];

  /* رقم الإجازة: من سطر عنوانه أوّلًا، ثم من النمط في النصّ كاملًا. */
  const fromLabel = byKey("leaveId").map((v) => (v.match(/[A-Z]{2,4}\d{6,16}/i) || [])[0]).filter(Boolean).map((v) => v.toUpperCase());
  const fromText = [...fullText.matchAll(LEAVE_ID_RE)].map((m) => m[1].toUpperCase());
  const leave = single(fromLabel.length ? fromLabel : fromText);
  if (leave.ambiguous) warnings.push("leave_id_ambiguous");

  const idFromLabel = byKey("idNumber").flatMap((v) => [...toAsciiDigits(v).matchAll(ID_RE)].map((m) => m[1]));
  const idFromText = [...toAsciiDigits(fullText).matchAll(ID_RE)].map((m) => m[1]);
  const id = single(idFromLabel.length ? idFromLabel : idFromText);
  if (id.ambiguous) warnings.push("id_ambiguous");

  /* التواريخ: سطر المدّة «( a to b )» أوّلًا، ثم سطرا الدخول والخروج. */
  let startDate = null, endDate = null, days = null, calendar = null;
  const duration = byKey("duration")[0] || null;
  if (duration) {
    const ds = datesIn(duration);
    if (ds.length >= 2) { startDate = ds[0].iso; endDate = ds[1].iso; calendar = ds[0].calendar; }
    const dm = toAsciiDigits(duration).match(/(\d{1,3})\s*(?:days?|يوم|ايام|أيام)/i);
    if (dm) days = Number(dm[1]);
  }
  const startCands = single(byKey("start").flatMap(datesIn).map((d) => d.iso));
  const endCands = single(byKey("end").flatMap(datesIn).map((d) => d.iso));
  if (startDate && startCands.value && startCands.value !== startDate) warnings.push("start_date_inconsistent");
  if (endDate && endCands.value && endCands.value !== endDate) warnings.push("end_date_inconsistent");
  if (!startDate) startDate = startCands.value;
  if (!endDate) endDate = endCands.value;
  if (startCands.ambiguous && !duration) warnings.push("start_date_ambiguous");
  if (endCands.ambiguous && !duration) warnings.push("end_date_ambiguous");
  if (startDate && endDate && endDate < startDate) warnings.push("end_before_start");
  if (days != null && startDate && endDate && daysBetweenInclusive(startDate, endDate) !== days) warnings.push("days_inconsistent");

  const issue = byKey("issueDate").flatMap(datesIn)[0];
  const facilityLine = lines.find((l) => /\b(hospital|clinic|medical\s+(center|centre|complex)|health\s+center)\b|مستشفي|مستشفى|مجمع|عياده|مركز صحي/i.test(normalizeArabic(l.text)) && !labelled.some((x) => x.line === l));

  const fields = {
    leaveId: leave.value,
    idNumber: id.value,
    name: byKey("name")[0] || null,
    startDate,
    endDate,
    days: days != null ? days : (startDate && endDate && endDate >= startDate ? daysBetweenInclusive(startDate, endDate) : null),
    daysPrinted: days != null,
    issueDate: issue ? issue.iso : null,
    nationality: byKey("nationality")[0] || null,
    employer: byKey("employer")[0] || null,
    practitioner: byKey("practitioner")[0] || null,
    position: byKey("position")[0] || null,
    facility: byKey("facility")[0] || (facilityLine ? clip(facilityLine.text) : null),
    calendar,
  };
  const markers = /sick\s*leave|medical\s*leave|medical\s*report/i.test(fullText) || /اجازه\s*مرضيه|مرضيه\s*اجازه/.test(normalizeArabic(fullText));
  return { fields, warnings, markers, hasText: fullText.trim().length > 0, textLength: fullText.length };
}

const CRITICAL = ["leaveId", "idNumber", "startDate", "endDate"];

function qrSummary(buf, leaveId) {
  let text = null;
  try { text = extractQrTextFromPdf(buf); } catch { text = null; }
  if (!text) return { found: false };
  let host = null;
  try { host = new URL(text).hostname.toLowerCase(); } catch { host = null; }
  /* نصّ الرمز لا يُجلب ولا يُفتح ولا يُعاد إلى المتصفّح — يُستخلص منه المضيف
     وما إذا كان يذكر رقم الإجازة نفسه، فقط. */
  return {
    found: true,
    host,
    officialHost: !!host && (host === "seha.sa" || host.endsWith(".seha.sa")),
    mentionsLeaveId: !!leaveId && text.toUpperCase().includes(leaveId),
  };
}

/* النتيجة:
     { ok: true, status: "extracted", fields, missing: [], warnings, qr }
     { ok: true, status: "partial",   fields, missing: [...], warnings, qr }
     { ok: false, reason: scanned | not_sick_leave | malformed | encrypted | too_many_pages | too_complex | timeout } */
async function extractSickLeave(buf, opts) {
  let lines;
  try {
    lines = await readLines(buf, opts);
  } catch (err) {
    return { ok: false, reason: err instanceof ExtractError ? err.reason : "malformed" };
  }
  const parsed = parseFields(lines);
  if (!parsed.hasText) return { ok: false, reason: "scanned" };
  const found = CRITICAL.filter((k) => parsed.fields[k]);
  if (!parsed.markers && !parsed.fields.leaveId) return { ok: false, reason: "not_sick_leave" };
  const missing = CRITICAL.filter((k) => !parsed.fields[k]);
  return {
    ok: true,
    status: missing.length ? "partial" : "extracted",
    fields: parsed.fields,
    missing,
    found,
    warnings: parsed.warnings,
    qr: qrSummary(buf, parsed.fields.leaveId),
  };
}

module.exports = {
  extractSickLeave,
  parseFields,
  groupLines,
  parseDate,
  labelOf,
  normalizeArabic,
  daysBetweenInclusive,
  toAsciiDigits,
  CRITICAL,
  LIMITS,
};
