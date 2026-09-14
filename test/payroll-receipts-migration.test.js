const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../scripts/setup-payroll-receipts.js");

/* هجرة جدول الإيصالات — تاسك أجير، المرحلة 2.4.
   =========================================================================
   الهجرة تُنفَّذ مرّةً على قاعدة تحمل بيانات Production. فما يُختبر هنا
   ليس «هل تعمل» بل **ما لا يجوز أن تفعله**: لا ALTER على جدول قائم، ولا
   قيمة مفتاح تخالف ما يُنتجه الكود، ولا DROP بالسهو.

   والتحقّق بعد التنفيذ يُختبر كما يُختبر المنطق: تحقّقٌ يقول «تمام» على
   قاعدة ناقصة أسوأ من غيابه — فهو يُطمئن على ما لم يحدث. */

/* مُزيَّف بواجهة sql.query نفسها. ما يُقاس هنا نصُّ ما يُمرَّر إليه —
   وهو كلّ ما تفعله verify: تقرأ وتقارن. ولا يُستعمل مُشغّل حقيقي لأن
   قيمة الردّ نفسها هي المُدخَل المُختبَر، لا وصولُ الطلب. */
function fakeSql(respond) {
  const queries = [];
  return {
    queries,
    query: async (text, params) => {
      queries.push({ text, params });
      return respond(text, params || []);
    },
  };
}

/* ═══ ① ما لا يجوز أن تفعله الهجرة ═══ */

const allSql = () => S.STATEMENTS.map((s) => s.sql).join("\n");

test("لا ALTER ولا DROP ولا حذف في عبارات الهجرة", () => {
  const sql = allSql();
  /* ALTER على جدول قائم هو الخطر الوحيد الذي لا يُتراجَع عنه بإسقاط
     جدول: payroll_transfer_proofs يحمل بيانات Production. */
  assert.ok(!/\bALTER\b/i.test(sql), "لا ALTER إطلاقًا");
  assert.ok(!/\bDROP\b/i.test(sql), "لا DROP في مسار التهيئة");
  /* ON DELETE CASCADE و ON DELETE SET NULL أفعالُ مراجع في تعريف
     المفتاح الأجنبي، لا عبارات حذف — تُستثنى قبل الفحص وإلّا رُفض
     تعريفٌ سليم. والتعليقات كذلك: نصٌّ لا يُنفَّذ. */
  const executable = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\bON\s+(DELETE|UPDATE)\s+(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/gi, "");
  assert.ok(!/\b(DELETE|TRUNCATE|UPDATE|INSERT)\b/i.test(executable), "ولا مساس ببيانات قائمة");
  /* والجدول الوحيد الذي يُنشأ. */
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(created, ["payroll_receipts"]);
  assert.ok(/CREATE TABLE IF NOT EXISTS payroll_receipts/.test(sql), "وبـIF NOT EXISTS");
  for (const i of sql.match(/CREATE INDEX[^\n]*/gi) || []) {
    assert.match(i, /IF NOT EXISTS/, "كل فهرس IF NOT EXISTS — فإعادة التشغيل آمنة");
  }
});

test("match_key مقصور على الثلاثة التي يُنتجها الكود", () => {
  const M = require("../lib/payroll/receiptMatch");
  const allowed = (allSql().match(/match_key IN \(([^)]*)\)/) || [])[1];
  const set = new Set(allowed.split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
  assert.deepEqual([...set].sort(), ["account+bank", "iban", "manual"]);
  assert.ok(!set.has("account"), "والمفتاح الخام الملغى ليس منها");

  /* والمفتاحان اللذان يُنتجهما الكود فعلًا داخلها — وإلّا رُفض كل صفّ. */
  const idx = M.indexEmployees([
    { "الرقم الوظيفي": "900", IBAN: "SA9100010001000100010001" },
    { "الرقم الوظيفي": "901", "رقم الحساب": "990000000000001", "اسم البنك": "BANK ONE" },
  ]);
  for (const r of [
    { extIban: "SA9100010001000100010001" },
    { extAccount: "990000000000001", extBank: "BANK ONE" },
  ]) assert.ok(set.has(M.linkReceipt(r, idx).matchKey), "مفتاحٌ يُنتجه الكود مسموح");
});

test("القيود التي طُلب إثباتها موجودة نصًّا", () => {
  const sql = allSql();
  assert.match(sql, /link_reason_code\s+text/, "عمود link_reason_code");
  assert.match(sql, /match_key IS DISTINCT FROM 'account\+bank' OR ext_bank IS NOT NULL/,
    "account+bank يستحيل مربوطًا بلا ext_bank");
  assert.match(sql, /dup_state IN \('none','candidate','distinct','redundant'\)/);
  assert.match(sql, /\(dup_state IN \('distinct','redundant'\)\) = \(dup_resolved_at IS NOT NULL\)/,
    "لا حالة محسومة بلا أثر يسمّي من حسمها");
  assert.match(sql, /duplicate_of IS NULL OR duplicate_of <> id/);
  assert.match(sql, /UNIQUE \(run_id, source_hash, page_from, page_to\)/);
  /* ولا قيد فريد على (run_id, employee_eid): split payment حالة مشروعة. */
  assert.ok(!/UNIQUE \(run_id, employee_eid\)/.test(sql), "لا قيد يمنع تعدّد إيصالات الموظف");
});

test("قيد الحسم يقبل distinct+distinct لا redundant وحده", () => {
  /* تحويلان حقيقيان لمستفيد واحد (split payment) يُحسمان distinct
     كلاهما. فقيدٌ يشترط redundant في أحدهما كان يمنع الحسم الصحيح. */
  const sql = allSql();
  const resolution = (sql.match(/payroll_receipts_dup_resolution\s+CHECK \(([^;]*?)\),\n/) || [])[1] || "";
  assert.ok(!/redundant.*AND/i.test(resolution), "لا اشتراط اقتران redundant");
  assert.match(sql, /dup_state IN \('distinct','redundant'\)/,
    "الحسم حالةٌ لكل صفّ على حدة، فالزوجان distinct مقبولان");
});

test("التراجع محروس بـ--confirm ولا يمسّ غير جدوله", () => {
  const sql = S.ROLLBACK.map((s) => s.sql).join("\n");
  assert.match(sql, /DROP TABLE IF EXISTS payroll_receipts/);
  assert.equal(S.ROLLBACK.length, 1, "عبارة واحدة لا غير");
  assert.ok(!/payroll_transfer_proofs|payroll_runs|employees/.test(sql),
    "ولا اسم جدول قائم في مسار التراجع");
});

/* ═══ ② التحقّق بعد التنفيذ ═══ */

/* قاعدة سليمة مُحاكاة: ترد بما تردّ به قاعدةٌ نُفِّذت عليها الهجرة. */
function healthy(overrides = {}) {
  const checks = S.expectedChecks().map((conname) => ({
    conname,
    def: conname === "payroll_receipts_key_known"
      ? "CHECK (match_key IS NULL OR match_key = ANY (ARRAY['iban'::text, 'account+bank'::text, 'manual'::text]))"
      : conname === "payroll_receipts_account_key_needs_bank"
        ? "CHECK (match_key IS DISTINCT FROM 'account+bank'::text OR ext_bank IS NOT NULL)"
        : conname === "payroll_receipts_dup_known"
          ? "CHECK (dup_state = ANY (ARRAY['none'::text, 'candidate'::text, 'distinct'::text, 'redundant'::text]))"
          : conname === "payroll_receipts_dup_resolution"
            ? "CHECK (((dup_state = ANY (ARRAY['distinct'::text, 'redundant'::text]))) = (dup_resolved_at IS NOT NULL))"
            : conname === "payroll_receipts_no_self_dup"
              ? "CHECK (duplicate_of IS NULL OR duplicate_of <> id)"
              : "CHECK (true)",
  }));
  checks.push({ conname: "payroll_receipts_run_id_source_hash_page_from_page_to_key",
                def: "UNIQUE (run_id, source_hash, page_from, page_to)" });

  const state = {
    regclass: [{ oid: "payroll_receipts" }],
    constraints: checks,
    columns: ["id", "link_reason_code", "match_key"],
    indexes: S.expectedIndexes().map((indexname) => ({ indexname })),
    rows: 0,
    existingColumns: S.EXISTING_TABLES.payroll_transfer_proofs,
    newForeignKeys: 0,
    ...overrides,
  };

  return (q, params) => {
    if (/to_regclass/.test(q)) return state.regclass;
    if (/pg_get_constraintdef/.test(q)) return state.constraints;
    if (/contype = 'f'/.test(q)) return [{ n: state.newForeignKeys }];
    if (/information_schema.columns/.test(q)) {
      const table = params[0];
      const list = table === "payroll_receipts" ? state.columns : state.existingColumns;
      return list.map((column_name) => ({ column_name }));
    }
    if (/pg_indexes/.test(q)) return state.indexes;
    if (/count\(\*\)/.test(q)) return [{ n: state.rows }];
    throw new Error(`استعلام غير متوقَّع: ${q}`);
  };
}

const failures = (results) => results.filter((r) => !r.ok).map((r) => r.label);

async function runVerify(overrides) {
  const sql = fakeSql(healthy(overrides));
  return { results: await S.verify(sql), queries: sql.queries };
}

test("التحقّق يمرّ على قاعدة نُفِّذت عليها الهجرة", async () => {
  const { results, queries } = await runVerify();
  assert.deepEqual(failures(results), [], "لا فحص ساقط");
  assert.ok(results.length >= 20, `فحوصٌ فعلية لا واحد: ${results.length}`);
  /* والتحقّق لا يكتب: كل ما مُرِّر إلى القاعدة SELECT. */
  assert.ok(queries.length >= 6, `استعلاماتٌ فعلية: ${queries.length}`);
  for (const q of queries) assert.match(q.text.trim(), /^SELECT\b/i);
});

test("ويسقط على كل نقص — لا يُطمئن على ما لم يحدث", async () => {
  const cases = [
    ["الجدول غير موجود", { regclass: [{ oid: null }] }, /الجدول payroll_receipts موجود/],
    ["قيد ناقص", { constraints: [] }, /قيد payroll_receipts_/],
    ["فهرس ناقص", { indexes: [] }, /فهرس idx_payroll_receipts_/],
    ["صفوف موجودة", { rows: 3 }, /عدد الصفوف صفر/],
    ["عمود link_reason_code مفقود", { columns: ["id"] }, /link_reason_code/],
    ["جدول قائم تغيّر", { existingColumns: ["id"] }, /أعمدة payroll_transfer_proofs/],
    ["مفتاح أجنبي جديد", { newForeignKeys: 1 }, /لا مفتاح أجنبي جديد/],
  ];
  for (const [label, override, expected] of cases) {
    const { results } = await runVerify(override);
    const failed = failures(results);
    assert.ok(failed.some((f) => expected.test(f)), `${label}: لم يُرصَد (${failed.join(" · ")})`);
  }
});

test("ويسقط على قيدٍ موجودٍ بنصٍّ خاطئ — الاسم وحده لا يكفي", async () => {
  /* قيدٌ باسمه الصحيح ونصٍّ يسمح بالمفتاح الملغى: التحقّق بالأسماء
     وحدها كان سيمرّ عليه. */
  const bent = healthy().call(null, "pg_get_constraintdef")
    .map((c) => c.conname === "payroll_receipts_key_known"
      ? { ...c, def: "CHECK (match_key = ANY (ARRAY['iban'::text, 'account'::text]))" } : c);
  const { results } = await runVerify({ constraints: bent });
  assert.ok(failures(results).some((f) => /match_key مقصور/.test(f)), "نصّ القيد يُفحص لا اسمه");

  const noBank = healthy().call(null, "pg_get_constraintdef")
    .map((c) => c.conname === "payroll_receipts_account_key_needs_bank"
      ? { ...c, def: "CHECK (true)" } : c);
  const { results: r2 } = await runVerify({ constraints: noBank });
  assert.ok(failures(r2).some((f) => /ext_bank/.test(f)), "وشرط ext_bank يُفحص نصًّا");
});

test("الأسماء المتوقَّعة تُشتقّ من العبارات لا تُكتب مرّتين", () => {
  /* قائمةٌ متوازية تتخلّف عن الأصل بصمت، فيصير التحقّق تصديقًا لما لم
     يُنفَّذ. فكل اسم مُتوقَّع يجب أن يرد في نصّ العبارات نفسه. */
  const sql = allSql();
  const names = [...S.expectedChecks(), ...S.expectedIndexes()];
  assert.ok(names.length >= 14, `أسماءٌ فعلية: ${names.length}`);
  for (const n of names) assert.ok(sql.includes(n), `${n} مشتقٌّ من العبارات`);
});

test("الدوال الخادمة اثنتان", () => {
  const f = S.verifyFunctions();
  assert.equal(f.ok, true, `سقف Vercel Hobby — الآن ${f.detail}`);
  assert.equal(f.detail, "2");
});

test("‎--rollback بلا ‎--confirm لا ينفّذ شيئًا", async () => {
  /* DROP لا يُنفَّذ بالسهو. والفحص على المسار الفعلي لا على النصّ:
     شرطٌ يُحذف يومًا يجعل عَلَمًا واحدًا يُسقط جدولًا. */
  const argv = process.argv;
  const err = console.error;
  const exitCode = process.exitCode;
  const said = [];
  try {
    process.argv = ["node", "setup", "--rollback"];
    console.error = (...a) => said.push(a.join(" "));
    /* بلا DATABASE_URL أصلًا: لو تجاوز الحارس لسقط بخطأ اتّصال لا
       برسالة الحارس — والتمييز هو المقصود. */
    delete process.env.DATABASE_URL;
    await S.main();
    assert.equal(process.exitCode, 1, "يخرج بفشل");
    assert.ok(said.join("\n").includes("--confirm"), "ويطلب --confirm صراحةً");
    assert.ok(!said.join("\n").includes("DATABASE_URL"), "ولم يبلغ مرحلة الاتّصال");
  } finally {
    process.argv = argv;
    console.error = err;
    process.exitCode = exitCode;
  }
});
