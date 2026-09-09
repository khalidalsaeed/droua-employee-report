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
  name: ["الاسم", "اسم الموظف", "اسم الموظّف", "الاسم كاملا باللغة العربية", "الاسم بالعربي", "name", "employee name"],
  nameEn: ["الاسم كاملا باللغة الانجليزية", "الاسم بالانجليزي", "english name", "name en"],
  /* رقم الهوية/الإقامة: يُتعرَّف عليه كي لا يُعدّ عمودًا مجهولًا — ولا
     يُحتفظ منه إلا بآخر أربع خانات، كالحساب البنكيّ تمامًا. */
  nationalId: ["رقم الهوية/الاقامة", "رقم الهويه/الاقامه", "رقم الهوية", "رقم الاقامة", "الهوية", "national id", "iqama"],
  iban: ["الايبان", "الآيبان", "رقم الايبان", "رقم الحساب", "الحساب البنكي", "iban", "account", "bank account"],
  /* «اسم البنك» عمودٌ في قائمة موظفي بعض الشهور دون بعض — وبلا مرادفه
     يسقط في `unknownColumns` فتصير مقارنةُ البنك فراغًا بفراغ. */
  bank: ["البنك", "المصرف", "اسم البنك", "bank", "bank name"],
  method: ["طريقة الصرف", "طريقة الدفع", "طريقة التحويل", "الصرف", "method", "payment method"],
  jobTitle: ["المسمى الوظيفي", "المسمّى الوظيفي", "الوظيفة", "job title", "title", "position"],
  status: ["الحالة", "حالة الموظف", "status"],

  basic: ["الراتب الاساسي", "الراتب الأساسي", "اساسي", "أساسي", "basic", "basic salary"],
  /* ثلاثة مجاميع مختلفة يجب ألّا تختلط:
       gross      = الأساسيّ + البدلات    (قبل الخصم)
       additions  = ما يُضاف خارج البدلات (وقت إضافيّ ونحوه)
       net        = المستحقّ فعلًا         (بعد الخصم)
     وخلطُ «اجمالي الراتب» بـ«صافي الراتب» يجعل كل مقارنة تكذب بمقدار
     الخصميات — وهو خطأٌ لا يظهر إلا حين يكون لموظّفٍ خصم. */
  gross: ["اجمالي الراتب", "إجمالي الراتب", "كامل الراتب", "الراتب الاجمالي", "gross", "gross salary"],
  allowancesTotal: ["اجمالي البدلات", "إجمالي البدلات", "مجموع البدلات", "البدلات", "بدلات", "total allowances", "allowances"],
  additionsTotal: ["اجمالي الاضافات", "إجمالي الإضافات", "total additions"],
  deductionsTotal: ["اجمالي الخصميات", "إجمالي الخصميات", "الاستقطاعات", "الخصومات", "مجموع الخصومات",
    "deductions", "total deductions"],
  net: ["صافي الراتب", "الصافي", "المستحق", "net", "net salary"],
};

/* ── أعمدة مركَّبة: بدلات وخصميات مفصَّلة ──
   ملفّات المسير الحقيقية تفصّل البدل إلى «بدل سكن» و«بدل مواصلات» و«بدل
   إعاشة»… والخصم إلى «تاخير» و«غياب» و«التامينات»… ولا تُدرَج قوائم بأسماء
   بعينها: أي عمودٍ يبدأ بـ«بدل» بدلٌ، و«خصم»/«استقطاع» خصمٌ — فعمودٌ جديد
   في مسير الشهر القادم يُفهم بلا تعديل كود.

   والمسمَّيات التي لا تحمل البادئة تُدرَج صراحةً. */
const ALLOWANCE_PARTS = ["اخرى", "أخرى", "وقت اضافي", "الوقت الاضافي", "ساعات اضافية", "مكافاة", "مكافأة", "حوافز", "overtime", "bonus"];
const DEDUCTION_PARTS = ["تاخير", "تأخير", "خروج مبكر", "غياب", "التامينات الاجتماعية", "التأمينات الاجتماعية",
  "شخصي سلفة", "سلفة", "سلف", "جزاءات", "جزاء", "قرض", "loan", "penalty", "absence",
  /* أنواع جزاءاتٍ لا تحمل بادئة «خصم»: تُدرَج صراحةً كي لا تُعدّ أعمدة
     مجهولة. ولا أثر لها على الحساب حين يوجد عمود «اجمالي الخصميات» —
     المعلن يسبق الأجزاء — لكنها تُخرجها من ضجيج «أعمدة لم تُقرأ». */
  "نسيان بصمه", "نسيان بصمة", "بصمة", "بصمه", "مخالفة", "مخالفات", "غرامة", "غرامات"];

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

const PART_INDEX = new Map();
for (const name of ALLOWANCE_PARTS) PART_INDEX.set(normalizeHeader(name), "allowancePart");
for (const name of DEDUCTION_PARTS) PART_INDEX.set(normalizeHeader(name), "deductionPart");

/* تصنيف عمودٍ لم يُطابق مرادفًا: بالبادئة أوّلًا ثمّ بقائمة الأجزاء. */
function classifyColumn(rawHeader) {
  const key = normalizeHeader(rawHeader);
  if (!key) return null;
  if (ALIAS_INDEX.has(key)) return { kind: "field", field: ALIAS_INDEX.get(key) };
  if (PART_INDEX.has(key)) return { kind: PART_INDEX.get(key) };
  if (/^(ال)?بدل/.test(key) || /^allowance/.test(key)) return { kind: "allowancePart" };
  if (/^(ال)?(خصم|استقطاع|حسم)/.test(key)) return { kind: "deductionPart" };
  return null;
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
/* الحقول المتوقَّعة **لكل نوع على حدة**: ما يجب أن يوجد، وما يُحسِّن
   المقارنة إن وُجد.

   والتمييز بين الأنواع ليس تنميقًا: ملفّ الكاش يحمل بطبيعته رقمًا واسمًا
   وصافيًا لا غير — فقياسُه على قائمةٍ تتوقّع بدلاتٍ وحساباتٍ بنكية يخفض
   ثقته إلى النصف ويُنتج إنذارًا كاذبًا على ملفٍّ سليم تمامًا. وإنذارٌ كاذب
   في نظام تدقيق أسوأ من صمت: يدرّب المستخدم على تجاهل التنبيه. */
const EXPECTED_FIELDS = {
  full: { required: ["empNo", "net"], useful: ["name", "basic", "allowances", "deductions"] },
  transfer: { required: ["empNo", "net"], useful: ["name", "iban", "bank"] },
  cash: { required: ["empNo", "net"], useful: ["name"] },
  [KIND_EMPLOYEES]: { required: ["empNo", "name"], useful: ["jobTitle", "status", "iban"] },
};
const DEFAULT_FIELDS = { required: ["empNo", "net"], useful: ["name"] };

/* عتبةُ «يحتاج مراجعة يدوية». دون هذا يكون القارئ قد فهم أقلّ من ثلثي
   الملفّ — ومقارنةٌ على فهمٍ ناقص تُنتج ملاحظاتٍ كاذبة أكثر ممّا تُنتج
   صحيحة، فالأصدق أن يقولها للمستخدم بدل أن يُخفيها في رقم. */
const CONFIDENCE_FLOOR = 0.67;

function normalizeRows(kind, header, dataRows) {
  const warnings = [];
  const map = {};
  const mapping = {};
  const unknownColumns = [];
  const allowanceCols = [];
  const deductionCols = [];

  header.forEach((cell, index) => {
    const label = cleanText(cell);
    const found = classifyColumn(cell);
    if (!found) {
      /* عمودٌ لم يُتعرَّف عليه ليس خطأً بالضرورة — قد يكون «القسم» أو
         «تاريخ الانضمام». لكنه يُعلَن: أخطر ما في القراءة عمودٌ مهمّ سُمّي
         تسميةً لم تُدرَج، فيصير صفرًا صامتًا لا فراغًا مرئيًّا. */
      if (label) unknownColumns.push(label);
      return;
    }
    if (found.kind === "allowancePart") { allowanceCols.push({ index, label }); return; }
    if (found.kind === "deductionPart") { deductionCols.push({ index, label }); return; }
    const field = found.field;
    if (field in map) { warnings.push(`عمودان لحقلٍ واحد (${field})؛ أُخذ الأول: ${label}`); return; }
    map[field] = index;
    mapping[field] = label;
  });

  if (allowanceCols.length) mapping.allowanceParts = allowanceCols.map((c) => c.label).join(" + ");
  if (deductionCols.length) mapping.deductionParts = deductionCols.map((c) => c.label).join(" + ");

  const spec = EXPECTED_FIELDS[kind] || DEFAULT_FIELDS;
  const has = (field) => field in map
    || (field === "allowances" && (("allowancesTotal" in map) || allowanceCols.length))
    || (field === "deductions" && (("deductionsTotal" in map) || deductionCols.length))
    || (field === "net" && ("net" in map || ("gross" in map)));
  for (const field of spec.required) {
    if (!has(field)) warnings.push(`عمود مطلوب لم يُتعرَّف عليه: ${field}`);
  }

  const at = (row, field) => (field in map ? row[map[field]] : undefined);
  const sumAt = (row, cols) => cols.reduce((total, c) => total + toNumber(row[c.index]), 0);

  const rows = [];
  const seen = new Set();
  let skipped = 0;

  for (const raw of dataRows) {
    const empNo = cleanText(at(raw, "empNo")).replace(AR_DIGITS, digitValue);
    const name = cleanText(at(raw, "name")) || cleanText(at(raw, "nameEn"));
    /* صفٌّ بلا رقمٍ ولا اسم وفيه أرقام = صفّ مجاميع في آخر المسير. يُتخطّى
       ويُعدّ — ولا يُعدّ موظّفًا اسمه فارغ وراتبه مجموع الجميع. */
    if (!empNo && !name) { if (raw.some((c) => String(c).trim() !== "")) skipped += 1; continue; }
    if (empNo && seen.has(empNo)) warnings.push(`رقم موظّف مكرّر في الملفّ: ${empNo}`);
    if (empNo) seen.add(empNo);

    const idLast4 = lastFour(at(raw, "nationalId"));
    if (kind === KIND_EMPLOYEES) {
      rows.push({
        empNo, name,
        jobTitle: cleanText(at(raw, "jobTitle")) || null,
        status: cleanText(at(raw, "status")) || null,
        iban4: lastFour(at(raw, "iban")),
        bank: cleanText(at(raw, "bank")) || null,
        method: cleanText(at(raw, "method")) || null,
        idLast4,
      });
      continue;
    }

    const basic = toNumber(at(raw, "basic"));
    /* الأولوية للمجموع المُعلَن، ثمّ لمجموع الأجزاء. فملفٌّ يحمل الاثنين
       يُقرأ من المعلن، وملفٌّ يفصّل بلا مجموع يُجمع له. */
    const allowances = "allowancesTotal" in map
      ? toNumber(at(raw, "allowancesTotal"))
      : sumAt(raw, allowanceCols);
    const additions = "additionsTotal" in map ? toNumber(at(raw, "additionsTotal")) : 0;
    const deductions = "deductionsTotal" in map
      ? toNumber(at(raw, "deductionsTotal"))
      : sumAt(raw, deductionCols);
    const gross = "gross" in map ? toNumber(at(raw, "gross")) : basic + allowances;
    /* الصافي المُعلَن أوّلًا. وبلا عمودٍ له يُحسب — ولا يُترك صفرًا صامتًا. */
    const net = "net" in map ? toNumber(at(raw, "net")) : gross + additions - deductions;

    rows.push({
      empNo, name,
      iban4: lastFour(at(raw, "iban")),
      bank: cleanText(at(raw, "bank")) || null,
      method: cleanText(at(raw, "method")) || null,
      idLast4,
      basic, allowances, additions, deductions, gross, net,
    });
  }

  if (skipped) warnings.push(`صفوفٌ بلا رقمٍ ولا اسم تُخطّيت: ${skipped} (غالبًا صفّ مجاميع)`);

  /* الثقة: نسبةُ ما فُهم من الحقول المتوقَّعة، والمطلوبُ منها يزن ضِعف
     المفيد — فملفٌّ بلا عمود «الصافي» لا تُنقذه عشرةُ أعمدة ثانوية. */
  const weigh = (fields, weight) =>
    fields.reduce((acc, f) => ({
      got: acc.got + (has(f) ? weight : 0), max: acc.max + weight,
    }), { got: 0, max: 0 });
  const req = weigh(spec.required, 2);
  const useful = weigh(spec.useful, 1);
  const confidence = (req.max + useful.max) === 0 ? 1
    : Math.round(((req.got + useful.got) / (req.max + useful.max)) * 100) / 100;

  return {
    kind,
    rows,
    meta: {
      source: "csv",
      rowCount: rows.length,
      skippedRows: skipped,
      warnings,
      mapping,
      unknownColumns,
      confidence,
      needsManualReview: confidence < CONFIDENCE_FLOOR || spec.required.some((f) => !has(f)),
    },
  };
}

/* ── إيجاد صفّ الترويسة ──
   ملفّات حقيقية تبدأ بعنوانٍ أو شعار أو سطر تاريخ قبل الجدول — فأخذُ الصفّ
   الأول ترويسةً يجعل القارئ يقرأ عنوانًا بوصفه أسماء أعمدة، ثمّ يعدّ صفّ
   الترويسة الحقيقيّ بيانًا. والنتيجة: صفر أعمدة معروفة، وموظّفٌ اسمه
   «الرقم الوظيفي».

   فيُبحث عن الصفّ الذي يُطابق أكثرَ عدد من الحقول المعروفة في أوّل خمسة
   عشر صفًّا. */
const HEADER_SCAN_ROWS = 15;

function scoreHeader(row) {
  const seen = new Set();
  for (const cell of row) {
    const field = ALIAS_INDEX.get(normalizeHeader(cell));
    if (field) seen.add(field);
  }
  return seen.size;
}

function findHeader(rows, kind) {
  const spec = EXPECTED_FIELDS[kind] || DEFAULT_FIELDS;
  let best = { index: 0, score: -1 };
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i += 1) {
    const score = scoreHeader(rows[i]);
    /* الأعلى يفوز، وعند التساوي يفوز الأعلى موضعًا: الترويسة تسبق البيان. */
    if (score > best.score) best = { index: i, score };
  }
  /* لا صفّ يحمل حقلين معروفين ⇒ لا ترويسة يمكن التعرّف عليها. يُؤخذ الأول
     ويتكفّل التطبيع بالتحذير — لا نُخمّن مواضع الأعمدة. */
  if (best.score < Math.min(2, spec.required.length)) best = { index: 0, score: 0 };
  return {
    header: rows[best.index] || [],
    dataRows: rows.slice(best.index + 1),
    headerRow: best.index + 1,
    headerScore: best.score,
  };
}

/* الورقة التي تحمل الجدول: أعلى ترويسةً، ثمّ أكثر صفوفًا. فمصنّفٌ فيه ورقة
   «تعليمات» وأخرى بالبيانات لا يُقرأ من الأولى. */
function pickSheet(sheets, kind) {
  const scored = (sheets || [])
    .filter((s) => s && s.rows && s.rows.length)
    .map((s) => ({ sheet: s, score: findHeader(s.rows, kind).headerScore, rows: s.rows.length }));
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.rows - a.rows);
  return scored[0].sheet;
}

function parse({ kind, bytes }) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes || "");
  const table = splitRows(text);
  if (!table.length) {
    return { kind, rows: [], meta: {
      source: "csv", rowCount: 0, warnings: ["ملفّ فارغ"],
      mapping: {}, unknownColumns: [], confidence: 0, needsManualReview: true,
    } };
  }
  const { header, dataRows, headerRow } = findHeader(table, kind);
  const out = normalizeRows(kind, header, dataRows);
  out.meta.headerRow = headerRow;
  return out;
}

module.exports = {
  format: "csv",
  available: true,
  parse,
  normalizeRows, normalizeHeader, toNumber, lastFour, splitRows, findHeader, pickSheet,
  ALIASES, EXPECTED_FIELDS, DEFAULT_FIELDS, CONFIDENCE_FLOOR,
};
