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
     --skip-unknown    يمضي رغم وجود رقم وظيفي في الكشف لا صفّ له في
                       employees (موظف غادر وحُذف سجلّه). بدونه يتوقّف. */

const RUN_ID = "2026-08";
const MONTH_END = "2026-08-31";
const F_EID = "الرقم الوظيفي";
const F_NAME = "اسم العامل";
const F_JOB = "المهنة";
const F_START = "تاريخ المباشرة";

const SHEET_ATTACHMENT_KEY = "payroll_sheet";

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

/* رابط كشف الرواتب على المسير: المرفق المخصّص أوّلًا، ثم ملفّ المسير
   الرئيسي — وهو ما ترفعه الواجهة في الحالتين. */
function sheetUrlOf(run) {
  const attachment = (run.attachments || []).find((a) => a.key === SHEET_ATTACHMENT_KEY && a.fileUrl);
  return (attachment && attachment.fileUrl) || run.fileUrl || null;
}

/* القائمة من الكشف: أرقام الموظفين من الوثيقة، وأسماؤهم من السجلّ. */
async function rosterFromSheet(run, d, { skipUnknown }) {
  const url = sheetUrlOf(run);
  if (!url) return { ok: false, reason: "no_sheet_attached" };

  const buffer = await d.fetchFile(url);
  const extraction = await d.extractRoster(buffer);
  if (!extraction.ok) return { ok: false, reason: extraction.reason, extraction, url };

  const byEid = new Map();
  for (const e of await d.listEmployees()) {
    const eid = String((e && e[F_EID]) || "").trim();
    if (eid) byEid.set(eid, e);
  }

  const roster = [];
  const unknown = [];
  for (const row of extraction.staff) {
    const employee = byEid.get(row.eid);
    if (!employee) {
      unknown.push(row);
      continue;
    }
    roster.push({
      eid: row.eid,
      name: String(employee[F_NAME] || "").trim(),
      jobTitle: String(employee[F_JOB] || "").trim() || null,
    });
  }

  if (unknown.length && !skipUnknown) {
    return { ok: false, reason: "unknown_eids", unknown, roster, url, extraction };
  }
  return { ok: true, roster, unknown, url, source: "payroll_sheet", extraction };
}

/* البديل الصريح: سجلّ الموظفين الحالي، مُصفّى بتاريخ المباشرة حيث وُجد.
   من لا تاريخ مباشرة له يُبقى — الحذف بسبب حقل ناقص أسوأ من الإبقاء. */
async function rosterFromEmployees(d) {
  const roster = [];
  const seen = new Set();
  let excluded = 0;
  for (const e of await d.listEmployees()) {
    const eid = String((e && e[F_EID]) || "").trim();
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
  const { dryRun = false, fromEmployees = false, skipUnknown = false, ...overrides } = options;
  const d = deps(overrides);

  const run = await d.getRun(RUN_ID);
  if (!run) return { ok: false, reason: "run_not_found", runId: RUN_ID };

  const existing = (run.employees || []).length;
  const resolved = await resolveRoster(run, d, { fromEmployees, skipUnknown });
  if (!resolved.ok) return { ok: false, ...resolved, run, existing };

  const result = await insertRows(resolved.roster, d, { dryRun });
  return {
    ok: true, runId: RUN_ID, monthLabel: run.monthLabel,
    source: resolved.source, sheetUrl: resolved.url || null,
    existing, roster: resolved.roster, unknown: resolved.unknown || [],
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
  duplicate_eid: "رقم وظيفي مكرّر في الكشف — القارئ فسّر شيئًا آخر رقمًا وظيفيًا.",
  totals_mismatch: "مجموع الصوافي المستخرجة لا يطابق صف الإجماليات — الاستخراج ناقص.",
  unknown_eids: "أرقام في الكشف بلا صفّ في سجلّ الموظفين (موظف غادر وحُذف سجلّه).",
};

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const fromEmployees = argv.includes("--from-employees");
  const skipUnknown = argv.includes("--skip-unknown");

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

  const r = await backfill({ dryRun, fromEmployees, skipUnknown });

  if (!r.ok) {
    console.error(`فشل: ${REASONS[r.reason] || r.reason}`);
    if (r.reason === "totals_mismatch") {
      console.error(`  المستخرج: ${r.extraction.sumNet.toFixed(2)} · المطبوع: ${r.extraction.totalNet.toFixed(2)}`);
    }
    if (r.reason === "unknown_eids") {
      for (const u of r.unknown) console.error(`  رقم ${u.eid} (الاسم في الكشف تقريبًا: «${u.nameHint}»)`);
      console.error("\n  أعِد سجلّ الموظف إلى النظام ثم أعد التشغيل، أو مرّر --skip-unknown لتخطّيه.");
    }
    process.exitCode = 1;
    return;
  }

  console.log(`المسير: ${r.monthLabel} (${r.runId})`);
  console.log(`المصدر: ${r.source === "payroll_sheet" ? `كشف الرواتب المرفوع — ${r.sheetUrl}` : "سجلّ الموظفين الحالي"}`);
  if (r.source === "payroll_sheet") {
    console.log(`تحقّق الاكتمال: مجموع الصوافي ${r.extraction.sumNet.toFixed(2)} = صف الإجماليات ${r.extraction.totalNet.toFixed(2)} ✅`);
  }
  console.log(`صفوف إثبات موجودة مسبقًا: ${r.existing}`);
  if (r.unknown.length) console.log(`متخطّى (لا سجلّ له): ${r.unknown.map((u) => u.eid).join(", ")}`);
  console.log(`\nالموظفون (${r.roster.length}):`);
  for (const e of r.roster) console.log(`  ${String(e.eid).padStart(5)}  ${e.name}${e.jobTitle ? ` — ${e.jobTitle}` : ""}`);

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
