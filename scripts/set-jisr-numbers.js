#!/usr/bin/env node
/* إدخال «رقم جسر» للموظفين — على ثلاث خطوات، الكتابة في الأخيرة وحدها.
   =========================================================================
   الربط بين كشف جسر وسجلّ الموظفين يحتاج مفتاحًا صريحًا، ولا يوجد اليوم:
   جسر يرقّم من مرتبتين والمنصّة في المدى 5xx. هذا السكربت يملأ ذلك
   المفتاح مرّة واحدة.

   لماذا ثلاث خطوات لا واحدة: الجسر الوحيد المتاح للاقتراح هو تشابه
   الأسماء، و«شميم» و«شميم حسين» يبدوان الشخص نفسه — وقد لا يكونان.
   برنامج لا يصحّ أن يقرّر ذلك. فالسكربت يقترح، وأنت تراجع وتصحّح ملفًّا
   نصّيًا من عشرة أسطر، ثم يطبّق ما اعتمدتَه أنت لا ما خمّنه هو.

     ١) --propose   يقرأ الكشف والسجلّ ويكتب ملفّ اقتراح محلّيًا.
                    قراءة محضة: لا كتابة واحدة في القاعدة.
     ٢) تراجع الملف بعينك وتصحّح ما يلزم.
     ٣) --apply     يتحقّق ثم يكتب. مع --dry-run يعرض ولا يكتب.

   التشغيل:
     node scripts/set-jisr-numbers.js --propose --run 2026-08 --out jisr-map.json
     node scripts/set-jisr-numbers.js --apply --map jisr-map.json --dry-run
     node scripts/set-jisr-numbers.js --apply --map jisr-map.json

   الأعلام:
     --overwrite  يسمح باستبدال رقم جسر موجود عند موظف. بدونه يتوقّف. */

const fs = require("fs");
const { F_EID, F_NAME, F_JISR, normalizeJisr } = require("../lib/data/employees");

const F_JOB = "المهنة";
const SHEET_ATTACHMENT_KEY = "payroll_sheet";

function deps(o = {}) {
  return {
    getRun: o.getRun || require("../lib/data/payrollRuns").get,
    listEmployees: o.listEmployees || require("../lib/data/employees").list,
    updateEmployee: o.updateEmployee || require("../lib/data/employees").update,
    fetchFile: o.fetchFile || (async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`تعذّر تنزيل الكشف (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    }),
    extractRoster: o.extractRoster || require("../lib/payroll/sheetRoster").extractRoster,
  };
}

/* ─── تشابه الأسماء: للاقتراح والعرض فقط، لا للربط ───
   يُختزل الاسم إلى حروفه الأساسية (بلا همزات ولا تاء مربوطة ولا مسافات)
   كي يقارَب «لامين مولا» بـ«الأمين مولا». النتيجة اقتراحٌ لبشر يراجع،
   ولا تكتب شيئًا بنفسها أبدًا. */
function foldArabic(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[ً-ْـ]/g, "")   // تشكيل وتطويل
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^ء-ي]/g, "");
}

/* نسبة الحروف المشتركة بين الاسمين، منسوبةً إلى الأقصر — فاسمٌ ناقص
   («ساجر» مقابل «ساجر احمد») يبقى مرشّحًا قويًا. */
function similarity(a, b) {
  const x = foldArabic(a), y = foldArabic(b);
  if (!x || !y) return 0;
  const [shortStr, longStr] = x.length <= y.length ? [x, y] : [y, x];
  if (longStr.includes(shortStr)) return 1;
  const pool = [...longStr];
  let hits = 0;
  for (const ch of shortStr) {
    const at = pool.indexOf(ch);
    if (at >= 0) { hits++; pool.splice(at, 1); }
  }
  return hits / shortStr.length;
}

const confidenceOf = (score, rivals) =>
  rivals > 1 ? "غامض" : score >= 0.95 ? "عالية" : score >= 0.7 ? "متوسطة" : "ضعيفة";

async function propose(runId, d) {
  const run = await d.getRun(runId);
  if (!run) return { ok: false, reason: "run_not_found", runId };
  const attachment = (run.attachments || []).find((a) => a.key === SHEET_ATTACHMENT_KEY && a.fileUrl);
  const url = (attachment && attachment.fileUrl) || run.fileUrl || null;
  if (!url) return { ok: false, reason: "no_sheet_attached", runId };

  const extraction = await d.extractRoster(await d.fetchFile(url));
  if (!extraction.ok) return { ok: false, reason: extraction.reason, extraction, url };

  const employees = await d.listEmployees();
  const mappings = [];
  for (const row of extraction.staff) {
    /* كل المرشّحين فوق العتبة، لا الأفضل وحده: مرشّحان متقاربان يعنيان
       «غامض» لا اختيارًا اعتباطيًا. */
    const scored = employees
      .map((e) => ({ e, score: similarity(row.nameHint, e[F_NAME]) }))
      .filter((c) => c.score >= 0.7)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const rivals = scored.filter((c) => best && c.score >= best.score - 0.05).length;
    const confidence = best ? confidenceOf(best.score, rivals) : "لا مرشّح";
    /* الغامض والضعيف يخرجان بـ null صراحةً — لا يُملأ بتخمين. */
    const accept = best && (confidence === "عالية" || confidence === "متوسطة");
    mappings.push({
      "رقم جسر": row.jisrNo,
      "الرقم الوظيفي": accept ? String(best.e[F_EID] || "") : null,
      "الاسم في الكشف (تقريبي)": row.nameHint,
      "الاسم في المنصة": accept ? String(best.e[F_NAME] || "") : null,
      "الثقة": confidence,
    });
  }
  return { ok: true, runId, sheetUrl: url, mappings, extraction };
}

/* ─── التحقّق قبل أي كتابة ─── */
async function validate(mappings, d, { overwrite }) {
  const employees = await d.listEmployees();
  const byEid = new Map(employees.map((e) => [String(e[F_EID] || "").trim(), e]));
  const errors = [];
  const plan = [];
  const seenJisr = new Map();
  const seenEid = new Map();

  for (const m of mappings) {
    const jisr = normalizeJisr(m[F_JISR]);
    const eid = String(m[F_EID] || "").trim();
    const where = `رقم جسر ${m[F_JISR] || "—"}`;

    if (!jisr) { errors.push(`${where}: رقم جسر فارغ`); continue; }
    if (!eid) { errors.push(`${where}: الرقم الوظيفي غير مُعبَّأ (ما زال null) — راجع الملف`); continue; }

    if (seenJisr.has(jisr)) { errors.push(`رقم جسر ${jisr} مكرّر داخل الملف`); continue; }
    seenJisr.set(jisr, eid);
    if (seenEid.has(eid)) { errors.push(`الرقم الوظيفي ${eid} مذكور مرّتين في الملف`); continue; }
    seenEid.set(eid, jisr);

    const employee = byEid.get(eid);
    if (!employee) { errors.push(`${where}: لا موظف بالرقم الوظيفي ${eid}`); continue; }

    /* الرقم مملوك لموظف آخر؟ يُرفض دائمًا — حتى مع --overwrite، فذاك
       للاستبدال على صاحبه لا لانتزاعه من غيره. */
    const holder = employees.find((e) => normalizeJisr(e[F_JISR]) === jisr && String(e[F_EID]).trim() !== eid);
    if (holder) { errors.push(`رقم جسر ${jisr} مستعمل للموظف ${holder[F_NAME]} (${holder[F_EID]})`); continue; }

    const current = normalizeJisr(employee[F_JISR]);
    if (current && current !== jisr && !overwrite) {
      errors.push(`الموظف ${eid} يحمل رقم جسر ${current} بالفعل — مرّر --overwrite لاستبداله بـ ${jisr}`);
      continue;
    }
    plan.push({
      eid, jisr, name: String(employee[F_NAME] || ""), jobTitle: String(employee[F_JOB] || "") || null,
      previous: current, action: current === jisr ? "بلا تغيير" : current ? "استبدال" : "إضافة",
    });
  }
  return { ok: errors.length === 0, errors, plan };
}

async function apply(mappings, d, { dryRun, overwrite } = {}) {
  const checked = await validate(mappings, d, { overwrite });
  if (!checked.ok) return { ok: false, reason: "validation_failed", ...checked };
  if (dryRun) return { ok: true, dryRun: true, plan: checked.plan, written: 0 };

  let written = 0;
  for (const p of checked.plan) {
    if (p.action === "بلا تغيير") continue;
    /* عبر update() القائمة: تحقّق التفرّد في الخادم يعمل، والتغيير
       يُسجَّل في سجلّ التدقيق. لا SQL خام هنا. */
    await d.updateEmployee(p.eid, { [F_JISR]: p.jisr });
    written++;
  }
  return { ok: true, plan: checked.plan, written, unchanged: checked.plan.length - written };
}

/* ─── واجهة سطر الأوامر ─── */
const argOf = (argv, name) => {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : null;
  return v && !v.startsWith("--") ? v : null;
};

function printPlan(plan) {
  console.log("  رقم جسر → الرقم الوظيفي  الإجراء     الاسم");
  for (const p of plan) {
    console.log(`  ${String(p.jisr).padStart(7)} → ${String(p.eid).padStart(13)}  ${p.action.padEnd(10)}  ${p.name}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const wantPropose = argv.includes("--propose");
  const wantApply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const overwrite = argv.includes("--overwrite");

  if (wantPropose === wantApply) {
    console.error("اختر إمّا --propose وإمّا --apply.");
    console.error("  node scripts/set-jisr-numbers.js --propose --run 2026-08 --out jisr-map.json");
    console.error("  node scripts/set-jisr-numbers.js --apply --map jisr-map.json --dry-run");
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ — الخطوتان تقرآن سجلّ الموظفين من القاعدة.");
    process.exitCode = 1;
    return;
  }
  const d = deps();

  if (wantPropose) {
    const runId = argOf(argv, "--run");
    const out = argOf(argv, "--out") || "jisr-map.json";
    if (!runId) { console.error("‏--run مطلوب، مثل: --run 2026-08"); process.exitCode = 1; return; }

    console.log("— اقتراح فقط: لا كتابة واحدة في القاعدة —\n");
    const r = await propose(runId, d);
    if (!r.ok) { console.error("فشل:", r.reason); process.exitCode = 1; return; }

    console.log(`الكشف: ${r.sheetUrl}`);
    console.log(`تحقّق الاكتمال: ${r.extraction.sumNet.toFixed(2)} = ${r.extraction.totalNet.toFixed(2)} ✅\n`);
    console.log("  رقم جسر  الاسم في الكشف (تقريبي)     ← الرقم الوظيفي  الاسم في المنصة        الثقة");
    for (const m of r.mappings) {
      console.log(
        `  ${String(m["رقم جسر"]).padStart(7)}  ${String(m["الاسم في الكشف (تقريبي)"]).padEnd(26)}` +
        ` ← ${String(m["الرقم الوظيفي"] || "؟").padStart(13)}  ${String(m["الاسم في المنصة"] || "—").padEnd(22)} ${m["الثقة"]}`
      );
    }
    const blanks = r.mappings.filter((m) => !m["الرقم الوظيفي"]).length;
    fs.writeFileSync(out, JSON.stringify({ sourceRun: runId, generatedAt: new Date().toISOString(), mappings: r.mappings }, null, 2) + "\n", "utf8");
    console.log(`\nكُتب الاقتراح في ${out} — ملفّ محلّي، لا صفّ في القاعدة.`);
    if (blanks) console.log(`⚠️  ${blanks} سطرًا بلا رقم وظيفي (غامض أو ضعيف) — املأها بيدك.`);
    console.log("الأسماء أعلاه للاقتراح والتشخيص فقط؛ الربط النهائي يقع على ما تعتمده أنت.");
    console.log(`\nراجع الملف ثم: node scripts/set-jisr-numbers.js --apply --map ${out} --dry-run`);
    return;
  }

  const mapPath = argOf(argv, "--map");
  if (!mapPath) { console.error("‏--map مطلوب، مثل: --map jisr-map.json"); process.exitCode = 1; return; }
  const parsed = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const mappings = Array.isArray(parsed) ? parsed : parsed.mappings;
  if (!Array.isArray(mappings)) { console.error("صيغة الملف غير صالحة: يُتوقَّع mappings مصفوفةً."); process.exitCode = 1; return; }

  console.log(dryRun ? "— معاينة فقط، بلا أي كتابة —\n" : "— تنفيذ فعلي —\n");
  const r = await apply(mappings, d, { dryRun, overwrite });
  if (!r.ok) {
    console.error("فشل التحقّق — لم يُكتب شيء:\n");
    for (const e of r.errors) console.error(`  • ${e}`);
    process.exitCode = 1;
    return;
  }
  printPlan(r.plan);
  if (r.dryRun) {
    const changes = r.plan.filter((p) => p.action !== "بلا تغيير").length;
    console.log(`\nسيُحدَّث ${changes} موظفًا. لم يُكتب شيء. أعد التشغيل بلا --dry-run للتنفيذ.`);
    return;
  }
  console.log(`\nحُدِّث: ${r.written} · بلا تغيير: ${r.unchanged}`);
  console.log("لم يُمسّ الرقم الوظيفي ولا أي حقل آخر.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل غير متوقّع:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { propose, validate, apply, similarity, foldArabic };
