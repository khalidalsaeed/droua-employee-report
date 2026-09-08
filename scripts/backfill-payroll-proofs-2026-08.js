#!/usr/bin/env node
/* Backfill لمرّة واحدة: صفوف إثبات التحويل لمسير أغسطس 2026.
   =========================================================================
   مسير 2026-08 أُنشئ يدويًا قبل ميزة اللقطة، فلا صفوف موظفين له — وقسم
   «إثبات تحويل راتب الموظف» لا يُرسم في صفحة بلا صفوف. هذا السكربت يبذر
   تلك الصفوف وحدها ولا شيء غيرها.

   ما لا يلمسه إطلاقًا (تُتحقّق منه في test/payroll-backfill.test.js):
     - payroll_runs        : لا status_key ولا source ولا notified_at ولا
                             أي عمود آخر. لا عبارة UPDATE واحدة عليه.
     - payroll_attachments : لا قراءة تُعدّل ولا كتابة.
     - البريد وإشعارات الدفع : لا استدعاء لأيّ منهما في هذا الملفّ.
     - المسيرات الأخرى     : كل كتابة تحمل run_id = '2026-08' حرفيًا.

   الكتابة الوحيدة:
     INSERT INTO payroll_transfer_proofs (...)
     VALUES (...) ON CONFLICT (run_id, employee_eid) DO NOTHING
   فتشغيله مرّتين لا يُنتج تكرارًا ولا يمسّ صفًّا موجودًا — وهذا يشمل
   صفًّا رُفع إليه إثبات فعلًا: DO NOTHING لا يمسح file_url.

   ── الربط ──
   أرقام الكشف هي أرقام نظام جسر لا «الرقم الوظيفي» في المنصّة: جسر من
   مرتبتين والمنصّة في المدى 5xx. فالربط يجري عبر حقل «رقم جسر» في سجلّ
   الموظف — مفتاح صريح أُدخل بيد إنسان — لا بمطابقة الأرقام مباشرة ولا
   بمطابقة الأسماء. الأسماء تُطبع للتشخيص وحده ولا تُنشئ رابطًا أبدًا:
   «شميم» و«شميم حسين» يبدوان الشخص نفسه ولا يصحّ أن يقرّر ذلك برنامج.

   ── مصدر القائمة ──
   الافتراضي هو كشف رواتب أغسطس المرفوع على المسير نفسه: هو الوثيقة
   الوحيدة التي تثبت من صُرف له راتب ذلك الشهر. «قائمة الموظفين الحاليين»
   جوابٌ خاطئ — من التحق في سبتمبر ليس من موظفي أغسطس، ومن غادر بعده كان
   منهم — ولا تُستعمل إلّا بعلَم صريح ‎--from-employees مع طباعة تحذير.

   الأسماء تؤخذ من جدول employees لا من الكشف: الخطوط المُجزّأة تُخرج
   الاسم مشوّه الفواصل، فلا يصلح بيانًا مخزّنًا.

   التشغيل:
     node scripts/backfill-payroll-proofs-2026-08.js --dry-run
     node scripts/backfill-payroll-proofs-2026-08.js

   الأعلام:
     --dry-run         يطبع ما سيُكتب ولا يكتب حرفًا. لا INSERT إطلاقًا.
     --from-employees  يتخطّى الكشف ويستعمل سجلّ الموظفين الحالي (يُصفّى
                       بتاريخ المباشرة حتى 2026-08-31 حيث وُجد التاريخ).
     --exclude 82,85   يستثني أرقام جسر بعينها، مسمّاةً واحدًا واحدًا.
                       بديلٌ مقصود عن علَمٍ عامٍّ يتخطّى «كل مجهول»: ذاك
                       كان سيمرّر عشرة من عشرة بضغطة حين يكون الخلل في
                       الربط نفسه لا في موظف غادر. */

const RUN_ID = "2026-08";
const MONTH_END = "2026-08-31";
const F_START = "تاريخ المباشرة";
/* قاعدة الربط وأسماء حقول الهوية تسكن lib/payroll/sheetLink.js لا هنا:
   تحتاجها هذه العملية ومزامنة راتب المسير معًا، ونسختان من قاعدة ربطٍ
   تتباعدان — وهي القاعدة التي تمنع إرفاق إثبات بالشخص الخطأ، فلا تُنسخ.
   وF_DAMANAH هناك هو «الرقم الوظيفي» حرفيًا: رقم الموظف لدى ضمان
   ومفتاح الربط عبر أربعة جداول، لا يُخلط برقم جسر. */
const { sheetUrlOf, linkStaff, F_DAMANAH, F_NAME, F_JOB } = require("../lib/payroll/sheetLink");

/* الاعتماديات تُحقن كي تُختبر الدوالّ بلا قاعدة ولا شبكة. */
function deps(overrides) {
  const o = overrides || {};
  return {
    sql: o.sql || require("../lib/db").getSql(),
    getRun: o.getRun || require("../lib/data/payrollRuns").get,
    listEmployees: o.listEmployees || require("../lib/data/employees").list,
    fetchFile: o.fetchFile || defaultFetchFile,
    extractRoster: o.extractRoster || require("../lib/payroll/sheetRoster").extractRoster,
    log: o.log || console.log,
  };
}

async function defaultFetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`تعذّر تنزيل الكشف (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/* القائمة من الكشف: أرقام جسر من الوثيقة، والهوية من السجلّ عبر «رقم جسر». */
async function rosterFromSheet(run, d, { exclude }) {
  const url = sheetUrlOf(run);
  if (!url) return { ok: false, reason: "no_sheet_attached" };

  const buffer = await d.fetchFile(url);
  const extraction = await d.extractRoster(buffer);
  if (!extraction.ok) return { ok: false, reason: extraction.reason, extraction, url };

  /* الربط بمفتاح «رقم جسر» وحده — المستثنَون بأمر المستخدم اسمٌ مستقلّ
     عن عدّاد الإدراج المتخطّى (ON CONFLICT) في insertRows، فلا يدوس
     أحدهما الآخر في الردّ. */
  const link = linkStaff(extraction.staff, await d.listEmployees(), { exclude });
  if (!link.ok) return { ...link, url, extraction };
  const { linked: roster, unknown, excluded } = link;

  if (unknown.length) {
    return { ok: false, reason: "unknown_jisr_numbers", unknown, roster, excluded, url, extraction };
  }
  return { ok: true, roster, unknown, excluded, url, source: "payroll_sheet", extraction };
}

/* البديل الصريح: سجلّ الموظفين الحالي، مُصفّى بتاريخ المباشرة حيث وُجد.
   من لا تاريخ مباشرة له يُبقى — الحذف بسبب حقل ناقص أسوأ من الإبقاء. */
async function rosterFromEmployees(d) {
  const roster = [];
  const seen = new Set();
  let excluded = 0;
  for (const e of await d.listEmployees()) {
    const eid = String((e && e[F_DAMANAH]) || "").trim();
    const name = String((e && e[F_NAME]) || "").trim();
    if (!eid || !name || seen.has(eid)) continue;
    const start = String((e && e[F_START]) || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && start > MONTH_END) {
      excluded++;
      continue; // التحق بعد أغسطس — ليس من موظفي ذلك الشهر
    }
    seen.add(eid);
    roster.push({ eid, name, jobTitle: String((e && e[F_JOB]) || "").trim() || null });
  }
  return { ok: true, roster, source: "employees_table", excluded };
}

async function resolveRoster(run, d, opts) {
  if (opts.fromEmployees) return rosterFromEmployees(d);
  return rosterFromSheet(run, d, opts);
}

/* الكتابة. dryRun يعني صفر عبارات INSERT — لا «تنفيذ ثم تراجع». */
async function insertRows(roster, d, { dryRun }) {
  if (dryRun) return { inserted: 0, attempted: roster.length, dryRun: true };
  let inserted = 0;
  for (const r of roster) {
    const rows = await d.sql`
      INSERT INTO payroll_transfer_proofs (run_id, employee_eid, employee_name, job_title)
      VALUES (${RUN_ID}, ${r.eid}, ${r.name}, ${r.jobTitle})
      ON CONFLICT (run_id, employee_eid) DO NOTHING
      RETURNING id`;
    if (rows[0]) inserted++;
  }
  return { inserted, attempted: roster.length, skipped: roster.length - inserted };
}

async function backfill(options = {}) {
  const { dryRun = false, fromEmployees = false, exclude = [], ...overrides } = options;
  const d = deps(overrides);

  const run = await d.getRun(RUN_ID);
  if (!run) return { ok: false, reason: "run_not_found", runId: RUN_ID };

  const existing = (run.employees || []).length;
  const resolved = await resolveRoster(run, d, { fromEmployees, exclude });
  if (!resolved.ok) return { ok: false, ...resolved, run, existing };

  const result = await insertRows(resolved.roster, d, { dryRun });
  return {
    ok: true, runId: RUN_ID, monthLabel: run.monthLabel,
    source: resolved.source, sheetUrl: resolved.url || null,
    /* extraction يُمرَّر صراحةً: مسار الفشل ينشر ‎...resolved فيحمله معه،
       أمّا مسار النجاح فيبني كائنًا جديدًا — وكان يُسقطه. فانكسر التقرير
       عند أول تشغيل ناجح فعلًا، بعد أن ظلّ العطل مستورًا ما دامت كل
       التشغيلات تتوقّف عند unknown_jisr_numbers.
       غائب في مسار ‎--from-employees: لا كشف هناك أصلًا، فالمُنادي يفحص. */
    extraction: resolved.extraction || null,
    existing, roster: resolved.roster, unknown: resolved.unknown || [], excluded: resolved.excluded || [],
    ...result,
  };
}

/* ─── واجهة سطر الأوامر ─── */
const REASONS = {
  run_not_found: `لا يوجد مسير بالمعرّف ${RUN_ID}.`,
  no_sheet_attached: "لا كشف رواتب مرفوع على مسير أغسطس، فلا مصدر يثبت موظفيه.\n  إمّا ترفع الكشف على المسير ثم تعيد التشغيل، وإمّا تمرّر --from-employees\n  لاستعمال سجلّ الموظفين الحالي (قائمة تقريبية لا وثيقة).",
  unreadable_pdf: "تعذّرت قراءة ملفّ الكشف كـPDF (قد يكون صورة).",
  no_employee_rows: "لم يُعثر على صفّ موظف واحد في الكشف — بنيته غير متوقّعة.",
  no_totals_row: "لا صفّ إجماليات في الكشف، فلا سبيل للتحقّق من اكتمال الاستخراج.",
  duplicate_jisr_in_sheet: "رقم جسر مكرّر داخل الكشف — القارئ فسّر شيئًا آخر رقم موظف.",
  duplicate_jisr_in_platform: "موظفان يحملان رقم جسر نفسه في سجلّ الموظفين.",
  totals_mismatch: "مجموع الصوافي المستخرجة لا يطابق صف الإجماليات — الاستخراج ناقص.",
  unknown_jisr_numbers: "أرقام جسر في الكشف لا يحملها أي موظف في السجلّ.",
};

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const fromEmployees = argv.includes("--from-employees");
  /* --exclude 82,85 — أرقام جسر مسمّاة واحدًا واحدًا، لا علَم يتخطّى
     «كل مجهول». تجاوز الحاجز يجب أن يكون قرارًا لا سهوًا. */
  const excludeArg = argv[argv.indexOf("--exclude") + 1];
  const exclude = argv.includes("--exclude") && excludeArg && !excludeArg.startsWith("--")
    ? excludeArg.split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  if (argv.includes("--skip-unknown")) {
    console.error("‏--skip-unknown أُزيل. سمِّ الأرقام صراحةً: --exclude 82,85");
    process.exitCode = 1;
    return;
  }

  if (!dryRun && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  if (dryRun && !process.env.DATABASE_URL) {
    console.error("حتى --dry-run يقرأ المسير وسجلّ الموظفين من القاعدة، فيلزمه DATABASE_URL.");
    process.exitCode = 1;
    return;
  }

  console.log(dryRun ? "— معاينة فقط، بلا أي كتابة —\n" : `— تنفيذ فعلي على مسير ${RUN_ID} —\n`);
  if (fromEmployees) {
    console.log("⚠️  المصدر: سجلّ الموظفين الحالي، لا كشف أغسطس.");
    console.log("   هذه قائمة تقريبية: من غادر بعد أغسطس لن يظهر، ومن التحق قبل 2026-08-31 سيظهر\n");
  }

  if (exclude.length) console.log(`مستثنى بأمرك: أرقام جسر ${exclude.join(", ")}\n`);
  const r = await backfill({ dryRun, fromEmployees, exclude });

  if (!r.ok) {
    console.error(`فشل: ${REASONS[r.reason] || r.reason}`);
    if (r.reason === "totals_mismatch" && r.extraction) {
      console.error(`  المستخرج: ${r.extraction.sumNet.toFixed(2)} · المطبوع: ${r.extraction.totalNet.toFixed(2)}`);
    }
    if (r.reason === "duplicate_jisr_in_platform") {
      console.error(`  رقم جسر ${r.jisrNo} عند الموظفَين: ${r.eids.join(" و ")}`);
    }
    if (r.reason === "unknown_jisr_numbers") {
      console.error("");
      for (const u of r.unknown) console.error(`  رقم جسر ${String(u.jisrNo).padStart(5)} — الاسم في الكشف تقريبًا: «${u.nameHint}»`);
      const total = (r.extraction && r.extraction.staff) ? r.extraction.staff.length : r.unknown.length;
      console.error(`\n  ${r.unknown.length} من ${total} غير مربوطين.`);
      if (r.unknown.length === total) {
        console.error("  الكلّ غير مربوط: الأرجح أن حقل «رقم جسر» لم يُملأ بعد لأي موظف.");
        console.error("  شغّل أولًا: node scripts/set-jisr-numbers.js --propose --run 2026-08 --out jisr-map.json");
      } else {
        console.error("  املأ «رقم جسر» لهؤلاء في سجلّ الموظفين، أو استثنِهم صراحةً:");
        console.error(`    --exclude ${r.unknown.map((u) => u.jisrNo).join(",")}`);
      }
      console.error("\n  الاسم أعلاه للتعرّف وحده — لا يُستعمل للربط إطلاقًا.");
    }
    process.exitCode = 1;
    return;
  }

  console.log(`المسير: ${r.monthLabel} (${r.runId})`);
  console.log(`المصدر: ${r.source === "payroll_sheet" ? `كشف الرواتب المرفوع — ${r.sheetUrl}` : "سجلّ الموظفين الحالي"}`);
  /* التقرير لا يُسقط التشغيل: مصدرٌ بلا كشف (‎--from-employees) لا
     extraction له، وسطرُ عرضٍ ناقص أهون من انهيار بعد عمل صحيح. */
  if (r.source === "payroll_sheet" && r.extraction) {
    console.log(`تحقّق الاكتمال: مجموع الصوافي ${r.extraction.sumNet.toFixed(2)} = صف الإجماليات ${r.extraction.totalNet.toFixed(2)} ✅`);
  }
  console.log(`صفوف إثبات موجودة مسبقًا: ${r.existing}`);
  if (r.excluded.length) console.log(`مستثنى بأمرك: أرقام جسر ${r.excluded.map((u) => u.jisrNo).join(", ")}`);
  console.log(`\nالموظفون (${r.roster.length}):`);
  console.log("  رقم جسر → الرقم الوظيفي  الاسم");
  for (const e of r.roster) {
    console.log(`  ${String(e.jisrNo).padStart(7)} → ${String(e.eid).padStart(13)}  ${e.name}${e.jobTitle ? ` — ${e.jobTitle}` : ""}`);
  }

  if (dryRun) {
    console.log(`\nسيُحاول إدراج ${r.attempted} صفًّا بـ ON CONFLICT (run_id, employee_eid) DO NOTHING.`);
    console.log("لم يُكتب شيء. أعد التشغيل بلا --dry-run للتنفيذ.");
    return;
  }
  console.log(`\nأُدرج: ${r.inserted} · موجود مسبقًا فتُخطّي: ${r.skipped}`);
  console.log("لم يُمسّ المسير ولا مرفقاته ولا حالته، ولم يُرسل أي تنبيه.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل غير متوقّع:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { RUN_ID, MONTH_END, backfill, resolveRoster, rosterFromSheet, rosterFromEmployees, sheetUrlOf };
