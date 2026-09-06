const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { makeFakeSql } = require("./helpers/fake-sql");
const { assertProofFile, PROOF_EXTENSIONS } = require("../lib/data/payrollRuns");

/* إثبات التحويل: مستقلّ لكل موظف، ومقصور على PDF/JPG/JPEG/PNG. */

test("الصيغ المسموحة تُقبل والباقي يُرفض", () => {
  const ok = [
    "https://blob.example.com/payroll/2026-08/proofs/1001/1725-transfer.pdf",
    "https://blob.example.com/a/b.PDF",
    "https://blob.example.com/a/b.jpg",
    "https://blob.example.com/a/b.jpeg",
    "https://blob.example.com/a/b.png",
  ];
  for (const u of ok) assert.doesNotThrow(() => assertProofFile(u), `يجب قبول ${u}`);

  const bad = [
    "https://blob.example.com/a/b.docx",
    "https://blob.example.com/a/b.exe",
    "https://blob.example.com/a/b.svg",
    "https://blob.example.com/a/b.pdf.exe",
    "https://blob.example.com/a/b",
  ];
  for (const u of bad) assert.throws(() => assertProofFile(u), /صيغة الملف غير مسموحة/, `يجب رفض ${u}`);
});

/* الحذف يمرّ بالقيمة الفارغة نفسها التي يمرّ بها المسار العادي. */
test("إزالة الإثبات (null) مسموحة", () => {
  for (const v of [null, undefined, ""]) assert.doesNotThrow(() => assertProofFile(v));
});

/* استعلام السلسلة يجب ألّا يخدع الفحص في الاتجاهين. */
test("الفحص على المسار لا على السلسلة كاملة", () => {
  assert.doesNotThrow(() => assertProofFile("https://x.com/a/b.pdf?download=1"));
  assert.throws(() => assertProofFile("https://x.com/a/b.exe?name=x.pdf"), /صيغة الملف غير مسموحة/);
});

test("قائمة الامتدادات هي بالضبط الأربعة المطلوبة", () => {
  assert.deepEqual([...PROOF_EXTENSIONS].sort(), [".jpeg", ".jpg", ".pdf", ".png"]);
});

/* ─── العزل: إثبات موظف لا يمسّ موظفًا آخر ───
   يُحمَّل payrollRuns بقاعدة مُزيَّفة عبر اعتراض require لـ../db، فيُقاس
   ما تكتبه update() فعلًا: عبارة UPDATE واحدة مقيّدة بـrun_id و
   employee_eid معًا، وقيمها تخصّ الموظف المذكور وحده. */
function loadWithFakeDb(sql) {
  const dbPath = require.resolve("../lib/db");
  const blobPath = require.resolve("../lib/blob");
  const runsPath = require.resolve("../lib/data/payrollRuns");
  const deleted = [];
  const originalLoad = Module._load;
  for (const p of [dbPath, blobPath, runsPath]) delete require.cache[p];
  Module._load = function (request, parent, isMain) {
    if (parent && /lib[\\/]data[\\/]payrollRuns\.js$/.test(parent.filename)) {
      if (request === "../db") return { getSql: () => sql };
      if (request === "../blob") return { deleteFile: async (u) => { if (u) deleted.push(u); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const mod = require("../lib/data/payrollRuns");
    return { mod, deleted, restore: () => { Module._load = originalLoad; delete require.cache[runsPath]; } };
  } catch (err) {
    Module._load = originalLoad;
    throw err;
  }
}

/* قاعدة فيها مسير واحد بموظفين، أحدهما له إثبات مسبق. */
function fakeRunDb() {
  return makeFakeSql((call) => {
    if (/FROM payroll_runs WHERE id =/.test(call.text)) {
      return [{ id: "2026-08", month_label: "أغسطس 2026", uploaded_at: "2026-09-01", status_key: "pending_invoice", file_url: null }];
    }
    if (/FROM payroll_attachments/.test(call.text)) return [];
    if (/FROM payroll_transfer_proofs/.test(call.text)) {
      return [
        { employee_eid: "1001", employee_name: "أحمد علي", job_title: "سائق", file_url: "https://blob/old-1001.pdf", file_name: "قديم.pdf", uploaded_at: "2026-09-02", uploaded_by: "hr-manager@droua.com" },
        { employee_eid: "1002", employee_name: "سعيد محمد", job_title: "فنّي", file_url: null, file_name: null, uploaded_at: null, uploaded_by: null },
      ];
    }
    return [];
  });
}

test("رفع إثبات لموظف يكتب صفّه وحده، مقيّدًا بالمسير ورقم ضمان", async () => {
  const sql = fakeRunDb();
  const { mod, restore } = loadWithFakeDb(sql);
  try {
    await mod.update("2026-08", { proofs: [{ eid: "1002", fileUrl: "https://blob/new-1002.png", fileName: "إثبات.png" }] },
      { email: "hr-manager@droua.com" });

    const writes = sql.matching(/UPDATE payroll_transfer_proofs/);
    assert.equal(writes.length, 1, "عبارة كتابة واحدة لا أكثر");
    assert.match(writes[0].text, /WHERE run_id = \? AND employee_eid = \?/);
    assert.ok(writes[0].values.includes("2026-08"));
    assert.ok(writes[0].values.includes("1002"));
    assert.ok(!writes[0].values.includes("1001"), "لا يظهر الموظف الآخر في أي قيمة");
    assert.ok(writes[0].values.includes("https://blob/new-1002.png"));
    assert.ok(writes[0].values.includes("hr-manager@droua.com"), "يُسجَّل من رفعه");
  } finally { restore(); }
});

test("الاستبدال يحذف الملف القديم لصاحبه وحده", async () => {
  const sql = fakeRunDb();
  const { mod, deleted, restore } = loadWithFakeDb(sql);
  try {
    await mod.update("2026-08", { proofs: [{ eid: "1001", fileUrl: "https://blob/new-1001.jpg", fileName: "جديد.jpg" }] }, { email: "x@y.z" });
    assert.deepEqual(deleted, ["https://blob/old-1001.pdf"]);
  } finally { restore(); }
});

test("الحذف يُفرغ الصفّ ويحذف الملف", async () => {
  const sql = fakeRunDb();
  const { mod, deleted, restore } = loadWithFakeDb(sql);
  try {
    await mod.update("2026-08", { proofs: [{ eid: "1001", fileUrl: null, fileName: null }] }, { email: "x@y.z" });
    const write = sql.matching(/UPDATE payroll_transfer_proofs/)[0];
    assert.ok(write.values.includes(null));
    assert.deepEqual(deleted, ["https://blob/old-1001.pdf"]);
  } finally { restore(); }
});

/* موظف ليس في لقطة المسير لا يُنشأ له صفّ: لا دسّ لموظف في مسير شهرٍ
   مضى، ولا كتابة إلى صفّ غير موجود. */
test("موظف خارج لقطة المسير يُرفض ولا يُكتب شيء", async () => {
  const sql = fakeRunDb();
  const { mod, restore } = loadWithFakeDb(sql);
  try {
    await assert.rejects(
      () => mod.update("2026-08", { proofs: [{ eid: "9999", fileUrl: "https://blob/x.pdf" }] }, { email: "x@y.z" }),
      /هذا الموظف ليس ضمن مسير الرواتب/
    );
    assert.equal(sql.matching(/UPDATE payroll_transfer_proofs/).length, 0);
  } finally { restore(); }
});

test("طلب بلا رقم وظيفي يُرفض", async () => {
  const sql = fakeRunDb();
  const { mod, restore } = loadWithFakeDb(sql);
  try {
    await assert.rejects(
      () => mod.update("2026-08", { proofs: [{ fileUrl: "https://blob/x.pdf" }] }, { email: "x@y.z" }),
      /الرقم الوظيفي مطلوب/
    );
  } finally { restore(); }
});

test("صيغة غير مسموحة تُرفض على الخادم ولا تُكتب", async () => {
  const sql = fakeRunDb();
  const { mod, restore } = loadWithFakeDb(sql);
  try {
    await assert.rejects(
      () => mod.update("2026-08", { proofs: [{ eid: "1002", fileUrl: "https://blob/x.docx" }] }, { email: "x@y.z" }),
      /صيغة الملف غير مسموحة/
    );
    assert.equal(sql.matching(/UPDATE payroll_transfer_proofs/).length, 0);
  } finally { restore(); }
});

/* المسيرات التي أُنشئت قبل الميزة لا صفوف لها، والواجهة تعتمد على أن
   الحقل مصفوفة فارغة لا undefined. */
test("مسير بلا لقطة موظفين يُرجع employees فارغة", async () => {
  const sql = makeFakeSql((call) => {
    if (/FROM payroll_runs WHERE id =/.test(call.text)) {
      return [{ id: "2026-07", month_label: "يوليو 2026", uploaded_at: "2026-08-02", status_key: "pending_invoice", file_url: "/payroll/2026-07.pdf" }];
    }
    return [];
  });
  const { mod, restore } = loadWithFakeDb(sql);
  try {
    const run = await mod.get("2026-07");
    assert.deepEqual(run.employees, []);
    assert.equal(run.fileUrl, "/payroll/2026-07.pdf", "الحقول القائمة كما هي");
  } finally { restore(); }
});

/* ── مسير يدوي قائم صار له صفوف إثبات ──
   =========================================================================
   الحالة الواقعية بعد backfill أغسطس: مسير أُنشئ يدويًا قبل الميزة
   (source = 'manual')، ثم بُذرت له صفوف في payroll_transfer_proofs بلا
   أن يتغيّر شيء آخر فيه.

   ما يُثبَت هنا أن ظهور بطاقات الإثبات معلَّق على وجود الصفوف وحدها —
   لا على source ولا على status_key ولا على من أنشأ المسير. لو ارتبط
   العرض يومًا بـsource لظلّ مسير أغسطس فارغًا رغم صفوفه العشرة، وهو
   عطلٌ لا يكشفه شيء غير اختبار كهذا. */

/* مسير manual تمامًا كأغسطس على Production: عشرة صفوف إثبات، حالة
   pending_invoice، مرفقات كما هي. */
function manualRunWithProofs() {
  const staff = [
    ["506", "شكيب ميا", "سائق", "49"],
    ["504", "لامين مولا", null, "55"],
    ["500", "شميم", "عامل تحميل وتنزيل", "71"],
  ];
  return makeFakeSql((call) => {
    if (/FROM payroll_runs WHERE id =/.test(call.text)) {
      return [{ id: "2026-08", month_label: "أغسطس 2026", uploaded_at: "2026-09-02",
                status_key: "pending_invoice", file_url: "https://blob/2026-08.pdf" }];
    }
    if (/FROM payroll_attachments/.test(call.text)) {
      return [{ key: "payroll_sheet", label: "مسير الرواتب", status_key: "attached",
                file_url: "https://blob/sheet.pdf", uploaded_at: "2026-09-02", note: null }];
    }
    if (/FROM payroll_transfer_proofs/.test(call.text)) {
      return staff.map(([eid, name, job, jisr]) => ({
        employee_eid: eid, employee_name: name, job_title: job,
        file_url: null, file_name: null, uploaded_at: null, uploaded_by: null, jisr_no: jisr,
      }));
    }
    return [];
  });
}

test("مسير manual بصفوف إثبات يُرجع employees مملوءة", async () => {
  const { mod, restore } = loadWithFakeDb(manualRunWithProofs());
  try {
    const run = await mod.get("2026-08");
    assert.equal(run.employees.length, 3, "الصفوف هي ما يملأ القائمة");
    assert.equal(run.monthLabel, "أغسطس 2026");
    /* الواجهة ترسم القسم على employees.length — فامتلاؤه هو الشرط. */
    assert.ok(run.employees.length > 0);
  } finally { restore(); }
});

test("العرض لا يعتمد على source: توليد الصفّ لا يقرؤه أصلًا", async () => {
  const sql = manualRunWithProofs();
  const { mod, restore } = loadWithFakeDb(sql);
  try {
    const run = await mod.get("2026-08");
    /* toRun لا يُخرج source، فلا سبيل للواجهة أن تشترطه. */
    assert.equal("source" in run, false, "source ليس جزءًا من شكل المسير المُرجَع");
    /* ولا يُقرأ من القاعدة في مسار العرض. */
    const selects = sql.calls.filter((c) => /^SELECT/.test(c.text)).map((c) => c.text).join(" ");
    assert.ok(!/source/.test(selects), "لا عمود source في أي استعلام عرض");
  } finally { restore(); }
});

test("كل موظف يحمل ما تعرضه البطاقة: اسم ومهنة ورقم ضمان ورقم جسر", async () => {
  const { mod, restore } = loadWithFakeDb(manualRunWithProofs());
  try {
    const run = await mod.get("2026-08");
    const first = run.employees[0];
    assert.equal(first.eid, "506", "رقم ضمان");
    assert.equal(first.jisrNo, "49", "رقم جسر بجانبه");
    assert.equal(first.name, "شكيب ميا");
    assert.equal(first.jobTitle, "سائق");
    assert.equal(first.proof, null, "بلا إثبات بعد — تظهر دعوة الإرفاق");
    /* مهنة غائبة تبقى null لا نصًّا فارغًا. */
    assert.equal(run.employees[1].jobTitle, null);
  } finally { restore(); }
});

test("قراءة المسير لا تكتب شيئًا ولا تمسّ حالته", async () => {
  const sql = manualRunWithProofs();
  const { mod, restore } = loadWithFakeDb(sql);
  try {
    const run = await mod.get("2026-08");
    assert.equal(run.statusKey, "pending_invoice", "الحالة كما هي");
    assert.equal(run.attachments.length, 1, "المرفقات كما هي");
    const writes = sql.calls.filter((c) => /^(INSERT|UPDATE|DELETE)/.test(c.text));
    assert.deepEqual(writes, [], "العرض قراءة محضة");
  } finally { restore(); }
});
