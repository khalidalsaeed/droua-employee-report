#!/usr/bin/env node
/* فحص حيّ لمطابقة ملفّ التحويل على القاعدة المشتركة — ببيانات وهمية فقط.
   =========================================================================
   القاعدة نفسها تخدم الـPreview والإنتاج، فكل ما يُكتب هنا يُحذف في finally
   مهما حدث، ويُطبع عدد صفوف الاختبار قبل التنظيف وبعده.

   ما يُكتب مؤقّتًا:
     payroll_runs             صفّ مسير وهمي معرّفه TEST_RUN (2099-12) لا غير
     payroll_transfer_proofs  3 موظفين وهميين (T901..T903) لهذا المسير وحده
     payroll_transfer_files / _matches  ما ينتجه الرفع على هذا المسير وحده
   والتنظيف حذفُ صفّ المسير الوهمي؛ البقية تسقط بـON DELETE CASCADE.

   الإثباتات القديمة والمسيرات الحقيقية: قراءة عدّادات قبل/بعد فقط.
   لا يطبع صفًّا ولا آيبانًا ولا اسمًا حقيقيًا.

   التشغيل: DATABASE_URL=... node scripts/verify-payroll-transfers-live.js */

const assert = require("assert");
const F = require("../test/helpers/transfer-fixtures");
const service = require("../lib/payroll/transfers/service");
const payrollRuns = require("../lib/data/payrollRuns");
const { getSql } = require("../lib/db");

const TEST_RUN = "2099-12";
const EMPS = F.EMPLOYEES.slice(0, 3).map((e, i) => ({ ...e, eid: `T90${i + 1}`, jisrNo: `T${i + 1}` }));

async function counts(sql) {
  const n = async (q) => Number((await sql.query(q))[0].n);
  return {
    test_runs: await n(`SELECT count(*)::int n FROM payroll_runs WHERE id = '${TEST_RUN}'`),
    test_proofs: await n(`SELECT count(*)::int n FROM payroll_transfer_proofs WHERE run_id = '${TEST_RUN}'`),
    test_files: await n(`SELECT count(*)::int n FROM payroll_transfer_files WHERE run_id = '${TEST_RUN}'`),
    test_matches: await n(`SELECT count(*)::int n FROM payroll_transfer_matches WHERE run_id = '${TEST_RUN}'`),
    all_transfer_files: await n(`SELECT count(*)::int n FROM payroll_transfer_files`),
    all_transfer_matches: await n(`SELECT count(*)::int n FROM payroll_transfer_matches`),
    real_runs: await n(`SELECT count(*)::int n FROM payroll_runs WHERE id <> '${TEST_RUN}'`),
    legacy_proofs_with_file: await n(`SELECT count(*)::int n FROM payroll_transfer_proofs WHERE file_url IS NOT NULL`),
  };
}

async function main() {
  const sql = getSql();
  const report = { before: await counts(sql) };
  assert.equal(report.before.test_runs, 0, `المسير الوهمي ${TEST_RUN} موجود مسبقًا — توقّف`);
  const deps = {
    listEmployees: async () => EMPS.map((e) => ({ "الرقم الوظيفي": e.eid, "اسم العامل": e.name, IBAN: e.iban })),
    fetchFile: async () => Buffer.from("x"),
    extractRoster: async () => ({ ok: true, staff: EMPS.map((e) => ({ jisrNo: e.jisrNo, net: e.expected / 100 })) }),
    log: () => {},
  };
  const row = (e, amount, ref) => F.row(e.name, e.iban, (amount / 100).toFixed(2), ref, "2100-01-02");
  try {
    await sql`INSERT INTO payroll_runs (id, month_label, uploaded_at, status_key, file_url) VALUES (${TEST_RUN}, 'اختبار آلي — يُحذف', NULL, 'pending_invoice', 'https://example.invalid/sheet.pdf')`;
    for (const e of EMPS) {
      await sql`INSERT INTO payroll_transfer_proofs (run_id, employee_eid, employee_name, job_title) VALUES (${TEST_RUN}, ${e.eid}, ${e.name}, 'اختبار')`;
    }
    report.during_seed = await counts(sql);

    // 1) رفع أوّل: مطابق + ناقص + غير موجود
    const v1 = F.csv([F.HEADER, row(EMPS[0], EMPS[0].expected, "LIVE1"), row(EMPS[1], EMPS[1].expected - 25000, "LIVE2")]);
    let st = await service.reconcileUpload({ runId: TEST_RUN, bytes: v1, fileName: "اسم خام فيه بيانات.csv", actor: { email: "verify@example.invalid" } }, deps);
    assert.equal(st.matches.T901.status, "matched");
    assert.equal(st.matches.T902.status, "amount_mismatch");
    assert.equal(st.matches.T902.diff, -250);
    assert.equal(st.matches.T903.status, "not_found");
    assert.match(st.current.fileName, /^transfer-2099-12-[0-9a-f]{8}\.csv$/);
    report.upload = "ok";

    // 2) نفس الملفّ مرّة أخرى → duplicate_file
    await assert.rejects(service.reconcileUpload({ runId: TEST_RUN, bytes: v1, fileName: "x.csv", replace: true, actor: {} }, deps), (e) => e.code === "duplicate_file");
    // 3) ملفّ آخر بلا تأكيد → exists
    const v2 = F.csv([F.HEADER, ...EMPS.map((e, i) => row(e, e.expected, `LIVE${10 + i}`))]);
    await assert.rejects(service.reconcileUpload({ runId: TEST_RUN, bytes: v2, fileName: "y.csv", actor: {} }, deps), (e) => e.code === "exists");
    report.duplicate_and_confirm = "ok";

    // 4) استبدال مؤكَّد → السابق replaced ونتيجته باقية
    st = await service.reconcileUpload({ runId: TEST_RUN, bytes: v2, fileName: "y.csv", replace: true, actor: { email: "verify@example.invalid" } }, deps);
    assert.equal(st.current.counts.matched, 3);
    assert.deepEqual(st.history.map((h) => h.state), ["current", "replaced"]);
    assert.equal(st.history[1].counts.amount_mismatch, 1);
    report.replace = "ok";

    // 5) القيد: ملفّان حاليّان مستحيلان على مستوى القاعدة
    await assert.rejects(sql.query(`UPDATE payroll_transfer_files SET superseded_at = NULL WHERE run_id = '${TEST_RUN}'`));
    // 6) القيد: الاسم الخام مرفوض بنيويًا
    await assert.rejects(sql.query(`UPDATE payroll_transfer_files SET file_label = 'raw name.csv' WHERE run_id = '${TEST_RUN}'`));
    report.db_constraints = "ok";

    // 7) لا آيبان كامل في الصفوف المخزّنة
    const stored = JSON.stringify(await sql`SELECT f.transfers, f.summary, m.* FROM payroll_transfer_files f JOIN payroll_transfer_matches m ON m.file_id = f.id WHERE f.run_id = ${TEST_RUN}`);
    for (const e of EMPS) assert.ok(!stored.includes(e.iban), "آيبان كامل مخزَّن");
    report.no_full_iban = "ok";

    // 8) الإثباتات القديمة ما زالت تُقرأ في المسيرات الحقيقية (عدّ فقط)
    const real = (await sql`SELECT id FROM payroll_runs WHERE id <> ${TEST_RUN} ORDER BY id DESC LIMIT 3`).map((r) => r.id);
    let legacyVisible = 0;
    for (const id of real) legacyVisible += ((await payrollRuns.get(id)).employees || []).filter((e) => e.proof && e.proof.fileUrl).length;
    report.legacy_proofs_visible_via_api = legacyVisible;
    report.during_test = await counts(sql);
  } finally {
    await sql`DELETE FROM audit_log WHERE target_id = ${TEST_RUN}`;
    await sql`DELETE FROM payroll_runs WHERE id = ${TEST_RUN}`;
    report.after_cleanup = await counts(sql);
  }
  for (const k of ["test_runs", "test_proofs", "test_files", "test_matches"]) assert.equal(report.after_cleanup[k], 0, `بقي ${k}`);
  assert.equal(report.after_cleanup.legacy_proofs_with_file, report.before.legacy_proofs_with_file);
  assert.equal(report.after_cleanup.real_runs, report.before.real_runs);
  return report;
}

module.exports = { main, counts, TEST_RUN };

if (require.main === module) {
  main().catch((e) => { console.error("FAILED:", e.code || "", String(e.message).slice(0, 300)); process.exitCode = 1; });
}
