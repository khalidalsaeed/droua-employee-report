const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { makeFakeSql } = require("./helpers/fake-sql");
const { extractRoster } = require("../lib/payroll/sheetRoster");
const { RUN_ID, backfill, rosterFromEmployees } = require("../scripts/backfill-payroll-proofs-2026-08.js");

/* Backfill مسير أغسطس 2026.
   =========================================================================
   الخطر في عملية كهذه ليس أن تفشل، بل أن تنجح وتفعل أكثر ممّا طُلب:
   تلمس مسيرًا آخر، أو تكرّر صفًّا، أو تعدّل حالة المسير، أو تدوس إثباتًا
   مرفوعًا. فالاختبارات هنا تقيس ما كُتب فعلًا في القاعدة — كل عبارة
   وكل قيمة — لا ما تُرجعه الدالّة عن نفسها. */

const JULY_SHEET = fs.readFileSync(path.join(__dirname, "..", "payroll", "2026-07.pdf"));

const EMPLOYEES = [
  { "الرقم الوظيفي": "49", "اسم العامل": "شكيب مياه", "المهنة": "سائق" },
  { "الرقم الوظيفي": "55", "اسم العامل": "الأمين مولا" },
  { "الرقم الوظيفي": "56", "اسم العامل": "محمد توفيق", "المهنة": "فنّي" },
  { "الرقم الوظيفي": "59", "اسم العامل": "محمد فرهاد" },
  { "الرقم الوظيفي": "60", "اسم العامل": "راسل ديوان" },
  { "الرقم الوظيفي": "63", "اسم العامل": "محمد طيف الرحمن" },
  { "الرقم الوظيفي": "70", "اسم العامل": "محمد شهيد الإسلام" },
  { "الرقم الوظيفي": "71", "اسم العامل": "شميم حسين" },
  { "الرقم الوظيفي": "82", "اسم العامل": "محمد هلال الدين" },
  { "الرقم الوظيفي": "85", "اسم العامل": "ساجر أحمد" },
  /* التحق في سبتمبر — ليس من موظفي أغسطس، وليس في كشف أغسطس. */
  { "الرقم الوظيفي": "91", "اسم العامل": "موظف جديد", "تاريخ المباشرة": "2026-09-15" },
];

const RUN = {
  id: RUN_ID, monthLabel: "أغسطس 2026", statusKey: "pending_invoice",
  uploadedAt: "2026-09-02", fileUrl: "https://blob/2026-08.pdf",
  attachments: [{ key: "payroll_sheet", fileUrl: "https://blob/sheet-2026-08.pdf", statusKey: "attached" }],
  employees: [],
};

function harness(over = {}) {
  const sql = makeFakeSql((call) => (/INSERT INTO payroll_transfer_proofs/.test(call.text) ? [{ id: 1 }] : []));
  return {
    sql,
    opts: {
      sql,
      getRun: async (id) => (id === RUN_ID ? JSON.parse(JSON.stringify(RUN)) : null),
      listEmployees: async () => EMPLOYEES,
      fetchFile: async () => JULY_SHEET, // الكشف الحقيقي في المستودع، كعيّنة
      log: () => {},
      ...over,
    },
  };
}

/* ── المصدر: الكشف نفسه ── */

test("القائمة تأتي من كشف الرواتب لا من سجلّ الموظفين الحالي", async () => {
  const h = harness();
  const r = await backfill(h.opts);
  assert.equal(r.ok, true);
  assert.equal(r.source, "payroll_sheet");
  assert.deepEqual(r.roster.map((e) => e.eid), ["49", "55", "56", "59", "60", "63", "70", "71", "82", "85"]);
  /* الموظف 91 التحق في سبتمبر: في السجلّ الحالي لكن ليس في كشف أغسطس. */
  assert.ok(!r.roster.some((e) => e.eid === "91"), "موظف سبتمبر لا يدخل مسير أغسطس");
});

test("الأسماء من جدول الموظفين لا من الكشف المشوّه", async () => {
  const r = await backfill(harness().opts);
  const first = r.roster.find((e) => e.eid === "49");
  assert.equal(first.name, "شكيب مياه");
  assert.equal(first.jobTitle, "سائق");
  assert.equal(r.roster.find((e) => e.eid === "55").jobTitle, null, "مهنة غائبة تُخزَّن null لا نصًّا فارغًا");
});

test("اكتمال الاستخراج مُتحقَّق بمطابقة صف الإجماليات", async () => {
  const extraction = await extractRoster(JULY_SHEET);
  assert.equal(extraction.ok, true);
  assert.equal(extraction.staff.length, 10);
  assert.ok(Math.abs(extraction.sumNet - extraction.totalNet) < 0.005);
  assert.equal(extraction.totalNet.toFixed(2), "15297.53");
});

test("استخراج ناقص يوقف العملية بدل أن يُنتج مسيرًا ينقصه موظف", async () => {
  const h = harness({
    extractRoster: async () => ({ ok: false, reason: "totals_mismatch", sumNet: 13900.03, totalNet: 15297.53, staff: [] }),
  });
  const r = await backfill(h.opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "totals_mismatch");
  assert.equal(h.sql.calls.length, 0, "لا كتابة عند فشل التحقّق");
});

test("رقم في الكشف بلا سجلّ يوقف العملية إلّا بعلَم صريح", async () => {
  const partial = EMPLOYEES.filter((e) => e["الرقم الوظيفي"] !== "82");
  const blocked = await backfill(harness({ listEmployees: async () => partial }).opts);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "unknown_eids");
  assert.deepEqual(blocked.unknown.map((u) => u.eid), ["82"]);

  const h = harness({ listEmployees: async () => partial });
  const allowed = await backfill({ ...h.opts, skipUnknown: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.roster.length, 9);
  assert.ok(!allowed.roster.some((e) => e.eid === "82"));
});

test("بلا كشف مرفوع: يتوقّف ولا يستعمل السجلّ الحالي صامتًا", async () => {
  const h = harness({ getRun: async () => ({ ...RUN, fileUrl: null, attachments: [] }) });
  const r = await backfill(h.opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_sheet_attached");
  assert.equal(h.sql.calls.length, 0);
});

/* ── البديل الصريح ── */

test("--from-employees يُصفّي بتاريخ المباشرة ويُبقي من لا تاريخ له", async () => {
  const r = await rosterFromEmployees({ listEmployees: async () => EMPLOYEES });
  assert.equal(r.source, "employees_table");
  assert.ok(!r.roster.some((e) => e.eid === "91"), "من التحق بعد أغسطس يُستبعد");
  assert.equal(r.excluded, 1);
  assert.equal(r.roster.length, 10, "من لا تاريخ مباشرة له يبقى");
});

/* ── ما لا يُمسّ: جوهر الطلب ── */

test("كل كتابة INSERT فقط، وبـ ON CONFLICT DO NOTHING", async () => {
  const h = harness();
  await backfill(h.opts);
  assert.equal(h.sql.calls.length, 10);
  for (const c of h.sql.calls) {
    assert.match(c.text, /^INSERT INTO payroll_transfer_proofs/);
    assert.match(c.text, /ON CONFLICT \(run_id, employee_eid\) DO NOTHING/);
  }
});

test("لا UPDATE ولا DELETE ولا TRUNCATE على أي جدول", async () => {
  const h = harness();
  await backfill(h.opts);
  const joined = h.sql.calls.map((c) => c.text).join(" ");
  for (const verb of ["UPDATE", "DELETE", "TRUNCATE", "ALTER", "DROP"]) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(joined), `يجب ألّا تظهر ${verb}`);
  }
});

test("لا مساس بـ payroll_runs ولا payroll_attachments", async () => {
  const h = harness();
  await backfill(h.opts);
  const joined = h.sql.calls.map((c) => c.text).join(" ");
  assert.ok(!/payroll_runs/.test(joined), "لا حالة ولا source ولا notified_at");
  assert.ok(!/payroll_attachments/.test(joined), "لا مرفقات");
  assert.ok(!/notified_at|notify_error|status_key|source/.test(joined));
});

test("لا مسير غير 2026-08 يظهر في أي قيمة مكتوبة", async () => {
  const h = harness();
  await backfill(h.opts);
  for (const c of h.sql.calls) {
    assert.equal(c.values[0], RUN_ID, "run_id هو أول قيمة في كل إدراج");
    const others = c.values.filter((v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v) && v !== RUN_ID);
    assert.deepEqual(others, [], "لا معرّف شهر آخر في أي قيمة");
  }
});

test("إعادة التشغيل لا تُنتج تكرارًا: DO NOTHING تتكفّل", async () => {
  /* القاعدة ترفض الإدراج الثاني (لا صفّ مُرجَع) — كما يفعل القيد الفريد. */
  const sql = makeFakeSql(() => []);
  const h = harness();
  const r = await backfill({ ...h.opts, sql });
  assert.equal(r.ok, true);
  assert.equal(r.attempted, 10);
  assert.equal(r.inserted, 0, "لا صفّ جديد");
  assert.equal(r.skipped, 10, "الكلّ موجود مسبقًا");
});

test("صفّ عليه إثبات مرفوع لا يُدهس: لا UPDATE ولا حقول ملفّ في الإدراج", async () => {
  const h = harness();
  await backfill(h.opts);
  for (const c of h.sql.calls) {
    assert.ok(!/file_url|file_name|uploaded_at|uploaded_by/.test(c.text),
      "الإدراج يحمل الهوية فقط — لا حقل ملفّ يمكن أن يمحو إثباتًا");
  }
});

/* ── المعاينة ── */

test("--dry-run لا يُصدر عبارة واحدة", async () => {
  const h = harness();
  const r = await backfill({ ...h.opts, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.attempted, 10);
  assert.equal(r.inserted, 0);
  assert.equal(h.sql.calls.length, 0, "معاينة تعني صفر كتابة، لا كتابة ثم تراجع");
});

test("مسير غير موجود يُرفض قبل أي شيء", async () => {
  const h = harness({ getRun: async () => null });
  const r = await backfill(h.opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "run_not_found");
  assert.equal(h.sql.calls.length, 0);
});
