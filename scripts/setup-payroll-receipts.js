#!/usr/bin/env node
/* تهيئة قاعدة البيانات لجدول إيصالات التحويل — المرحلة 2.4 من تاسك أجير.
   =========================================================================
   ⚠️ لم يُنفَّذ على أي قاعدة بعد. مُعدٌّ للمراجعة ثم القرار.

   آمن وقابل لإعادة التشغيل: كل عبارة IF NOT EXISTS، ولا يحذف شيئًا ولا
   يعدّل بيانات قائمة. على نمط scripts/setup-payroll-monthly.js حرفيًا.

   وما لا يفعله عمدًا: **لا ALTER TABLE على payroll_transfer_proofs.**
   المرحلة 2.1 أثبتت أن العلاقة والمبلغ والحالة كلّها تُقرأ من جدول
   الإيصالات أو تُشتقّ، فلا عمود واحد يُضاف إلى جدول يحمل بيانات
   Production.

   التشغيل:   node scripts/setup-payroll-receipts.js
   المعاينة:  node scripts/setup-payroll-receipts.js --dry-run
   التحقّق:   node scripts/setup-payroll-receipts.js --verify
              قراءة فقط: يقرأ فهارس النظام ويقارنها بنصّ العبارات هنا.
   التراجع:   node scripts/setup-payroll-receipts.js --rollback --confirm
              يُسقط الجدول وفهارسه. لا يمسّ شيئًا غيره — ولا يمكن أن
              يمسّ، لأنه لم يُضف عمودًا إلى جدول قائم. */

const STATEMENTS = [
  {
    label: "جدول payroll_receipts",
    sql: `
      CREATE TABLE IF NOT EXISTS payroll_receipts (
        id             bigserial   PRIMARY KEY,
        run_id         text        NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,

        -- المصدر: الملفّ كما رُفع. مصدر التدقيق، لا يُحذف أبدًا.
        source_hash    text        NOT NULL,
        source_url     text        NOT NULL,
        source_name    text,
        source_pages   integer     NOT NULL,

        -- مدى هذا الإيصال داخل المصدر
        page_from      integer     NOT NULL,
        page_to        integer     NOT NULL,

        -- هوية الإيصال، مستقلّة عن الملفّ الذي جاء فيه
        receipt_hash   text        NOT NULL,
        dup_state      text        NOT NULL DEFAULT 'none',
        duplicate_of   bigint      REFERENCES payroll_receipts(id) ON DELETE SET NULL,
        dup_resolved_at timestamptz,
        dup_resolved_by text,
        dup_note        text,

        -- الملفّ المستقلّ المقتطَع. NULL = لم يُقتطع بعد.
        file_url       text,
        file_name      text,

        -- ما استُخرج، خامًا كما طُبع
        ext_iban        text,
        ext_account     text,
        ext_beneficiary text,
        ext_bank        text,
        ext_sender      text,
        ext_amount      numeric(12,2),
        ext_date        text,
        ext_reference   text,

        -- حدُّ التقسيم كما قرّرته القاعدة
        identifier_type text,
        start_reason    text,

        -- الربط
        employee_eid   text,
        match_key      text,
        link_status    text        NOT NULL,
        link_reason    text,
        -- رمز ثابت للآلة بجانب النصّ العربي للإنسان: عبارةٌ تُعاد
        -- صياغتها لا تكسر واجهةً ولا تقريرًا.
        link_reason_code text,
        candidates     jsonb,
        linked_at      timestamptz,
        linked_by      text,

        analyzed_at    timestamptz NOT NULL DEFAULT now(),
        uploaded_by    text,

        CONSTRAINT payroll_receipts_pages_sane
          CHECK (page_from >= 1 AND page_to >= page_from AND page_to <= source_pages),

        -- البُعد الأول: الربط
        CONSTRAINT payroll_receipts_link_known
          CHECK (link_status IN ('linked','ambiguous','unlinked','unreadable')),
        -- لا صفّ «مربوط» بلا موظف، ولا صفّ بموظف وحالته غير مربوط
        CONSTRAINT payroll_receipts_link_coherent
          CHECK ((link_status = 'linked') = (employee_eid IS NOT NULL)),
        CONSTRAINT payroll_receipts_key_with_employee
          CHECK ((employee_eid IS NULL) = (match_key IS NULL)),
        CONSTRAINT payroll_receipts_key_known
          CHECK (match_key IS NULL OR match_key IN ('iban','account+bank','manual')),
        -- رقم الحساب الداخلي ليس فريدًا عالميًا: بنكان قد يُصدران الرقم
        -- نفسه. فالربط به مقيَّد بسياق بنكه، والقيد هنا يمنع صفًّا
        -- مربوطًا بحساب بلا بنك حتى لو أخطأت طبقةُ الربط يومًا.
        CONSTRAINT payroll_receipts_account_key_needs_bank
          CHECK (match_key IS DISTINCT FROM 'account+bank' OR ext_bank IS NOT NULL),

        -- البُعد الثالث: التكرار — مستقلّ تمامًا عن الربط
        CONSTRAINT payroll_receipts_dup_known
          CHECK (dup_state IN ('none','candidate','distinct','redundant')),
        CONSTRAINT payroll_receipts_dup_ref
          CHECK (dup_state <> 'none' OR duplicate_of IS NULL),
        -- الحسم قرار إنسان: لا حالة محسومة بلا أثر يسمّي من حسمها
        CONSTRAINT payroll_receipts_dup_resolution
          CHECK ((dup_state IN ('distinct','redundant')) = (dup_resolved_at IS NOT NULL)),
        CONSTRAINT payroll_receipts_no_self_dup
          CHECK (duplicate_of IS NULL OR duplicate_of <> id),

        -- الحاجز الذي يمنع إدراج الإيصال نفسه من المصدر نفسه مرّتين.
        -- والمدى جزء من المفتاح: بلاه يتصادم عشرة إيصالات من ملفّ واحد.
        UNIQUE (run_id, source_hash, page_from, page_to)
      )`,
  },
  {
    label: "فهرس payroll_receipts(run_id)",
    sql: `CREATE INDEX IF NOT EXISTS idx_payroll_receipts_run ON payroll_receipts (run_id)`,
  },
  {
    label: "فهرس payroll_receipts(run_id, receipt_hash)",
    // لكشف النظير عبر مصدرين — للبحث لا للمنع.
    sql: `CREATE INDEX IF NOT EXISTS idx_payroll_receipts_hash ON payroll_receipts (run_id, receipt_hash)`,
  },
  {
    label: "فهرس payroll_receipts(run_id, source_hash)",
    sql: `CREATE INDEX IF NOT EXISTS idx_payroll_receipts_source ON payroll_receipts (run_id, source_hash)`,
  },
  {
    label: "فهرس payroll_receipts(run_id, employee_eid) للمربوطة",
    /* غير فريد عن قصد: عدّة إيصالات لموظف واحد حالة مشروعة
       (split payment). وقيدٌ فريد هنا كان يرفض الإيصال الثاني. */
    sql: `CREATE INDEX IF NOT EXISTS idx_payroll_receipts_employee
            ON payroll_receipts (run_id, employee_eid) WHERE link_status = 'linked'`,
  },
];

/* التراجع. منفصل ومحروس بعلَم صريح: DROP لا يُنفَّذ بالسهو. */
const ROLLBACK = [
  { label: "إسقاط جدول payroll_receipts وفهارسه", sql: `DROP TABLE IF EXISTS payroll_receipts` },
];

/* ─── التحقّق بعد التنفيذ: قراءة فقط ─── */

/* ‎--verify لا يكتب حرفًا ولا يُصلح شيئًا: يقرأ فهارس النظام ويقارنها
   بنصّ العبارات في هذا الملفّ نفسه. فأسماء القيود والفهارس **تُشتقّ**
   من SQL أعلاه لا تُكتب مرّتين — قائمةٌ متوازية تتخلّف عن الأصل بصمت،
   ويصير التحقّق تصديقًا لما لم يُنفَّذ.

   ويُثبت ستّة:
     ① الجدول موجود.
     ② كل قيد CHECK مذكور في العبارة موجود — ومعه نصّه، فيُرى فعلًا
       أن match_key مقصور على الثلاثة وأن account+bank يلزمه ext_bank.
     ③ كل فهرس مطلوب موجود.
     ④ عدد الصفوف صفر.
     ⑤ الجداول القائمة لم تتغيّر: أعمدتها كما كانت، ولا مفتاح أجنبي
       جديد عليها.
     ⑥ الدوال الخادمة اثنتان (فحص ملفّات لا قاعدة). */

const EXISTING_TABLES = {
  /* لقطة أعمدة الجداول القائمة قبل هذه الهجرة. الهجرة لا تحمل ALTER
     واحدًا، فأي فرق هنا معناه أن شيئًا آخر مسّها. */
  payroll_transfer_proofs: [
    "created_at", "employee_eid", "employee_name", "file_name", "file_url",
    "id", "job_title", "run_id", "sheet_amount", "uploaded_at", "uploaded_by",
  ],
};

const NEW_TABLE = "payroll_receipts";

/* الأسماء المتوقَّعة تُستخرج من العبارات نفسها. */
const createSql = () => STATEMENTS.map((s) => s.sql).join("\n");
const expectedChecks = () =>
  [...createSql().matchAll(/CONSTRAINT\s+(\w+)/g)].map((m) => m[1]).sort();
const expectedIndexes = () =>
  [...createSql().matchAll(/CREATE INDEX IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]).sort();

const READ_ONLY = /^select\b/i;
const query = async (sql, text, params) => {
  if (!READ_ONLY.test(String(text).trim())) throw new Error("استعلام تحقّق غير SELECT");
  return sql.query(text, params);
};

async function verify(sql) {
  const results = [];
  const check = (ok, label, detail) => { results.push({ ok, label, detail }); return ok; };

  /* ① الجدول */
  const tbl = await query(sql,
    "SELECT to_regclass($1) AS oid", [NEW_TABLE]);
  const exists = !!(tbl[0] && tbl[0].oid);
  check(exists, `الجدول ${NEW_TABLE} موجود`, exists ? "" : "غير موجود");
  if (!exists) return results;

  /* ② القيود — بأسمائها ونصوصها */
  const cons = await query(sql, `
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = $1::regclass
     ORDER BY conname`, [NEW_TABLE]);
  const byName = new Map(cons.map((c) => [c.conname, c.def]));
  for (const name of expectedChecks()) {
    check(byName.has(name), `قيد ${name}`, byName.get(name) || "مفقود");
  }
  check(cons.some((c) => /UNIQUE .*run_id.*source_hash.*page_from.*page_to/i.test(c.def)),
    "قيد التفرّد (run_id, source_hash, page_from, page_to)");

  /* والشروط التي طُلب إثباتها نصًّا لا اسمًا */
  const keyKnown = byName.get("payroll_receipts_key_known") || "";
  check(/'iban'/.test(keyKnown) && /'account\+bank'/.test(keyKnown) && /'manual'/.test(keyKnown)
        && !/'account'::/.test(keyKnown.replace(/'account\+bank'/g, "")),
    "match_key مقصور على iban · account+bank · manual", keyKnown);
  check(/ext_bank IS NOT NULL/i.test(byName.get("payroll_receipts_account_key_needs_bank") || ""),
    "account+bank يستحيل مربوطًا بلا ext_bank");
  for (const [name, needle] of [
    ["payroll_receipts_dup_known", /'candidate'/],
    ["payroll_receipts_dup_resolution", /dup_resolved_at/i],
    ["payroll_receipts_no_self_dup", /duplicate_of/i],
  ]) check(needle.test(byName.get(name) || ""), `نصّ ${name}`, byName.get(name) || "مفقود");

  /* والعمود الجديد */
  const cols = await query(sql, `
    SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 ORDER BY column_name`, [NEW_TABLE]);
  const colNames = cols.map((c) => c.column_name);
  check(colNames.includes("link_reason_code"), "عمود link_reason_code موجود");

  /* ③ الفهارس */
  const idx = await query(sql,
    "SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname", [NEW_TABLE]);
  const idxNames = new Set(idx.map((r) => r.indexname));
  for (const name of expectedIndexes()) check(idxNames.has(name), `فهرس ${name}`);

  /* ④ صفر صفوف */
  const n = await query(sql, `SELECT count(*)::int AS n FROM ${NEW_TABLE}`);
  check(n[0].n === 0, "عدد الصفوف صفر", String(n[0].n));

  /* ⑤ الجداول القائمة لم تتغيّر */
  for (const [table, expected] of Object.entries(EXISTING_TABLES)) {
    const got = (await query(sql, `
      SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 ORDER BY column_name`, [table])).map((c) => c.column_name);
    const same = got.length === expected.length && got.every((c, i) => c === expected[i]);
    check(same, `أعمدة ${table} كما كانت (${expected.length})`,
      same ? "" : `الآن ${got.length}`);

    /* ولا مفتاح أجنبي جديد منها إلى الجدول الجديد. */
    const fk = await query(sql, `
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = $1::regclass AND contype = 'f'
         AND confrelid = $2::regclass`, [table, NEW_TABLE]);
    check(fk[0].n === 0, `لا مفتاح أجنبي جديد على ${table}`);
  }

  /* وفحصٌ عامّ لا يحتاج لقطةً: لا جدول آخر اكتسب صلةً بالجديد. الصلة
     الوحيدة المشروعة ذاتية — duplicate_of يشير إلى الجدول نفسه. */
  const refs = await query(sql, `
    SELECT DISTINCT conrelid::regclass::text AS tbl
      FROM pg_constraint
     WHERE contype = 'f' AND confrelid = $1::regclass
     ORDER BY tbl`, [NEW_TABLE]);
  const names = refs.map((r) => r.tbl);
  check(names.every((t) => t === NEW_TABLE),
    `لا جدول قائم يشير إلى ${NEW_TABLE}`, names.join(" · ") || "لا شيء");

  return results;
}

/* الدوال الخادمة — فحص ملفّات، لا علاقة له بالقاعدة. */
function verifyFunctions() {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "api");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
  const n = walk(root).length;
  return { ok: n === 2, label: "الدوال الخادمة = 2 (سقف Vercel Hobby)", detail: String(n) };
}

async function run(sql, statements, { onProgress } = {}) {
  for (const s of statements) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return statements.length;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const rollback = argv.includes("--rollback");
  const verifyOnly = argv.includes("--verify");
  const statements = rollback ? ROLLBACK : STATEMENTS;

  if (verifyOnly) {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL غير مُهيّأ — التحقّق يقرأ فهارس النظام.");
      process.exitCode = 1;
      return;
    }
    const { getSql } = require("../lib/db");
    const results = [...(await verify(getSql())), verifyFunctions()];
    for (const r of results) {
      console.log(`${r.ok ? "✅" : "❌"} ${r.label}${r.detail ? `  ${r.detail}` : ""}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${failed ? `فشل ${failed} من ${results.length}` : `تمّ ${results.length} فحصًا`}`);
    if (failed) process.exitCode = 1;
    return;
  }

  if (rollback && !argv.includes("--confirm")) {
    console.error("‏--rollback يُسقط جدول payroll_receipts وكل صفوفه.");
    console.error("أعد التشغيل مع ‎--confirm إن كان ذلك ما تريد.");
    process.exitCode = 1;
    return;
  }
  if (dryRun) {
    console.log(`— معاينة فقط، بلا اتّصال بالقاعدة ${rollback ? "(تراجع)" : ""} —\n`);
    for (const s of statements) console.log(`${s.label}:\n${s.sql.trim()}\n`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  const count = await run(getSql(), statements, { onProgress: (s) => console.log(`${s.label} ... تم`) });
  console.log(`\n${rollback ? "اكتمل التراجع" : "اكتملت التهيئة"} (${count} عبارة).`);
  if (!rollback) console.log("لم تُمسّ أي بيانات قائمة، ولا عمود أُضيف إلى جدول قائم.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = {
  STATEMENTS, ROLLBACK, run,
  verify, verifyFunctions, expectedChecks, expectedIndexes, EXISTING_TABLES, main,
};
