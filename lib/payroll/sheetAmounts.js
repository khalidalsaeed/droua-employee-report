/* تخزين «راتب المسير» لكل موظف داخل صفّ إثبات تحويله.
   =========================================================================
   المرحلة الأولى من مطابقة إيصالات التحويل، وهي أصل ما بعدها: المطابقة
   النهائية تقارن ثلاث قيم لكل موظف —

     sheet_amount    صافيه في كشف رواتب الشهر            ← هذه الوحدة
     invoice_amount  «صافي الراتب الشهري» في فاتورة ضمان
     receipt_amount  المبلغ المحوَّل فعلًا في الإيصال البنكي

   وبلا الأولى محفوظةً داخل صفّ الموظف لا يوجد مرجعُ راتبٍ يُقاس عليه
   شيء. ولا يصحّ أن يُقرأ حيًّا من سجلّ الموظف عند المقارنة: الراتب
   يتغيّر شهرًا بعد شهر — وقتٌ إضافي وغياب وسلف وخصميات — فراتب سبتمبر
   ليس مرجعًا لأغسطس. القيمة الصحيحة الوحيدة هي ما طُبع في كشف ذلك الشهر
   نفسه، ولذلك تُلقَط منه وتُجمَّد في صفّه.

   ── ما تفعله هذه الوحدة، وما لا تفعله ──
   تقرأ كشف الشهر المرفوع على المسير، تستخرج صافي كل صفّ عبر
   lib/payroll/sheetRoster.js (بحاجز مطابقة المجموع للإجماليات المطبوعة)،
   تربطه بموظفه عبر «رقم جسر» في lib/payroll/sheetLink.js، ثم تكتب
   sheet_amount في صفّه وحده.

   كل كتابة UPDATE مقيّدة بـ(run_id, employee_eid) معًا — لا INSERT
   إطلاقًا. فلا تستطيع هذه العملية أن تُنشئ صفًّا لموظف ليس في لقطة
   المسير، ولا أن تدسّ موظفًا في مسير شهرٍ مضى. ولا تلمس file_url ولا
   file_name ولا uploaded_at: إثبات مرفوع فعلًا لا يتأثّر بمزامنة الراتب.
   ورقمٌ في الكشف بلا صفّ إثبات يُرجَع في `missing` ولا يُنشأ له صفّ —
   تباعدٌ بين الكشف واللقطة يُبلَّغ عنه ولا يُصلَح بالتخمين.

   وIS DISTINCT FROM في شرط الكتابة يجعل إعادة التشغيل تُبلّغ صفر تعديل
   بصدق بدل أن تعدّ عشرة صفوف «حُدّثت» بالقيمة نفسها. */

const { extractRoster: defaultExtractRoster } = require("./sheetRoster");
const { sheetUrlOf, linkStaff } = require("./sheetLink");

function withDeps(deps) {
  const d = deps || {};
  return {
    sql: d.sql || require("../db").getSql(),
    getRun: d.getRun || require("../data/payrollRuns").get,
    listEmployees: d.listEmployees || require("../data/employees").list,
    fetchFile: d.fetchFile || defaultFetchFile,
    extractRoster: d.extractRoster || defaultExtractRoster,
  };
}

async function defaultFetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`تعذّر تنزيل الكشف (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/* بالهللات صحيحةً لا بالريالات عائمةً: السماحية المعتمدة بين الإيصال
   والمسير صفر تامّ، ومقارنة صفرية على أعداد عائمة تكذب. التخزين يبقى
   numeric(12,2) في القاعدة، والمقارنة تجري على أعداد صحيحة. */
const toHalalas = (n) => Math.round(Number(n) * 100);

/* يجمع ما سيُكتب بلا أن يكتب حرفًا. مفصولة عن الكتابة كي يكون --dry-run
   نفس المسار حرفيًا ناقصًا خطوة الكتابة، لا مسارًا ثانيًا قد يتباعد. */
async function resolveSheetAmounts(runId, deps, { exclude } = {}) {
  const d = withDeps(deps);

  const run = await d.getRun(runId);
  if (!run) return { ok: false, reason: "run_not_found", runId };

  const proofs = run.employees || [];
  if (!proofs.length) return { ok: false, reason: "no_proof_rows", runId, run };

  const url = sheetUrlOf(run);
  if (!url) return { ok: false, reason: "no_sheet_attached", runId, run };

  let buffer;
  try {
    buffer = await d.fetchFile(url);
  } catch (err) {
    return { ok: false, reason: "sheet_download_failed", runId, run, url, error: (err && err.message) || String(err) };
  }

  const extraction = await d.extractRoster(buffer);
  if (!extraction.ok) return { ok: false, reason: extraction.reason, runId, run, url, extraction };

  const link = linkStaff(extraction.staff, await d.listEmployees(), { exclude });
  if (!link.ok) return { ok: false, ...link, runId, run, url, extraction };

  /* الصفّ الموجود فعلًا في لقطة المسير هو ما يمكن تحديثه — لا غيره. */
  const byEid = new Map(proofs.map((p) => [String(p.eid), p]));
  const rows = [];
  const missing = [];
  for (const l of link.linked) {
    /* حاجز مضاعف فوق ما يرفضه sheetRoster: قيمة غير رقمية تُكتَب هنا
       فتصير NULL في عمود numeric — أي «لم تُزامَن بعد» على صفٍّ زُومن،
       والتقرير يقول «حُدِّث» بثقة. الرفض تامّ لا جزئي: كشفٌ فيه صافٍ
       واحد غير مقروء لا يُخزَّن منه شيء. */
    /* اشتراط النوع رقمًا لا مجرّد قابليةٍ للتحويل: Number(null) صفرٌ
       منتهٍ، فـ«صافٍ مفقود» كان يعبر الحاجز ويُخزَّن 0.00 — وذاك أسوأ
       من NULL: يبدو راتبًا صحيحًا ويُقارَن كأنه صفر فعلي. و«"3412.08"»
       نصًّا يُرفض أيضًا: sheetRoster يُنتج أرقامًا، فنصٌّ هنا يعني أن
       أحدًا غيّر عقدًا لم يُلاحظ. */
    if (typeof l.net !== "number" || !Number.isFinite(l.net)) {
      return { ok: false, reason: "non_numeric_net", runId, run, url, extraction, jisrNo: l.jisrNo, eid: l.eid, net: l.net };
    }
    const proof = byEid.get(l.eid);
    if (!proof) {
      missing.push(l);
      continue;
    }
    const current = proof.sheetAmount === null || proof.sheetAmount === undefined ? null : Number(proof.sheetAmount);
    rows.push({
      eid: l.eid, jisrNo: l.jisrNo, name: proof.name || l.name,
      net: l.net, current,
      changed: current === null || toHalalas(current) !== toHalalas(l.net),
    });
  }

  /* صفّ إثبات لا يقابله سطر في الكشف: الموظف في لقطة المسير ولا راتب
     له في كشف الشهر. يُبلَّغ ولا يُلمس صفّه — قد يكون غادر، وقد يكون
     الكشف ناقصًا، وكلاهما قرار إنسان لا تخمين برنامج. */
  const linkedEids = new Set(link.linked.map((l) => l.eid));
  const withoutSheetRow = proofs.filter((p) => !linkedEids.has(String(p.eid)))
    .map((p) => ({ eid: String(p.eid), name: p.name }));

  return {
    ok: true, runId, monthLabel: run.monthLabel, url, extraction,
    rows, missing, withoutSheetRow,
    unknown: link.unknown || [], excluded: link.excluded || [],
  };
}

/* الكتابة. dryRun يعني صفر عبارات UPDATE — لا «تنفيذ ثم تراجع». */
async function applySheetAmounts(runId, rows, deps, { dryRun } = {}) {
  const pending = rows.filter((r) => r.changed);
  if (dryRun) return { dryRun: true, updated: 0, attempted: pending.length, unchanged: rows.length - pending.length, notFound: [] };

  const d = withDeps(deps);
  let updated = 0;
  const notFound = [];
  for (const r of pending) {
    const written = await d.sql`
      UPDATE payroll_transfer_proofs
         SET sheet_amount = ${r.net}
       WHERE run_id = ${runId} AND employee_eid = ${r.eid}
         AND sheet_amount IS DISTINCT FROM ${r.net}
      RETURNING id`;
    if (written[0]) updated++;
    else notFound.push(r.eid);
  }
  return { updated, attempted: pending.length, unchanged: rows.length - pending.length, notFound };
}

async function syncSheetAmounts(runId, options = {}) {
  const { dryRun = false, exclude = [], ...deps } = options;
  const resolved = await resolveSheetAmounts(runId, deps, { exclude });
  if (!resolved.ok) return resolved;
  const applied = await applySheetAmounts(runId, resolved.rows, deps, { dryRun });
  return { ...resolved, ...applied };
}

module.exports = { resolveSheetAmounts, applySheetAmounts, syncSheetAmounts, toHalalas };
