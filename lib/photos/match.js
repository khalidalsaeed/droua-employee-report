/* مطابقة اسم ملفّ الصورة بسجلّ الموظف — بالاسم وحده.
   =========================================================================
   الصورة نفسها لا تُفتح هنا: لا تعرّف على الوجه، ولا تحليل لمحتواها،
   ولا ترتيب إرسال. المدخل اسم الملفّ («صورة <الاسم>.jpg») وحده.

   القاعدة: لا تخمين — بالترتيب:
     ① تطابق تامّ مع الاسم العربي بعد التطبيع (همزات، تاء مربوطة، مسافات).
     ② تطابق تامّ مع الاسم الإنجليزي.
     ③ اسمٌ مكرّر في السجلّ خطأَ إدخال («راسل ديوان راسل ديوان»).
     ④ اسمٌ مختصر اعتمده صاحب القرار صراحةً (CONFIRMED_ALIASES).
   ما عدا ذلك:
     - ambiguous: كلمات الاسم كلها موجودة في اسم موظف أو أكثر، بلا تطابق تامّ.
       لا يُربط حتى يُعتمد.
     - unmatched: لا موظف يحمل كلمات الاسم.
   اسمٌ تامّ يحمله موظفان ملتبسٌ أيضًا — لا «أوّل نتيجة». */

const OrgCore = require("../../org-core");

/* اختصارات اعتمدها مدير الموارد البشرية في 2026-10-18 بعد مراجعة نتيجة
   المطابقة: اسم الملفّ ← الاسم العربي كما في المصدر. لا تُضاف هنا
   مطابقة لم تُعتمد صراحةً. */
const CONFIRMED_ALIASES = Object.freeze({
  "ساجر": "ساجر احمد",
  "فرهاد": "مد فرهاد علي شاركير",
  "مد طيف الرحمن": "مد طيف الرحمن شهاب",
  "شميم": "شميم حسين",
});

const PREFIX_RE = /^\s*صورة\s+/;

/* «صورة محمد راسل برودان.jpg» ← «محمد راسل برودان» */
function nameFromFile(fileName) {
  const base = String(fileName || "").split(/[\\/]/).pop();
  return base.replace(/\.[A-Za-z0-9]+$/, "").replace(PREFIX_RE, "").trim();
}

const tokens = (s) => OrgCore.norm(s).split(" ").filter(Boolean);

function matchName(name, rows) {
  const key = OrgCore.norm(name);
  if (!key) return { status: "unmatched", candidates: 0 };

  const exact = (field) => rows.filter((r) => r[field] && OrgCore.norm(r[field]) === key);
  for (const [field, via] of [["nameAr", "arabic"], ["nameEn", "english"]]) {
    const hits = exact(field);
    if (hits.length === 1) return { status: "matched", via, row: hits[0] };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
  }

  /* ③ خطأ إدخال مُثبت من البيانات نفسها: الاسم العربي مكتوبٌ مرّتين متتاليتين
     («راسل ديوان راسل ديوان»). يُقارن بنصفه إن كان النصفان متطابقين حرفيًا
     — لا حذف لأي كلمة أخرى ولا مطابقة جزئية. */
  const doubled = rows.filter((r) => {
    const t = tokens(r.nameAr || "");
    const half = t.length / 2;
    return t.length >= 2 && Number.isInteger(half) &&
      t.slice(0, half).join(" ") === t.slice(half).join(" ") && t.slice(0, half).join(" ") === key;
  });
  if (doubled.length === 1) return { status: "matched", via: "doubled_record_name", row: doubled[0] };
  if (doubled.length > 1) return { status: "ambiguous", candidates: doubled.length };

  const aliasKey = Object.keys(CONFIRMED_ALIASES).find((k) => OrgCore.norm(k) === key);
  if (aliasKey) {
    const target = OrgCore.norm(CONFIRMED_ALIASES[aliasKey]);
    const hits = rows.filter((r) => r.nameAr && OrgCore.norm(r.nameAr) === target);
    if (hits.length === 1) return { status: "matched", via: "confirmed_alias", row: hits[0] };
    return { status: "ambiguous", candidates: hits.length };
  }

  const want = tokens(name);
  const partial = rows.filter((r) => [r.nameAr, r.nameEn].some((n) => {
    if (!n) return false;
    const have = new Set(tokens(n));
    return want.every((t) => have.has(t));
  }));
  if (partial.length) return { status: "ambiguous", candidates: partial.length };
  return { status: "unmatched", candidates: 0 };
}

function matchFile(fileName, rows) {
  return { file: fileName, name: nameFromFile(fileName), ...matchName(nameFromFile(fileName), rows) };
}

module.exports = { matchFile, matchName, nameFromFile, CONFIRMED_ALIASES };
