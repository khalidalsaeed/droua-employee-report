/* ─── تطبيع القيم في ملفّ التحويل البنكي ───
   =========================================================================
   كل ما يُقارَن في المطابقة يمرّ من هنا: الأرقام العربية، والمبالغ، والآيبان،
   والأسماء. دوالّ نقيّة بلا قاعدة ولا شبكة.

   ── المبالغ بالهللة لا بالريال ──
   المقارنة تجري على أعداد صحيحة (هللات). 4500.00 و4499.995 ليستا «تقريبًا
   متساويتين» في مسير رواتب: التسامح صفر، والأعداد العشرية في JS تجعل
   0.1+0.2≠0.3 — فالعدد الصحيح وحده يجعل «حتى الهللة» قاعدةً لا أمنية.

   ── الآيبان لا يُسجَّل كاملًا أبدًا ──
   maskIban هو الشكل الوحيد الذي يغادر الخادم إلى الواجهة أو السجلّ.
   والتخزين يحمل آخر أربع خانات وبصمة SHA-256 (للمطابقة لاحقًا) لا الرقم. */

const crypto = require("crypto");

const AR_DIGITS = /[٠-٩۰-۹]/g;
function westernDigits(s) {
  return String(s === null || s === undefined ? "" : s).replace(AR_DIGITS, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/* "4,500.00" / "٤٬٥٠٠٫٠٠" / "SAR 4500" / "4500.00 ر.س" → 450000 (هللة).
   يُرجع null لما ليس مبلغًا — لا صفرًا: الصفر مبلغٌ حقيقي يُقارَن. */
function toHalalas(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  let s = westernDigits(raw)
    .replace(/[٬]/g, ",")
    .replace(/[٫]/g, ".")
    .replace(/SAR|SR|ر\.?\s?س\.?|ريال/gi, "")
    .replace(/[\s ‏‎]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1); }
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.replace(/,/g, "").split(".");
  const halalas = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(halalas)) return null;
  return negative ? -halalas : halalas;
}

const fromHalalas = (h) => (h === null || h === undefined ? null : h / 100);

/* "SA03 8000 0000 6080 1016 7519" → "SA0380000000608010167519". */
function normalizeIban(raw) {
  const s = westernDigits(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s || null;
}

/* فحص الخانتين الرقابيّتين (ISO 13616، باقي القسمة على 97). آيبان سعودي
   طوله 24. فحصٌ فاشل يعني خطأ قراءة أو إدخال — لا يُستعمل مفتاحَ هوية. */
function isValidIban(iban) {
  const s = normalizeIban(iban);
  if (!s || !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  if (s.startsWith("SA") && s.length !== 24) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/* رقم حساب: أرقام فقط بعد التطبيع. */
function normalizeAccount(raw) {
  const s = westernDigits(raw).replace(/[^0-9]/g, "");
  return s.length >= 6 ? s : null;
}

const last4 = (s) => (s && s.length >= 4 ? s.slice(-4) : null);

/* SA••••••1234 — العرض الوحيد المسموح للآيبان أو الحساب. */
function maskIban(ibanOrLast4, prefix) {
  const tail = ibanOrLast4 && ibanOrLast4.length > 4 ? ibanOrLast4.slice(-4) : ibanOrLast4;
  if (!tail) return null;
  return `${prefix === undefined ? "SA" : prefix}••••••${tail}`;
}

/* بصمة للمطابقة لاحقًا دون تخزين الرقم. البادئة تفصل مجال البصمة عن أي
   استعمال آخر لـSHA-256 في المنصّة. */
function identifierHash(kind, value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(`payroll-transfer:${kind}:${value}`).digest("hex");
}

/* ── الأسماء: تعزيزٌ لا هوية ──
   تطبيع الصور العربية الشائعة (أ/إ/آ→ا، ة→ه، ى→ي) وإسقاط التشكيل والتطويل
   و«بن/ابن/ال» الزائدة، ثم مقارنة مجموعات الكلمات. والنتيجة رقم بين 0 و1
   لا قرار: المحرّك وحده يقرّر، ولا يقرّر بالاسم وحده أبدًا. */
function normalizeName(raw) {
  return westernDigits(raw)
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .replace(/[^a-zء-ي\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["بن", "ابن", "bin", "ibn", "bint", "بنت", "al", "el", "mr", "mrs", "ms"].includes(w))
    .map((w) => w.replace(/^ال(?=..)/, "").replace(/^(al|el)-?(?=...)/, ""))
    .join(" ")
    .trim();
}

/* تشابه كلمات: نسبة الكلمات المشتركة إلى كلمات الاسم الأقصر، مع قبول
   اختلاف حرف واحد في الكلمات الطويلة («محمد»/«محمود» لا، «Mohammed»/
   «Mohamed» نعم). */
function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function nameSimilarity(a, b) {
  const wa = normalizeName(a).split(" ").filter(Boolean);
  const wb = normalizeName(b).split(" ").filter(Boolean);
  if (!wa.length || !wb.length) return 0;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const used = new Set();
  let hits = 0;
  for (const w of short) {
    const k = long.findIndex((x, idx) => !used.has(idx) && (x === w || (w.length >= 5 && editDistanceAtMost1(x, w))));
    if (k >= 0) { used.add(k); hits++; }
  }
  return hits / short.length;
}

/* تواريخ: 2026-11-02 / 02/11/2026 / 2-11-2026 / 20261102 → "2026-11-02". */
function normalizeDate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number" && raw > 20000 && raw < 80000) {
    /* رقم تسلسلي من Excel (أيام منذ 1899-12-30). */
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(raw) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = westernDigits(raw).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return iso(m[1], m[2], m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (m) return iso(m[3], m[2], m[1]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return iso(m[1], m[2], m[3]);
  if (/^\d{5}(\.\d+)?$/.test(s)) return normalizeDate(Number(s));
  return null;
}
function iso(y, mo, d) {
  const Y = Number(y), M = Number(mo), D = Number(d);
  if (Y < 2000 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31) return null;
  return `${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

module.exports = {
  westernDigits, toHalalas, fromHalalas,
  normalizeIban, isValidIban, normalizeAccount, last4, maskIban, identifierHash,
  normalizeName, nameSimilarity, normalizeDate,
};
