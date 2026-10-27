const { normalizeArabic, parseDate, toAsciiDigits } = require("./extract");

/* ─── مطابقة بيانات الملفّ بالنتيجة الرسمية من «صحة» ───
   =========================================================================
   المفاتيح الحاسمة (رقم الإجازة، رقم الهوية، البداية، النهاية) تُقارن حرفيًا
   بعد تطبيع الشكل وحده: حروف كبيرة ومسافات لرقم الإجازة، أرقام فقط للهوية،
   ISO للتواريخ. لا مطابقة تقريبية عليها إطلاقًا — رقم يختلف بخانة واحدة
   مختلفٌ تمامًا.

   الاسم مفتاح تأكيد: اختلاف إملائي بسيط (همزة، تاء مربوطة، حرف واحد) يُعرض
   تنبيهًا ولا يُسقط التحقّق. اسمٌ مختلف فعلًا يُسقطه. واسمان بلغتين مختلفتين
   لا يُقارَنان ولا يُسقطان شيئًا — يُعرضان للمراجعة البشرية.

   الحالات:
     verified     كل المفاتيح الحاسمة متطابقة (وقد يرافقها تنبيه على الاسم)
     mismatch     الإجازة موجودة رسميًا لكن بيانات الملفّ تختلف عنها
     not_found    «صحة» لم تُرجع إجازة بهذا الرقم وهذه الهوية
     unavailable  الخدمة الرسمية لم تُجب — ليس دليلًا على شيء */

const STATUS = { VERIFIED: "verified", MISMATCH: "mismatch", NOT_FOUND: "not_found", UNAVAILABLE: "unavailable" };

const normLeaveId = (v) => String(v == null ? "" : v).toUpperCase().replace(/\s+/g, "") || null;
const normId = (v) => toAsciiDigits(String(v == null ? "" : v)).replace(/\D/g, "") || null;

function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = parseDate(s);
  return p ? p.iso : null;
}

/* ---------- الاسم ---------- */

function nameKey(v) {
  return normalizeArabic(v)
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    /* «عبد الله» و«عبدالله» اسم واحد */
    .replace(/(^|\s)عبد\s+/g, "$1عبد")
    .replace(/(^|\s)(bin|ibn|بن|ابن)(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function script(v) {
  const s = String(v || "");
  const ar = (s.match(/[؀-ۿ]/g) || []).length;
  const la = (s.match(/[A-Za-z]/g) || []).length;
  if (!ar && !la) return null;
  return ar >= la ? "ar" : "latin";
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/* exact | minor | different | not_comparable | missing */
function compareNames(fileName, officialName) {
  if (!fileName || !officialName) return { result: "missing" };
  const sa = script(fileName), sb = script(officialName);
  if (!sa || !sb || sa !== sb) return { result: "not_comparable" };
  const a = nameKey(fileName), b = nameKey(officialName);
  if (!a || !b) return { result: "missing" };
  if (a === b) return { result: "exact" };
  const ta = a.split(" "), tb = b.split(" ");
  /* اسم مختصر (ثنائي/ثلاثي) داخل الاسم الكامل: كل كلماته موجودة بالترتيب. */
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  let k = 0;
  for (const w of long) if (k < short.length && w === short[k]) k++;
  if (short.length >= 2 && k === short.length) return { result: "minor", kind: "subset" };
  const dist = levenshtein(a.replace(/\s/g, ""), b.replace(/\s/g, ""));
  const len = Math.max(a.replace(/\s/g, "").length, b.replace(/\s/g, "").length);
  /* حرف واحد لكل خمسة أحرف تقريبًا، وثلاثة أحرف على الأكثر. */
  if (dist <= Math.min(3, Math.floor(len / 5))) return { result: "minor", kind: "spelling" };
  return { result: "different" };
}

/* ---------- المقارنة ---------- */

/* file: الحقول المستخرجة من الملفّ (أو المُدخلة يدويًا لملفّ ممسوح).
   lookup: نتيجة الاستعلام الرسمي { status: found|not_found|unavailable, record?, reason? }. */
function compareWithOfficial(file, lookup) {
  const f = file || {};
  if (!lookup || lookup.status === "unavailable") {
    return { status: STATUS.UNAVAILABLE, reason: (lookup && lookup.reason) || "service_unavailable", checks: [], differences: [], notes: [] };
  }
  if (lookup.status === "not_found") {
    return {
      status: STATUS.NOT_FOUND,
      reason: "leave_not_found",
      checks: [],
      differences: [{ field: "leaveId", code: "leave_not_found" }],
      notes: [],
    };
  }

  const r = lookup.record || {};
  const checks = [];
  const differences = [];
  const notes = [];

  const critical = [
    { field: "leaveId", file: normLeaveId(f.leaveId), official: normLeaveId(r.leaveId), code: "leave_id_mismatch" },
    { field: "idNumber", file: normId(f.idNumber), official: normId(r.idNumber), code: "id_mismatch" },
    { field: "startDate", file: normDate(f.startDate), official: normDate(r.startDate), code: "start_date_mismatch" },
    { field: "endDate", file: normDate(f.endDate), official: normDate(r.endDate), code: "end_date_mismatch" },
  ];
  for (const c of critical) {
    if (!c.file || !c.official) {
      checks.push({ field: c.field, result: "missing", side: !c.file ? "file" : "official" });
      differences.push({ field: c.field, code: !c.file ? "missing_in_file" : "missing_in_official" });
      continue;
    }
    const same = c.file === c.official;
    checks.push({ field: c.field, result: same ? "match" : "mismatch" });
    if (!same) differences.push({ field: c.field, code: c.code, file: c.file, official: c.official });
  }

  /* عدد الأيام: إن ذكره الطرفان صراحةً فاختلافه اختلافٌ عن السجلّ الرسمي.
     لا يُشتقّ من تواريخ صحة هنا — اختلاف التاريخين مذكورٌ أعلاه باسمه. */
  const fileDays = f.days != null && f.days !== "" ? Number(f.days) : null;
  const offDays = r.days != null && r.days !== "" ? Number(r.days) : null;
  if (Number.isFinite(fileDays) && Number.isFinite(offDays)) {
    const same = fileDays === offDays;
    checks.push({ field: "days", result: same ? "match" : "mismatch" });
    if (!same) differences.push({ field: "days", code: "days_mismatch", file: fileDays, official: offDays });
  }

  const nm = compareNames(f.name, r.name);
  checks.push({ field: "name", result: nm.result === "exact" ? "match" : nm.result, kind: nm.kind });
  if (nm.result === "different") differences.push({ field: "name", code: "name_mismatch" });
  else if (nm.result === "minor") notes.push({ field: "name", code: "name_minor_difference", kind: nm.kind });
  else if (nm.result === "not_comparable") notes.push({ field: "name", code: "name_not_comparable" });

  return {
    status: differences.length ? STATUS.MISMATCH : STATUS.VERIFIED,
    reason: differences.length ? differences[0].code : null,
    checks,
    differences,
    notes,
  };
}

module.exports = { compareWithOfficial, compareNames, nameKey, normLeaveId, normId, normDate, STATUS };
