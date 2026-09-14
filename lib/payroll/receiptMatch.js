/* ربط الإيصالات بالموظفين، ومطابقة المجموع براتب المسير — نقيّ.
   =========================================================================
   ── الربط: بمفتاح قاطع فريد وحده ──
   IBAN المستفيد، ثم — عند غيابه إطلاقًا — رقم حساب المستفيد كما تطبعه
   صيغة ANB داخل نطاق «إلى». والاسم تعزيزٌ يُعرَض ولا يربط. والمبلغ
   ممنوع أن يكون مفتاح هوية: راتبان متساويان شائعان في الكشف نفسه.

   ولا نزول من IBAN إلى الحساب: IBAN مستخرجٌ لا يقابل أحدًا يعني خللًا
   في سجلّ الموظفين يستحقّ المراجعة، والنزول يربط بموظف على أساس أضعف
   بعد أن رفض الأقوى.

   ── المطابقة: على المجموع لا على إيصال واحد ──
   موظف قد يتلقّى تحويلين في الشهر نفسه، فالمقارنة:
     receiptTotal = Σ (الإيصالات المربوطة القابلة للاحتساب)
     receiptTotal == sheet_amount   بالهللات الصحيحة، سماحية صفر

   والمرشّح للتكرار لا يُحتسب حتى يُحسم: إيصالان متطابقان نصًّا ولا
   نعرف أيّهما الحقيقي، فاحتساب أحدهما تخمينٌ مبنيّ على ترتيب الرفع. */

/* أسماء الحقول كما تُخزَّن في employees.data — منقولة من خريطة
   doc-status.js التي تشاركها الواجهة، لا مُخمَّنة. وقد خمّنتُ أولًا
   «رقم الآيبان» فوجدت المخزَّن «IBAN» حرفيًا: تخمينُ اسم حقل يُنتج
   فهرسًا فارغًا فلا يُربط إيصالٌ واحد، والعطل صامت لأن «لا مطابقة»
   نتيجةٌ مشروعة في هذا النظام. */
const F_IBAN = "IBAN";
const F_ACCOUNT = "رقم الحساب";
const F_NAME_BANK = "اسم المستفيد (كما في البنك)";
const F_DAMANAH = "الرقم الوظيفي";

/* حالات الإيصال — البُعد الأول. التكرار بُعد مستقلّ (dupState). */
const LINK_LINKED = "linked";
const LINK_AMBIGUOUS = "ambiguous";
const LINK_UNLINKED = "unlinked";
const LINK_UNREADABLE = "unreadable";

/* حالات الموظف — مشتقّة، لا تُخزَّن. */
const M_MATCHED = "matched";
const M_PARTIAL = "partial";
const M_OVERPAID = "overpaid";
const M_MISSING = "missing_receipt";
const M_REVIEW = "needs_review";

const halalas = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null);

/* تطبيع المعرّفات: الفراغ والشرطات تُزال، والحروف تُرفع. IBAN يُكتب
   أحيانًا بمسافات كل أربعة محارف في سجلّ أُدخل بيد إنسان. */
const normId = (v) => String(v == null ? "" : v).replace(/[\s-]/g, "").toUpperCase();

/* فهرسان للموظفين: بالـIBAN وبرقم الحساب. القيمة مصفوفة لا موظف واحد،
   فتعدّد الحاملين يُكتشف ولا يُختار منه. */
function indexEmployees(employees) {
  const byIban = new Map();
  const byAccount = new Map();
  for (const e of employees || []) {
    const eid = String((e && e[F_DAMANAH]) || "").trim();
    if (!eid) continue;
    const iban = normId(e[F_IBAN]);
    const account = normId(e[F_ACCOUNT]);
    if (iban) {
      if (!byIban.has(iban)) byIban.set(iban, []);
      byIban.get(iban).push(e);
    }
    if (account) {
      if (!byAccount.has(account)) byAccount.set(account, []);
      byAccount.get(account).push(e);
    }
  }
  return { byIban, byAccount };
}

/* يربط إيصالًا واحدًا. يُرجع { linkStatus, employeeEid, matchKey,
   linkReason, candidates } ولا يُخمّن عند أدنى التباس. */
function linkReceipt(receipt, index) {
  const iban = normId(receipt.extIban);
  const account = normId(receipt.extAccount);

  if (!iban && !account) {
    return { linkStatus: LINK_UNREADABLE, employeeEid: null, matchKey: null,
             linkReason: "لا معرّف مستفيد مقروء في الإيصال", candidates: null };
  }

  const eidOf = (e) => String(e[F_DAMANAH] || "").trim();
  const listOf = (arr) => (arr || []).map((e) => ({ eid: eidOf(e), name: e[F_NAME_BANK] || null }));

  if (iban) {
    const hits = index.byIban.get(iban) || [];
    if (hits.length === 1) {
      return { linkStatus: LINK_LINKED, employeeEid: eidOf(hits[0]), matchKey: "iban",
               linkReason: null, candidates: null };
    }
    if (hits.length > 1) {
      return { linkStatus: LINK_AMBIGUOUS, employeeEid: null, matchKey: null,
               linkReason: "الآيبان نفسه عند أكثر من موظف في السجلّ", candidates: listOf(hits) };
    }
    /* IBAN مستخرج ولا صاحب له: لا نزول إلى الحساب. */
    return { linkStatus: LINK_UNLINKED, employeeEid: null, matchKey: null,
             linkReason: "آيبان الإيصال لا يقابل أي موظف في السجلّ", candidates: null };
  }

  const hits = index.byAccount.get(account) || [];
  if (hits.length === 1) {
    return { linkStatus: LINK_LINKED, employeeEid: eidOf(hits[0]), matchKey: "account",
             linkReason: null, candidates: null };
  }
  if (hits.length > 1) {
    return { linkStatus: LINK_AMBIGUOUS, employeeEid: null, matchKey: null,
             linkReason: "رقم الحساب نفسه عند أكثر من موظف في السجلّ", candidates: listOf(hits) };
  }
  return { linkStatus: LINK_UNLINKED, employeeEid: null, matchKey: null,
           linkReason: "رقم حساب الإيصال لا يقابل أي موظف في السجلّ", candidates: null };
}

/* الاسم تعزيز: تناقضه لا يُلغي ربطًا بمفتاح قاطع، لكنه يُعرَض. */
function nameWarning(receipt, employee) {
  const onReceipt = String(receipt.extBeneficiary || "").trim().toUpperCase();
  const onRecord = String((employee && employee[F_NAME_BANK]) || "").trim().toUpperCase();
  if (!onReceipt || !onRecord) return null;
  const words = (s) => new Set(s.split(/\s+/).filter((w) => w.length > 2));
  const a = words(onReceipt);
  const b = words(onRecord);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared === 0 ? "اسم المستفيد في الإيصال يخالف الاسم البنكي في السجلّ" : null;
}

function linkAll(receipts, employees) {
  const index = indexEmployees(employees);
  const byEid = new Map();
  for (const e of employees || []) byEid.set(String(e[F_DAMANAH] || "").trim(), e);
  return (receipts || []).map((r) => {
    const link = linkReceipt(r, index);
    const warn = link.employeeEid ? nameWarning(r, byEid.get(link.employeeEid)) : null;
    return { ...r, ...link, nameWarning: warn };
  });
}

/* ─── المطابقة على مستوى الموظف ─── */

/* proof — صفّ الموظف في المسير: { eid, name, sheetAmount }.
   linked — الإيصالات بعد الربط.

   الترتيب هو المنطق: كل صور نقص المعرفة تُحسم قبل أي حكم على الأرقام،
   فلا يُعلَن «مطابق» على مجموع ناقص ولا «جزئي» على مجموع غير موثوق. */
function matchEmployee(proof, linked) {
  const eid = String(proof.eid);
  const mine = (linked || []).filter((r) => r.linkStatus === LINK_LINKED && String(r.employeeEid) === eid);
  /* القابل للاحتساب هو المحسوم مشروعًا وحده — none أو distinct. و
     redundant **لا يُحتسب**: حُسم أنه تكرار. واستثناء candidate وحده
     كان يُدخل المكرّر المحسوم في المجموع فيُضاعف مبلغًا حُسم أنه واحد. */
  const countable = mine.filter((r) => r.dupState === undefined || r.dupState === "none" || r.dupState === "distinct");
  const pending = mine.filter((r) => r.dupState === "candidate");
  const missingAmount = countable.filter((r) => halalas(r.extAmount) === null);
  /* إيصال ملتبس يُرشّح هذا الموظف بين مرشّحيه. */
  const claiming = (linked || []).filter(
    (r) => r.linkStatus === LINK_AMBIGUOUS && (r.candidates || []).some((c) => String(c.eid) === eid)
  );

  const sheet = halalas(proof.sheetAmount);
  const receiptTotal = countable.reduce((a, r) => a + (halalas(r.extAmount) || 0), 0);

  const base = {
    eid, receipts: mine, countable, pending, claiming,
    receiptTotal: countable.length ? receiptTotal / 100 : null,
    sheetAmount: proof.sheetAmount === undefined ? null : proof.sheetAmount,
    difference: null,
  };

  if (sheet === null) return { ...base, status: M_REVIEW, reason: "راتب المسير غير مقروء بعد" };
  if (pending.length) return { ...base, status: M_REVIEW, reason: "إيصال مرشّح للتكرار لم يُحسم بعد" };
  if (missingAmount.length) return { ...base, status: M_REVIEW, reason: "إيصال مربوط بلا مبلغ مقروء" };
  if (claiming.length) return { ...base, status: M_REVIEW, reason: "إيصال ملتبس يُرشّح هذا الموظف" };
  if (!countable.length) return { ...base, status: M_MISSING, reason: "لا إيصال تحويل لهذا الموظف" };

  const diff = (receiptTotal - sheet) / 100;
  if (receiptTotal === sheet) return { ...base, status: M_MATCHED, difference: 0 };
  return {
    ...base,
    status: receiptTotal < sheet ? M_PARTIAL : M_OVERPAID,
    difference: diff,
    reason: receiptTotal < sheet
      ? "مجموع التحويلات أقلّ من راتب المسير"
      : "مجموع التحويلات أعلى من راتب المسير",
  };
}

function matchAll(proofs, linked) {
  return (proofs || []).map((p) => matchEmployee(p, linked));
}

/* ملخّص للعرض: الرقائق أعلى الصفحة. */
function summarize(matches, linked) {
  const count = (s) => matches.filter((m) => m.status === s).length;
  return {
    employees: matches.length,
    matched: count(M_MATCHED),
    partial: count(M_PARTIAL),
    overpaid: count(M_OVERPAID),
    missingReceipt: count(M_MISSING),
    needsReview: count(M_REVIEW),
    receipts: (linked || []).length,
    linked: (linked || []).filter((r) => r.linkStatus === LINK_LINKED).length,
    ambiguous: (linked || []).filter((r) => r.linkStatus === LINK_AMBIGUOUS).length,
    unlinked: (linked || []).filter((r) => r.linkStatus === LINK_UNLINKED).length,
    unreadable: (linked || []).filter((r) => r.linkStatus === LINK_UNREADABLE).length,
    duplicateCandidates: (linked || []).filter((r) => r.dupState === "candidate").length,
  };
}

module.exports = {
  indexEmployees, linkReceipt, linkAll, nameWarning,
  matchEmployee, matchAll, summarize, halalas, normId,
  LINK_LINKED, LINK_AMBIGUOUS, LINK_UNLINKED, LINK_UNREADABLE,
  M_MATCHED, M_PARTIAL, M_OVERPAID, M_MISSING, M_REVIEW,
  F_IBAN, F_ACCOUNT, F_NAME_BANK, F_DAMANAH,
};
