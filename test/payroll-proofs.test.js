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
