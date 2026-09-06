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
const { F_DAMANAH, F_NAME, F_JISR, normalizeJisr } = require("../lib/data/employees");

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

/* ─── مطابقة الأسماء: للاقتراح والعرض فقط، لا للربط ───
   =========================================================================
   النسخة الأولى قاست اشتراك الحروف بلا ترتيب، فتقاربت أسماءٌ لا صلة
   بينها لمجرّد اشتراك حروف شائعة، وخرجت ثلاثة صفوف «غامضة» كان الصحيح
   فيها بيّنًا لعين بشرية:

     63 «مد طيف الرحمن شهاب» — أربعة أسماء تبدأ بـ«مد» فتزاحمت
     70 «مد شهيد الاسلام»    — «محمد» في السجلّ مقابل «مد» في الكشف
     71 «شميم حسين»          — السجلّ يحمل «شميم» فعوقب على النقص

   المقياس هنا يعمل على الكلمات لا الحروف، ويطبّع ثلاثة فروق حقيقية في
   هذه السجلّات: صور الهمزة والتاء المربوطة، و«محمد» ↔ «مد»، وأل
   التعريف («الرحمن» ↔ «ال رحمن»، «الاسلام» ↔ «اسلام»).

   والقسمة على الاسم الأقصر مقصودة: اسمٌ ناقص في السجلّ («شميم» من
   «شميم حسين») لا يُعاقَب على نقصه، بينما اسمٌ لا تتطابق كلماته يسقط.

   ملاحظة على التطبيع: لا يُستعمل \b إطلاقًا. حدود الكلمات في JavaScript
   مبنيّة على محارف ASCII فلا تحدّ كلمة عربية أصلًا — و`\bمحمد\b` لا
   يطابق شيئًا في نصّ عربي. التقسيم يقع على المسافات صراحةً. */

function foldArabic(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[ً-ْـ]/g, "")   // تشكيل وتطويل
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^ء-ي ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* أل التعريف تُحذف من بداية الكلمة حين يبقى بعدها جذر معتبر، فلا
   يُشوَّه اسم قصير مثل «الي». */
const stripDefiniteArticle = (t) => (t.length > 3 && t.startsWith("ال") ? t.slice(2) : t);

function nameTokens(s) {
  return foldArabic(s)
    .split(" ")
    .filter((t) => t && t !== "ال")
    .map((t) => (t === "محمد" ? "مد" : t))   // تطبيع على مستوى الكلمة
    .map(stripDefiniteArticle)
    .filter(Boolean);
}

/* أطول تتابع مشترك — يراعي ترتيب الحروف، فلا يتساوى اسمان لمجرّد
   اشتراكهما في حروف. */
function lcsLength(a, b) {
  const m = a.length, n = b.length;
  const row = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[n];
}

/* كلمتان تتطابقان إن تساوتا، أو كانت إحداهما بداية الأخرى (اختصار)،
   أو تقاربتا إملائيًا فوق العتبة (تفيق/توفيق، شاركر/شاركير). ما دون
   العتبة صفرٌ لا درجة ضعيفة: تراكم درجات ضعيفة هو ما صنع الغموض. */
const TOKEN_THRESHOLD = 0.7;
function tokenMatch(a, b) {
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.95;
  const ratio = lcsLength(a, b) / Math.max(a.length, b.length);
  return ratio >= TOKEN_THRESHOLD ? ratio : 0;
}

function similarity(a, b) {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.length || !B.length) return 0;
  const [shortTokens, longTokens] = A.length <= B.length ? [A, B] : [B, A];
  const pool = longTokens.slice();
  let sum = 0;
  for (const t of shortTokens) {
    let bestIdx = -1, bestScore = 0;
    pool.forEach((u, i) => { const sc = tokenMatch(t, u); if (sc > bestScore) { bestScore = sc; bestIdx = i; } });
    if (bestIdx >= 0) { sum += bestScore; pool.splice(bestIdx, 1); }   // كل كلمة تُستهلك مرّة
  }
  return sum / shortTokens.length;
}

/* ─── التخصيص الأحادي ───
   اختيار الأفضل لكل صفّ على حدة يسمح بإسناد رقم ضمان واحد إلى رقمَي
   جسر — وهو خطأ صامت يُنتج مسيرًا فيه موظف مرّتين وآخر غائب. فالتخصيص
   عالميّ: جشعٌ تنازليًا ثم تحسين بالتبديل الثنائي حتى لا يبقى تبادل
   يرفع المجموع. عشرة صفوف، فالكلفة لا شيء.

   الحسم لا يُفرض: صفٌّ لا يبلغ عتبة الدرجة، أو لا يفصله فارقٌ واضح عن
   أقوى منافس له، يخرج «غير محسوم» بلا رقم ضمان. تخمينٌ هنا يعني إثبات
   تحويل راتب في بطاقة الموظف الخطأ. */
const DECIDED_MIN_SCORE = 0.6;
const DECIDED_MIN_MARGIN = 0.2;

function assignOneToOne(rows, employees, nameOf) {
  const grid = rows.map((r) => employees.map((e) => similarity(nameOf(r), e.name)));
  const assigned = new Array(rows.length).fill(-1);
  const taken = new Set();

  const pairs = [];
  rows.forEach((_, i) => employees.forEach((__, k) => pairs.push([i, k, grid[i][k]])));
  pairs.sort((a, b) => b[2] - a[2]);
  for (const [i, k, sc] of pairs) {
    if (assigned[i] < 0 && !taken.has(k) && sc > 0) { assigned[i] = k; taken.add(k); }
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < assigned.length; i++) {
      for (let j = i + 1; j < assigned.length; j++) {
        const a = assigned[i], b = assigned[j];
        if (a < 0 || b < 0) continue;
        if (grid[i][b] + grid[j][a] > grid[i][a] + grid[j][b] + 1e-9) {
          assigned[i] = b; assigned[j] = a; improved = true;
        }
      }
    }
  }

  return rows.map((row, i) => {
    const k = assigned[i];
    const score = k >= 0 ? grid[i][k] : 0;
    /* المنافس يُحسب على كل الموظفين لا على غير المُسنَدين وحدهم: أشدّ
       تحفّظًا، فيخرج «غير محسوم» عند أدنى شكّ. */
    let rival = 0;
    employees.forEach((_, x) => { if (x !== k && grid[i][x] > rival) rival = grid[i][x]; });
    const margin = score - rival;
    const decided = k >= 0 && score >= DECIDED_MIN_SCORE && margin >= DECIDED_MIN_MARGIN;
    return { row, employee: decided ? employees[k] : null, score, margin, decided };
  });
}

async function propose(runId, d) {
  const run = await d.getRun(runId);
  if (!run) return { ok: false, reason: "run_not_found", runId };
  const attachment = (run.attachments || []).find((a) => a.key === SHEET_ATTACHMENT_KEY && a.fileUrl);
  const url = (attachment && attachment.fileUrl) || run.fileUrl || null;
  if (!url) return { ok: false, reason: "no_sheet_attached", runId };

  const extraction = await d.extractRoster(await d.fetchFile(url));
  if (!extraction.ok) return { ok: false, reason: extraction.reason, extraction, url };

  const employees = (await d.listEmployees()).map((e) => ({
    eid: String(e[F_DAMANAH] || "").trim(),
    name: String(e[F_NAME] || "").trim(),
  })).filter((e) => e.eid && e.name);

  /* تخصيص عالميّ لا اختيار صفٍّ صفًّا: هو ما يمنع إسناد رقم ضمان واحد
     إلى رقمَي جسر. وما لا يُحسم يبقى null — لا تخمين إجباري. */
  const assignment = assignOneToOne(extraction.staff, employees, (r) => r.nameHint);

  const mappings = assignment.map(({ row, employee, score, margin, decided }) => ({
    "رقم جسر": row.jisrNo,
    "رقم ضمان": employee ? employee.eid : null,
    "الاسم في الكشف (تقريبي)": row.nameHint,
    "الاسم في المنصة": employee ? employee.name : null,
    "الثقة": decided ? "محسوم" : "غير محسوم",
    "الدرجة": Number(score.toFixed(2)),
    "الفارق عن أقوى منافس": Number(margin.toFixed(2)),
  }));

  /* حارس أخير قبل تسليم الاقتراح: تكرار رقم ضمان هنا يعني عطلًا في
     التخصيص لا اجتهادًا، فلا يُسلَّم اقتراح فاسد لمراجعة بشرية. */
  const assignedEids = mappings.map((m) => m["رقم ضمان"]).filter(Boolean);
  if (new Set(assignedEids).size !== assignedEids.length) {
    return { ok: false, reason: "duplicate_damanah_in_proposal", mappings };
  }

  return { ok: true, runId, sheetUrl: url, mappings, extraction };
}

/* ─── التحقّق قبل أي كتابة ─── */
async function validate(mappings, d, { overwrite }) {
  const employees = await d.listEmployees();
  const byEid = new Map(employees.map((e) => [String(e[F_DAMANAH] || "").trim(), e]));
  const errors = [];
  const plan = [];
  const seenJisr = new Map();
  const seenEid = new Map();

  for (const m of mappings) {
    const jisr = normalizeJisr(m[F_JISR]);
    const eid = String(m["رقم ضمان"] || "").trim();
    const where = `رقم جسر ${m[F_JISR] || "—"}`;

    if (!jisr) { errors.push(`${where}: رقم جسر فارغ`); continue; }
    if (!eid) { errors.push(`${where}: رقم ضمان غير مُعبَّأ (ما زال null) — راجع الملف`); continue; }

    if (seenJisr.has(jisr)) { errors.push(`رقم جسر ${jisr} مكرّر داخل الملف`); continue; }
    seenJisr.set(jisr, eid);
    if (seenEid.has(eid)) { errors.push(`رقم ضمان ${eid} مذكور مرّتين في الملف`); continue; }
    seenEid.set(eid, jisr);

    const employee = byEid.get(eid);
    if (!employee) { errors.push(`${where}: لا موظف برقم ضمان ${eid}`); continue; }

    /* الرقم مملوك لموظف آخر؟ يُرفض دائمًا — حتى مع --overwrite، فذاك
       للاستبدال على صاحبه لا لانتزاعه من غيره. */
    const holder = employees.find((e) => normalizeJisr(e[F_JISR]) === jisr && String(e[F_DAMANAH]).trim() !== eid);
    if (holder) { errors.push(`رقم جسر ${jisr} مستعمل للموظف ${holder[F_NAME]} (${holder[F_DAMANAH]})`); continue; }

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
  console.log("  رقم جسر | رقم ضمان | الإجراء    | اسم الموظف");
  for (const p of plan) {
    console.log(`  ${String(p.jisr).padStart(7)} | ${String(p.eid).padStart(8)} | ${p.action.padEnd(10)} | ${p.name}`);
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
    console.log("  رقم جسر | رقم ضمان | اسم الموظف                  | الحالة      | درجة/فارق");
    for (const m of r.mappings) {
      console.log(
        `  ${String(m["رقم جسر"]).padStart(7)} | ${String(m["رقم ضمان"] || "؟").padStart(8)} |` +
        ` ${String(m["الاسم في المنصة"] || "— (غير محسوم)").padEnd(27)} | ${String(m["الثقة"]).padEnd(11)} |` +
        ` ${m["الدرجة"].toFixed(2)} / ${m["الفارق عن أقوى منافس"].toFixed(2)}`
      );
    }
    const blanks = r.mappings.filter((m) => !m["رقم ضمان"]).length;
    fs.writeFileSync(out, JSON.stringify({ sourceRun: runId, generatedAt: new Date().toISOString(), mappings: r.mappings }, null, 2) + "\n", "utf8");
    console.log(`\nكُتب الاقتراح في ${out} — ملفّ محلّي، لا صفّ في القاعدة.`);
    if (blanks) {
      console.log(`⚠️  ${blanks} سطرًا «غير محسوم» بلا رقم ضمان — املأها بيدك بعد التحقّق.`);
      console.log(`   العتبة: درجة ≥ ${DECIDED_MIN_SCORE} وفارق ≥ ${DECIDED_MIN_MARGIN} عن أقوى منافس.`);
    } else {
      console.log("كل الصفوف محسومة، ولا رقم ضمان مُسنَد لأكثر من رقم جسر.");
    }
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
  console.log("لم يُمسّ رقم ضمان ولا أي حقل آخر.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل غير متوقّع:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = {
  propose, validate, apply,
  similarity, foldArabic, nameTokens, tokenMatch, assignOneToOne,
  DECIDED_MIN_SCORE, DECIDED_MIN_MARGIN,
};
