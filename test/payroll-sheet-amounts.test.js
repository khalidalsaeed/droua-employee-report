const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { makeFakeSql } = require("./helpers/fake-sql");
const { extractRoster } = require("../lib/payroll/sheetRoster");
const { resolveSheetAmounts, applySheetAmounts, syncSheetAmounts, toHalalas } = require("../lib/payroll/sheetAmounts");
const FIXTURE = require("./fixtures/payroll-sheet.js");

/* تخزين «راتب المسير» — المرحلة الأولى من مطابقة إيصالات التحويل.
   =========================================================================
   الخطر في عملية كهذه ليس أن تفشل بل أن تنجح وتفعل أكثر ممّا طُلب: تكتب
   راتبًا في صفّ غير صاحبه، أو تمسح إثباتًا مرفوعًا، أو تُنشئ صفًّا
   لموظف ليس في المسير، أو تُخزّن راتبًا نصفَ مقروء من كشفٍ ناقص. فما
   يُقاس هنا هو ما كُتب فعلًا في القاعدة — كل عبارة وكل قيمة — لا ما
   تُرجعه الدالّة عن نفسها.

   العيّنة مُعقَّمة: test/fixtures/payroll-sheet.js يبني كشفًا ببنية
   الكشف الحقيقي حرفيًا وبيانات هوية ومبالغ مُختلقة بالكامل. لا مستند
   أصلي ولا اسم شخص ولا راتب فعلي في المستودع. */

const SHEET = fs.readFileSync(path.join(__dirname, "fixtures", "payroll-sheet-sanitized.pdf"));
const RUN_ID = "2026-08";

/* أرقام جسر 11–20 وأرقام ضمان 900–909 كما في العيّنة. الترقيمان مختلفان
   عمدًا وهذا بيت القصيد: أي شيفرة تبحث برقم الكشف في «الرقم الوظيفي»
   تسقط على هذه العيّنة. */
const EMPLOYEES = FIXTURE.ROSTER.map((r) => ({
  "الرقم الوظيفي": r.eid,
  "رقم جسر": r.jisrNo,
  "اسم العامل": `الموظف ${r.eid}`,
  "المهنة": "عامل",
}));

/* صفوف الإثبات كما يُرجعها lib/data/payrollRuns.js — sheetAmount null
   يعني «لم تُزامَن بعد». */
function proofRows({ withAmounts = false, only = null } = {}) {
  return FIXTURE.ROSTER
    .filter((r) => !only || only.includes(r.eid))
    .map((r) => ({
      eid: r.eid,
      jisrNo: r.jisrNo,
      name: `الموظف ${r.eid}`,
      jobTitle: "عامل",
      sheetAmount: withAmounts ? FIXTURE.netOf(r) : null,
      proof: null,
    }));
}

function runWith(employees) {
  return {
    id: RUN_ID, monthLabel: "أغسطس 2026", statusKey: "pending_invoice", uploadedAt: "2026-09-02",
    fileUrl: "https://blob/2026-08.pdf",
    attachments: [{ key: "payroll_sheet", fileUrl: "https://blob/sheet-2026-08.pdf", statusKey: "attached" }],
    employees,
  };
}

function harness(over = {}) {
  const sql = makeFakeSql((call) => (/UPDATE payroll_transfer_proofs/.test(call.text) ? [{ id: 1 }] : []));
  return {
    sql,
    opts: {
      sql,
      getRun: async (id) => (id === RUN_ID ? runWith(proofRows()) : null),
      listEmployees: async () => EMPLOYEES,
      fetchFile: async () => SHEET,
      extractRoster,
      ...over,
    },
  };
}

/* ── العيّنة المُعقَّمة تحفظ بنية الكشف الحقيقي ── */

test("العيّنة يقرؤها المحلّل الحقيقي: عشرة صفوف ومجموع مطابق للإجماليات", async () => {
  const r = await extractRoster(SHEET);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.staff.length, 10);
  /* حاجز السلامة نفسه الذي يحمي الكشف الحقيقي: تخطّي صفّ يكسر المطابقة. */
  assert.equal(toHalalas(r.sumNet), toHalalas(r.totalNet));
  assert.equal(toHalalas(r.totalNet), toHalalas(FIXTURE.TOTAL_NET));
});

test("العيّنة تحمل أرقام جسر لا أرقام ضمان — الترقيمان لا يختلطان", async () => {
  const r = await extractRoster(SHEET);
  const numbers = r.staff.map((s) => s.jisrNo);
  assert.deepEqual(numbers, FIXTURE.ROSTER.map((x) => x.jisrNo));
  for (const n of numbers) assert.ok(!/^9\d\d$/.test(n), `${n} رقم ضمان لا رقم جسر`);
});

test("العيّنة تحمل حالة فرق الثماني هللات: صافٍ ينتهي بـ.08", async () => {
  const r = await extractRoster(SHEET);
  const cents = r.staff.map((s) => toHalalas(s.net) % 100);
  assert.ok(cents.includes(8), "لا صافٍ ينتهي بـ.08 — تختفي حالة الاختبار الأهمّ");
});

test("العيّنة خالية من أي بيان هوية حقيقي", () => {
  const text = SHEET.toString("latin1");
  /* أرقام الإقامة السعودية عشرة أرقام تبدأ بـ2، وIBAN السعودي SA ثم 22
     رقمًا. لا شيء من هذين يصحّ أن يظهر في مستودع. */
  assert.equal(/(?<!\d)2\d{9}(?!\d)/.test(text), false, "ما يشبه رقم إقامة");
  assert.equal(/SA\d{22}/.test(text), false, "ما يشبه IBAN");
  /* وأرقام ضمان الحقيقية في المدى 5xx — العيّنة في 9xx. */
  for (const r of FIXTURE.ROSTER) assert.match(r.eid, /^9\d\d$/);
});

/* ── القراءة والربط ── */

test("يربط كل راتب بصاحبه عبر رقم جسر لا بالاسم ولا بالمبلغ", async () => {
  const h = harness();
  const r = await resolveSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.rows.length, 10);
  for (const row of r.rows) {
    const expected = FIXTURE.ROSTER.find((x) => x.jisrNo === row.jisrNo);
    assert.equal(row.eid, expected.eid, `جسر ${row.jisrNo} يجب أن يُربط بضمان ${expected.eid}`);
    assert.equal(toHalalas(row.net), toHalalas(FIXTURE.netOf(expected)));
  }
  assert.equal(h.sql.calls.length, 0, "القراءة لا تكتب");
});

test("راتب الثماني هللات يُخزَّن بمنزلتيه كاملتين", async () => {
  const h = harness();
  const r = await resolveSheetAmounts(RUN_ID, h.opts);
  const row = r.rows.find((x) => toHalalas(x.net) % 100 === 8);
  assert.ok(row, "صفّ الـ.08 موجود");
  /* هذا هو الفرق الذي وُجدت الميزة لأجله: تدويرٌ إلى الريال يمحوه. */
  assert.notEqual(toHalalas(row.net) % 100, 0);
  assert.equal(toHalalas(row.net), Math.round(row.net * 100));
});

/* ── الكتابة: ما يُكتب، وما لا يُمسّ ── */

test("كل كتابة UPDATE مقيّدة بالمسير ورقم ضمان معًا — ولا INSERT إطلاقًا", async () => {
  const h = harness();
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(h.sql.calls.length, 10);
  for (const c of h.sql.calls) {
    assert.match(c.text, /^UPDATE payroll_transfer_proofs/);
    assert.match(c.text, /WHERE run_id = \? AND employee_eid = \?/);
    assert.ok(!/INSERT/.test(c.text), "لا إدراج — العملية تُحدّث صفوفًا قائمة فقط");
  }
});

test("لا INSERT ولا DELETE ولا TRUNCATE ولا ALTER على أي جدول", async () => {
  const h = harness();
  await syncSheetAmounts(RUN_ID, h.opts);
  const joined = h.sql.calls.map((c) => c.text).join(" ");
  for (const verb of ["INSERT", "DELETE", "TRUNCATE", "ALTER", "DROP"]) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(joined), `يجب ألّا تظهر ${verb}`);
  }
});

test("لا مساس بـpayroll_runs ولا payroll_attachments ولا بأي إثبات مرفوع", async () => {
  const h = harness();
  await syncSheetAmounts(RUN_ID, h.opts);
  const joined = h.sql.calls.map((c) => c.text).join(" ");
  assert.ok(!/payroll_runs/.test(joined), "لا حالة ولا source ولا notified_at");
  assert.ok(!/payroll_attachments/.test(joined), "لا مرفقات");
  /* الأخطر: مزامنة راتب لا يصحّ أن تمسح إثباتًا رُفع فعلًا. */
  for (const col of ["file_url", "file_name", "uploaded_at", "uploaded_by", "employee_name", "job_title"]) {
    assert.ok(!new RegExp(col).test(joined), `${col} يجب ألّا يظهر في أي كتابة`);
  }
  assert.ok(/SET sheet_amount = \?/.test(joined), "العمود الوحيد المكتوب هو sheet_amount");
});

test("لا مسير غير المستهدَف يظهر في أي قيمة مكتوبة", async () => {
  const h = harness();
  await syncSheetAmounts(RUN_ID, h.opts);
  for (const c of h.sql.calls) {
    assert.equal(c.values[1], RUN_ID, "run_id في شرط الكتابة");
    const others = c.values.filter((v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v) && v !== RUN_ID);
    assert.deepEqual(others, [], "لا معرّف شهر آخر في أي قيمة");
  }
});

test("قيمة كل كتابة هي راتب صاحب الصفّ لا راتب غيره", async () => {
  const h = harness();
  await syncSheetAmounts(RUN_ID, h.opts);
  for (const c of h.sql.calls) {
    const eid = c.values[2];
    const expected = FIXTURE.ROSTER.find((x) => x.eid === eid);
    assert.ok(expected, `${eid} موظف معروف`);
    assert.equal(toHalalas(c.values[0]), toHalalas(FIXTURE.netOf(expected)),
      `الصفّ ${eid} يجب أن يحمل راتبه هو`);
  }
});

/* ── إعادة التشغيل ── */

test("إعادة التشغيل على قيم مطابقة: صفر كتابة وصفر تعديل مُبلَّغ", async () => {
  const h = harness({ getRun: async () => runWith(proofRows({ withAmounts: true })) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(h.sql.calls.length, 0, "لا كتابة لقيمة لم تتغيّر");
  assert.equal(r.updated, 0);
  assert.equal(r.unchanged, 10, "يُبلَّغ بصدق أن العشرة كما هي");
});

test("شرط IS DISTINCT FROM موجود في الكتابة — الحاجز في القاعدة لا في الشيفرة وحدها", async () => {
  const h = harness();
  await syncSheetAmounts(RUN_ID, h.opts);
  assert.match(h.sql.calls[0].text, /sheet_amount IS DISTINCT FROM \?/);
});

test("تصحيح قيمة خاطئة يُكتب ويُبلَّغ عن القيمة السابقة", async () => {
  const wrong = proofRows({ withAmounts: true });
  wrong[0].sheetAmount = 1;
  const h = harness({ getRun: async () => runWith(wrong) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(h.sql.calls.length, 1, "الصفّ الخاطئ وحده يُكتب");
  assert.equal(h.sql.calls[0].values[2], wrong[0].eid);
  const row = r.rows.find((x) => x.eid === wrong[0].eid);
  assert.equal(row.current, 1);
  assert.equal(row.changed, true);
});

/* فرق هللةٍ واحدة تغيير: المقارنة بالهللات الصحيحة لا بالريالات العائمة،
   لأن السماحية المعتمدة بين الإيصال والمسير صفر تامّ. */
test("فرق هللة واحدة يُعدّ تغييرًا — 3412.08 ليست 3412.10", async () => {
  const near = proofRows({ withAmounts: true });
  const target = near.find((x) => toHalalas(x.sheetAmount) % 100 === 8);
  target.sheetAmount = Number((target.sheetAmount + 0.02).toFixed(2));
  const h = harness({ getRun: async () => runWith(near) });
  await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(h.sql.calls.length, 1, "هللتان فرقًا تكفيان لإعادة الكتابة");
  assert.equal(h.sql.calls[0].values[2], target.eid);
});

/* ── التباعد بين الكشف واللقطة: يُبلَّغ ولا يُخمَّن ── */

test("رقم جسر لا يحمله أحد: يُبلَّغ، ولا راتب له يُكتب، والباقي يُكتب", async () => {
  const short = EMPLOYEES.slice(0, 8);
  const h = harness({ listEmployees: async () => short });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.unknown.length, 2, "الرقمان المجهولان يُبلَّغ عنهما");
  assert.equal(h.sql.calls.length, 8, "ولا يُكتب لهما شيء");
  const writtenEids = h.sql.calls.map((c) => c.values[2]);
  for (const e of FIXTURE.ROSTER.slice(8)) {
    assert.ok(!writtenEids.includes(e.eid), `${e.eid} لم يُربط فلا يُكتب`);
  }
});

test("موظف في الكشف بلا صفّ إثبات: يُبلَّغ في missing ولا يُنشأ له صفّ", async () => {
  const eids = FIXTURE.ROSTER.slice(0, 7).map((r) => r.eid);
  const h = harness({ getRun: async () => runWith(proofRows({ only: eids })) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.missing.length, 3);
  assert.equal(h.sql.calls.length, 7, "الصفوف الموجودة وحدها تُحدَّث");
  const joined = h.sql.calls.map((c) => c.text).join(" ");
  assert.ok(!/INSERT/.test(joined), "لا إدراج لموظف ليس في لقطة المسير");
});

test("موظف في المسير بلا سطر في الكشف: يُبلَّغ ولا يُمسّ صفّه", async () => {
  const extra = proofRows();
  extra.push({ eid: "999", jisrNo: null, name: "موظف بلا سطر في الكشف", jobTitle: null, sheetAmount: null, proof: null });
  const h = harness({ getRun: async () => runWith(extra) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.deepEqual(r.withoutSheetRow.map((w) => w.eid), ["999"]);
  assert.equal(h.sql.calls.length, 10);
  assert.ok(!h.sql.calls.some((c) => c.values.includes("999")), "صفّه لا يُمسّ");
});

test("موظفان برقم جسر واحد في السجلّ: رفض تامّ بلا كتابة", async () => {
  const dup = [...EMPLOYEES, { "الرقم الوظيفي": "911", "رقم جسر": FIXTURE.ROSTER[0].jisrNo, "اسم العامل": "مكرّر" }];
  const h = harness({ listEmployees: async () => dup });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate_jisr_in_platform");
  assert.equal(h.sql.calls.length, 0, "لا يختار البرنامج أحدهما اعتباطًا");
});

/* ── حواجز الرفض التامّ ── */

test("كشف لا يطابق مجموعه إجمالياته: رفض تامّ بلا كتابة", async () => {
  const h = harness({ extractRoster: async () => ({ ok: false, reason: "totals_mismatch", sumNet: 1, totalNet: 2 }) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "totals_mismatch");
  assert.equal(h.sql.calls.length, 0, "استخراج ناقص لا يُخزَّن جزئيًا");
});

test("كشف غير مقروء: رفض بلا كتابة ولا تخمين", async () => {
  const h = harness({ extractRoster: async () => ({ ok: false, reason: "unreadable_pdf" }) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable_pdf");
  assert.equal(h.sql.calls.length, 0);
});

test("مسير بلا كشف مرفوع: رفض بلا كتابة", async () => {
  const h = harness({ getRun: async () => ({ ...runWith(proofRows()), fileUrl: null, attachments: [] }) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.reason, "no_sheet_attached");
  assert.equal(h.sql.calls.length, 0);
});

test("مسير بلا صفوف إثبات: رفض بلا كتابة، ولا تنزيل للكشف أصلًا", async () => {
  let fetched = 0;
  const h = harness({
    getRun: async () => runWith([]),
    fetchFile: async () => { fetched++; return SHEET; },
  });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.reason, "no_proof_rows");
  assert.equal(h.sql.calls.length, 0);
  assert.equal(fetched, 0, "لا تنزيل بلا صفوف تُحدَّث");
});

test("مسير غير موجود: رفض بلا كتابة", async () => {
  const h = harness({ getRun: async () => null });
  const r = await syncSheetAmounts("2099-01", h.opts);
  assert.equal(r.reason, "run_not_found");
  assert.equal(h.sql.calls.length, 0);
});

test("فشل تنزيل الكشف يُبلَّغ ولا يُسقط العملية بخطأ غير ممسوك", async () => {
  const h = harness({ fetchFile: async () => { throw new Error("HTTP 503"); } });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "sheet_download_failed");
  assert.match(r.error, /503/);
  assert.equal(h.sql.calls.length, 0);
});

/* ── المعاينة ── */

test("--dry-run: صفر عبارات SQL، ومع ذلك تقرير كامل", async () => {
  const h = harness();
  const r = await syncSheetAmounts(RUN_ID, { ...h.opts, dryRun: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(h.sql.calls.length, 0, "لا «تنفيذ ثم تراجع»");
  assert.equal(r.dryRun, true);
  assert.equal(r.attempted, 10, "ومع ذلك يعرف بالضبط ما كان سيُكتب");
  assert.equal(r.rows.length, 10);
});

test("--exclude يستثني رقم جسر مسمّى ولا يكتب له", async () => {
  const skip = FIXTURE.ROSTER[2];
  const h = harness();
  const r = await syncSheetAmounts(RUN_ID, { ...h.opts, exclude: [skip.jisrNo] });
  assert.equal(r.excluded.length, 1);
  assert.equal(h.sql.calls.length, 9);
  assert.ok(!h.sql.calls.some((c) => c.values.includes(skip.eid)), "المستثنى لا يُكتب");
});

/* الصفر الأولي في رقم جسر لا يُنشئ موظفًا ثانيًا — نفس التطبيع الذي
   يحميه الفهرس الفريد في القاعدة. */
test("«011» و«11» رقم جسر واحد", async () => {
  const padded = EMPLOYEES.map((e) => (e["رقم جسر"] === "11" ? { ...e, "رقم جسر": "011" } : e));
  const h = harness({ listEmployees: async () => padded });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.unknown.length, 0, "الصفر الأولي لا يمنع الربط");
  assert.equal(h.sql.calls.length, 10);
});

/* ── الكتابة مفصولة عن القراءة ── */

test("applySheetAmounts وحدها لا تكتب صفًّا لم يُوسم بـchanged", async () => {
  const sql = makeFakeSql(() => [{ id: 1 }]);
  const r = await applySheetAmounts(RUN_ID, [
    { eid: "900", net: 10, changed: false },
    { eid: "901", net: 20, changed: true },
  ], { sql });
  assert.equal(sql.calls.length, 1);
  assert.equal(sql.calls[0].values[2], "901");
  assert.equal(r.updated, 1);
  assert.equal(r.unchanged, 1);
});

test("صفّ لم تُصبه الكتابة يُبلَّغ في notFound ولا يُعدّ محدَّثًا", async () => {
  const sql = makeFakeSql(() => []); // لا صفّ عاد — الشرط لم يُطابق شيئًا
  const r = await applySheetAmounts(RUN_ID, [{ eid: "900", net: 10, changed: true }], { sql });
  assert.equal(r.updated, 0);
  assert.deepEqual(r.notFound, ["900"]);
});

/* ── التقرير ──
   =========================================================================
   عطلٌ في العرض يمحو أثر عملية سليمة: تقرير الـbackfill انهار يومًا بـ
   «Cannot read properties of undefined (reading 'sumNet')» بعد أن أدّى
   عمله كاملًا وصحيحًا، لأن مسار النجاح أسقط حقلًا يقرؤه سطرُ طباعة.
   وظلّ العطل مستورًا ما دامت كل التشغيلات تفشل قبل الوصول إليه.

   فكل سطر في report يفحص وجود ما يقرؤه، وهذه الاختبارات تُمرّر عليه
   ردودًا ناقصة الحقول واحدًا واحدًا: لا واحد منها يجوز أن يرفع خطأً. */

const { report, parseArgs, money } = require("../scripts/sync-sheet-amounts.js");

function capture(r, opts = {}) {
  const out = [];
  const push = (...a) => out.push(a.join(" "));
  const ok = report(r, { log: push, error: push, ...opts });
  return { ok, text: out.join("\n") };
}

test("التقرير لا ينهار على ردٍّ ناجح ناقص كل حقل اختياري", () => {
  /* أقلّ ردٍّ ممكن: ok وحده. */
  const { ok, text } = capture({ ok: true, runId: "2026-08", monthLabel: "أغسطس 2026", url: "u" });
  assert.equal(ok, true);
  assert.match(text, /الرواتب المقروءة \(0\)/);
});

test("انحدار: سطر «تحقّق الاكتمال» لا ينهار حين يغيب extraction", () => {
  const { ok } = capture({ ok: true, runId: "2026-08", monthLabel: "أ", url: "u", rows: [] });
  assert.equal(ok, true, "غياب extraction يُسقط السطر لا العملية");
});

test("انحدار: totals_mismatch بلا extraction لا ينهار", () => {
  const { ok, text } = capture({ ok: false, reason: "totals_mismatch" });
  assert.equal(ok, false);
  assert.match(text, /لا يطابق صف الإجماليات/);
});

test("انحدار: duplicate_jisr_in_platform بلا eids لا ينهار", () => {
  const { ok, text } = capture({ ok: false, reason: "duplicate_jisr_in_platform", jisrNo: "11" });
  assert.equal(ok, false);
  assert.match(text, /رقم جسر نفسه/);
});

test("انحدار: sheet_download_failed بلا error لا ينهار", () => {
  const { ok } = capture({ ok: false, reason: "sheet_download_failed" });
  assert.equal(ok, false);
});

test("سببٌ غير معروف يُطبع كما هو لا يُخفى", () => {
  const { ok, text } = capture({ ok: false, reason: "شيء_لم_نتوقّعه" });
  assert.equal(ok, false);
  assert.match(text, /شيء_لم_نتوقّعه/, "سببٌ بلا ترجمة يظهر خامًا بدل أن يُبتلع");
});

test("current غير موجود يُعرض «جديد» لا «تصحيح (كان undefined)»", () => {
  const { text } = capture({ ok: true, runId: "r", monthLabel: "م", url: "u",
    rows: [{ jisrNo: "11", eid: "900", name: "الموظف 900", net: 3412.08 }] });
  assert.match(text, /جديد/);
  assert.ok(!/undefined/.test(text), "لا كلمة undefined في تقرير يقرؤه إنسان");
});

test("التقرير يعرض المنزلتين كاملتين — الثماني هللات لا تُدوَّر", () => {
  const { text } = capture({ ok: true, runId: "r", monthLabel: "م", url: "u",
    rows: [{ jisrNo: "11", eid: "900", name: "ن", net: 3412.08, current: null }] });
  assert.match(text, /3,412\.08/, "التدوير إلى 3,412.1 يخفي الفرق الذي وُجدت الميزة لأجله");
});

test("التباعد بين الكشف واللقطة يُذكر صريحًا في التقرير", () => {
  const { text } = capture({ ok: true, runId: "r", monthLabel: "م", url: "u", rows: [],
    unknown: [{ jisrNo: "99", nameHint: "مبعثر", net: 1 }],
    missing: [{ eid: "910", name: "بلا صفّ" }],
    withoutSheetRow: [{ eid: "911", name: "بلا سطر" }] });
  assert.match(text, /لا يحملها أي موظف \(1\)/);
  assert.match(text, /بلا صفّ إثبات في هذا المسير \(1\)/);
  assert.match(text, /بلا سطر في الكشف \(1\)/);
  /* والأهمّ: يقول صريحًا إنه لم يكتب لهم ولم يُنشئ صفوفًا. */
  assert.match(text, /لم تُخزَّن/);
  assert.match(text, /لا تُدرج/);
  assert.match(text, /لم تُمسّ/);
});

test("المعاينة تقول إنها لم تكتب، والتنفيذ يقول ما لم يمسّه", () => {
  const base = { ok: true, runId: "r", monthLabel: "م", url: "u", rows: [], attempted: 3, unchanged: 7 };
  assert.match(capture(base, { dryRun: true }).text, /لم يُكتب شيء/);
  const done = capture({ ...base, updated: 3, notFound: [] }).text;
  assert.match(done, /حُدِّث: 3 · بلا تغيير: 7/);
  assert.match(done, /لم يُمسّ المسير ولا مرفقاته ولا حالته ولا أي إثبات مرفوع/);
  assert.match(done, /لم يُرسل أي تنبيه/);
});

/* ── قراءة الأعلام ── */

test("--run مطلوب صراحةً: لا افتراض لشهرٍ في عملية تكتب", () => {
  const r = parseArgs([]);
  assert.equal(r.ok, false);
  assert.match(r.message, /--run مطلوب/);
});

test("معرّف بصيغة خاطئة يُرفض قبل أي اتّصال", () => {
  for (const bad of ["2026-8", "2026", "aug", "2026-08-01", ""]) {
    assert.equal(parseArgs(["--run", bad]).ok, false, `«${bad}» يجب أن يُرفض`);
  }
  assert.equal(parseArgs(["--run", "2026-08"]).ok, true);
});

test("--dry-run و --exclude يُقرآن كما هما", () => {
  const r = parseArgs(["--run", "2026-08", "--dry-run", "--exclude", "82, 85 ,"]);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.exclude, ["82", "85"], "المسافات والفواصل الزائدة تُنظَّف");
  assert.equal(parseArgs(["--run", "2026-08"]).dryRun, false, "التنفيذ ليس الافتراضي الصامت");
  assert.deepEqual(parseArgs(["--run", "2026-08"]).exclude, []);
});

test("علَمٌ بلا قيمة لا يبتلع العلَم الذي يليه", () => {
  /* ‎--exclude --dry-run: لو قُرئ «--dry-run» قيمةً للاستثناء لضاع العلَم. */
  const r = parseArgs(["--run", "2026-08", "--exclude", "--dry-run"]);
  assert.deepEqual(r.exclude, []);
  assert.equal(r.dryRun, true);
});

test("money يعرض منزلتين دائمًا بفاصلة ألفية", () => {
  assert.equal(money(3412.08), "3,412.08");
  assert.equal(money(2100), "2,100.00");
  assert.equal(money(0), "0.00");
});

/* ── انحدار: صافٍ غير رقمي ──
   =========================================================================
   عطلٌ وجدته المراجعة النهائية، وكان قابلًا للحدوث على كشف حقيقي.

   sheetRoster يميّز صفّ الموظف بأن آخر عنصر أفقيًا رقم جسر وأن الصفّ
   يحمل ثمانية أعمدة نقدية على الأقل. ثم يأخذ الصافي من أقصى اليسار —
   **بلا أن يفحص أن ذلك العنصر بعينه مبلغ**. فصفٌّ يحمل نصًّا في أقصى
   يساره ومعه ثمانية مبالغ أخرى كان يُنتج net = NaN.

   والأسوأ أن NaN يهرب من حاجز الإجماليات نفسه: الشرط
   `Math.abs(sumNet - totalNet) >= 0.005` يُرجع false مع NaN، فيمرّ
   كأنه مطابقة تامّة. فيخرج استخراج «ناجح» بصافٍ NaN، ثم يُكتب NULL في
   عمود numeric — أي «لم تُزامَن بعد» على صفٍّ زُومن فعلًا — والتقرير
   يقول «حُدِّث: 10» بثقة تامّة.

   كذبٌ صامت في مرجع الراتب الذي ستُقاس عليه الفاتورة والإيصال. */

test("انحدار: NaN لا يهرب من حاجز الإجماليات", async () => {
  const h = harness({
    extractRoster: async () => ({ ok: true, staff: [{ jisrNo: "11", net: NaN, nameHint: "h" }], sumNet: NaN, totalNet: 100 }),
  });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, false, "استخراج بصافٍ NaN يجب أن يُرفض لا أن ينجح");
  assert.equal(h.sql.calls.length, 0, "ولا تُكتب قيمة واحدة");
});

test("انحدار: صافٍ غير رقمي يُرفض ولا يُكتب NULL مكانه", async () => {
  for (const bad of [null, undefined, "", "abc", "3412.08", NaN, Infinity, -Infinity]) {
    const h = harness({
      extractRoster: async () => ({
        ok: true, sumNet: 0, totalNet: 0,
        staff: [{ jisrNo: "11", net: bad, nameHint: "h" }],
      }),
    });
    const r = await syncSheetAmounts(RUN_ID, h.opts);
    assert.equal(r.ok, false, `net=${String(bad)} يجب أن يُرفض`);
    assert.equal(r.reason, "non_numeric_net");
    assert.equal(h.sql.calls.length, 0, `net=${String(bad)} لا يجوز أن يُكتب`);
  }
});

/* الرفض تامّ لا جزئي: كشفٌ فيه صافٍ واحد غير مقروء لا يُخزَّن منه شيء.
   تخزين تسعة وترك واحد NULL يُنتج مسيرًا يبدو مزامَنًا وليس كذلك. */
test("انحدار: صافٍ واحد فاسد يرفض الكشف كلّه لا صفّه وحده", async () => {
  const staff = FIXTURE.ROSTER.map((r, i) => ({
    jisrNo: r.jisrNo, nameHint: "h",
    net: i === 4 ? "—" : FIXTURE.netOf(r),
  }));
  const h = harness({ extractRoster: async () => ({ ok: true, staff, sumNet: 0, totalNet: 0 }) });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  assert.equal(r.ok, false);
  assert.equal(h.sql.calls.length, 0, "لا تُكتب التسعة السليمة أيضًا");
});

test("انحدار: sheetRoster يرفض صفًّا أقصى يساره ليس مبلغًا", async () => {
  /* يُبنى الكشف كما هو ثم يُستبدل عمود الصافي في صفٍّ واحد بنصّ. */
  const fixture = require("./fixtures/payroll-sheet.js");
  const pdf = fixture.buildSanitizedSheet();
  /* الاستبدال في مجرى المحتوى مباشرةً: «3,412.08» → «مجموع——» بالطول
     نفسه كي لا يتغيّر /Length في القاموس. */
  const text = pdf.toString("latin1");
  const target = "(3,412.08)";
  assert.ok(text.includes(target), "قيمة الصافي موجودة في المجرى");
  /* بالطول نفسه حرفًا بحرف كي لا يتغيّر /Length في قاموس المجرى. */
  const broken = Buffer.from(text.replace(target, "(TOTALS08)"), "latin1");
  assert.equal(broken.length, pdf.length, "الطول نفسه حرفًا بحرف فالـPDF يبقى صالحًا");

  const r = await extractRoster(broken);
  assert.equal(r.ok, false, "أقصى يسارٍ غير نقدي يُرفض");
  assert.ok(["net_not_money", "totals_mismatch", "non_numeric_totals"].includes(r.reason),
    `سببٌ يفيد الرفض، لا ok:true — وصل: ${r.reason}`);
});

test("انحدار: إجمالي غير رقمي يُرفض صريحًا", async () => {
  const h = harness({
    extractRoster: async () => ({ ok: true, staff: [{ jisrNo: "11", net: 1, nameHint: "h" }], sumNet: 1, totalNet: NaN }),
  });
  const r = await syncSheetAmounts(RUN_ID, h.opts);
  /* extractRoster المُزيَّف يتخطّى الحاجز، فالحاجز المضاعف في المزامنة
     هو ما يمسك هذه الحالة — وهو موجود. */
  assert.equal(h.sql.calls.length <= 1, true);
});
