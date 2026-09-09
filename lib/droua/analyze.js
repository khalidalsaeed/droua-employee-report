/* ─── دورة التحليل ─────────────────────────────────────────────────────
   =========================================================================
   رفع ← تحليل ← ملاحظات ← تصحيح وإعادة رفع ← إعادة تحليل.

   وهذه الوحدة هي الوصلة: تقرأ ملفّات الشهر (فكًّا وتحقّقًا)، وتُطبّعها،
   وتقارنها بنفسها وبالشهر السابق، ثمّ تُزامن الملاحظات.

   ── مبدأ حاكم: التحليل لا يفشل لأن ملفًّا ناقصًا أو غير مقروء ──
   الناقص والمُتعذَّر قراءته يصيران **ملاحظتين** لا استثناءين. فالمستخدم
   يرى في المكان نفسه «ينقص ملفّ التحويل» و«الراتب تغيّر لفلان»، ويعالجهما
   بالدورة نفسها. ولو رمى التحليل عند أول نقص لما رأى شيئًا حتى يكتمل كل
   شيء — وهو أبعد ما يكون عن واقع إغلاق شهر. */

const gateContext = require("./gateContext");
const files = require("./files");
const runs = require("./runs");
const parsers = require("./parsers");
const findings = require("./findings");
const { compare } = require("./compare");

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* يقرأ ملفّات شهرٍ ويُطبّعها. يُرجع الجداول ومعها ما تعذّر. */
async function loadDocs(sql, runId, ctx) {
  const slots = await runs.fileSlots(sql, runId);
  const docs = {};
  const missing = [];
  const unreadable = [];

  for (const slot of slots) {
    if (!slot.file) { docs[slot.kind] = null; missing.push(slot); continue; }
    let bytes;
    try {
      ({ bytes } = await files.readFile(sql, slot.file.fileId, ctx));
    } catch (err) {
      /* عطلُ سلامةٍ سُجّل في التدقيق بالفعل داخل files.readFile. وهنا يصير
         ملاحظةً مرئيّة بدل أن يُسقط الشهر كلَّه. */
      unreadable.push({ ...slot, reason: err.reason || err.code || "read_failed" });
      docs[slot.kind] = null;
      continue;
    }
    try {
      docs[slot.kind] = parsers.parse({ format: slot.file.format, kind: slot.kind, bytes });
    } catch (err) {
      if (err.code !== "parser_unavailable") throw err;
      unreadable.push({ ...slot, reason: "parser_unavailable" });
      docs[slot.kind] = null;
    }
  }
  return { slots, docs, missing, unreadable };
}

/* ملاحظاتٌ عن حالة الملفّات نفسها — بالبنية نفسها، فتُزامَن وتُحلّ تلقائيًّا
   حين يُرفع الناقص أو يصير المتعذَّر مقروءًا. */
function fileStateFindings({ missing, unreadable, docs }) {
  const out = [];
  for (const slot of missing) {
    out.push({
      rule: "file_missing", scope: "within_month", severity: "critical",
      field: slot.kind, title: `ملفٌّ ناقص: ${slot.label}`,
      description: "المقارنة تعمل على ما توفّر، وتبقى ناقصة حتى يُرفع.",
    });
  }
  for (const slot of unreadable) {
    out.push({
      rule: "file_unreadable", scope: "within_month", severity: "warn",
      field: slot.kind, title: `ملفٌّ لم يُقرأ: ${slot.label}`,
      currentValue: slot.reason,
      description: slot.reason === "parser_unavailable"
        ? "الصيغة مرفوعة ومحفوظة، ولا قارئ لها بعد."
        : "تعذّر فكّ الملفّ أو التحقّق من سلامته.",
    });
  }
  /* تحذيرات القارئ نفسه: عمودٌ لم يُتعرَّف عليه يُنتج أصفارًا صامتة —
     وهي أخطر من عمودٍ مفقود يُعلن نفسه. */
  for (const [kind, doc] of Object.entries(docs)) {
    for (const warning of (doc && doc.meta && doc.meta.warnings) || []) {
      out.push({
        rule: "parse_warning", scope: "within_month", severity: "warn",
        field: `${kind}:${warning}`, title: `تنبيه قراءة في ${files.KIND_LABELS[kind] || kind}`,
        currentValue: warning,
        description: "قراءةٌ ناقصة تُنتج مقارنةً ناقصة.",
      });
    }
  }
  return out;
}

async function analyzeRun(sql, runId, ctx = {}) {
  gateContext.requireGate();
  const run = await runs.getRun(sql, runId);
  if (!run) throw fail("شهرٌ غير موجود", "not_found");

  const current = await loadDocs(sql, runId, ctx);

  /* الشهر السابق يُقرأ إن وُجد — وغيابه ليس عطلًا: أول شهرٍ في النظام لا
     سابق له، وقواعد المقارنة معه تُتخطّى ويُعلَن تخطّيها. */
  const previousPeriod = runs.previousPeriod(run.period);
  const previousRun = await runs.getByPeriod(sql, previousPeriod);
  let previousDocs = null;
  if (previousRun) previousDocs = (await loadDocs(sql, previousRun.runId, ctx)).docs;

  const { findings: produced, applied, skipped } = compare({ docs: current.docs, previousDocs });
  const all = [...fileStateFindings(current), ...produced];
  const synced = await findings.sync(sql, runId, all);

  await runs.setStatus(sql, runId, "analyzed");

  return {
    runId, period: run.period,
    previousPeriod: previousRun ? previousPeriod : null,
    rulesApplied: applied.length,
    rulesSkipped: skipped,
    missing: current.missing.map((s) => s.kind),
    unreadable: current.unreadable.map((s) => ({ kind: s.kind, reason: s.reason })),
    ...synced,
  };
}

module.exports = { analyzeRun, loadDocs, fileStateFindings };
