/* ─── محرّك مطابقة التحويلات مع موظفي المسير ───
   =========================================================================
   دالّة نقيّة: (موظفو المسير، تحويلات الملفّ) ⇄ حالة لكل موظف + تحويلات لم
   تُسنَد. لا قاعدة، ولا شبكة، ولا ساعة.

   ── الهوية: من أقوى مفتاح إلى أضعفه ──
     1. الآيبان (بعد فحصه الرقابي)          → إسناد
     2. رقم الحساب                           → إسناد
     3. رقم الموظف (ضمان أو جسر) في الملفّ    → إسناد، ما لم يناقضه آيبان
     4. الاسم                                → **لا يُسند أبدًا**. يقوّي إسنادًا
                                               قائمًا أو يرشّح موظفًا للمراجعة.
     المبلغ                                  → للمقارنة فقط، لا يحدّد هوية.

   تعارض المفاتيح (آيبان يشير إلى موظف ورقم موظف إلى آخر، أو آيبان مسجّل
   لموظفين) لا يُحسم: التحويل يبقى غير مُسند ويُعرض للمراجعة.

   ── الحالات ──
     matched          تحويل واحد، والمبلغ = المستحق حتى الهللة (التسامح 0)
     amount_mismatch  تحويل واحد لموظف صحيح، والمبلغ مختلف
     not_found        لا تحويل ولا مرشّح
     needs_review     أكثر من تحويل محتمل، مرجع مكرّر، تعارض مفاتيح،
                      مرشّح بالاسم وحده، مستحق غير معروف، أو موظف نقدي
                      وصله تحويل
     cash             يُصرف راتبه نقدًا — خارج المطابقة البنكية */

const N = require("./normalize");

const TOLERANCE_HALALAS = 0; // حتى الهللة — انظر docs/payroll-transfer-reconciliation.md
const NAME_SUGGEST = 0.8;    // ترشيحٌ للمراجعة لا إسناد
const NAME_WEAK = 0.5;       // دونه يُنبَّه «اسم المستفيد مختلف» على إسنادٍ بالآيبان

const REASONS = {
  multiple_transfers: "أكثر من تحويل محتمل",
  duplicate_reference: "رقم المرجع مكرّر في الملفّ",
  key_conflict: "تعارض بين الآيبان ورقم الموظف",
  name_only: "تحويل محتمل بالاسم فقط — الحساب لا يطابق",
  no_expected_amount: "لا يوجد مبلغ مستحق للمقارنة",
  cash_with_transfer: "موظف يُصرف له نقدًا لكن وُجد تحويل باسمه",
  ambiguous_amount: "أكثر من مبلغ في سطر التحويل",
  invalid_iban: "آيبان غير صالح في الملفّ",
  shared_iban: "الآيبان مسجّل لأكثر من موظف",
};

const stripZeros = (s) => (s ? String(s).trim().replace(/^0+(?=\d)/, "") : null);

function indexEmployees(employees) {
  const iban = new Map(), account = new Map(), no = new Map();
  const add = (map, key, e) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(e); };
  for (const e of employees) {
    add(iban, e.iban, e);
    add(account, e.account, e);
    add(no, stripZeros(e.eid), e);
    if (e.jisrNo && stripZeros(e.jisrNo) !== stripZeros(e.eid)) add(no, stripZeros(e.jisrNo), e);
  }
  return { iban, account, no };
}

function ibanEndsWithAccount(e, account) {
  return account && account.length >= 10 && e.iban && e.iban.endsWith(account);
}

function reconcile({ employees, transfers }) {
  const emps = (employees || []).map((e) => ({ ...e, iban: e.iban || null, account: e.account || null }));
  const idx = indexEmployees(emps);

  const refCount = new Map();
  for (const t of transfers) if (t.reference) refCount.set(t.reference, (refCount.get(t.reference) || 0) + 1);

  const assigned = new Map(emps.map((e) => [e.eid, []]));
  const hints = new Map(emps.map((e) => [e.eid, []])); // سبب المراجعة لموظفٍ بلا إسناد
  const unassigned = [];

  for (const t of transfers) {
    let strong = null, basis = null;
    if (t.iban && idx.iban.has(t.iban)) { strong = idx.iban.get(t.iban); basis = "iban"; }
    else if (t.account) {
      const viaAcc = idx.account.get(t.account) || emps.filter((e) => ibanEndsWithAccount(e, t.account));
      if (viaAcc && viaAcc.length) { strong = viaAcc; basis = "account"; }
    }
    const byNo = t.empNo ? idx.no.get(stripZeros(t.empNo)) || null : null;

    let target = null, conflict = null;
    if (strong) {
      if (strong.length > 1) conflict = "shared_iban";
      else if (byNo && !byNo.includes(strong[0])) conflict = "key_conflict";
      else target = strong[0];
    } else if (byNo) {
      if (byNo.length > 1) conflict = "key_conflict";
      else if (t.iban && byNo[0].iban && byNo[0].iban !== t.iban) conflict = "key_conflict";
      else { target = byNo[0]; basis = "emp_no"; }
    }

    if (target) {
      assigned.get(target.eid).push({ t, basis });
      continue;
    }

    /* لا إسناد. المرشّحون بالاسم (أو أطراف التعارض) يُعلَّمون للمراجعة. */
    let suggested = [];
    if (conflict) suggested = [...new Set([...(strong || []), ...(byNo || [])])];
    else if (t.name) {
      suggested = emps.filter((e) => Math.max(N.nameSimilarity(t.name, e.name), e.beneficiaryName ? N.nameSimilarity(t.name, e.beneficiaryName) : 0) >= NAME_SUGGEST);
    }
    const reason = conflict || (suggested.length ? "name_only" : "no_identifier_match");
    for (const e of suggested) hints.get(e.eid).push({ t, reason });
    unassigned.push({ t, reason, suggested: suggested.map((e) => e.eid) });
  }

  const results = emps.map((e) => {
    const list = assigned.get(e.eid);
    const hint = hints.get(e.eid);
    const base = { eid: e.eid, expected: e.expected === undefined ? null : e.expected };

    if (e.cash) {
      if (!list.length) return { ...base, status: "cash", reason: null, transfer: null, candidates: 0 };
      return { ...base, status: "needs_review", reason: "cash_with_transfer", transfer: pick(list[0]), candidates: list.length };
    }
    if (list.length > 1) {
      return { ...base, status: "needs_review", reason: "multiple_transfers", transfer: null, candidates: list.length,
               candidateAmounts: list.map((x) => x.t.amount) };
    }
    if (list.length === 1) {
      const { t } = list[0];
      const transfer = pick(list[0]);
      const sim = t.name ? Math.max(N.nameSimilarity(t.name, e.name), e.beneficiaryName ? N.nameSimilarity(t.name, e.beneficiaryName) : 0) : null;
      transfer.nameMismatch = sim !== null && sim < NAME_WEAK;
      /* تحويلٌ مُسنَد لكن هناك تحويلٌ آخر مرشّح له (بالاسم أو تعارض) = أكثر من تحويل محتمل. */
      if (hint.length) return { ...base, status: "needs_review", reason: "multiple_transfers", transfer, candidates: 1 + hint.length };
      if (t.reference && refCount.get(t.reference) > 1) return { ...base, status: "needs_review", reason: "duplicate_reference", transfer, candidates: 1 };
      const flag = (t.flags || []).find((f) => REASONS[f]);
      if (flag) return { ...base, status: "needs_review", reason: flag, transfer, candidates: 1 };
      if (base.expected === null) return { ...base, status: "needs_review", reason: "no_expected_amount", transfer, candidates: 1 };
      const diff = t.amount - base.expected;
      if (Math.abs(diff) <= TOLERANCE_HALALAS) return { ...base, status: "matched", reason: null, transfer, candidates: 1, diff: 0 };
      return { ...base, status: "amount_mismatch", reason: null, transfer, candidates: 1, diff };
    }
    if (hint.length) {
      return { ...base, status: "needs_review", reason: hint.length > 1 ? "multiple_transfers" : hint[0].reason, transfer: null, candidates: hint.length,
               suggestion: pick({ t: hint[0].t, basis: "name" }) };
    }
    return { ...base, status: "not_found", reason: null, transfer: null, candidates: 0 };
  });

  const counts = { matched: 0, amount_mismatch: 0, not_found: 0, needs_review: 0, cash: 0 };
  for (const r of results) counts[r.status]++;
  return {
    results,
    unassigned: unassigned.map((u) => ({ ...pick({ t: u.t, basis: null }), reason: u.reason, suggested: u.suggested })),
    summary: { ...counts, employees: results.length, transfers: transfers.length, unassigned: unassigned.length },
  };
}

/* ما يغادر المحرّك من التحويل: الحساب مقنَّع، لا رقم كامل. */
function pick({ t, basis }) {
  return {
    line: t.line,
    amount: t.amount,
    reference: t.reference || null,
    date: t.date || null,
    bank: t.bank || null,
    beneficiaryName: t.name || null,
    accountMasked: t.iban ? N.maskIban(t.iban) : t.account ? N.maskIban(t.account, "") : null,
    basis,
  };
}

module.exports = { reconcile, REASONS, TOLERANCE_HALALAS, NAME_SUGGEST };
