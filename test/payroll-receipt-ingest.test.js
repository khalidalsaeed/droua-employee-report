const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { ingestDocument, sourceKey } = require("../lib/payroll/receiptIngest");
const M = require("../lib/payroll/receiptMatch");
const F = require("./fixtures/receipts.js");

/* مسار ingest إيصالات الرواتب — المرحلة 2.4 من تاسك أجير.
   =========================================================================
   ثلاث طبقات نقيّة: التحويل إلى صفوف، وكشف التكرار، والربط والمطابقة.
   لا قاعدة ولا Blob ولا شبكة — وهذا ما يجعل حالات الحدّ قابلة للكتابة
   في سطرين.

   والبيانات كلّها مُختلقة: العيّنات تُبنى في الذاكرة، ومعرّفات الموظفين
   تُشتقّ من معرّفات تلك العيّنات. */

const hashOf = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* سجلّ موظفين مُختلَق مبنيّ على معرّفات إيصالات العيّنة نفسها. */
function employeesFor(rows, startEid = 900) {
  return rows.map((r, i) => ({
    "الرقم الوظيفي": String(startEid + i),
    ...(r.extIban ? { IBAN: r.extIban } : {}),
    ...(r.extAccount ? { "رقم الحساب": r.extAccount } : {}),
    "اسم المستفيد (كما في البنك)": r.extBeneficiary,
  }));
}

async function ingest(buf, existing = []) {
  return ingestDocument(buf, { sourceHash: hashOf(buf), sourceName: "f.pdf", existing });
}
const asStored = (rows) => rows.map((r, i) => ({
  id: i + 1, sourceHash: r.sourceHash, pageFrom: r.pageFrom, pageTo: r.pageTo,
  receiptHash: r.receiptHash, dupState: r.dupState,
}));

/* ═══ ① الاستيعاب: كل إيصال صفٌّ مستقلّ ═══ */

test("مجمّع يُنتج صفًّا لكل إيصال لا صفًّا للملفّ", async () => {
  const r = await ingest(F.accountBundle(5));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.rows.length, 5, "خمسة إيصالات ⇒ خمسة صفوف");
  assert.equal(r.rule, "beneficiary_identifier_boundary");
  /* وكل صفّ يحمل مداه وهويته ومصدره. */
  for (const [i, row] of r.rows.entries()) {
    assert.equal(row.pageFrom, i + 1);
    assert.equal(row.pageTo, i + 1);
    assert.match(row.receiptHash, /^[0-9a-f]{64}$/);
    assert.equal(row.sourcePages, 5);
    assert.ok(row.sourceHash);
  }
  assert.equal(new Set(r.rows.map((x) => x.receiptHash)).size, 5, "هويات متمايزة");
});

test("إيصال مفرد يُنتج صفًّا واحدًا", async () => {
  const r = await ingest(F.innerTransfer());
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].identifierType, "account");
  assert.equal(r.rows[0].startReason, "beneficiary_account");
});

test("كل صفّ يحمل الحقول المطلوبة للتخزين", async () => {
  const r = await ingest(F.mixedBundle());
  for (const row of r.rows) {
    for (const key of ["sourceHash", "sourcePages", "pageFrom", "pageTo", "receiptHash",
                       "identifierType", "startReason", "extAmount", "extReference", "dupState"]) {
      assert.ok(key in row, `الحقل ${key} مفقود`);
    }
    assert.ok(row.extIban || row.extAccount, "معرّف مستفيد موجود");
  }
  assert.deepEqual(r.rows.map((x) => x.identifierType), ["account", "iban", "account", "iban"]);
});

test("مصدرٌ بلا hash يُرفض قبل أي تحليل", async () => {
  const r = await ingestDocument(F.innerTransfer(), {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_source_hash");
});

/* ═══ ② كشف التكرار — ولا واحد منه يُسقط إيصالًا ═══ */

test("إعادة رفع الملفّ نفسه: صفر صفوف جديدة، ويُبلَّغ صريحًا", async () => {
  const buf = F.accountBundle(5);
  const first = await ingest(buf);
  const again = await ingest(buf, asStored(first.rows));
  assert.equal(again.rows.length, 0, "لا تكرار");
  assert.equal(again.skipped.length, 5, "ولا صمت: الخمسة مُبلَّغ عنها");
  for (const s of again.skipped) assert.equal(s.skipReason, "already_ingested");
});

test("نفس الإيصال في مصدرين: يُدرَج ويُوسَم — لا يُرفض ولا يُسقط", async () => {
  const bundle = F.accountBundle(3);
  const firstPass = await ingest(bundle);
  const stored = asStored(firstPass.rows);

  /* ملفّ آخر يحوي إيصالًا بالهوية نفسها. */
  const single = F.accountBundle(1);
  const second = await ingest(single, stored);
  assert.equal(second.rows.length, 1, "يُدرَج — إسقاطه يُخفي حالة حقيقية");
  assert.equal(second.rows[0].dupState, "candidate");
  assert.equal(second.rows[0].duplicateOf, stored[0].id, "ويشير إلى الأسبق");
  /* والأسبق يُوسَم معه: لا يُحتسب أحدهما اعتباطًا بترتيب الرفع. */
  assert.deepEqual(second.markDuplicate, [stored[0].id]);
});

test("إيصالان متطابقان داخل الملفّ الواحد: الثاني candidate", async () => {
  /* مجمّع فيه إيصالان بنفس المستفيد والمبلغ والمرجع ⇒ نصّهما واحد. */
  const dup = F.accountBundle(1);
  const { buildPdf } = require("./fixtures/pdf-writer.js");
  const one = F.innerTransferReceipt({ account: "8800000000055", beneficiary: "SAME", reference: "TBC2608130000555", amountText: "700.00" });
  const r = await ingest(buildPdf([one, one]));
  assert.equal(r.rows.length, 2, "المدى يختلف فيُدرجان");
  assert.equal(r.rows[0].receiptHash, r.rows[1].receiptHash, "والهوية واحدة");
  assert.equal(r.rows[1].dupState, "candidate");
  assert.equal(r.rows[0].dupState, "candidate", "والأول يُوسَم معه");
  assert.ok(dup);
});

test("مفتاح المصدر يميّز المدى لا الملفّ", () => {
  const a = { sourceHash: "aa", pageFrom: 1, pageTo: 1 };
  const b = { sourceHash: "aa", pageFrom: 2, pageTo: 2 };
  assert.notEqual(sourceKey(a), sourceKey(b), "عشرة إيصالات من ملفّ واحد لا تتصادم");
  assert.equal(sourceKey(a), sourceKey({ ...a }));
});

/* ═══ ③ الربط: بمفتاح قاطع فريد وحده ═══ */

test("الربط بـIBAN وبرقم الحساب", async () => {
  const r = await ingest(F.mixedBundle());
  const emp = employeesFor(r.rows);
  const linked = M.linkAll(r.rows, emp);
  assert.equal(linked.filter((x) => x.linkStatus === "linked").length, 4);
  assert.equal(linked.filter((x) => x.matchKey === "iban").length, 2);
  assert.equal(linked.filter((x) => x.matchKey === "account").length, 2);
});

test("لا نزول من IBAN إلى الحساب", () => {
  const idx = M.indexEmployees([{ "الرقم الوظيفي": "900", "رقم الحساب": "8800000000001" }]);
  const r = M.linkReceipt({ extIban: "SA9900009999999999999999", extAccount: "8800000000001" }, idx);
  assert.equal(r.linkStatus, "unlinked", "IBAN بلا صاحب ⇒ مراجعة لا نزول");
  assert.equal(r.employeeEid, null);
});

test("معرّف عند أكثر من موظف ⇒ ambiguous بمرشّحيه", () => {
  const dup = [
    { "الرقم الوظيفي": "900", IBAN: "SA9100010001000100010001" },
    { "الرقم الوظيفي": "901", IBAN: "SA9100010001000100010001" },
  ];
  const r = M.linkReceipt({ extIban: "SA9100010001000100010001" }, M.indexEmployees(dup));
  assert.equal(r.linkStatus, "ambiguous");
  assert.equal(r.employeeEid, null);
  assert.deepEqual(r.candidates.map((c) => c.eid), ["900", "901"]);
});

test("بلا معرّف ⇒ unreadable · ومعرّف بلا صاحب ⇒ unlinked", () => {
  const idx = M.indexEmployees([{ "الرقم الوظيفي": "900", "رقم الحساب": "8800000000001" }]);
  assert.equal(M.linkReceipt({}, idx).linkStatus, "unreadable");
  assert.equal(M.linkReceipt({ extAccount: "8800000000999" }, idx).linkStatus, "unlinked");
});

test("الاسم تعزيز: تناقضه يُعرَض ولا يُلغي ربطًا", async () => {
  const emp = [{ "الرقم الوظيفي": "900", "رقم الحساب": "8800000000001", "اسم المستفيد (كما في البنك)": "ALPHA BETA" }];
  const linked = M.linkAll([{ extAccount: "8800000000001", extBeneficiary: "GAMMA DELTA" }], emp);
  assert.equal(linked[0].linkStatus, "linked", "المفتاح القاطع أقوى من الاسم");
  assert.ok(linked[0].nameWarning, "والتناقض يُعرَض");
  const agree = M.linkAll([{ extAccount: "8800000000001", extBeneficiary: "ALPHA BETA" }], emp);
  assert.equal(agree[0].nameWarning, null);
});

test("المبلغ ممنوع أن يكون مفتاح هوية", () => {
  /* إيصالان بالمبلغ نفسه ومعرّفين مختلفين ⇒ كلٌّ لصاحبه. */
  const emp = [
    { "الرقم الوظيفي": "900", "رقم الحساب": "8800000000001" },
    { "الرقم الوظيفي": "901", "رقم الحساب": "8800000000002" },
  ];
  const linked = M.linkAll([
    { extAccount: "8800000000001", extAmount: 1000 },
    { extAccount: "8800000000002", extAmount: 1000 },
  ], emp);
  assert.deepEqual(linked.map((x) => x.employeeEid), ["900", "901"]);
  /* ومعرّف مجهول لا يُربط بالمبلغ مهما تطابق. */
  const orphan = M.linkAll([{ extAccount: "8800000000999", extAmount: 1000 }], emp);
  assert.equal(orphan[0].employeeEid, null);
});

/* ═══ ④ المطابقة على المجموع ═══ */

const rec = (eid, amount, dupState = "none") => ({
  linkStatus: "linked", employeeEid: eid, extAmount: amount, dupState,
});

test("إيصال واحد يساوي المسير ⇒ matched", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3412.08 }, [rec("900", 3412.08)]);
  assert.equal(m.status, "matched");
  assert.equal(m.difference, 0);
  assert.equal(m.receiptTotal, 3412.08);
});

test("إيصالان 2000 + 1000 ومسيره 3000 ⇒ matched", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 }, [rec("900", 2000), rec("900", 1000)]);
  assert.equal(m.status, "matched", "المقارنة على المجموع لا على إيصال واحد");
  assert.equal(m.countable.length, 2);
  assert.equal(m.receiptTotal, 3000);
});

test("المجموع أقلّ بـ0.01 ⇒ partial", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 }, [rec("900", 1999.99), rec("900", 1000)]);
  assert.equal(m.status, "partial");
  assert.equal(Math.round(m.difference * 100), -1, "الفرق بالهللة");
});

test("المجموع أعلى ⇒ overpaid", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 }, [rec("900", 2000), rec("900", 1000.5)]);
  assert.equal(m.status, "overpaid");
  assert.equal(Math.round(m.difference * 100), 50);
});

test("لا إيصال ⇒ missing_receipt", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 }, []);
  assert.equal(m.status, "missing_receipt");
  assert.equal(m.receiptTotal, null, "لا مجموع لا صفر");
});

test("sheet_amount غائب ⇒ needs_review لا matched", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: null }, [rec("900", 3000)]);
  assert.equal(m.status, "needs_review", "بلا مرجع لا حكم");
});

test("إيصال بلا مبلغ مقروء ⇒ needs_review", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 }, [rec("900", 3000), rec("900", null)]);
  assert.equal(m.status, "needs_review", "مجموع ناقص لا يُحكم عليه");
});

test("مرشّح تكرار لم يُحسم ⇒ needs_review ولا يُحتسب", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 },
    [rec("900", 3000), rec("900", 3000, "candidate")]);
  assert.equal(m.status, "needs_review");
  assert.equal(m.pending.length, 1);
  assert.equal(m.countable.length, 1, "المرشّح لا يُضاعف المجموع");
});

test("حسم المرشّح distinct ⇒ يُحتسب · redundant ⇒ لا", () => {
  const distinct = M.matchEmployee({ eid: "900", sheetAmount: 6000 },
    [rec("900", 3000), rec("900", 3000, "distinct")]);
  assert.equal(distinct.status, "matched", "المحسوم مشروعًا يُحتسب");
  const redundant = M.matchEmployee({ eid: "900", sheetAmount: 3000 },
    [rec("900", 3000), rec("900", 3000, "redundant")]);
  assert.equal(redundant.status, "matched", "والمحسوم مكرّرًا لا يُحتسب");
});

test("إيصال ملتبس يُرشّح الموظف ⇒ needs_review لا missing", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 },
    [{ linkStatus: "ambiguous", candidates: [{ eid: "900" }, { eid: "901" }] }]);
  assert.equal(m.status, "needs_review");
  assert.notEqual(m.status, "missing_receipt", "لا يُقال «لا إيصال» وهناك مرشّح");
});

test("إيصال موظف آخر لا يدخل مجموعه", () => {
  const m = M.matchEmployee({ eid: "900", sheetAmount: 3000 }, [rec("901", 3000)]);
  assert.equal(m.status, "missing_receipt");
  assert.equal(m.countable.length, 0);
});

/* سماحية صفر تامّ — والمقارنة بالهللات لا بالريالات العائمة. */
test("سماحية صفر: فرق هللة واحدة ليس مطابقة", () => {
  assert.equal(M.matchEmployee({ eid: "9", sheetAmount: 1000 }, [rec("9", 1000.01)]).status, "overpaid");
  assert.equal(M.matchEmployee({ eid: "9", sheetAmount: 1000 }, [rec("9", 999.99)]).status, "partial");
  assert.equal(M.matchEmployee({ eid: "9", sheetAmount: 1000 }, [rec("9", 1000)]).status, "matched");
});

test("الجمع بالهللات: 0.1+0.2 لا يُنتج فرقًا وهميًا", () => {
  const m = M.matchEmployee({ eid: "9", sheetAmount: 0.3 }, [rec("9", 0.1), rec("9", 0.2)]);
  assert.equal(m.status, "matched", "الجمع العائم كان سيُنتج 0.30000000000000004");
});

/* ═══ ⑤ الملخّص ═══ */

test("الملخّص يعدّ الحالات كلّها", async () => {
  const r = await ingest(F.accountBundle(3));
  const emp = employeesFor(r.rows);
  const linked = M.linkAll(r.rows, emp);
  const proofs = emp.map((e, i) => ({ eid: e["الرقم الوظيفي"], sheetAmount: r.rows[i].extAmount }));
  const s = M.summarize(M.matchAll(proofs, linked), linked);
  assert.equal(s.employees, 3);
  assert.equal(s.matched, 3);
  assert.equal(s.receipts, 3);
  assert.equal(s.linked, 3);
  for (const k of ["partial", "overpaid", "missingReceipt", "needsReview", "ambiguous", "unlinked", "unreadable", "duplicateCandidates"]) {
    assert.equal(s[k], 0, `${k} يجب أن يكون صفرًا`);
  }
});

test("أسماء حقول السجلّ مطابقة للمخزَّن فعلًا", () => {
  /* خمّنتُ «رقم الآيبان» فوجدت المخزَّن «IBAN» — وتخمينُ اسم حقل يُنتج
     فهرسًا فارغًا فلا يُربط إيصالٌ واحد، والعطل صامت لأن «لا مطابقة»
     نتيجةٌ مشروعة. فالأسماء مقيَّدة بخريطة doc-status.js. */
  const fs = require("node:fs");
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "doc-status.js"), "utf8");
  assert.match(src, new RegExp(`iban:"${M.F_IBAN}"`), "اسم حقل IBAN");
  assert.match(src, new RegExp(`acc:"${M.F_ACCOUNT}"`), "اسم حقل رقم الحساب");
  assert.match(src, new RegExp(`benef:"${M.F_NAME_BANK.replace(/[()]/g, "\\$&")}"`), "اسم المستفيد البنكي");
  assert.match(src, new RegExp(`damanah:"${M.F_DAMANAH}"`), "رقم ضمان");
});
