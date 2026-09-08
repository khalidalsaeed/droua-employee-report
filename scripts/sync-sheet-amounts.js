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
};

const money = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const runId = argValue(argv, "--run");

  if (!runId) {
    console.error("‏--run مطلوب. مثال: node scripts/sync-sheet-amounts.js --run 2026-08 --dry-run");
    process.exitCode = 1;
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(runId)) {
    console.error(`معرّف المسير «${runId}» ليس بصيغة YYYY-MM.`);
    process.exitCode = 1;
    return;
  }
  const excludeArg = argValue(argv, "--exclude");
  const exclude = excludeArg ? excludeArg.split(",").map((x) => x.trim()).filter(Boolean) : [];

  /* حتى ‎--dry-run يقرأ المسير وسجلّ الموظفين من القاعدة. */
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ.");
    process.exitCode = 1;
    return;
  }

  console.log(dryRun ? "— معاينة فقط، بلا أي كتابة —\n" : `— تنفيذ فعلي على مسير ${runId} —\n`);
  if (exclude.length) console.log(`مستثنى بأمرك: أرقام جسر ${exclude.join(", ")}\n`);

  const r = await syncSheetAmounts(runId, { dryRun, exclude });

  if (!r.ok) {
    console.error(`فشل: ${REASONS[r.reason] || r.reason}`);
    if (r.reason === "totals_mismatch" && r.extraction) {
      console.error(`  المستخرج: ${money(r.extraction.sumNet)} · المطبوع: ${money(r.extraction.totalNet)}`);
    }
    if (r.reason === "duplicate_jisr_in_platform") {
      console.error(`  رقم جسر ${r.jisrNo} عند الموظفَين: ${r.eids.join(" و ")}`);
    }
    if (r.reason === "sheet_download_failed") console.error(`  ${r.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`المسير: ${r.monthLabel} (${r.runId})`);
  console.log(`الكشف: ${r.url}`);
  console.log(`تحقّق الاكتمال: مجموع الصوافي ${money(r.extraction.sumNet)} = صف الإجماليات ${money(r.extraction.totalNet)} ✅\n`);

  console.log(`الرواتب المقروءة (${r.rows.length}):`);
  console.log("  رقم جسر → رقم ضمان   راتب المسير      الحالة");
  for (const row of r.rows) {
    const state = row.current === null ? "جديد"
      : row.changed ? `تصحيح (كان ${money(row.current)})`
      : "كما هو";
    console.log(`  ${String(row.jisrNo).padStart(7)} → ${String(row.eid).padStart(8)}   ${money(row.net).padStart(12)}   ${state}   ${row.name}`);
  }

  /* التباعد بين الكشف واللقطة يُبلَّغ صريحًا ولا يُصلَح بالتخمين: قد
     يكون موظفًا غادر، وقد يكون كشفًا ناقصًا — وكلاهما قرار إنسان. */
  if (r.unknown.length) {
    console.log(`\n⚠️  أرقام جسر في الكشف لا يحملها أي موظف (${r.unknown.length}):`);
    for (const u of r.unknown) console.log(`  ${u.jisrNo} — الاسم في الكشف تقريبًا: «${u.nameHint}» · صافيه ${money(u.net)}`);
    console.log("  رواتبهم لم تُخزَّن. املأ «رقم جسر» لهم في السجلّ ثم أعد التشغيل.");
  }
  if (r.missing.length) {
    console.log(`\n⚠️  موظفون في الكشف بلا صفّ إثبات في هذا المسير (${r.missing.length}):`);
    for (const m of r.missing) console.log(`  رقم ضمان ${m.eid} — ${m.name}`);
    console.log("  لم يُنشأ لهم صفّ: هذه العملية لا تُدرج، تُحدّث فقط.");
  }
  if (r.withoutSheetRow.length) {
    console.log(`\n⚠️  موظفون في المسير بلا سطر في الكشف (${r.withoutSheetRow.length}):`);
    for (const w of r.withoutSheetRow) console.log(`  رقم ضمان ${w.eid} — ${w.name}`);
    console.log("  صفوفهم لم تُمسّ، وراتبهم يبقى غير مقروء.");
  }
  if (r.excluded.length) console.log(`\nمستثنى بأمرك: أرقام جسر ${r.excluded.map((u) => u.jisrNo).join(", ")}`);

  if (dryRun) {
    console.log(`\nسيُحدَّث ${r.attempted} صفًّا، و${r.unchanged} صفًّا يحمل القيمة نفسها فلن يُمسّ.`);
    console.log("لم يُكتب شيء. أعد التشغيل بلا --dry-run للتنفيذ.");
    return;
  }
  console.log(`\nحُدِّث: ${r.updated} · بلا تغيير: ${r.unchanged}`);
  if (r.notFound.length) console.log(`⚠️  صفوف لم تُصَب: ${r.notFound.join(", ")}`);
  console.log("لم يُمسّ المسير ولا مرفقاته ولا حالته ولا أي إثبات مرفوع، ولم يُرسل أي تنبيه.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل غير متوقّع:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { REASONS };
