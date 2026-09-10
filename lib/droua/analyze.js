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
      /* ⚠️ **كل** عطل قراءةٍ ملاحظة، لا «غياب القارئ» وحده.
         كان ما عداه يُرمى فيسقط تحليل الشهر كلّه بخطأ 500: مصنّفٌ تالف
         أو ملفٌّ رُفع في الخانة الخطأ يمحو نتيجة الملفّات الثلاثة
         السليمة معه، ولا يقول أيُّها السبب. وهو نقضٌ للمبدأ الحاكم أعلى
         هذا الملفّ.

         والبايتات هنا **من المستخدم**، وفسادُها حدثٌ متوقَّع لا عطلٌ في
         الخادم. ويُسجَّل رمزًا لا رسالةً: نصُّ الخطأ قد يحمل شيئًا من
         المحتوى، والملاحظات تُقرأ وتُصدَّر. */
      unreadable.push({ ...slot, reason: err.code === "parser_unavailable" ? "parser_unavailable" : "parse_failed" });
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
    /* الاختياريّ الغائب ليس خللًا: شهرٌ بلا عمل إضافي شهرٌ سليم. ويبقى
       أثرُه مُعلنًا في «لم تُقيَّم» التي تسمّي القواعد المعطَّلة به. */
    const required = slot.required !== false;
    out.push({
      rule: "file_missing", scope: "within_month",
      severity: required ? "critical" : "info",
      field: slot.kind, title: `ملفٌّ ناقص: ${slot.label}`,
      description: required
        ? "المقارنة تعمل على ما توفّر، وتبقى ناقصة حتى يُرفع."
        : "ملفٌّ اختياريّ — غيابُه لا يُنقص الشهر، ويوقف قواعده وحدها.",
    });
  }
  for (const slot of unreadable) {
    out.push({
      rule: "file_unreadable", scope: "within_month", severity: "warn",
      field: slot.kind, title: `ملفٌّ لم يُقرأ: ${slot.label}`,
      currentValue: slot.reason,
      description: slot.reason === "parser_unavailable"
        ? "الصيغة مرفوعة ومحفوظة، ولا قارئ لها بعد."
        : slot.reason === "parse_failed"
          ? "الملفّ محفوظٌ سليمًا ولم يُفهم محتواه — تأكّد أنه المصنّف الصحيح وبالصيغة المعلنة."
          : "تعذّر فكّ الملفّ أو التحقّق من سلامته.",
    });
  }
  /* ثقةُ القراءة: حين يفهم القارئ أقلّ من ثلثي الملفّ تصير المقارنة عليه
     أكثر إنتاجًا للكذب منها للصدق. فيُقال ذلك للمستخدم بوضوح بدل أن
     يُخبَّأ في رقمٍ لا يراه أحد. */
  for (const [kind, doc] of Object.entries(docs)) {
    const meta = (doc && doc.meta) || null;
    if (!meta) continue;

    if (meta.needsManualReview) {
      out.push({
        rule: "low_confidence", scope: "within_month", severity: "critical",
        field: kind, title: `قراءةٌ ناقصة تحتاج مراجعة: ${files.KIND_LABELS[kind] || kind}`,
        currentValue: `ثقة ${Math.round((meta.confidence || 0) * 100)}%`,
        description: "الأعمدة المفهومة لا تكفي — راجع تسميات الأعمدة قبل الاعتماد على الملاحظات.",
      });
    }

    /* الأعمدة غير المعروفة ملاحظةٌ واحدة لا واحدة لكل عمود: عشرون ملاحظة
       عن عشرين عمودًا تُغرق ما يهمّ. */
    if ((meta.unknownColumns || []).length) {
      out.push({
        rule: "unknown_columns", scope: "within_month", severity: "info",
        field: kind, title: `أعمدةٌ لم تُقرأ في ${files.KIND_LABELS[kind] || kind}`,
        currentValue: meta.unknownColumns.slice(0, 6).join(" · "),
        description: "قد تكون ثانوية — أو حقلًا مهمًّا بتسميةٍ غير مُدرَجة.",
      });
    }
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

/* ── ملاحظاتُ «تعذّر التقييم» ──
   قاعدةٌ لم تُقيَّم لأن مصدرها غائبٌ عندنا **ليست نتيجةً سالبة**. ولو
   سكتنا عنها لقرأ المستخدم صفر ملاحظات على أنه «لا خلل»، وهو استنتاجٌ لم
   يُثبته شيء: الملفّ لم يُفحص أصلًا.

   والملاحظة **واحدة لكل مصدرٍ ناقص** تسرد القواعد المعطَّلة به — لا واحدة
   لكل قاعدة: مصدرٌ واحد يعطّل ستّ قواعد، فستّ ملاحظات عن سببٍ واحد تُغرق
   ما يهمّ وتُدرّب على تجاهل التنبيه. */
const MONTH_LABELS = { current: "الشهر الجاري", previous: "الشهر السابق" };

const FIELD_LABELS = {
  iban4: "رقم الحساب", bank: "البنك", method: "طريقة الصرف",
  net: "الصافي", basic: "الراتب الأساسي",
  allowances: "البدلات", deductions: "الاستقطاعات",
};

/* أسماءٌ عربية للقواعد. المعرّف الإنجليزيّ يبقى في `current_value` — فهو
   ما تقرأه الواجهة لتحسب التغطية — والعربيّ للوصف الذي يقرأه المستخدم. */
const RULE_LABELS = {
  duplicate_emp_no: "رقم موظّف مكرّر",
  missing_in_split: "مستحقٌّ بلا صرف",
  extra_in_split: "مصروفٌ بلا استحقاق",
  net_mismatch: "صافٍ يخالف الصرف",
  totals_mismatch: "مجموعٌ لا يتطابق",
  paid_twice: "صُرف مرّتين",
  non_positive_net: "صافٍ صفرٌ أو سالب",
  not_in_employee_list: "مصروفٌ خارج القائمة",
  not_in_payroll: "على القائمة بلا راتب",
  iban_vs_list: "الحساب يخالف القائمة",
  method_vs_channel: "قناة الصرف تخالف المسجَّل",
  bank_without_account: "تحويلٌ بلا حسابٍ مسجَّل",
  iban_changed: "تغيّر الحساب",
  net_changed: "تغيّر الصافي",
  basic_changed: "تغيّر الأساسي",
  allowances_changed: "تغيّر البدلات",
  deductions_changed: "تغيّر الاستقطاعات",
  new_employee: "موظّفٌ جديد",
  removed_employee: "موظّفٌ خرج",
  bank_changed: "تغيّر البنك",
};

function kindLabel(kind) {
  /* «employees|transfer» من `previousAny`: أيّهما توفّر كفى. */
  return String(kind).split("|").map((k) => files.KIND_LABELS[k] || k).join(" أو ");
}

/* النقص نوعان: ملفٌّ غائب، وعمودٌ غائب في ملفٍّ موجود. والثاني يحتاج
   تسميةً تقول أين بالضبط — «لا عمود حساب في مسير التحويل» لا «ينقص
   مصدر». */
function sourceKey(source) {
  return source.field ? `${source.month}:${source.doc}.${source.field}` : `${source.month}:${source.kind}`;
}

function sourceLabel(source) {
  if (!source.field) return kindLabel(source.kind);
  const field = FIELD_LABELS[source.field] || source.field;
  if (source.doc === "merged") return `${field} (لا عمود له في أي ملفّ)`;
  return `${field} في ${files.KIND_LABELS[source.doc] || source.doc}`;
}

function notEvaluableFindings(notEvaluable, previousPeriod) {
  const groups = new Map();
  /* قاعدةٌ يعطّلها مصدران تُذكر في ملاحظتيهما — ليعرف المستخدم أثر كل
     نقصٍ على حدة — لكنها **تُعدّ مرّة واحدة** في مجموع التغطية، تُنسب إلى
     أوّل مصدرٍ ينقصها. وبلا هذا التقسيم يصير مجموع الأعداد أكبر من عدد
     القواعد نفسها، فيُبلَّغ المستخدم بنقصٍ أوسع من الواقع. */
  const claimed = new Set();
  for (const entry of notEvaluable || []) {
    for (const source of entry.missing) {
      const key = sourceKey(source);
      if (!groups.has(key)) groups.set(key, { ...source, rules: [], owned: 0 });
      const group = groups.get(key);
      if (group.rules.includes(entry.rule)) continue;
      group.rules.push(entry.rule);
      if (!claimed.has(entry.rule)) { claimed.add(entry.rule); group.owned++; }
    }
  }

  const out = [];
  for (const [key, group] of groups) {
    const label = sourceLabel(group);
    const month = MONTH_LABELS[group.month] || group.month;
    const when = group.month === "previous" && previousPeriod ? `${month} (${previousPeriod})` : month;
    out.push({
      rule: "not_evaluable",
      scope: group.month === "previous" ? "vs_previous" : "within_month",
      /* ملفٌّ ناقص في الشهر الجاري له `file_missing` حرجةٌ بالفعل، فهذه
         تكملةٌ تسمّي القواعد المعطَّلة لا إنذارٌ ثانٍ عن الشيء نفسه.
         أمّا **عمودٌ** ناقص في ملفٍّ موجود فلا شيء آخر يغطّيه: الملفّ
         مرفوعٌ ومقروءٌ وبثقةٍ عالية، ولا يظهر النقص إلا هنا. */
      severity: group.field || group.month === "previous" ? "warn" : "info",
      field: key,
      title: `قواعد لم تُقيَّم: ${label} — ${when}`,
      /* معرّفات القواعد لا عددُها: الواجهة تقرأها لتحسب **القواعد
         المتميّزة** المعطَّلة — وقاعدةٌ يعطّلها مصدران تُعدّ مرّة. وجمعُ
         الأعداد وحدَه كان يُضاعفها فيُبلَّغ المستخدم بنقصٍ أكبر من الواقع. */
      currentValue: group.rules.join(" · "),
      /* العدد في `delta` لا في النصّ: عمودُ القيمة يُقتطع عند 120 محرفًا،
         واقتطاعُ قائمةٍ طويلة كان يُسقط معرّفاتٍ بأكملها فيُحسب النقص
         أصغر ممّا هو — وهو بالضبط ما تمنعه هذه الشاشة. */
      delta: group.owned,
      description: "المصدر غير متوفّر، فهذه القواعد لم تُفحص ولم تُنفَ: "
        + `${group.rules.map((r) => RULE_LABELS[r] || r).join("، ")}. `
        + "تحتاج مراجعةً يدويّة — وغيابُ المصدر ليس دليلًا على سلامةٍ ولا على خلل.",
    });
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

  const { findings: produced, applied, skipped, notEvaluable } =
    compare({ docs: current.docs, previousDocs });
  const all = [
    ...fileStateFindings(current),
    ...notEvaluableFindings(notEvaluable, previousRun ? previousPeriod : null),
    ...produced,
  ];
  const synced = await findings.sync(sql, runId, all);

  await runs.setStatus(sql, runId, "analyzed");

  return {
    runId, period: run.period,
    previousPeriod: previousRun ? previousPeriod : null,
    rulesApplied: applied.length,
    rulesSkipped: skipped,
    rulesNotEvaluable: notEvaluable,
    missing: current.missing.map((s) => s.kind),
    unreadable: current.unreadable.map((s) => ({ kind: s.kind, reason: s.reason })),
    ...synced,
  };
}

module.exports = { analyzeRun, loadDocs, fileStateFindings, notEvaluableFindings, RULE_LABELS };
