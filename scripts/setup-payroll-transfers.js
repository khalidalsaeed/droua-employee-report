#!/usr/bin/env node
/* تهيئة القاعدة لمطابقة ملفّ التحويل البنكي لمسير الرواتب.
   =========================================================================
   ⚠️ لا يُشغَّل إلا بعد اعتماد صريح: قاعدة الـPreview هي قاعدة الإنتاج
   نفسها (DATABASE_URL مشترك بين البيئتين في Vercel).

   إضافيّ بالكامل وآمن لإعادة التشغيل: جدولان جديدان وفهارسهما، كل عبارة
   IF NOT EXISTS. لا ALTER على جدول قائم، ولا حذف، ولا تعديل بيانات.
   payroll_runs / payroll_transfer_proofs / payroll_attachments لا تُمسّ.

   ── ما لا يُخزَّن ──
   • الملفّ نفسه لا يُخزَّن إطلاقًا: لا Blob ولا رابط عامّ ولا bytea. تبقى
     بصمته SHA-256 واسمه وحجمه فقط.
   • الآيبان/رقم الحساب لا يُخزَّن كاملًا: آخر أربع خانات + بصمة SHA-256
     (لإعادة المطابقة إن صُحّح آيبان موظف) داخل transfers.

   التشغيل:   node scripts/setup-payroll-transfers.js
   المعاينة:  node scripts/setup-payroll-transfers.js --dry-run
   التراجع:   node scripts/setup-payroll-transfers.js --rollback-sql
              يطبع عبارتي DROP TABLE فقط ولا ينفّذ شيئًا. */

const STATEMENTS = [
  {
    label: "جدول payroll_transfer_files (ملفّ التحويل لكل شهر + السجلّ)",
    sql: `
      CREATE TABLE IF NOT EXISTS payroll_transfer_files (
        id               bigserial PRIMARY KEY,
        run_id           text NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
        file_name        text NOT NULL CHECK (file_name !~ '[[:cntrl:]]' AND length(file_name) <= 200),
        file_format      text NOT NULL CHECK (file_format IN ('pdf', 'xlsx', 'csv')),
        file_size        integer NOT NULL CHECK (file_size > 0),
        file_sha256      text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
        detected_period  text,
        uploaded_by      text,
        uploaded_at      timestamptz NOT NULL DEFAULT now(),
        -- الاستبدال لا يحذف: الملفّ السابق يبقى صفًّا في السجلّ بتاريخ استبداله.
        superseded_at    timestamptz,
        superseded_by    text,
        -- التحويلات المستخرجة مقنَّعة: {line,name,ibanLast4,ibanHash,accountLast4,
        -- accountHash,amount(هللة),reference,date,bank,empNo,flags}
        transfers        jsonb NOT NULL,
        -- عدّادات النتيجة + تحويلات لم تُسنَد (مقنَّعة) + تحذيرات القراءة
        summary          jsonb NOT NULL,
        matched_at       timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    label: "فهرس: ملفّ حالي واحد فقط لكل شهر",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_transfer_files_current
            ON payroll_transfer_files (run_id) WHERE superseded_at IS NULL`,
  },
  {
    label: "جدول payroll_transfer_matches (نتيجة لكل موظف)",
    sql: `
      CREATE TABLE IF NOT EXISTS payroll_transfer_matches (
        id                  bigserial PRIMARY KEY,
        file_id             bigint NOT NULL REFERENCES payroll_transfer_files(id) ON DELETE CASCADE,
        run_id              text NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
        employee_eid        text NOT NULL,
        status              text NOT NULL CHECK (status IN ('matched', 'amount_mismatch', 'not_found', 'needs_review', 'cash')),
        reason              text,
        expected_amount     numeric(12,2),
        transferred_amount  numeric(12,2),
        reference           text,
        transfer_date       date,
        account_masked      text,
        beneficiary_name    text,
        bank                text,
        match_basis         text CHECK (match_basis IS NULL OR match_basis IN ('iban', 'account', 'emp_no', 'name')),
        candidate_count     integer NOT NULL DEFAULT 0,
        name_mismatch       boolean NOT NULL DEFAULT false,
        created_at          timestamptz NOT NULL DEFAULT now(),
        UNIQUE (file_id, employee_eid)
      )`,
  },
  {
    label: "فهرس payroll_transfer_matches(run_id)",
    sql: `CREATE INDEX IF NOT EXISTS idx_payroll_transfer_matches_run ON payroll_transfer_matches (run_id)`,
  },
];

const ROLLBACK = [
  "DROP TABLE IF EXISTS payroll_transfer_matches",
  "DROP TABLE IF EXISTS payroll_transfer_files",
];

async function run(sql, { onProgress } = {}) {
  for (const s of STATEMENTS) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return STATEMENTS.length;
}

async function main() {
  if (process.argv.includes("--rollback-sql")) {
    console.log(ROLLBACK.map((s) => s + ";").join("\n"));
    return;
  }
  if (process.argv.includes("--dry-run")) {
    console.log("— معاينة فقط، بلا اتّصال بالقاعدة —\n");
    for (const s of STATEMENTS) console.log(`${s.label}:\n${s.sql.trim()}\n`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  const count = await run(getSql(), { onProgress: (s) => console.log(`${s.label} ... تم`) });
  console.log(`\nاكتملت التهيئة (${count} عبارة). لم تُمسّ أي بيانات قائمة.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشلت التهيئة:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, ROLLBACK, run };
