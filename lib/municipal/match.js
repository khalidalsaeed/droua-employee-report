/* مطابقة الشهادة بالموظف — بمفتاح ثابت لا بالاسم.
   =========================================================================
   رقم الهوية المطبوع على الشهادة يُطابَق حرفيًا (أرقامًا فقط) برقم الإقامة
   في سجلّ الموظف، فيُعطي employee_eid. لا مطابقة تقريبية ولا بالاسم:
     - سجلّ واحد مطابق        → matched
     - أكثر من سجلّ           → ambiguous  (لا يُربط حتى يُؤكَّد يدويًا)
     - لا سجلّ                 → unmatched
   التأكيد اليدوي (--assign <رقم الشهادة>=<eid>) لا يُقبل إلا لـeid موجود
   فعلًا بين المرشّحين أو في السجلّ، ويُعلَّم via:"assigned".

   الاسم المطبوع يُعرض في التقرير للمراجعة البشرية فقط — لا يقرّر شيئًا. */

const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "");

function matchCards(cards, employees, assignments) {
  const byIqama = new Map();
  for (const e of employees || []) {
    const k = digits(e.iqama);
    if (!k) continue;
    if (!byIqama.has(k)) byIqama.set(k, []);
    byIqama.get(k).push(e);
  }
  const known = new Set((employees || []).map((e) => String(e.eid)));
  const assign = assignments || {};

  const items = cards.map((card) => {
    const candidates = byIqama.get(digits(card.idNumber)) || [];
    const manual = assign[card.certNo];
    if (manual != null) {
      if (!known.has(String(manual))) return { card, status: "invalid_assignment", eid: null, candidates };
      return { card, status: "matched", via: "assigned", eid: String(manual), candidates };
    }
    if (candidates.length === 1) return { card, status: "matched", via: "iqama", eid: String(candidates[0].eid), employee: candidates[0], candidates };
    if (candidates.length > 1) return { card, status: "ambiguous", eid: null, candidates };
    return { card, status: "unmatched", eid: null, candidates };
  });

  /* موظف واحد لا يملك بطاقتين في الدفعة نفسها: الاثنتان ambiguous. */
  const owners = new Map();
  items.filter((i) => i.status === "matched").forEach((i) => owners.set(i.eid, (owners.get(i.eid) || 0) + 1));
  items.forEach((i) => { if (i.status === "matched" && owners.get(i.eid) > 1) { i.status = "ambiguous"; i.reason = "same_employee_twice"; i.eid = null; } });

  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    items,
    summary: {
      total: items.length,
      matched: count("matched"),
      ambiguous: count("ambiguous"),
      unmatched: count("unmatched") + count("invalid_assignment"),
    },
  };
}

module.exports = { matchCards, digits };
