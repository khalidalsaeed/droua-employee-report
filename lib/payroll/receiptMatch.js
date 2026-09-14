/* ربط الإيصالات بالموظفين، ومطابقة المجموع براتب المسير — نقيّ.
   =========================================================================
   ── الربط: بمفتاح قاطع فريد وحده ──
   IBAN المستفيد، ثم — عند غيابه إطلاقًا — **الزوج** (رقم حساب المستفيد ·
   اسم بنكه) كما تطبعهما صيغة ANB داخل نطاق «إلى». والاسم تعزيزٌ يُعرَض
   ولا يربط. والمبلغ ممنوع أن يكون مفتاح هوية: راتبان متساويان شائعان في
   الكشف نفسه.

   ── لماذا الزوج لا الرقم الخام ──
   رقم الحساب الداخلي **ليس فريدًا عالميًا**: بنكان مختلفان قد يُصدران
   الرقم نفسه، فتطابقٌ خام قد يربط إيصالًا بموظف ليس صاحبه. والفهرس
   يكشف ازدواج الرقم **داخل سجلّنا** ولا يحمي من ازدواجه **عبر البنوك**.

   وقاعدة الاشتقاق من IBAN — «الحساب هو ذيل الآيبان» — فُحصت على
   المستندات الحقيقية فلم تُثبت: لا عيّنة واحدة تحمل IBAN حقيقيًا ورقم
   حساب مستقلًّا معًا، والأطوال لا تتّفق. فبقي المخرج الآمن: تقييد
   الحساب بسياق بنكه، وإلّا `unlinked` لمراجعة إنسان.

   **ولا fallback إلى الرقم الخام إطلاقًا** — غياب البنك من الإيصال أو
   من السجلّ أو تعارضهما كلّها `unlinked`، لا ربطٌ بأساس أضعف.

   ولا نزول من IBAN إلى الحساب: IBAN مستخرجٌ لا يقابل أحدًا يعني خللًا
   في سجلّ الموظفين يستحقّ المراجعة، والنزول يربط بموظف على أساس أضعف
   بعد أن رفض الأقوى. واسم البنك على مسار IBAN **إشارةُ تحقّق تُعرَض**
   ولا تُلغي تطابقًا صحيحًا: اسم بنك نصّي ضعيفٌ أمام مفتاح قاطع.

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
const F_BANK = "اسم البنك";
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

/* ─── تطبيع اسم البنك ─── */

/* محافظٌ وحتمي: كل خطوة تُزيل اختلافًا في **الكتابة** لا في **الهوية**.
   ولا تشابه تقريبي إطلاقًا — لا مسافة تحرير ولا بادئة مشتركة ولا إسقاط
   للواحق كـ«التجاري» و«السعودي»: اسمان يشتركان في كلمة قد يكونان بنكين
   مختلفين، وربطٌ خاطئ هنا يُحوّل راتبًا إلى غير صاحبه.

   الخطوات بترتيبها:
     ① NFKC — المستندات تُخرج العربية بصور العرض، وبلا هذا لا يتطابق
        نصّ الإيصال مع نصّ السجلّ أبدًا. (وهو الدرس نفسه الذي أفقدنا
        المستفيد والبنك والمرسل في عشرة إيصالات.)
     ② إسقاط التشكيل والتطويل.
     ③ توحيد الأشكال المعروفة وحدها: آ أ إ ٱ ← ا · ى ← ي · ة ← ه.
     ④ رفع الحروف اللاتينية.
     ⑤ إسقاط كل ما ليس حرفًا ولا رقمًا — المسافات والترقيم والأقواس.
        فـ«AL RAJHI» و«ALRAJHI» اسمٌ واحد كُتب بفراغ زائد، لا بنكان.

   ثم — وأخيرًا — جدول مرادفات **صريح** يُطبَّق على المفتاح المُطبَّع،
   وهو فارغ عمدًا: لا يُدخَل مرادف لم يُرَ في مستند حقيقي وسجلّ حقيقي
   معًا. فبنكٌ يطبع اختصاره في الإيصال واسمه الكامل في السجلّ يبقى
   `unlinked` حتى يُضاف مرادفه بعد تحقّق — وهذا الفشل الآمن هو المقصود
   لا نقصٌ فيه. */
const BANK_ALIASES = Object.freeze({});

const AR_MARKS = /[ً-ْٰـ]/g;
function normBank(value, aliases) {
  let s = String(value == null ? "" : value).normalize("NFKC").trim();
  if (!s) return "";
  s = s.replace(AR_MARKS, "");
  s = s.replace(/[آأإٱ]/g, "ا");
  s = s.replace(/ى/g, "ي");
  s = s.replace(/ة/g, "ه");
  s = s.toUpperCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, "");
  if (!s) return "";
  const map = aliases === undefined ? BANK_ALIASES : aliases;
  return (map && Object.prototype.hasOwnProperty.call(map, s) ? map[s] : s) || "";
}

/* مفتاح الزوج. الفاصل محرف لا يُنتجه التطبيع — فالطرفان حروف وأرقام
   فقط بعده — فلا يلتبس زوجٌ بزوج مهما انتقل محتوى من حقل إلى آخر. */
const pairKey = (account, bank) => `${account}\u0000${bank}`;

/* ثلاثة فهارس. القيمة مصفوفة لا موظف واحد، فتعدّد الحاملين يُكتشف ولا
   يُختار منه.

   و`byAccount` **فهرس تشخيص لا ربط**: لا يُربط منه إيصالٌ أبدًا، ويُقرأ
   وحده ليُميَّز «لا صاحب لهذا الرقم» من «له صاحب ببنك آخر» — فيقرأ
   الإنسان سببًا دقيقًا بدل «لا مطابقة». */
function indexEmployees(employees, opts = {}) {
  const aliases = opts.bankAliases === undefined ? BANK_ALIASES : opts.bankAliases;
  const byIban = new Map();
  const byAccount = new Map();
  const byAccountBank = new Map();
  const push = (map, key, e) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  };
  for (const e of employees || []) {
    const eid = String((e && e[F_DAMANAH]) || "").trim();
    if (!eid) continue;
    const iban = normId(e[F_IBAN]);
    const account = normId(e[F_ACCOUNT]);
    const bank = normBank(e[F_BANK], aliases);
    if (iban) push(byIban, iban, e);
    if (account) {
      push(byAccount, account, e);
      /* سجلٌّ بلا اسم بنك لا يدخل الفهرس الرابط إطلاقًا — فلا يُفتح
         للحساب الخام بابٌ خلفي من جهة السجلّ. */
      if (bank) push(byAccountBank, pairKey(account, bank), e);
    }
  }
  return { byIban, byAccount, byAccountBank, bankAliases: aliases };
}

/* يربط إيصالًا واحدًا. يُرجع { linkStatus, employeeEid, matchKey,
   linkReason, linkReasonCode, candidates } ولا يُخمّن عند أدنى التباس.

   و`linkReasonCode` رمزٌ ثابت للآلة بجانب النصّ العربي للإنسان: عبارةٌ
   تُعاد صياغتها لا تكسر واجهةً ولا اختبارًا. */
function linkReceipt(receipt, index) {
  const aliases = index && index.bankAliases;
  const iban = normId(receipt.extIban);
  const account = normId(receipt.extAccount);
  const bank = normBank(receipt.extBank, aliases);

  const no = (code, reason, candidates = null) => ({
    linkStatus: candidates ? LINK_AMBIGUOUS : LINK_UNLINKED,
    employeeEid: null, matchKey: null, linkReason: reason, linkReasonCode: code, candidates,
  });

  if (!iban && !account) {
    return { linkStatus: LINK_UNREADABLE, employeeEid: null, matchKey: null,
             linkReason: "لا معرّف مستفيد مقروء في الإيصال",
             linkReasonCode: "no_identifier", candidates: null };
  }

  const eidOf = (e) => String(e[F_DAMANAH] || "").trim();
  const listOf = (arr) => (arr || []).map((e) => ({ eid: eidOf(e), name: e[F_NAME_BANK] || null }));

  /* ① IBAN — مفتاح قاطع مستقلّ. اسم البنك لا يدخل مفتاحه ولا يُبطله:
     الآيبان يحمل رمز بنكه في محرفيه الخامس والسادس، فهو مُغنٍ عن اسم
     نصّي قد يُكتب بصيغتين. وتعارض الاسم يُعرَض تحذيرًا في linkAll. */
  if (iban) {
    const hits = index.byIban.get(iban) || [];
    if (hits.length === 1) {
      return { linkStatus: LINK_LINKED, employeeEid: eidOf(hits[0]), matchKey: "iban",
               linkReason: null, linkReasonCode: null, candidates: null };
    }
    if (hits.length > 1) {
      return no("iban_multiple_owners", "الآيبان نفسه عند أكثر من موظف في السجلّ", listOf(hits));
    }
    /* IBAN مستخرج ولا صاحب له: لا نزول إلى الحساب. */
    return no("iban_no_owner", "آيبان الإيصال لا يقابل أي موظف في السجلّ");
  }

  /* ② الحساب — بالزوج وحده، ولا fallback إلى الرقم الخام في أي فرع. */
  if (!bank) {
    return no("receipt_bank_missing",
      "لا اسم بنك مقروء في الإيصال — رقم الحساب وحده لا يربط، يلزم ربط يدوي");
  }

  const pairHits = index.byAccountBank.get(pairKey(account, bank)) || [];
  if (pairHits.length === 1) {
    return { linkStatus: LINK_LINKED, employeeEid: eidOf(pairHits[0]), matchKey: "account+bank",
             linkReason: null, linkReasonCode: null, candidates: null };
  }
  if (pairHits.length > 1) {
    return no("account_bank_multiple_owners",
      "رقم الحساب والبنك نفساهما عند أكثر من موظف في السجلّ", listOf(pairHits));
  }

  /* لا زوج مطابق. الرقم الخام يُقرأ هنا **للتشخيص وحده** — ليقرأ
     الإنسان أي الثلاثة هو، ولا يُربط منه شيء. */
  const rawHits = index.byAccount.get(account) || [];
  if (!rawHits.length) {
    return no("account_no_owner", "رقم حساب الإيصال لا يقابل أي موظف في السجلّ");
  }
  if (!rawHits.some((e) => normBank(e[F_BANK], aliases))) {
    return no("record_bank_missing",
      "سجلّ صاحب هذا الحساب بلا اسم بنك — لا يُربط بالرقم وحده، يلزم ربط يدوي");
  }
  return no("bank_mismatch",
    "بنك الإيصال يخالف بنك السجلّ لحامل هذا الرقم — يلزم ربط يدوي");
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

/* البنك على مسار IBAN: إشارة تحقّق تُعرَض ولا تُلغي ربطًا — كالاسم.
   وعلى مسار الحساب لا معنى لها: البنك هناك **جزء من المفتاح**، فما
   رُبط فبنكه متطابق أصلًا. */
function bankWarning(receipt, employee, aliases) {
  const onReceipt = normBank(receipt && receipt.extBank, aliases);
  const onRecord = normBank(employee && employee[F_BANK], aliases);
  if (!onReceipt || !onRecord) return null;
  return onReceipt === onRecord
    ? null
    : "اسم بنك المستفيد في الإيصال يخالف اسم البنك في السجلّ";
}

function linkAll(receipts, employees, opts = {}) {
  const index = indexEmployees(employees, opts);
  const byEid = new Map();
  for (const e of employees || []) byEid.set(String(e[F_DAMANAH] || "").trim(), e);
  return (receipts || []).map((r) => {
    const link = linkReceipt(r, index);
    const employee = link.employeeEid ? byEid.get(link.employeeEid) : null;
    return {
      ...r, ...link,
      nameWarning: employee ? nameWarning(r, employee) : null,
      bankWarning: employee ? bankWarning(r, employee, index.bankAliases) : null,
    };
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
  indexEmployees, linkReceipt, linkAll, nameWarning, bankWarning,
  normBank, pairKey, BANK_ALIASES,
  matchEmployee, matchAll, summarize, halalas, normId,
  LINK_LINKED, LINK_AMBIGUOUS, LINK_UNLINKED, LINK_UNREADABLE,
  M_MATCHED, M_PARTIAL, M_OVERPAID, M_MISSING, M_REVIEW,
  F_IBAN, F_ACCOUNT, F_NAME_BANK, F_BANK, F_DAMANAH,
};
