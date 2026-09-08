#!/usr/bin/env node
/* مزامنة «راتب المسير» من كشف الرواتب إلى صفوف إثبات التحويل.
   =========================================================================
   المرحلة الأولى من مطابقة الإيصالات: تخزين مرجع الراتب داخل صفّ كل
   موظف. بلا هذا المرجع محفوظًا لا يوجد ما تُقاس عليه قيمة الفاتورة ولا
   مبلغ التحويل — انظر lib/payroll/sheetAmounts.js لتفصيل السبب.

   ليس سكربت مرّة واحدة كـbackfill أغسطس: كل شهر يُرفع كشفه ثم تُشغَّل
   عليه هذه المزامنة، فهو يأخذ ‎--run لأي مسير.

   ── الكتابة الوحيدة ──
     UPDATE payroll_transfer_proofs SET sheet_amount = $
      WHERE run_id = $ AND employee_eid = $
        AND sheet_amount IS DISTINCT FROM $

   لا INSERT ولا DELETE ولا مساس بـpayroll_runs ولا payroll_attachments،
   ولا لمس لـfile_url أو file_name أو uploaded_at — إثبات مرفوع فعلًا لا
   يتأثّر. وIS DISTINCT FROM يجعل إعادة التشغيل تُبلّغ صفر تعديل بصدق.

   ── حواجز السلامة قبل أي كتابة ──
     · مجموع صوافي الكشف يجب أن يطابق صف الإجماليات المطبوع فيه، وإلّا
       فالاستخراج ناقص ويُرفض كليًا (lib/payroll/sheetRoster.js).
     · الربط بـ«رقم جسر» وحده، ورقمٌ لا يحمله أحد يُبلَّغ ولا يُخمَّن
       (lib/payroll/sheetLink.js).
     · موظف في الكشف بلا صفّ إثبات في المسير يُبلَّغ ولا يُنشأ له صفّ.
     · موظف في المسير بلا سطر في الكشف يُبلَّغ ولا يُلمس صفّه.

   التشغيل:
     node scripts/sync-sheet-amounts.js --run 2026-08 --dry-run
     node scripts/sync-sheet-amounts.js --run 2026-08

   الأعلام:
     --run <معرّف>   المسير المستهدَف، بصيغة YYYY-MM. مطلوب صراحةً: لا
                     افتراض لـ«الشهر الحالي» في عملية تكتب في القاعدة.
     --dry-run       يطبع ما سيُكتب ولا يكتب حرفًا. لا UPDATE إطلاقًا.
     --exclude 82,85 يستثني أرقام جسر بعينها، مسمّاةً واحدًا واحدًا. */

const { syncSheetAmounts } = require("../lib/payroll/sheetAmounts");

const REASONS = {
  run_not_found: "لا يوجد مسير بهذا المعرّف.",
  no_proof_rows: "المسير بلا صفوف إثبات تحويل، فلا صفّ يُكتب فيه راتب.\n  ابذر الصفوف أوّلًا (backfill للمسيرات القديمة، أو الـCron للجديدة).",
  no_sheet_attached: "لا كشف رواتب مرفوع على هذا المسير، فلا مصدر للرواتب.",
  sheet_download_failed: "تعذّر تنزيل ملفّ الكشف.",
  unreadable_pdf: "تعذّرت قراءة ملفّ الكشف كـPDF (قد يكون صورة).",
  no_employee_rows: "لم يُعثر على صفّ موظف واحد في الكشف — بنيته غير متوقّعة.",
  no_totals_row: "لا صفّ إجماليات في الكشف، فلا سبيل للتحقّق من اكتمال الاستخراج.",
  duplicate_jisr_in_sheet: "رقم جسر مكرّر داخل الكشف — القارئ فسّر شيئًا آخر رقم موظف.",
  duplicate_jisr_in_platform: "موظفان يحملان رقم جسر نفسه في سجلّ الموظفين.",
  totals_mismatch: "مجموع الصوافي المستخرجة لا يطابق صف الإجماليات — الاستخراج ناقص.",
  net_not_money: "أقصى يسار أحد صفوف الكشف ليس مبلغًا — بنية الكشف غير متوقّعة، ولا يصحّ تخمين الصافي.",
  non_numeric_totals: "مجموع أو إجمالي غير رقمي — تعذّرت قراءة الكشف قراءةً موثوقة.",
  non_numeric_net: "صافٍ غير رقمي في الكشف — رُفض الكشف كلّه، ولم يُخزَّن منه رقم واحد.",
};

const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

/* ─── التقرير، مفصولًا عن التنفيذ ───
   =========================================================================
   مفصول لسببين. الأول أنه يُختبر: تقرير الـbackfill انهار يومًا بـ
   «Cannot read properties of undefined (reading 'sumNet')» بعد عمل صحيح
   تمامًا — لأن مسار النجاح كان يُسقط حقلًا يقرؤه سطرُ طباعة. عطلٌ في
   العرض يمحو أثر عملية سليمة، فيستحقّ اختباره كما يُختبر المنطق.

   والثاني أنه يُعرَض قبل الوصول إلى Production: يمكن تشغيله على قاعدة
   مُزيَّفة وعيّنة مُعقَّمة، فيُرى شكل الجدول ويُراجَع قبل أن يُقرأ رقم
   حقيقي واحد. */
function report(r, { dryRun = false, log = console.log, error = console.error } = {}) {
  if (!r.ok) {
    error(`فشل: ${REASONS[r.reason] || r.reason}`);
    /* كل سطر تفصيل يفحص وجود ما يقرؤه: تقريرٌ ناقص أهون من انهيار. */
    if (r.reason === "totals_mismatch" && r.extraction) {
      error(`  المستخرج: ${money(r.extraction.sumNet)} · المطبوع: ${money(r.extraction.totalNet)}`);
    }
    if (r.reason === "duplicate_jisr_in_platform" && Array.isArray(r.eids)) {
      error(`  رقم جسر ${r.jisrNo} عند الموظفَين: ${r.eids.join(" و ")}`);
    }
    if (r.reason === "sheet_download_failed" && r.error) error(`  ${r.error}`);
    return false;
  }

  log(`المسير: ${r.monthLabel} (${r.runId})`);
  log(`الكشف: ${r.url}`);
  if (r.extraction) {
    log(`تحقّق الاكتمال: مجموع الصوافي ${money(r.extraction.sumNet)} = صف الإجماليات ${money(r.extraction.totalNet)} ✅`);
  }

  const rows = r.rows || [];
  log(`\nالرواتب المقروءة (${rows.length}):`);
  log("  رقم جسر → رقم ضمان   راتب المسير      الحالة");
  for (const row of rows) {
    const state = row.current === null || row.current === undefined ? "جديد"
      : row.changed ? `تصحيح (كان ${money(row.current)})`
      : "كما هو";
    log(`  ${String(row.jisrNo).padStart(7)} → ${String(row.eid).padStart(8)}   ${money(row.net).padStart(12)}   ${state.padEnd(24)} ${row.name}`);
  }

  /* التباعد بين الكشف واللقطة يُبلَّغ صريحًا ولا يُصلَح بالتخمين: قد
     يكون موظفًا غادر، وقد يكون كشفًا ناقصًا — وكلاهما قرار إنسان. */
  const unknown = r.unknown || [];
  if (unknown.length) {
    log(`\n⚠️  أرقام جسر في الكشف لا يحملها أي موظف (${unknown.length}):`);
    for (const u of unknown) log(`  ${u.jisrNo} — الاسم في الكشف تقريبًا: «${u.nameHint}» · صافيه ${money(u.net)}`);
    log("  رواتبهم لم تُخزَّن. املأ «رقم جسر» لهم في السجلّ ثم أعد التشغيل.");
  }
  const missing = r.missing || [];
  if (missing.length) {
    log(`\n⚠️  موظفون في الكشف بلا صفّ إثبات في هذا المسير (${missing.length}):`);
    for (const m of missing) log(`  رقم ضمان ${m.eid} — ${m.name}`);
    log("  لم يُنشأ لهم صفّ: هذه العملية لا تُدرج، تُحدّث فقط.");
  }
  const orphans = r.withoutSheetRow || [];
  if (orphans.length) {
    log(`\n⚠️  موظفون في المسير بلا سطر في الكشف (${orphans.length}):`);
    for (const w of orphans) log(`  رقم ضمان ${w.eid} — ${w.name}`);
    log("  صفوفهم لم تُمسّ، وراتبهم يبقى غير مقروء.");
  }
  const excluded = r.excluded || [];
  if (excluded.length) log(`\nمستثنى بأمرك: أرقام جسر ${excluded.map((u) => u.jisrNo).join(", ")}`);

  /* العدّادات تغيب حين يُستدعى التقرير على نتيجة القراءة وحدها بلا
     خطوة الكتابة. وصفرٌ هنا صادق — لم تُحدَّث صفوف فعلًا — أمّا
     «حُدِّث: undefined» فسطرٌ يكذب على قارئه، وهو أسوأ من انهيار:
     الانهيار يُرى والكذب يُصدَّق. */
  const count = (n) => (typeof n === "number" ? n : 0);
  if (dryRun) {
    log(`\nسيُحدَّث ${count(r.attempted)} صفًّا، و${count(r.unchanged)} صفًّا يحمل القيمة نفسها فلن يُمسّ.`);
    log("لم يُكتب شيء. أعد التشغيل بلا --dry-run للتنفيذ.");
    return true;
  }
  log(`\nحُدِّث: ${count(r.updated)} · بلا تغيير: ${count(r.unchanged)}`);
  if ((r.notFound || []).length) log(`⚠️  صفوف لم تُصَب: ${r.notFound.join(", ")}`);
  log("لم يُمسّ المسير ولا مرفقاته ولا حالته ولا أي إثبات مرفوع، ولم يُرسل أي تنبيه.");
  return true;
}

/* يفصل قراءة الأعلام عن تنفيذها كي تُختبر قواعد الرفض بلا تشغيل. */
function parseArgs(argv) {
  const runId = argValue(argv, "--run");
  if (!runId) {
    return { ok: false, message: "‏--run مطلوب. مثال: node scripts/sync-sheet-amounts.js --run 2026-08 --dry-run" };
  }
  if (!/^\d{4}-\d{2}$/.test(runId)) {
    return { ok: false, message: `معرّف المسير «${runId}» ليس بصيغة YYYY-MM.` };
  }
  const excludeArg = argValue(argv, "--exclude");
  return {
    ok: true,
    runId,
    dryRun: argv.includes("--dry-run"),
    exclude: excludeArg ? excludeArg.split(",").map((x) => x.trim()).filter(Boolean) : [],
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exitCode = 1;
    return;
  }
  const { runId, dryRun, exclude } = parsed;

  /* حتى ‎--dry-run يقرأ المسير وسجلّ الموظفين من القاعدة. */
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ.");
    process.exitCode = 1;
    return;
  }

  console.log(dryRun ? "— معاينة فقط، بلا أي كتابة —\n" : `— تنفيذ فعلي على مسير ${runId} —\n`);
  if (exclude.length) console.log(`مستثنى بأمرك: أرقام جسر ${exclude.join(", ")}\n`);

  const r = await syncSheetAmounts(runId, { dryRun, exclude });
  if (!report(r, { dryRun })) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل غير متوقّع:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { REASONS, report, parseArgs, money };
