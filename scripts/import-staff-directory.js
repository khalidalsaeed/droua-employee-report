#!/usr/bin/env node
/* استيراد موظفي ذروة إلى الدليل الموحَّد (staff_directory) — مرّة واحدة.
   =========================================================================
   يقرأ «تقرير قائمة الموظفين» (xlsx أو csv) ويصنّف كل صفّ قبل أي كتابة
   (lib/data/staffDirectory.js → classifyImport):

     new · update · unchanged · ajeer (الهوية تطابق موظف أجير — لا يُنشأ)
     review (ملتبس — لا يُكتب) · invalid · skip

   الافتراضيّ معاينةٌ بلا كتابة: يقرأ employees والدليل للمطابقة فقط، ويطبع
   ملخّصًا بهويات مُقنَّعة. التقرير الكامل (--report) يُكتب خارج المستودع
   حصرًا — يرفض أي مسار داخله (المستودع عامّ).

   الكتابة (--apply) في معاملة واحدة، وتُرفض ما بقي صفّ «review» دون حسم.
   الحسم بعد المراجعة: --assign=<رقم الموظف>=new|skip|ajeer:<eid> (يتكرّر).

   التشغيل:
     node scripts/import-staff-directory.js "<التقرير>.xlsx" [--report=/خارج/المستودع/r.json]
     node scripts/import-staff-directory.js "<التقرير>.xlsx" --apply --batch=droua-2026-11
   التراجع عن دفعة:
     node scripts/import-staff-directory.js --undo-batch=droua-2026-11 [--apply]
     يحذف صفوف الدفعة التي لا رحلات لها، ويُعطّل (active=false) ما له رحلات. */
const fs = require("fs");
const path = require("path");
const { readFirstSheet } = require("./import-org-xlsx");
const dir = require("../lib/data/staffDirectory");

const REPO = path.resolve(__dirname, "..");

/* عناوين الأعمدة المقبولة لكل حقل (تُطابَق بعد تطبيع المسافات). */
const ALIASES = {
  number: ["رقم الموظف", "الرقم الوظيفي", "الرقم الوظيفى", "Employee Number", "Employee No", "Employee ID", "Emp No"],
  name: ["الاسم كاملاً باللغة العربية", "الاسم كاملا باللغة العربية", "اسم الموظف", "الاسم", "الاسم الكامل", "Name", "Employee Name", "Full Name"],
  job: ["المسمى الوظيفي", "المسمى", "الوظيفة", "المهنة", "Job Title", "Position", "Title"],
  department: ["القسم", "الإدارة", "الادارة", "Department"],
  identity: ["رقم الهوية/الإقامة", "رقم الهوية / الإقامة", "رقم الهوية", "الهوية", "رقم الإقامة", "رقم الاقامة", "الإقامة", "رقم الهوية الوطنية", "National ID", "Iqama", "Iqama Number", "ID Number"],
  status: ["حالة الموظف", "الحالة", "Status"],
};
const INACTIVE = /غير نشط|منته|مستقيل|موقوف|inactive|terminated/i;
const hnorm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();

/* csv بسيط بعلامات اقتباس مزدوجة (RFC 4180) — بلا اعتمادية. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((cells, i) => ({ rowNo: i + 1, cells }));
}

function readRows(file) {
  const bytes = fs.readFileSync(file);
  return /\.csv$/i.test(file) ? parseCsv(bytes.toString("utf8")) : readFirstSheet(bytes);
}

/* صفّ العناوين: أوّل صفّ (ضمن العشرين الأولى) فيه عمود اسم وعمود رقم. */
function extract(rawRows) {
  for (const r of rawRows.slice(0, 20)) {
    const header = r.cells.map(hnorm);
    const idx = {};
    for (const [key, names] of Object.entries(ALIASES)) {
      const i = names.map(hnorm).map((n) => header.indexOf(n)).find((x) => x >= 0);
      if (i !== undefined) idx[key] = i;
    }
    if (idx.name === undefined || idx.number === undefined) continue;
    const rows = [];
    for (const d of rawRows.slice(rawRows.indexOf(r) + 1)) {
      const v = (k) => (idx[k] === undefined || d.cells[idx[k]] == null ? null : String(d.cells[idx[k]]).trim() || null);
      if (!["number", "name", "job", "department", "identity"].some(v)) continue; // صفّ فارغ
      rows.push({ row: d.rowNo, number: v("number"), name: v("name"), job: v("job"), department: v("department"),
        identity: v("identity"), active: !(v("status") && INACTIVE.test(v("status"))) });
    }
    return { columns: Object.keys(idx), rows };
  }
  throw new Error("لم يُعثر على صفّ عناوين فيه عمود للاسم وعمود لرقم الموظف");
}

function parseAssign(argv) {
  const out = {};
  for (const a of argv.filter((x) => x.startsWith("--assign="))) {
    const m = /^--assign=([^=]+)=(new|skip|ajeer:.+)$/.exec(a);
    if (!m) throw new Error(`صيغة --assign غير صالحة: ${a}`);
    out[m[1].trim()] = m[2];
  }
  return out;
}

function summarize(result) {
  const by = {};
  for (const r of result) by[r.status] = (by[r.status] || 0) + 1;
  return by;
}

/* للطباعة والتقرير: الهوية مُقنَّعة دائمًا. */
const safe = (r) => ({ ...r, identity: r.identity ? dir.mask(r.identity) : null });

function assertOutsideRepo(p) {
  const abs = path.resolve(p);
  if (abs === REPO || abs.startsWith(REPO + path.sep)) throw new Error("التقرير يُكتب خارج المستودع فقط");
  return abs;
}

async function loadContext(sql) {
  const ajeer = (await sql`SELECT eid, name, data FROM employees`).map((e) => ({
    eid: String(e.eid), name: (e.data && e.data["اسم العامل"]) || e.name, identity: e.data && e.data["رقم الإقامة"],
  }));
  const existing = (await sql`SELECT id, employee_number, name, job_title, department, identity_number FROM staff_directory WHERE source_type = 'droua'`)
    .map((d) => ({ id: String(d.id), employeeNumber: d.employee_number, name: d.name, job: d.job_title, department: d.department, identity: d.identity_number }));
  return { ajeer, existing };
}

function writeQueries(sql, result, rows, batch) {
  const byRow = new Map(rows.map((r) => [r.row, r]));
  const q = [];
  for (const r of result) {
    const active = byRow.get(r.row).active;
    if (r.status === "new") {
      q.push(sql`INSERT INTO staff_directory (source_type, employee_number, name, job_title, department, identity_number, active, import_batch)
                 VALUES ('droua', ${r.number}, ${r.name}, ${r.job}, ${r.department}, ${r.identity}, ${active}, ${batch})`);
    } else if (r.status === "update") {
      q.push(sql`UPDATE staff_directory SET name = ${r.name}, job_title = ${r.job}, department = ${r.department},
                   identity_number = COALESCE(${r.identity}, identity_number), active = ${active}, updated_at = now()
                 WHERE id = ${r.staffId} AND source_type = 'droua'`);
    }
  }
  return q;
}

async function undoBatch(sql, batch, apply) {
  const rows = await sql`SELECT d.id, EXISTS (SELECT 1 FROM employee_travel t WHERE t.staff_id = d.id) AS has_trips
                           FROM staff_directory d WHERE d.import_batch = ${batch} AND d.source_type = 'droua'`;
  const del = rows.filter((r) => !r.has_trips).map((r) => String(r.id));
  const off = rows.filter((r) => r.has_trips).map((r) => String(r.id));
  console.log(`الدفعة ${batch}: ${rows.length} صفّ — يُحذف ${del.length}، ويُعطَّل ${off.length} (له رحلات).`);
  if (!apply) { console.log("— معاينة فقط. أضف --apply للتنفيذ. —"); return; }
  await sql.transaction([
    sql`DELETE FROM staff_directory WHERE id = ANY(${del}::bigint[])`,
    sql`UPDATE staff_directory SET active = false, updated_at = now() WHERE id = ANY(${off}::bigint[])`,
  ]);
  console.log("تم.");
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const undo = (argv.find((a) => a.startsWith("--undo-batch=")) || "").slice(13);
  const file = argv.find((a) => !a.startsWith("--"));
  const reportArg = (argv.find((a) => a.startsWith("--report=")) || "").slice(9);
  const batch = (argv.find((a) => a.startsWith("--batch=")) || "").slice(8);
  const reportPath = reportArg ? assertOutsideRepo(reportArg) : null;

  let sql = null;
  if (process.env.DATABASE_URL) sql = require("../lib/db").getSql();
  if (undo) {
    if (!sql) throw new Error("DATABASE_URL مطلوب");
    return undoBatch(sql, undo, apply);
  }
  if (!file) throw new Error("الاستعمال: node scripts/import-staff-directory.js <التقرير.xlsx|csv> [--apply --batch=<اسم>] [--assign=<رقم>=new|skip|ajeer:<eid>] [--report=<مسار خارج المستودع>]");

  const { columns, rows } = extract(readRows(file));
  console.log(`الأعمدة المعرَّفة: ${columns.join("، ")} — ${rows.length} صفّ`);
  if (!columns.includes("identity")) console.log("⚠️ لا عمود هوية/إقامة: المطابقة مع أجير بالاسم وحده تُعرض للمراجعة ولا تُحسم آليًا.");

  const ctx = sql ? await loadContext(sql) : { ajeer: [], existing: [] };
  if (!sql) console.log("⚠️ بلا DATABASE_URL: تصنيف داخل الملف فقط، بلا مطابقة مع أجير أو الدليل. لا كتابة ممكنة.");
  const result = dir.classifyImport(rows, { ...ctx, assign: parseAssign(argv) });
  const sum = summarize(result);
  console.log("الملخّص:", JSON.stringify(sum));
  for (const r of result.filter((x) => x.status === "review" || x.status === "invalid")) {
    console.log(`  صفّ ${r.row} [${r.status}] رقم ${r.number || "—"}: ${r.reason}${r.candidates ? ` (مرشّحو أجير: ${r.candidates.join("، ")})` : ""}`);
  }
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({ file: path.basename(file), summary: sum, rows: result.map(safe) }, null, 2));
    console.log(`التقرير: ${reportPath}`);
  }

  if (!apply) { console.log("\n— معاينة فقط، لم يُكتب شيء. —"); return; }
  if (!sql) throw new Error("DATABASE_URL مطلوب للكتابة");
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(batch)) throw new Error("--batch=<اسم الدفعة> مطلوب (حروف لاتينية وأرقام و-_)");
  if (sum.review) throw new Error(`${sum.review} صفّ ملتبس بلا حسم — راجعها ثم حدّد قرارها بـ--assign. لم يُكتب شيء.`);
  const queries = writeQueries(sql, result, rows, batch);
  if (!queries.length) { console.log("لا جديد للكتابة."); return; }
  await sql.transaction(queries);
  console.log(`تم في معاملة واحدة: ${sum.new || 0} جديد، ${sum.update || 0} تحديث. الدفعة: ${batch}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل — لم يُكتب شيء:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { ALIASES, parseCsv, extract, parseAssign, summarize, assertOutsideRepo, writeQueries };
