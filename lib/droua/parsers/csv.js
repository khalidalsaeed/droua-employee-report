/* ─── قارئ CSV ومطبِّع الصفوف ──────────────────────────────────────────
   =========================================================================
   بلا اعتماد خارجيّ: CSV صيغةٌ صغيرة، والمكتبة لها كلفةُ سلسلة توريد لا
   يبرّرها ثلاثون سطرًا.

   وهو أيضًا **المطبِّع المشترك**: قارئ PDF أو Excel يوم يُكتب يُخرج مصفوفة
   صفوفٍ نصّية ويمرّرها إلى `normalizeRows` هنا. فمنطق أسماء الأعمدة وتطبيع
   الأرقام يُكتب مرّة واحدة لا ثلاثًا — وتباعدُ ثلاث نسخ منه بعد سنة كان
   سيُنتج مقارنةً تكذب على صيغةٍ دون أخرى. */

const KIND_EMPLOYEES = "employees";

/* ── أسماء الأعمدة: مرادفات عربية وإنجليزية ──
   القائمة أطول ممّا يبدو ضروريًّا عمدًا: عمودٌ لا يُتعرَّف عليه لا يُنتج
   خطأً بل صفرًا صامتًا، وصفرٌ صامت في مقارنة رواتب أسوأ من الرفض. */
const ALIASES = {
  empNo: ["رقم الموظف", "الرقم الوظيفي", "رقم الموظّف", "م", "emp no", "employee no", "employee id", "emp_no", "id"],
  name: ["الاسم", "اسم الموظف", "اسم الموظّف", "name", "employee name"],
  iban: ["الايبان", "الآيبان", "رقم الحساب", "الحساب البنكي", "iban", "account", "bank account"],
  bank: ["البنك", "المصرف", "bank", "bank name"],
  method: ["طريقة الصرف", "طريقة الدفع", "الصرف", "method", "payment method"],
  basic: ["الراتب الاساسي", "الراتب الأساسي", "اساسي", "أساسي", "basic", "basic salary"],
  allowances: ["البدلات", "بدلات", "allowances", "allowance"],
  deductions: ["الاستقطاعات", "الخصومات", "استقطاعات", "deductions", "deduction"],
  net: ["الصافي", "صافي الراتب", "المستحق", "net", "net salary", "total"],
  jobTitle: ["المسمى الوظيفي", "المسمّى الوظيفي", "الوظيفة", "job title", "title", "position"],
  status: ["الحالة", "حالة الموظف", "status"],
};

const stripDiacritics = (s) => s.replace(/[ً-ْـ]/g, "");

/* التطبيع يوحّد صور الألف والهاء/التاء المربوطة: «الاسم» و«الأسم»، و«الوظيفة»
   و«الوظيفه» — وهي فروقٌ تقع في ملفّات حقيقية بلا قصد. */
function normalizeHeader(raw) {
  return stripDiacritics(String(raw || ""))
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const ALIAS_INDEX = new Map();
for (const [field, names] of Object.entries(ALIASES)) {
  for (const name of names) ALIAS_INDEX.set(normalizeHeader(name), field);
}

/* الأرقام العربية-الهندية والفواصل والعملة. و«(1٬234)» سالبٌ محاسبيّ. */
const AR_DIGITS = /[٠-٩۰-۹]/g;
const digitValue = (ch) => {
  const code = ch.charCodeAt(0);
  return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
};

function toNumber(raw) {
  if (raw === null || raw === undefined) return 0;
  let text = String(raw).replace(AR_DIGITS, digitValue).trim();
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  text = text.replace(/[()\-]/g, "");
  /* الفاصلة العشرية العربية «٫» والفاصل الألفيّ «٬» و«,» والمسافات. */
  text = text.replace(/٫/g, ".").replace(/[٬,\s]/g, "");
  text = text.replace(/[^\d.]/g, "");
  const parts = text.split(".");
  if (parts.length > 2) text = `${parts.slice(0, -1).join("")}.${parts[parts.length - 1]}`;
  const n = Number(text);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/* آخر أربع خانات وحدها. الرقم الكامل لا يغادر الملفّ المشفَّر — يُقتطع هنا
   عند القراءة، قبل أن يبلغ أي بنية في الذاكرة أو أي صفّ في القاعدة. */
function lastFour(raw) {
  const digits = String(raw || "").replace(AR_DIGITS, digitValue).replace(/[^0-9A-Za-z]/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

const cleanText = (raw) => String(raw === null || raw === undefined ? "" : raw)
  .replace(/\s+/g, " ").trim();

/* ─── تفكيك CSV: اقتباسات، واقتباس مزدوج داخلها، وCRLF، وBOM ─────────── */
function splitRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

/* ─── التطبيع المشترك ────────────────────────────────────────────────── */
function normalizeRows(kind, header, dataRows) {
  const warnings = [];
  const map = {};
  header.forEach((cell, index) => {
    const field = ALIAS_INDEX.get(normalizeHeader(cell));
    if (field && !(field in map)) map[field] = index;
  });

  const need = kind === KIND_EMPLOYEES ? ["empNo", "name"] : ["empNo", "net"];
  for (const field of need) {
    if (!(field in map)) warnings.push(`عمود مطلوب لم يُتعرَّف عليه: ${field}`);
  }

  const at = (row, field) => (field in map ? row[map[field]] : undefined);
  const rows = [];
  const seen = new Set();

  for (const raw of dataRows) {
    const empNo = cleanText(at(raw, "empNo")).replace(AR_DIGITS, digitValue);
    const name = cleanText(at(raw, "name"));
    if (!empNo && !name) continue;
    if (empNo && seen.has(empNo)) warnings.push(`رقم موظّف مكرّر في الملفّ: ${empNo}`);
    if (empNo) seen.add(empNo);

    if (kind === KIND_EMPLOYEES) {
      rows.push({
        empNo, name,
        jobTitle: cleanText(at(raw, "jobTitle")) || null,
        status: cleanText(at(raw, "status")) || null,
        iban4: lastFour(at(raw, "iban")),
      });
      continue;
    }

    const basic = toNumber(at(raw, "basic"));
    const allowances = toNumber(at(raw, "allowances"));
    const deductions = toNumber(at(raw, "deductions"));
    /* الصافي المحسوب حين لا يوجد عمود صافٍ — لا صفرٌ صامت. */
    const net = "net" in map ? toNumber(at(raw, "net")) : basic + allowances - deductions;

    rows.push({
      empNo, name,
      iban4: lastFour(at(raw, "iban")),
      bank: cleanText(at(raw, "bank")) || null,
      method: cleanText(at(raw, "method")) || null,
      basic, allowances, deductions, net,
    });
  }

  return { kind, rows, meta: { source: "csv", rowCount: rows.length, warnings } };
}

function parse({ kind, bytes }) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes || "");
  const table = splitRows(text);
  if (!table.length) return { kind, rows: [], meta: { source: "csv", rowCount: 0, warnings: ["ملفّ فارغ"] } };
  const [header, ...dataRows] = table;
  return normalizeRows(kind, header, dataRows);
}

module.exports = {
  format: "csv",
  available: true,
  parse,
  normalizeRows, normalizeHeader, toNumber, lastFour, splitRows, ALIASES,
};
