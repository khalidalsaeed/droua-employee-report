#!/usr/bin/env node
/* فحصٌ بعد الهجرة: هل المخطّط الحقيقيّ يطابق التصميم؟
   =========================================================================
   ⛔ **للقراءة فقط.** لا CREATE ولا ALTER ولا INSERT ولا UPDATE — ولا صفّ
   واحد يُكتب. كل استعلاماته SELECT على كتالوج النظام.

   ولماذا لا يكفي «تمّت 4 عبارة»: العبارة تنجح ولا تُخبر بما صار في القاعدة.
   فقد يكون الجدول موجودًا من قبل بشكلٍ مختلف — و`IF NOT EXISTS` تتخطّاه
   بصمت وتُعلن النجاح. الفحص الحقيقيّ يقرأ ما هو موجود، لا ما نُفِّذ.

   ── الفحص الأقوى فيه ──
   لا يكتفي بوجود القيد، بل **يُقيّم تعبيره كما خزّنته القاعدة** على أسماء
   ملفّات اختبارية عبر SELECT — بلا إدخال أي صفّ. فلو كان في القيد خطأ
   escaping (كالذي أمسكه الـdry run) لظهر هنا رفضًا لاسمٍ طبيعيّ.

   التشغيل:
     node --env-file=.env.local scripts/verify-droua-schema.js
*/

const BACKSLASH = String.fromCharCode(92);

/* التوقّعات — مرآةُ scripts/setup-droua-files.js. ويحرس تطابقَهما اختبارٌ
   في test/droua-migration-sql.test.js فلا ينحرف أحدهما عن الآخر بصمت. */
const EXPECTED = {
  droua_payroll_runs: {
    columns: {
      id: "uuid NOT NULL",
      period: "text NOT NULL",
      status: "text NOT NULL",
      created_at: "timestamp with time zone NOT NULL",
      analyzed_at: "timestamp with time zone NULL",
      closed_at: "timestamp with time zone NULL",
    },
    constraints: [
      /PRIMARY KEY \(id\)/,
      /UNIQUE \(period\)/,
      /CHECK \(\(\(period\)::text ~ '\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$'/,
      /CHECK[\s\S]*'draft'[\s\S]*'ready'[\s\S]*'analyzed'[\s\S]*'closed'/,
    ],
  },
  droua_payroll_files: {
    columns: {
      id: "uuid NOT NULL",
      run_id: "uuid NOT NULL",
      kind: "text NOT NULL",
      blob_pathname: "text NOT NULL",
      file_name: "text NOT NULL",
      format: "text NOT NULL",
      content_type: "text NOT NULL",
      size_bytes: "bigint NOT NULL",
      plaintext_sha256: "text NOT NULL",
      enc_algo: "text NOT NULL",
      enc_key_id: "text NOT NULL",
      enc_iv: "text NOT NULL",
      enc_tag: "text NOT NULL",
      created_at: "timestamp with time zone NOT NULL",
      superseded_at: "timestamp with time zone NULL",
      deleted_at: "timestamp with time zone NULL",
      purged_at: "timestamp with time zone NULL",
    },
    constraints: [
      /PRIMARY KEY \(id\)/,
      /UNIQUE \(blob_pathname\)/,
      /FOREIGN KEY \(run_id\) REFERENCES droua_payroll_runs\(id\) ON DELETE CASCADE/,
      /CHECK[\s\S]*'cash'[\s\S]*'full'|CHECK[\s\S]*'full'[\s\S]*'cash'/,
      /CHECK[\s\S]*'pdf'[\s\S]*'csv'|CHECK[\s\S]*'csv'[\s\S]*'pdf'/,
      /CHECK \(\(\(size_bytes > 0\) AND \(size_bytes <= 10485760\)\)\)/,
      /droua_payroll_files_type_pair/,
      /droua_payroll_files_lifecycle/,
    ],
    indexes: [
      { name: "idx_droua_payroll_files_current", must: [/UNIQUE/, /\(run_id, kind\)/, /WHERE \(superseded_at IS NULL\)/] },
    ],
  },
  droua_payroll_findings: {
    columns: {
      id: "uuid NOT NULL",
      run_id: "uuid NOT NULL",
      fingerprint: "text NOT NULL",
      rule: "text NOT NULL",
      scope: "text NOT NULL",
      severity: "text NOT NULL",
      title: "text NOT NULL",
      employee_ref: "text NULL",
      employee_name: "text NULL",
      field: "text NULL",
      previous_value: "text NULL",
      current_value: "text NULL",
      delta: "numeric NULL",
      description: "text NULL",
      status: "text NOT NULL",
      user_note: "text NULL",
      first_seen_at: "timestamp with time zone NOT NULL",
      last_seen_at: "timestamp with time zone NOT NULL",
      resolved_at: "timestamp with time zone NULL",
    },
    constraints: [
      /PRIMARY KEY \(id\)/,
      /UNIQUE \(run_id, fingerprint\)/,
      /FOREIGN KEY \(run_id\) REFERENCES droua_payroll_runs\(id\) ON DELETE CASCADE/,
      /CHECK[\s\S]*'within_month'[\s\S]*'vs_previous'/,
      /CHECK[\s\S]*'needs_review'[\s\S]*'needs_fix'/,
    ],
  },
};

/* أسماء ملفّات تُقيَّم على القيد **كما خزّنته القاعدة** — بلا إدخال صفّ. */
const NAME_CASES = [
  ["مسير الرواتب كامل سبتمبر.pdf", true, "اسم عربيّ طبيعيّ"],
  ["payroll-full-2026-09.csv", true, "اسم إنجليزيّ طبيعيّ"],
  ["a", true, "أقصر اسم"],
  ["x".repeat(255), true, "الحدّ الأعلى"],
  ["", false, "فارغ"],
  ["x".repeat(256), false, "أطول من الحدّ"],
  ["dir/file.pdf", false, "شرطة مائلة"],
  [`dir${BACKSLASH}file.pdf`, false, "شرطة عكسية"],
  ["a\r\nX-Evil: 1.pdf", false, "CR/LF"],
  ["a\tb.pdf", false, "جدولة"],
];

let failures = 0;
const step = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مضبوط. شغّله بـ --env-file=.env.local");
    process.exitCode = 1;
    return;
  }
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  console.log("\nفحصٌ بعد الهجرة — قراءةٌ فقط، ولا صفّ يُكتب\n");

  const tables = Object.keys(EXPECTED);

  /* ① الجداول */
  const present = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${tables})`;
  const presentNames = new Set(present.map((r) => r.table_name));
  console.log("① الجداول");
  for (const name of tables) step(presentNames.has(name), name);

  /* ② الأعمدة: الاسم والنوع والقابلية للفراغ — لا الوجود وحده. */
  console.log("\n② الأعمدة");
  for (const [table, spec] of Object.entries(EXPECTED)) {
    if (!presentNames.has(table)) { step(false, `${table} — الجدول غائب`); continue; }
    const rows = await sql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
      ORDER BY ordinal_position`;
    const actual = new Map(rows.map((r) => [r.column_name,
      `${r.data_type} ${r.is_nullable === "YES" ? "NULL" : "NOT NULL"}`]));

    let mismatches = 0;
    for (const [column, expected] of Object.entries(spec.columns)) {
      if (actual.get(column) !== expected) {
        mismatches += 1;
        step(false, `${table}.${column}`, `متوقَّع «${expected}» والموجود «${actual.get(column) || "غائب"}»`);
      }
    }
    const extra = [...actual.keys()].filter((c) => !(c in spec.columns));
    if (extra.length) { mismatches += 1; step(false, `${table}: أعمدة زائدة`, extra.join(", ")); }
    if (!mismatches) step(true, `${table} — ${Object.keys(spec.columns).length} عمودًا مطابقة`);
  }

  /* ③ القيود بتعريفها لا باسمها */
  console.log("\n③ القيود");
  for (const [table, spec] of Object.entries(EXPECTED)) {
    if (!presentNames.has(table)) continue;
    const rows = await sql`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = ${table}::regclass ORDER BY conname`;
    const blob = rows.map((r) => `${r.conname} ${r.def}`).join("\n");
    let missing = 0;
    for (const pattern of spec.constraints) {
      if (!pattern.test(blob)) { missing += 1; step(false, `${table}: قيدٌ ناقص`, String(pattern)); }
    }
    if (!missing) step(true, `${table} — ${spec.constraints.length} قيدًا موجودة`, `المجموع ${rows.length}`);
  }

  /* ④ الفهرس الفريد الجزئيّ */
  console.log("\n④ الفهارس");
  for (const [table, spec] of Object.entries(EXPECTED)) {
    if (!spec.indexes || !presentNames.has(table)) continue;
    const rows = await sql`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${table}`;
    for (const expected of spec.indexes) {
      const found = rows.find((r) => r.indexname === expected.name);
      if (!found) { step(false, expected.name, "غير موجود"); continue; }
      const bad = expected.must.filter((p) => !p.test(found.indexdef));
      step(bad.length === 0, expected.name, bad.length ? found.indexdef : "فريدٌ جزئيّ على الحاليّ");
    }
  }

  /* ⑤ الفحص الحاسم: تقييم قيد اسم الملفّ **كما خزّنته القاعدة** */
  console.log("\n⑤ سلوك قيد file_name (تقييمٌ بلا إدخال)");
  try {
    const rows = await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'droua_payroll_files'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%file_name%'`;
    if (!rows.length) throw new Error("لا قيد على file_name");
    /* CHECK ((...)) → التعبير وحده، ثمّ يُستبدل العمود بمُعامل. */
    const body = rows[0].def.replace(/^CHECK\s*\(/, "").replace(/\)\s*$/, "");
    const parameterized = body.replace(/\bfile_name\b/g, "$1::text");
    for (const [name, expected, label] of NAME_CASES) {
      const [result] = await sql.query(`SELECT (${parameterized}) AS ok`, [name]);
      const ok = result.ok === true;
      step(ok === expected, label, ok === expected ? undefined : `القاعدة ${ok ? "قبلته" : "ردّته"} خلافًا للمتوقَّع`);
    }
  } catch (err) {
    step(false, "تقييم القيد", `تعذّر: ${err.message}`);
  }

  /* ⑥ الجداول فارغة — الهجرة تُنشئ ولا تُدخل */
  console.log("\n⑥ لا بيانات");
  for (const table of tables) {
    if (!presentNames.has(table)) continue;
    const [row] = await sql.query(`SELECT count(*)::int AS n FROM ${table}`, []);
    step(row.n === 0, `${table} فارغ`, row.n === 0 ? undefined : `${row.n} صفًّا`);
  }

  console.log(`\n  الحكم: ${failures === 0 ? "المخطّط مطابق للتصميم ✅" : `${failures} اختلافًا — راجع أعلاه ❌`}\n`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشل الفحص:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED, NAME_CASES, main };
