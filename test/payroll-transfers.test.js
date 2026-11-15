const test = require("node:test");
const assert = require("node:assert/strict");

const F = require("./helpers/transfer-fixtures");
const { transfersDb } = require("./helpers/transfers-db");
const N = require("../lib/payroll/transfers/normalize");
const { parseTransferFile } = require("../lib/payroll/transfers/parse");
const { reconcile, TOLERANCE_HALALAS } = require("../lib/payroll/transfers/match");
const { classifyHeader, periodFits, detectPeriod } = require("../lib/payroll/transfers/extract");
const service = require("../lib/payroll/transfers/service");

/* ⛔ كل البيانات هنا مصنوعة: أسماء مخترعة وآيبانات مولَّدة. */

const RUN_ID = "2026-10";
const amountText = (h) => (h / 100).toFixed(2);
const fullRows = (over = {}) => [F.HEADER, ...F.EMPLOYEES.map((e, i) => F.row(
  (over.names || {})[e.eid] || e.name,
  (over.ibans || {})[e.eid] || e.iban,
  amountText((over.amounts || {})[e.eid] ?? e.expected),
  `TRX${1000 + i}`))];

/* موظفو المحرّك كما يبنيهم buildRoster. */
const engineEmployees = (over = {}) => F.EMPLOYEES.map((e) => ({ ...e, account: null, cash: !!(over.cash || []).includes(e.eid) }));

async function transfersOf(rows, ext = "csv") {
  const bytes = ext === "xlsx" ? F.xlsx(rows) : F.csv(rows);
  return (await parseTransferFile(bytes, `t.${ext}`)).transfers;
}
const byEid = (out) => Object.fromEntries(out.results.map((r) => [r.eid, r]));

/* ─────────────── التطبيع ─────────────── */

test("المبالغ بالهللة: أرقام عربية وفواصل وعملة، والصفر ليس null", () => {
  assert.equal(N.toHalalas("4,500.00"), 450000);
  assert.equal(N.toHalalas("٤٬٥٠٠٫٥٠"), 450050);
  assert.equal(N.toHalalas("SAR 3,800.50"), 380050);
  assert.equal(N.toHalalas("3800.5 ر.س"), 380050);
  assert.equal(N.toHalalas("0.00"), 0);
  assert.equal(N.toHalalas("abc"), null);
  assert.equal(N.toHalalas("12.345"), null, "ثلاث منازل عشرية ليست مبلغًا");
});

test("الآيبان: فحص رقابي mod-97، وتقنيع لا يكشف إلا آخر 4", () => {
  const iban = F.fakeIban(1001);
  assert.ok(N.isValidIban(iban));
  assert.ok(N.isValidIban(iban.replace(/(.{4})/g, "$1 ")), "المسافات لا تهمّ");
  assert.ok(!N.isValidIban(iban.slice(0, -1) + ((Number(iban.slice(-1)) + 1) % 10)), "خانة خاطئة تُرفض");
  assert.equal(N.maskIban(iban), `SA••••••${iban.slice(-4)}`);
  assert.ok(!N.maskIban(iban).includes(iban.slice(4, 20)));
});

test("الأسماء: تطبيع عربي/لاتيني وتشابه كلمات", () => {
  assert.equal(N.nameSimilarity("سالم عبدالله القحطاني", "سالم عبد الله قحطاني") >= 0.66, true);
  assert.equal(N.nameSimilarity("Ahmed Raza Khan", "AHMAD RAZA KHAN"), 1);
  assert.ok(N.nameSimilarity("فهد ناصر الدوسري", "Rahul Kumar") === 0);
});

test("الترويسة: أسماء أعمدة عربية وإنجليزية", () => {
  assert.equal(classifyHeader("اسم المستفيد"), "name");
  assert.equal(classifyHeader("رقم الآيبان"), "iban");
  assert.equal(classifyHeader("Beneficiary IBAN"), "iban");
  assert.equal(classifyHeader("مبلغ التحويل (ريال)"), "amount");
  assert.equal(classifyHeader("Transaction Reference"), "reference");
  assert.equal(classifyHeader("Value Date"), "date");
  assert.equal(classifyHeader("رقم الحساب"), "account");
});

/* ─────────────── القرّاء ─────────────── */

test("CSV وXLSX وPDF (طبقة نصّ) تُنتج التحويلات نفسها", async () => {
  const rows = fullRows();
  const csv = await parseTransferFile(F.csv(rows), "t.csv");
  const xlsx = await parseTransferFile(F.xlsx(rows), "t.xlsx");
  const pdfRows = [F.PDF_HEADER, ...F.EMPLOYEES.map((e, i) => F.row(`Person ${i}`, e.iban, amountText(e.expected), `TRX${1000 + i}`, "02/11/2026", "Test Bank"))];
  const pdf = await parseTransferFile(await F.pdf(pdfRows), "t.pdf");
  for (const out of [csv, xlsx, pdf]) {
    assert.equal(out.transfers.length, 5);
    assert.deepEqual(out.transfers.map((t) => t.iban), F.EMPLOYEES.map((e) => e.iban));
    assert.deepEqual(out.transfers.map((t) => t.amount), F.EMPLOYEES.map((e) => e.expected));
    assert.equal(out.period, "2026-11");
  }
  assert.equal(csv.format, "csv"); assert.equal(xlsx.format, "xlsx"); assert.equal(pdf.format, "pdf");
  assert.equal(pdf.transfers[2].reference, "TRX1002");
});

test("PDF بلا ترويسة معروفة: قراءة الأسطر بالأنماط، ومبلغان في سطر = غامض", async () => {
  const rows = [["Statement"], ...F.EMPLOYEES.slice(0, 2).map((e, i) => [`Person ${i}`, e.iban, amountText(e.expected), `TRX${i}22`, "2026-11-02"]),
    ["Person X", F.EMPLOYEES[2].iban, "100.00", "200.00", "2026-11-02"]];
  const out = await parseTransferFile(await F.pdf(rows), "t.pdf");
  assert.equal(out.mode, "pdf-lines");
  assert.equal(out.transfers.length, 3);
  assert.equal(out.transfers[0].amount, F.EMPLOYEES[0].expected);
  assert.deepEqual(out.transfers[2].flags, ["ambiguous_amount"]);
});

test("PDF ممسوح بلا طبقة نصّ يُرفض بـscanned_pdf — لا OCR", async () => {
  await assert.rejects(parseTransferFile(await F.pdf([], { scanned: true }), "scan.pdf"), (e) => e.code === "scanned_pdf");
});

test("صيغ مرفوضة: xls القديم، وملفّ بلا تحويلات، وفارغ", async () => {
  const { buildXls } = require("./helpers/workbook-builder");
  await assert.rejects(parseTransferFile(buildXls([["a"]]), "old.xls"), (e) => e.code === "unsupported_format");
  await assert.rejects(parseTransferFile(F.csv([["لا شيء", "هنا"], ["x", "y"]]), "a.csv"), (e) => e.code === "no_transfers");
  await assert.rejects(parseTransferFile(Buffer.alloc(0), "a.csv"), (e) => e.code === "empty_file");
});

test("صفّ الإجمالي في الملفّ لا يُعدّ تحويلًا", async () => {
  const rows = [...fullRows(), ["الإجمالي", "", "22600.50", "", "", ""]];
  assert.equal((await transfersOf(rows)).length, 5);
});

/* ─────────────── المحرّك: اختبارات القبول ─────────────── */

test("قبول: ملفّ فيه كل الموظفين بمبالغهم → الكل «تم التحويل»", async () => {
  const out = reconcile({ employees: engineEmployees(), transfers: await transfersOf(fullRows(), "xlsx") });
  assert.deepEqual(out.summary, { matched: 5, amount_mismatch: 0, not_found: 0, needs_review: 0, cash: 0, employees: 5, transfers: 5, unassigned: 0 });
  const r = byEid(out)["901"];
  assert.equal(r.transfer.reference, "TRX1000");
  assert.equal(r.transfer.date, "2026-11-02");
  assert.equal(r.transfer.basis, "iban");
  assert.match(r.transfer.accountMasked, /^SA••••••\d{4}$/);
});

test("قبول: موظف بلا تحويل → «لم يتم العثور على تحويل»", async () => {
  const rows = fullRows().filter((r) => r[0] !== F.EMPLOYEES[2].name);
  const out = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf(rows) }));
  assert.equal(out["903"].status, "not_found");
  assert.equal(out["901"].status, "matched");
});

test("قبول: مبلغ ناقص ومبلغ زائد → «غير مطابق» بالفرق الصحيح", async () => {
  const out = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf(fullRows({ amounts: { 901: 425000, 902: 390050 } })) }));
  assert.equal(out["901"].status, "amount_mismatch");
  assert.equal(out["901"].diff, -25000);
  assert.equal(out["902"].status, "amount_mismatch");
  assert.equal(out["902"].diff, 10000);
});

test("التسامح صفر: فرق هللة واحدة = غير مطابق", async () => {
  assert.equal(TOLERANCE_HALALAS, 0);
  const out = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf(fullRows({ amounts: { 903: 520001 } })) }));
  assert.equal(out["903"].status, "amount_mismatch");
  assert.equal(out["903"].diff, 1);
});

test("قبول: تحويل مكرّر (نفس المرجع مرّتين) → بحاجة مراجعة، لا اختيار صامت", async () => {
  const rows = fullRows();
  rows.push([...rows[1]]);
  const out = reconcile({ employees: engineEmployees(), transfers: await transfersOf(rows) });
  const r = byEid(out)["901"];
  assert.equal(r.status, "needs_review");
  assert.equal(r.reason, "multiple_transfers");
  assert.equal(r.candidates, 2);
  assert.equal(r.transfer, null, "لا يُختار أحد التحويلين");
});

test("قبول: أكثر من تحويل لنفس الموظف (نفس الآيبان بمبالغ متعددة) → بحاجة مراجعة", async () => {
  const rows = fullRows();
  rows.push(F.row(F.EMPLOYEES[1].name, F.EMPLOYEES[1].iban, "500.00", "TRX9999"));
  const r = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf(rows) }))["902"];
  assert.equal(r.status, "needs_review");
  assert.equal(r.reason, "multiple_transfers");
  assert.deepEqual(r.candidateAmounts.sort((a, b) => a - b), [50000, 380050]);
});

test("نفس المرجع على موظفين مختلفين → كلاهما بحاجة مراجعة", async () => {
  const rows = fullRows();
  rows[2][3] = rows[1][3];
  const out = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf(rows) }));
  assert.equal(out["901"].reason, "duplicate_reference");
  assert.equal(out["902"].reason, "duplicate_reference");
});

test("قبول: الآيبان مطابق والاسم مختلف قليلًا → تم التحويل (الآيبان أقوى)", async () => {
  const out = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf(fullRows({ names: { 901: "سالم عبد الله قحطاني", 902: "AHMAD R KHAN" } })) }));
  assert.equal(out["901"].status, "matched");
  assert.equal(out["901"].transfer.nameMismatch, false);
  assert.equal(out["902"].status, "matched");
});

test("الآيبان مطابق والاسم مختلف كليًا → تم التحويل مع تنبيه اسم", async () => {
  const r = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf(fullRows({ names: { 904: "مستفيد آخر تمامًا" } })) }))["904"];
  assert.equal(r.status, "matched");
  assert.equal(r.transfer.nameMismatch, true);
});

test("قبول: الاسم مطابق والآيبان مختلف → بحاجة مراجعة، ولا إسناد بالاسم", async () => {
  const other = F.fakeIban(7777);
  const out = reconcile({ employees: engineEmployees(), transfers: await transfersOf(fullRows({ ibans: { 905: other } })) });
  const r = byEid(out)["905"];
  assert.equal(r.status, "needs_review");
  assert.equal(r.reason, "name_only");
  assert.equal(r.transfer, null);
  assert.equal(out.summary.unassigned, 1);
  assert.equal(out.unassigned[0].reason, "name_only");
  assert.deepEqual(out.unassigned[0].suggested, ["905"]);
});

test("تحويل لا يطابق أحدًا ولا يشبه اسمًا → غير مُسند، والموظف «غير موجود»", async () => {
  const rows = fullRows({ ibans: { 905: F.fakeIban(8888) }, names: { 905: "Unknown Person" } });
  const out = reconcile({ employees: engineEmployees(), transfers: await transfersOf(rows) });
  assert.equal(byEid(out)["905"].status, "not_found");
  assert.equal(out.unassigned[0].reason, "no_identifier_match");
});

test("المبلغ لا يحدّد الهوية: تحويل بمبلغ موظف لكن بآيبان مجهول لا يُسند له", async () => {
  const rows = [F.HEADER, F.row("X", F.fakeIban(4242), amountText(F.EMPLOYEES[0].expected), "R1")];
  const out = reconcile({ employees: engineEmployees(), transfers: await transfersOf(rows) });
  assert.equal(byEid(out)["901"].status, "not_found");
});

test("قبول: موظف نقدي لا يُعدّ تحويلًا بنكيًا — ومع وجود تحويل له يُراجَع", async () => {
  const rows = fullRows().filter((r) => r[0] !== F.EMPLOYEES[3].name);
  let out = byEid(reconcile({ employees: engineEmployees({ cash: ["904"] }), transfers: await transfersOf(rows) }));
  assert.equal(out["904"].status, "cash");
  out = byEid(reconcile({ employees: engineEmployees({ cash: ["904"] }), transfers: await transfersOf(fullRows()) }));
  assert.equal(out["904"].status, "needs_review");
  assert.equal(out["904"].reason, "cash_with_transfer");
});

test("رقم الموظف في الملفّ يُسند عند غياب الآيبان، والتعارض معه يُراجَع", async () => {
  const header = ["رقم الموظف", "اسم المستفيد", "المبلغ", "المرجع"];
  const t1 = await transfersOf([header, ["901", "سالم", amountText(450000), "R1"], ["12", "Ahmed", amountText(380050), "R2"]]);
  let out = byEid(reconcile({ employees: engineEmployees(), transfers: t1 }));
  assert.equal(out["901"].status, "matched");
  assert.equal(out["901"].transfer.basis, "emp_no");
  assert.equal(out["902"].status, "matched", "رقم جسر يُقبل كرقم موظف");

  const h2 = ["رقم الموظف", "الآيبان", "المبلغ", "المرجع"];
  const t2 = await transfersOf([h2, ["903", F.EMPLOYEES[0].iban, amountText(450000), "R1"]]);
  out = reconcile({ employees: engineEmployees(), transfers: t2 });
  assert.equal(byEid(out)["901"].reason, "key_conflict");
  assert.equal(byEid(out)["903"].reason, "key_conflict");
  assert.equal(out.unassigned[0].reason, "key_conflict");
});

test("آيبان مسجّل لموظفين اثنين → لا إسناد", async () => {
  const emps = engineEmployees();
  emps[1].iban = emps[0].iban;
  const out = reconcile({ employees: emps, transfers: await transfersOf(fullRows()) });
  assert.equal(byEid(out)["901"].reason, "shared_iban");
  assert.equal(byEid(out)["902"].status, "needs_review");
});

test("رقم الحساب بدل الآيبان يُطابق نهاية آيبان الموظف", async () => {
  const header = ["اسم المستفيد", "رقم الحساب", "المبلغ", "المرجع"];
  const acc = F.EMPLOYEES[0].iban.slice(-14);
  const out = byEid(reconcile({ employees: engineEmployees(), transfers: await transfersOf([header, ["سالم", acc, "4500.00", "R1"]]) }));
  assert.equal(out["901"].status, "matched");
  assert.equal(out["901"].transfer.basis, "account");
});

test("مستحق غير معروف (لا كشف جسر) → بحاجة مراجعة لا «تم»", async () => {
  const emps = engineEmployees().map((e) => ({ ...e, expected: null }));
  const r = byEid(reconcile({ employees: emps, transfers: await transfersOf(fullRows()) }))["901"];
  assert.equal(r.status, "needs_review");
  assert.equal(r.reason, "no_expected_amount");
});

test("نافذة الشهر: شهر المسير والذي يليه فقط", () => {
  assert.ok(periodFits("2026-10", "2026-10"));
  assert.ok(periodFits("2026-10", "2026-11"));
  assert.ok(!periodFits("2026-10", "2026-12"));
  assert.ok(!periodFits("2026-10", "2026-08"));
  assert.ok(periodFits("2026-12", "2027-01"));
  assert.ok(periodFits("2026-10", null));
  assert.equal(detectPeriod([{ date: "2026-11-01" }, { date: "2026-11-02" }, { date: "2026-10-30" }]), "2026-11");
});

/* ─────────────── الخدمة: حفظ، استبدال، سجلّ، أمان ─────────────── */

function serviceDeps(sql, { sheet = true, methods = {}, logs = [] } = {}) {
  const run = {
    id: RUN_ID, monthLabel: "أكتوبر 2026", fileUrl: sheet ? "https://blob.example/sheet.pdf" : null,
    attachments: sheet ? [{ key: "payroll_sheet", fileUrl: "https://blob.example/sheet.pdf" }] : [],
    employees: F.EMPLOYEES.map((e) => ({ eid: e.eid, jisrNo: e.jisrNo, name: e.name, jobTitle: null, proof: null })),
  };
  return {
    sql,
    getRun: async (id) => (id === RUN_ID ? run : null),
    listEmployees: async () => F.EMPLOYEES.map((e) => ({
      "الرقم الوظيفي": e.eid, "اسم العامل": e.name, IBAN: e.iban.replace(/(.{4})/g, "$1 "),
      ...(methods[e.eid] ? { "طريقة صرف الراتب": methods[e.eid] } : {}),
    })),
    fetchFile: async () => Buffer.from("sheet"),
    extractRoster: async () => ({ ok: true, staff: F.EMPLOYEES.map((e) => ({ jisrNo: e.jisrNo, net: e.expected / 100 })) }),
    log: (e) => logs.push(e),
  };
}

test("الخدمة: الرفع الأول يحفظ ملفًّا واحدًا ونتيجة لكل موظف، والمستحق من كشف جسر", async () => {
  const { db, sql } = transfersDb();
  const logs = [];
  const bytes = F.csv(fullRows({ amounts: { 902: 370050 } }));
  const state = await service.reconcileUpload({ runId: RUN_ID, bytes, fileName: "november.csv", actor: { email: "a@example.com", id: "u1" } }, serviceDeps(sql, { logs }));
  assert.equal(db.files.length, 1);
  assert.equal(db.matches.length, 5);
  assert.equal(state.setup, true);
  assert.equal(state.current.counts.matched, 4);
  assert.equal(state.current.counts.amount_mismatch, 1);
  assert.equal(state.current.expectedSource, "jisr_sheet");
  assert.deepEqual(
    { s: state.matches["902"].status, e: state.matches["902"].expected, t: state.matches["902"].transferred, d: state.matches["902"].diff },
    { s: "amount_mismatch", e: 3800.5, t: 3700.5, d: -100 });
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].uploadedBy, "a@example.com");
  assert.equal(logs[0].type, "payroll_transfer_file_uploaded");
});

test("الأمان: لا آيبان كامل في القاعدة ولا في السجلّ ولا في الاستجابة", async () => {
  const { db, sql } = transfersDb();
  const logs = [];
  const state = await service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(fullRows()), fileName: "t.csv", actor: { email: "a@example.com" } }, serviceDeps(sql, { logs }));
  const everything = JSON.stringify({ files: db.files, matches: db.matches, logs, state });
  for (const e of F.EMPLOYEES) {
    assert.ok(!everything.includes(e.iban), "آيبان كامل مسرَّب");
    assert.ok(!everything.includes(e.iban.slice(4, 18)), "جزء طويل من الآيبان مسرَّب");
  }
  assert.ok(db.files[0].transfers.every((t) => !("iban" in t) && /^[0-9a-f]{64}$/.test(t.ibanHash)));
  assert.match(db.files[0].file_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(logs).includes("TRX1000"), "محتوى الملفّ لا يدخل سجلّ التدقيق");
});

test("قبول: استبدال ملفّ الشهر — بلا تأكيد يُرفض بـexists، ومع التأكيد يُستبدل ويبقى السجلّ", async () => {
  const { db, sql } = transfersDb();
  const logs = [];
  const d = serviceDeps(sql, { logs });
  await service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(fullRows({ amounts: { 901: 1 } })), fileName: "v1.csv", actor: { email: "a@example.com" } }, d);
  await assert.rejects(
    service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(fullRows()), fileName: "v2.csv", actor: { email: "a@example.com" } }, d),
    (e) => e.code === "exists" && e.status === 409 && /يوجد ملف تحويل مرفوع مسبقًا، هل تريد استبداله؟/.test(e.message));
  assert.equal(db.files.length, 1, "لا شيء يُكتب قبل التأكيد");

  const state = await service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(fullRows()), fileName: "v2.csv", replace: true, actor: { email: "b@example.com" } }, d);
  assert.equal(db.files.length, 2);
  assert.equal(db.files.filter((f) => !f.superseded_at).length, 1);
  assert.match(state.current.fileName, /^transfer-2026-10-[0-9a-f]{8}\.csv$/);
  assert.equal(state.current.state, "current");
  assert.equal(state.current.counts.matched, 5);
  assert.equal(state.history.length, 2);
  assert.equal(state.history[1].state, "replaced");
  assert.equal(state.history[1].replacedBy, "b@example.com");
  assert.equal(state.history[1].counts.amount_mismatch, 1, "نتيجة الملفّ المستبدَل محفوظة لا تُحذف");
  assert.equal(db.matches.length, 10, "نتائج الملفّين معًا — لا حذف صامت");
  assert.equal(logs[1].type, "payroll_transfer_file_replaced");
});

test("SHA-256: رفع الملفّ الحالي نفسه مرّة أخرى يُرفض بـduplicate_file حتى مع التأكيد", async () => {
  const { db, sql } = transfersDb();
  const d = serviceDeps(sql);
  const bytes = F.csv(fullRows());
  await service.reconcileUpload({ runId: RUN_ID, bytes, fileName: "a.csv", actor: {} }, d);
  await assert.rejects(
    service.reconcileUpload({ runId: RUN_ID, bytes, fileName: "renamed.csv", replace: true, actor: {} }, d),
    (e) => e.code === "duplicate_file" && e.status === 409);
  assert.equal(db.files.length, 1);
});

test("اسم الملفّ الأصلي لا يُخزَّن — تسمية داخلية فقط", async () => {
  const { db, sql } = transfersDb();
  const logs = [];
  const raw = "تحويل رواتب سالم القحطاني SA6080000000000000001001.csv";
  await service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(fullRows()), fileName: raw, actor: {} }, serviceDeps(sql, { logs }));
  assert.match(db.files[0].file_label, /^transfer-2026-10-[0-9a-f]{8}\.csv$/);
  const all = JSON.stringify({ files: db.files, logs });
  assert.ok(!all.includes("القحطاني SA"), "الاسم الأصلي لا يدخل القاعدة ولا السجلّ");
  assert.ok(!all.includes("تحويل رواتب"));
});

test("قبول: ملفّ شهر مختلف يُرفض بلا كتابة", async () => {
  const { db, sql } = transfersDb();
  const rows = fullRows().map((r, i) => (i ? [...r.slice(0, 4), "2026-08-02", r[5]] : r));
  await assert.rejects(
    service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(rows), fileName: "aug.csv", actor: {} }, serviceDeps(sql)),
    (e) => e.code === "wrong_period" && /2026-08/.test(e.message));
  assert.equal(db.files.length, 0);
});

test("الخدمة: طريقة صرف «نقدي» في سجلّ الموظف تُخرجه من المطابقة", async () => {
  const { sql } = transfersDb();
  const rows = fullRows().filter((r) => r[0] !== F.EMPLOYEES[3].name);
  const state = await service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(rows), fileName: "t.csv", actor: {} }, serviceDeps(sql, { methods: { 904: "نقدي" } }));
  assert.equal(state.matches["904"].status, "cash");
  assert.equal(state.current.counts.cash, 1);
  assert.equal(state.current.counts.not_found, 0);
});

test("الخدمة: بلا كشف جسر يبقى المستحق مجهولًا والكل للمراجعة", async () => {
  const { sql } = transfersDb();
  const state = await service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(fullRows()), fileName: "t.csv", actor: {} }, serviceDeps(sql, { sheet: false }));
  assert.equal(state.current.expectedSource, "none");
  assert.equal(state.current.counts.needs_review, 5);
  assert.equal(state.matches["901"].reason, "no_expected_amount");
});

test("الخدمة: قبل تطبيق الهجرة — القراءة تُرجع setup:false والرفع يُرفض بـnot_setup", async () => {
  const { sql } = transfersDb({ missing: true });
  assert.deepEqual(await service.getState(RUN_ID, serviceDeps(sql)), { setup: false, current: null, matches: {}, history: [] });
  await assert.rejects(
    service.reconcileUpload({ runId: RUN_ID, bytes: F.csv(fullRows()), fileName: "t.csv", actor: {} }, serviceDeps(sql)),
    (e) => e.code === "not_setup" && e.status === 503);
});

test("الخدمة: ملفّ PDF ممسوح يُرفض برمز scanned_pdf", async () => {
  const { sql } = transfersDb();
  await assert.rejects(
    service.reconcileUpload({ runId: RUN_ID, bytes: await F.pdf([], { scanned: true }), fileName: "s.pdf", actor: {} }, serviceDeps(sql)),
    (e) => e.code === "scanned_pdf" && e.status === 422);
});

/* ─────────────── الهجرة ─────────────── */

test("الهجرة: جدولان جديدان فقط، إضافية بالكامل، ولا تمسّ جداول قائمة", () => {
  const { STATEMENTS, ROLLBACK } = require("../scripts/setup-payroll-transfers");
  const all = STATEMENTS.map((s) => s.sql).join("\n");
  const created = (all.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map((m) => m.split(" ").pop()).sort();
  assert.deepEqual(created, ["payroll_transfer_files", "payroll_transfer_matches"]);
  assert.ok(!/\b(ALTER|DROP|UPDATE|TRUNCATE)\b/i.test(all));
  assert.ok(!/\bDELETE\b/i.test(all.replace(/ON DELETE CASCADE/g, "")));
  for (const s of STATEMENTS) assert.match(s.sql, /IF NOT EXISTS/);
  assert.match(all, /UNIQUE INDEX IF NOT EXISTS uq_payroll_transfer_files_current\s+ON payroll_transfer_files \(run_id\) WHERE superseded_at IS NULL/);
  assert.match(all, /CHECK \(status IN \('matched', 'amount_mismatch', 'not_found', 'needs_review', 'cash'\)\)/);
  assert.ok(!/\biban\b\s+text/i.test(all), "لا عمود آيبان كامل");
  assert.ok(!/bytea|file_url|file_name/i.test(all), "الملفّ نفسه ولا اسمه الأصلي يُخزَّن");
  assert.match(all, /file_label\s+text NOT NULL CHECK \(file_label ~/);
  assert.match(all, /state\s+text GENERATED ALWAYS AS \(CASE WHEN superseded_at IS NULL THEN 'current' ELSE 'replaced' END\) STORED/);
  assert.match(all, /idx_payroll_transfer_files_sha ON payroll_transfer_files \(run_id, file_sha256\)/);
  assert.deepEqual(ROLLBACK, ["DROP TABLE IF EXISTS payroll_transfer_matches", "DROP TABLE IF EXISTS payroll_transfer_files"]);
});
