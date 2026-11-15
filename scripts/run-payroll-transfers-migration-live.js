#!/usr/bin/env node
/* تشغيلة واحدة: عدّادات الأساس ← الهجرة ← فحص القيود والفهارس ← الفحص الحيّ
   ببيانات وهمية مع التنظيف ← مقارنة العدّادات الحقيقية قبل/بعد.

   DATABASE_URL يُمرَّر متغيّرَ بيئة لهذه العملية وحدها ولا يُطبع أبدًا: لا
   console لأي رسالة خطأ خام (قد تحمل نصّ الاتصال) — رمز الخطأ وأوّل سطرٍ
   منقّحٍ فقط. */

const { getSql } = require("../lib/db");
const migration = require("./setup-payroll-transfers");
const live = require("./verify-payroll-transfers-live");

const redact = (s) => String(s || "").replace(/postgres(ql)?:\/\/\S+/gi, "[redacted]").slice(0, 300);

async function realCounts(sql) {
  const n = async (q) => Number((await sql.query(q))[0].n);
  const has = async (t) => Number((await sql.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}'`))[0].n) === 1;
  const out = {
    payroll_runs: await n("SELECT count(*)::int n FROM payroll_runs"),
    payroll_attachments: await n("SELECT count(*)::int n FROM payroll_attachments"),
    payroll_transfer_proofs: await n("SELECT count(*)::int n FROM payroll_transfer_proofs"),
    legacy_proofs_with_file: await n("SELECT count(*)::int n FROM payroll_transfer_proofs WHERE file_url IS NOT NULL"),
    employees: await n("SELECT count(*)::int n FROM employees"),
    audit_log: await n("SELECT count(*)::int n FROM audit_log"),
  };
  out.payroll_transfer_files = (await has("payroll_transfer_files")) ? await n("SELECT count(*)::int n FROM payroll_transfer_files") : "absent";
  out.payroll_transfer_matches = (await has("payroll_transfer_matches")) ? await n("SELECT count(*)::int n FROM payroll_transfer_matches") : "absent";
  return out;
}

async function schema(sql) {
  return {
    constraints: (await sql`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                           WHERE conrelid IN ('payroll_transfer_files'::regclass, 'payroll_transfer_matches'::regclass) ORDER BY 1, 2`)
      .map((c) => `${c.t}: ${c.conname} — ${c.def}`),
    indexes: (await sql`SELECT indexdef FROM pg_indexes WHERE tablename IN ('payroll_transfer_files','payroll_transfer_matches') ORDER BY indexname`).map((i) => i.indexdef),
    generated: (await sql`SELECT column_name, is_generated, generation_expression FROM information_schema.columns WHERE table_name = 'payroll_transfer_files' AND is_generated = 'ALWAYS'`),
  };
}

(async () => {
  const sql = getSql();
  const out = {};
  out.baseline = await realCounts(sql);
  out.migration_statements = await migration.run(sql);
  out.schema = await schema(sql);
  out.after_migration = await realCounts(sql);
  out.live = await live.main();
  out.final = await realCounts(sql);
  const keys = ["payroll_runs", "payroll_attachments", "payroll_transfer_proofs", "legacy_proofs_with_file", "employees", "audit_log"];
  out.real_counts_unchanged = keys.every((k) => out.final[k] === out.baseline[k]);
  out.new_tables_empty = out.final.payroll_transfer_files === 0 && out.final.payroll_transfer_matches === 0;
  console.log(JSON.stringify(out, null, 2));
  if (!out.real_counts_unchanged || !out.new_tables_empty) process.exitCode = 2;
})().catch((e) => { console.error("FAILED:", e && e.code ? e.code : "", redact(e && e.message)); process.exitCode = 1; });
