/* ─── استخراج التحويلات من ملفّ التحويل ───
   =========================================================================
   الناتج عقدٌ واحد مهما كانت الصيغة:

     Transfer { line, name, iban, account, amount (هللة), reference, date,
                bank, empNo, flags[] }

   والمستخرِج لا يقرّر لمن التحويل — هذا عمل المطابقة. لكنه لا يخمّن أيضًا:
   سطرٌ بمبلغين ولا عمود معروف للمبلغ يُعلَّم ambiguous_amount فيُراجَع، ولا
   يُختار أحد المبلغين بصمت.

   ── الترويسة ──
   تُبحث في أوّل 40 صفًّا: الصفّ الذي تتعرّف خلاياه على أكبر عدد من الحقول
   (مبلغ + معرّف واحد على الأقل). أسماء الأعمدة بالعربية والإنجليزية كما
   تُخرجها البنوك السعودية الشائعة، والمطابقة على صورة مطبَّعة.

   ── PDF ──
   الأسطر تُوزَّع على أعمدة الترويسة بأقرب إحداثي أفقي. وإن لم تُعرف ترويسة
   تُقرأ الأسطر «حرّةً»: سطرٌ فيه آيبان صالح أو رقم حساب ومبلغ واحد يُعدّ
   تحويلًا. والنصّ العربي الذي يُخرجه pdfjs معكوسًا يُجرَّب في الاتجاهين عند
   التعرّف على الترويسة. */

const N = require("./normalize");
const { TransferFileError } = require("./readers");

const FIELD_SYNONYMS = {
  name: ["اسم المستفيد", "المستفيد", "اسم الموظف", "الاسم", "اسم العامل", "beneficiary", "beneficiary name", "name", "employee name", "payee", "payee name", "account name", "اسم صاحب الحساب"],
  iban: ["الايبان", "الآيبان", "رقم الايبان", "رقم الآيبان", "iban", "iban number", "beneficiary iban", "ايبان المستفيد", "حساب المستفيد"],
  account: ["رقم الحساب", "الحساب", "account", "account number", "account no", "acc no", "beneficiary account"],
  amount: ["المبلغ", "المبلغ المحول", "مبلغ التحويل", "القيمه", "القيمة", "المبلغ بالريال", "صافي الراتب", "الصافي", "amount", "transfer amount", "net amount", "net salary", "credit", "amount sar", "salary", "الراتب"],
  reference: ["رقم المرجع", "المرجع", "رقم العمليه", "رقم العملية", "مرجع العمليه", "reference", "reference no", "ref", "ref no", "transaction id", "transaction reference", "txn id", "trn", "رقم الحواله", "رقم الحوالة"],
  date: ["التاريخ", "تاريخ التحويل", "تاريخ العمليه", "تاريخ العملية", "تاريخ التنفيذ", "date", "value date", "transfer date", "transaction date", "execution date"],
  bank: ["البنك", "اسم البنك", "بنك المستفيد", "bank", "bank name", "beneficiary bank"],
  empNo: ["رقم الموظف", "الرقم الوظيفي", "الرقم الوظيفى", "employee id", "employee no", "employee number", "emp no", "emp id", "staff id", "staff no"],
};

const headerKey = (s) => N.westernDigits(s).normalize("NFKC")
  .replace(/[ً-ٟـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
  .toLowerCase().replace(/[_\-:./()#]+/g, " ").replace(/\s+/g, " ").trim();

const SYN_INDEX = Object.entries(FIELD_SYNONYMS).flatMap(([field, list]) => list.map((s) => [headerKey(s), field]));

function classifyHeader(raw) {
  const text = String(raw || "");
  for (const candidate of [text, [...text].reverse().join("")]) {
    const k = headerKey(candidate);
    if (!k || k.length > 40) continue;
    const exact = SYN_INDEX.find(([s]) => s === k);
    if (exact) return exact[1];
  }
  for (const candidate of [text, [...text].reverse().join("")]) {
    const k = headerKey(candidate);
    if (!k || k.length > 40) continue;
    /* احتواء: «مبلغ التحويل (ريال)» ← amount. الأطول أوّلًا كي لا يغلب
       «الحساب» على «رقم الآيبان». */
    const hit = [...SYN_INDEX].sort((a, b) => b[0].length - a[0].length).find(([s]) => s.length >= 3 && k.includes(s));
    if (hit) return hit[1];
  }
  return null;
}

/* خريطة الترويسة: field → فهرس العمود. حقلٌ يتكرّر يُعلَّم ولا يُختار ثانيه. */
function headerMap(cells) {
  const map = {};
  const dupes = [];
  cells.forEach((c, i) => {
    const f = classifyHeader(c);
    if (!f) return;
    if (map[f] !== undefined) dupes.push(f);
    else map[f] = i;
  });
  return { map, dupes, score: Object.keys(map).length };
}

function findHeader(rows) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = headerMap(rows[i]);
    if (h.map.amount === undefined) continue;
    if (h.map.iban === undefined && h.map.account === undefined && h.map.name === undefined && h.map.empNo === undefined) continue;
    if (!best || h.score > best.score) best = { ...h, row: i };
  }
  return best;
}

const TOTAL_ROW = /(^|\s)(الاجمالي|الإجمالي|المجموع|اجمالي|إجمالي|total|grand total|sum)(\s|$)/i;
const IBAN_IN_TEXT = /SA\d{2}[0-9A-Z]{20}/g;
const MONEY_CELL = /^[-(]?\s*(SAR|SR)?\s*[\d٠-٩][\d٠-٩,٬]*[.٫][\d٠-٩]{2}\s*(SAR|SR|ر\.?\s?س\.?)?\s*[)-]?$/i;

function ibanOf(value) {
  const compact = N.normalizeIban(value);
  if (!compact) return null;
  const m = compact.match(IBAN_IN_TEXT);
  if (!m) return null;
  return m.find((x) => N.isValidIban(x)) || null;
}

function makeTransfer(line, fields) {
  const flags = [];
  let iban = fields.iban ? ibanOf(fields.iban) : null;
  if (fields.iban && !iban && N.normalizeIban(fields.iban)) {
    /* عمود آيبان بقيمة لا تجتاز الفحص الرقابي — لا تُعتمد هوية. */
    const raw = N.normalizeIban(fields.iban);
    if (/^SA/.test(raw)) flags.push("invalid_iban");
    else if (!fields.account) fields.account = fields.iban;
  }
  let account = fields.account ? N.normalizeAccount(fields.account) : null;
  /* عمود «الحساب» قد يحمل آيبانًا كاملًا. */
  if (!iban && fields.account && ibanOf(fields.account)) { iban = ibanOf(fields.account); account = null; }
  const amount = fields.amount === undefined ? null : N.toHalalas(fields.amount);
  return {
    line,
    name: fields.name ? String(fields.name).replace(/\s+/g, " ").trim().slice(0, 120) || null : null,
    iban,
    account,
    amount,
    reference: fields.reference ? N.westernDigits(fields.reference).replace(/\s+/g, "").slice(0, 60) || null : null,
    date: N.normalizeDate(fields.date),
    bank: fields.bank ? String(fields.bank).replace(/\s+/g, " ").trim().slice(0, 80) || null : null,
    empNo: fields.empNo ? N.westernDigits(fields.empNo).replace(/\s+/g, "").replace(/\.0+$/, "").slice(0, 30) || null : null,
    flags: [...flags, ...(fields.flags || [])],
  };
}

const usable = (t) => t.amount !== null && t.amount > 0 && (t.iban || t.account || t.name || t.empNo);

/* ── جداول (CSV / XLSX) ── */
function fromTables(sheets) {
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows);
    if (!header) continue;
    const transfers = [];
    for (let r = header.row + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      const get = (f) => (header.map[f] === undefined ? undefined : row[header.map[f]]);
      if (row.some((c) => TOTAL_ROW.test(String(c || "").trim())) && !ibanOf(get("iban") || "")) continue;
      const t = makeTransfer(r + 1, {
        name: get("name"), iban: get("iban"), account: get("account"), amount: get("amount"),
        reference: get("reference"), date: get("date"), bank: get("bank"), empNo: get("empNo"),
      });
      if (usable(t)) transfers.push(t);
    }
    return { transfers, mode: "table", columns: Object.keys(header.map), warnings: header.dupes.map((f) => `عمود مكرّر: ${f}`) };
  }
  return { transfers: [], mode: "table", columns: [], warnings: ["لم يُعثر على صفّ عناوين يحوي المبلغ ومعرّف المستفيد"] };
}

/* ── PDF ── */
function fromPdf(pdf) {
  const lines = pdf.lines;
  /* ترويسة: السطر الذي تتعرّف خلاياه على أكبر عدد من الحقول. */
  let header = null;
  lines.forEach((ln, i) => {
    const h = headerMap(ln.cells.map((c) => c.s));
    if (h.map.amount === undefined || h.score < 2) return;
    if (!header || h.score > header.score) header = { ...h, index: i, xs: ln.cells.map((c) => c.x) };
  });

  const transfers = [];
  const warnings = [];
  lines.forEach((ln, i) => {
    if (header && i <= header.index && ln.page === lines[header.index].page) return;
    const texts = ln.cells.map((c) => c.s);
    const joined = texts.join(" ");
    if (TOTAL_ROW.test(joined) && !ibanOf(joined)) return;

    let fields;
    if (header) {
      /* كل خليّة إلى أقرب عمود في الترويسة. */
      const assigned = {};
      for (const c of ln.cells) {
        let bestI = 0, bestD = Infinity;
        header.xs.forEach((x, k) => { const d = Math.abs(x - c.x); if (d < bestD) { bestD = d; bestI = k; } });
        const field = Object.keys(header.map).find((f) => header.map[f] === bestI);
        if (field) assigned[field] = assigned[field] ? `${assigned[field]} ${c.s}` : c.s;
      }
      fields = assigned;
      if (!fields.iban) { const iban = ibanOf(joined); if (iban) fields.iban = iban; }
    } else {
      fields = looseFields(texts);
      if (!fields) return;
    }
    const t = makeTransfer(`${ln.page}:${i + 1}`, fields);
    if (usable(t) && (t.iban || t.account || t.empNo)) transfers.push(t);
  });
  if (!header) warnings.push("لم تُعرف ترويسة أعمدة في PDF — قُرئت الأسطر بالأنماط (آيبان/مبلغ/تاريخ)");
  return { transfers, mode: header ? "pdf-columns" : "pdf-lines", columns: header ? Object.keys(header.map) : [], warnings };
}

/* سطرٌ حرّ: آيبان صالح أو رقم حساب طويل، ومبلغ. مبلغان فأكثر = غامض. */
function looseFields(texts) {
  const joined = texts.join(" ");
  const iban = ibanOf(joined);
  const amounts = texts.filter((s) => MONEY_CELL.test(s.trim()));
  const dateCell = texts.find((s) => N.normalizeDate(s) && /[-/.]/.test(s));
  const accountCell = !iban ? texts.find((s) => /^\d{10,20}$/.test(N.westernDigits(s).replace(/[\s-]/g, ""))) : null;
  if (!iban && !accountCell) return null;
  if (!amounts.length) return null;
  const rest = texts.filter((s) => s !== dateCell && !amounts.includes(s) && s !== accountCell && !ibanOf(s));
  const reference = rest.find((s) => /^[A-Z0-9]{6,30}$/i.test(N.westernDigits(s)) && /\d/.test(s));
  const name = rest.filter((s) => s !== reference && /[A-Za-zء-يﹰ-﻿]{2,}/.test(s)).join(" ");
  return {
    iban: iban || undefined,
    account: accountCell || undefined,
    amount: amounts[0],
    date: dateCell,
    reference,
    name,
    flags: amounts.length > 1 ? ["ambiguous_amount"] : [],
  };
}

/* ── الشهر الذي يغطّيه الملفّ ──
   الأغلبية من تواريخ التحويلات (YYYY-MM)، أو null إن لم تكن تواريخ. */
function detectPeriod(transfers) {
  const counts = new Map();
  for (const t of transfers) if (t.date) counts.set(t.date.slice(0, 7), (counts.get(t.date.slice(0, 7)) || 0) + 1);
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/* نافذة شهر المسير: تحويل رواتب «أكتوبر» يقع عادةً بين آخر أكتوبر ونهاية
   نوفمبر. فما يُقبل: شهر المسير نفسه والشهر الذي يليه. خارج ذلك = ملفّ
   شهرٍ آخر يُرفض بلا خلط. */
function periodFits(runId, period) {
  if (!period) return true;
  const [y, m] = runId.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return period === runId || period === next;
}

function extract(format, readResult) {
  if (format === "pdf") return fromPdf(readResult);
  if (format === "csv" || format === "xlsx") return fromTables(readResult);
  throw new TransferFileError("unsupported_format", "صيغة غير مدعومة");
}

module.exports = { extract, fromTables, fromPdf, classifyHeader, findHeader, detectPeriod, periodFits, ibanOf, FIELD_SYNONYMS };
