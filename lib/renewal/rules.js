/* قواعد «تجديد المستند» المشتركة — البطاقات البلدية وتصاريح أجير.
   =========================================================================
   دوالّ نقيّة بلا شبكة ولا قاعدة: تأخذ ما استُخرج من الملفّ الجديد وما في
   البطاقة الحالية، وتقرّر هل يُستبدَل. كل رفض يحمل:
     stage   الخطوة التي توقّف عندها (read / type / match / verify) — تعرضها
             شاشة التقدّم علامةَ ✕ على الخطوة نفسها.
     reason  رمز ثابت للاختبارات وسجلّ التدقيق.
     message النصّ العربي للمستخدم.

   ترتيب قوّة المطابقة:
     1. رقم الهوية/الإقامة — يقرّر وحده.
     2. لا شيء يحلّ محلّه: ملفّ بلا هوية مقروءة يُرفض (no_identifier)، ولا
        يُكتفى بالاسم أبدًا.
     3. الاسم تعزيز فقط: يُقارن بالاسم المطبوع على المستند السابق (الخطّ نفسه:
        عربي للبلدية، لاتيني لأجير). اختلاف طفيف يمرّ ويُذكر؛ اختلاف جذري مع
        هوية مطابقة يُرفض احتياطًا (name_mismatch) لأنه علامة خطأ في أحد
        السجلّين لا تجديد.

   الرفض لا يكتب شيئًا: المُنادي لا يرفع ملفًّا ولا يلمس الفهرس/القاعدة قبل
   أن تعيد هذه الدالّة ok:true. */

const MESSAGES = {
  unreadable: "المستند تالف أو غير مدعوم",
  wrong_type: "نوع المستند غير صحيح",
  duplicate: "هذا المستند مسجل مسبقًا",
  no_identifier: "لم نستطع استخراج رقم هوية/إقامة كافٍ من المستند",
  no_employee_identifier: "لا يوجد رقم هوية/إقامة مسجّل للموظف الحالي للمطابقة به",
  other_employee: "المستند المرفوع يبدو أنه يخص موظفًا آخر",
  id_mismatch: "الهوية مختلفة عن هوية الموظف الحالي",
  name_mismatch: "الاسم مختلف بشكل كبير رغم تطابق الهوية — راجع السجلّ قبل الاستبدال",
  no_expiry: "تعذّر قراءة تاريخ الانتهاء من المستند",
  older: "المستند المرفوع أقدم من المستند الحالي",
  not_newer: "المستند المرفوع لا يمدّد الصلاحية الحالية",
  expired: "المستند المرفوع منتهي الصلاحية",
  implausible_expiry: "تاريخ الانتهاء في المستند غير منطقي",
  qr_invalid: "رمز QR في المستند غير صالح أو لا يطابق الرابط الرسمي",
  changed_meanwhile: "تغيّرت البطاقة أثناء العملية — أعد المحاولة",
};

/* كم سنة إلى الأمام يُقبل تاريخ انتهاء قبل أن يُعدّ خطأ قراءة. */
const MAX_YEARS_AHEAD = { municipal: 5, ajeer: 2 };

const DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const digits = (v) => String(v == null ? "" : v).replace(/[٠-٩]/g, (d) => DIGITS[d]).replace(/\D/g, "");

function normName(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/[ً-ٰ]/g, "")
    .replace(/[إأآٱ]/g, "ا").replace(/[ىئ]/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/* تشابه الاسمين 0..1: الأعلى بين تداخل الكلمات ومعامل Dice على الثنائيات
   الحرفية. «SHAKIB MIA» و«MD SHAKIB MIA» ≈ 0.85؛ اسمان لا علاقة بينهما < 0.2. */
function nameSimilarity(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return null;
  if (x === y) return 1;
  const tx = new Set(x.split(" ")), ty = new Set(y.split(" "));
  const shared = [...tx].filter((t) => ty.has(t)).length;
  const tokens = shared / Math.min(tx.size, ty.size);
  const grams = (s) => { const g = new Map(), t = s.replace(/ /g, ""); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const gx = grams(x), gy = grams(y);
  let inter = 0, nx = 0, ny = 0;
  gx.forEach((n, k) => { nx += n; inter += Math.min(n, gy.get(k) || 0); });
  gy.forEach((n) => { ny += n; });
  const dice = nx + ny ? (2 * inter) / (nx + ny) : 0;
  return Math.round(Math.max(tokens, dice) * 100) / 100;
}
const NAME_DRASTIC = 0.34;
const NAME_CLOSE = 0.75;

function riyadhToday(now = Date.now()) {
  return new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
const dayMs = 86400000;
const toDay = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
function daysBetween(fromIso, toIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromIso)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toIso))) return null;
  return Math.round((toDay(toIso) - toDay(fromIso)) / dayMs);
}

const fail = (stage, reason, extra) => ({ ok: false, stage, reason, message: MESSAGES[reason], ...(extra || {}) });

/* القرار. المدخلات:
     kind       "municipal" | "ajeer"
     current    { docNumber, expiryDate, nameOnDoc, employee: { eid, name, iqama } | null,
                  knownHashes: [sha256…], knownDocNumbers: [..] }
     extracted  { ok, reason, docNumber, idNumber, name, expiryDate, qrOk }
     fileHash   sha256 للملفّ الجديد
     otherEmployee  { eid, name } إن وُجد موظف آخر بهوية المستند
     today      YYYY-MM-DD (الرياض) */
function decideRenewal({ kind, current, extracted, fileHash, otherEmployee, today }) {
  const t = today || riyadhToday();
  if (!extracted || extracted.reason === "not_pdf" || extracted.reason === "parse_failed" || extracted.reason === "too_large") {
    return fail("read", "unreadable");
  }
  if (!extracted.ok) return fail("type", "wrong_type");

  /* المكرّر قبل كل شيء: الملفّ نفسه (بصمة)، أو المستند نفسه برقمه. */
  if (fileHash && (current.knownHashes || []).includes(fileHash)) return fail("type", "duplicate");
  /* رقم المستند نفسه: مكرّر إن لم يمدّد الصلاحية (قد تُجدَّد شهادة برقمها
     نفسه، فالرقم وحده لا يكفي للحكم). رقم مسجّل في التاريخ أو في سجلّ آخر
     مكرّر دائمًا. */
  if (extracted.docNumber && extracted.docNumber === current.docNumber && !(extracted.expiryDate > (current.expiryDate || ""))) {
    return fail("type", "duplicate");
  }

  /* الهوية. */
  const docId = digits(extracted.idNumber);
  if (docId.length !== 10) return fail("match", "no_identifier");
  const empId = digits(current.employee && current.employee.iqama);
  if (!empId) return fail("match", "no_employee_identifier");
  if (docId !== empId) {
    if (otherEmployee && String(otherEmployee.eid) !== String(current.employee.eid)) {
      return fail("match", "other_employee", { otherEmployee: { eid: String(otherEmployee.eid), name: otherEmployee.name || null } });
    }
    return fail("match", "id_mismatch");
  }
  /* رقم مسجّل في التاريخ أو في سجلّ آخر — بعد الهوية عمدًا: مستند موظف آخر
     يُبلَّغ «يخص موظفًا آخر» لا «مسجّل مسبقًا». */
  if (extracted.docNumber && (current.knownDocNumbers || []).includes(extracted.docNumber)) return fail("type", "duplicate");
  const similarity = nameSimilarity(extracted.name, current.nameOnDoc || (current.employee && current.employee.name));
  if (similarity != null && similarity < NAME_DRASTIC) return fail("match", "name_mismatch", { nameSimilarity: similarity });

  /* التواريخ. */
  const newExp = extracted.expiryDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(newExp || ""))) return fail("verify", "no_expiry");
  const oldExp = current.expiryDate;
  if (oldExp && newExp < oldExp) return fail("verify", "older", { previousExpiry: oldExp, newExpiry: newExp });
  if (oldExp && newExp === oldExp) return fail("verify", "not_newer", { previousExpiry: oldExp, newExpiry: newExp });
  if (newExp < t) return fail("verify", "expired", { newExpiry: newExp });
  if (daysBetween(t, newExp) > MAX_YEARS_AHEAD[kind] * 366) return fail("verify", "implausible_expiry", { newExpiry: newExp });

  if (!extracted.qrOk) return fail("verify", "qr_invalid");

  return {
    ok: true,
    nameSimilarity: similarity,
    nameMatch: similarity == null ? "unknown" : similarity >= NAME_CLOSE ? "close" : "partial",
    previousExpiry: oldExp || null,
    newExpiry: newExp,
    extendedDays: oldExp ? daysBetween(oldExp, newExp) : null,
    daysLeft: daysBetween(t, newExp),
  };
}

module.exports = { decideRenewal, nameSimilarity, daysBetween, riyadhToday, digits, MESSAGES, MAX_YEARS_AHEAD };
