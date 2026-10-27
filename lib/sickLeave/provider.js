/* ─── مصدر النتيجة الرسمية ───
   =========================================================================
   لا يوجد اليوم API رسمي موثَّق من «صحة» للاستعلام عن الإجازات المرضية آليًا
   (انظر docs/sick-leave-verification.md). صفحة الاستعلام العامة واجهةٌ لبشر،
   وشروط المنصّة تمنع البرامج التي تعترض تشغيلها أو تُثقلها. لذلك لا يتّصل
   هذا الملفّ بـseha.sa إطلاقًا، ولا يحاكي متصفّحًا، ولا يتجاوز أي حماية.

   المصدر الوحيد المُنفَّذ: «manual» — النتيجة كما عرضتها صفحة «صحة» الرسمية
   للمستخدم بعد استعلامه بنفسه، يُدخلها في المنصّة. يُوسَم كل تحقّق بمصدره
   فلا يُقدَّم على أنه استعلام آلي.

   runLookup هي الواجهة الموحّدة لأي مصدر: تحوّل الأعطال والمهلة وتجاوز
   الحدّ إلى unavailable — لا إلى «غير صحيحة». فإن أُبرم لاحقًا عقدٌ رسمي
   (API بمفتاح)، يُضاف مصدر يُعيد الشكل نفسه ولا يتغيّر شيء آخر. */

const DEFAULT_TIMEOUT_MS = 10000;

class LookupError extends Error {
  constructor(reason, message) { super(message || reason); this.reason = reason; }
}

/* provider.lookup(query) → { status: "found", record } | { status: "not_found" }
   أي استثناء أو مهلة أو ردّ مشوّه → { status: "unavailable", reason }. */
async function runLookup(provider, query, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let timer;
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => provider.lookup(query)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new LookupError("timeout")), timeoutMs); }),
    ]);
    if (out && out.status === "found" && out.record && typeof out.record === "object") return { status: "found", record: out.record, source: provider.source };
    if (out && out.status === "not_found") return { status: "not_found", source: provider.source };
    if (out && out.status === "unavailable") return { status: "unavailable", reason: out.reason || "service_unavailable", source: provider.source };
    return { status: "unavailable", reason: "bad_response", source: provider.source };
  } catch (err) {
    const reason = err && err.reason ? err.reason
      : err && (err.status === 429 || err.statusCode === 429) ? "rate_limited"
      : "service_unavailable";
    return { status: "unavailable", reason, source: provider && provider.source };
  } finally {
    clearTimeout(timer);
  }
}

const OFFICIAL_FIELDS = ["leaveId", "idNumber", "name", "startDate", "endDate", "days", "practitioner", "facility"];

/* النتيجة الرسمية كما أدخلها المستخدم من صفحة «صحة».
   entry.outcome: found | not_found | unavailable */
function manualProvider(entry) {
  return {
    source: "seha_manual",
    lookup() {
      const e = entry || {};
      if (e.outcome === "not_found") return { status: "not_found" };
      if (e.outcome === "unavailable") return { status: "unavailable", reason: "service_unavailable" };
      if (e.outcome !== "found") throw new LookupError("bad_input");
      const record = {};
      for (const k of OFFICIAL_FIELDS) {
        const v = e[k];
        if (v == null || v === "") continue;
        record[k] = String(v).replace(/\s+/g, " ").trim().slice(0, 120);
      }
      return { status: "found", record };
    },
  };
}

module.exports = { runLookup, manualProvider, LookupError, OFFICIAL_FIELDS, DEFAULT_TIMEOUT_MS };
