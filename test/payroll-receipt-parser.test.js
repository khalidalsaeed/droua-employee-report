const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePageText, receiptHash, extractFields, hasHardKey, findIbans, toHalalas,
} = require("../lib/payroll/receiptFields");
const { readPages, splitByNewIban, parseReceiptDocument } = require("../lib/payroll/receiptDoc");
const F = require("./fixtures/receipts.js");

/* محلّل إيصالات التحويل — المرحلة 2.2 من تاسك أجير.
   =========================================================================
   العيّنات مُعقَّمة وتُبنى في الذاكرة: لا ملفّ PDF يُودَع في المستودع
   ولا بيان هوية. أرقام IBAN تبدأ بـSA9x (الحقيقية SA02) فلا يمكن أن
   تشير إلى حساب قائم حتى بالخطأ.

   وما تحفظه العيّنة من المستند الحقيقي هو بنيته: IBAN مقطوع على سطرين
   عند نفس الإحداثيين المقيسين، ومبلغ بفاصلة ألفية ومنزلتين ورمز عملة،
   ومرجع بحروف كبيرة وأرقام.

   ما لا يفعله المحلّل عن قصد: لا يقرّر link_status ولا dup_state — ذاك
   يحتاج سجلّ الموظفين وبقية صفوف المسير، وهو شأن 2.3. هذه الطبقة تصف
   ما في المستند وتتوقّف. */

const first = (r) => r.receipts[0];

/* ═══ الاختبارات العشرة المخطَّطة في 2.1 ═══ */

/* ① أهمّ ظاهرة في المستند: IBAN مقطوع على عنصرين في سطرين. */
test("① IBAN مقطوع على سطرين يُعاد تجميعه", async () => {
  const r = await parseReceiptDocument(F.single());
  assert.equal(r.ok, true, r.reason);
  const f = first(r).fields;
  /* النصّ يحمل الجزأين مفترقين — فالتجميع ليس تحصيل حاصل. */
  assert.match(first(r).text, /SA91000100010001\n00010001/);
  assert.equal(f.iban, F.iban(1));
  assert.equal(f.iban.length, 24);
  assert.deepEqual(f.issues, []);
});

test("① والمتّصل في عنصر واحد يُقرأ أيضًا", async () => {
  const r = await parseReceiptDocument(F.wholeIban());
  assert.equal(first(r).fields.iban, F.iban(2));
});

/* ② الأنماط أساس: لا وسم عربي في العيّنة، والمفتاح القاطع يُستخرج. */
test("② IBAN يُستخرج بلا أي وسم عربي", () => {
  const f = extractFields("QWERTY\nSA9100010001000100010001\nZXCV");
  assert.equal(f.iban, "SA9100010001000100010001");
  /* ولا وسوم إطلاقًا، ومع ذلك المفتاح القاطع موجود. */
  assert.equal(hasHardKey(f), true);
});

test("② والوسوم — عربيةً أو لاتينية — تُسمّي ما لا يميّزه نمط", () => {
  const latin = extractFields("TO: BENEFICIARY ONE\nBANK: SOME BANK\nFROM: SENDER CO");
  assert.equal(latin.beneficiary, "BENEFICIARY ONE");
  assert.equal(latin.bank, "SOME BANK");
  assert.equal(latin.sender, "SENDER CO");
  const arabic = extractFields("اسم المستفيد: BENEFICIARY TWO\nاسم البنك: OTHER BANK");
  assert.equal(arabic.beneficiary, "BENEFICIARY TWO");
  assert.equal(arabic.bank, "OTHER BANK");
});

/* الوسم العربي يفترق عن قيمته سطرًا — ظاهرة إعادة تشكيل RTL. */
test("② وسمٌ في سطر وقيمته في التالي يُقرأ", () => {
  const f = extractFields("اسم المستفيد:\nBENEFICIARY THREE\nشيء آخر");
  assert.equal(f.beneficiary, "BENEFICIARY THREE");
});

/* ③ الكسر هو ما وُجدت الميزة لأجله: تدويرٌ إلى الريال يمحوه. */
test("③ مبلغ ينتهي بـ.08 يُستخرج بمنزلتيه كاملتين", async () => {
  const r = await parseReceiptDocument(F.single());
  const f = first(r).fields;
  assert.equal(f.amount, 3412.08);
  assert.equal(f.amountHalalas, 341208);
  assert.equal(f.amountHalalas % 100, 8, "الهللات الثماني موجودة");
});

/* ④ استقرار الهوية شرطُ ألّا يُوسم إيصال مرشّحًا للتكرار بلا سبب. */
test("④ receipt_hash مستقرّ عبر تشغيلين لنفس البايتات", async () => {
  const buf = F.single();
  const a = await parseReceiptDocument(buf);
  const b = await parseReceiptDocument(Buffer.from(buf));
  assert.equal(first(a).receiptHash, first(b).receiptHash);
  assert.match(first(a).receiptHash, /^[0-9a-f]{64}$/);
});

test("④ والترتيب حتمي: عناصر مبعثرة تُنتج النصّ نفسه", () => {
  const items = [
    { x: 60, y: 700, str: "SECOND" },
    { x: 200, y: 780, str: "B" },
    { x: 60, y: 780, str: "A" },
  ];
  const shuffled = [items[2], items[0], items[1]];
  assert.equal(normalizePageText(items), normalizePageText(shuffled));
  assert.equal(normalizePageText(items), "A B\nSECOND", "أعلى أولًا، ثم يسارًا فيمينًا");
});

test("⑤ receipt_hash يختلف بين إيصالين مختلفين", async () => {
  const a = await parseReceiptDocument(F.single());
  const b = await parseReceiptDocument(F.wholeIban());
  assert.notEqual(first(a).receiptHash, first(b).receiptHash);
});

/* ⑥ لا مفتاح ⇒ لا ربط. والمحلّل يصف ولا يقرّر الحالة. */
test("⑥ إيصال بلا IBAN: لا مفتاح قاطع، والسبب مُعلَن", async () => {
  const r = await parseReceiptDocument(F.noIban());
  assert.equal(r.ok, true);
  const f = first(r).fields;
  assert.equal(f.iban, null);
  assert.deepEqual(f.ibans, []);
  assert.ok(f.issues.includes("no_iban"));
  assert.equal(hasHardKey(f), false, "بلا مفتاح قاطع — 2.3 تُصنّفه unreadable");
  /* ولا يُخمَّن مستفيدٌ من رقم في الصفحة. */
  assert.equal(f.account, null);
});

/* ⑦ ملفّ مشوّه: سببٌ مفهوم لا انهيار — انهيارٌ هنا يُسقط دفعة كاملة. */
test("⑦ ملفّ ليس PDF: رفض مفهوم بلا انهيار", async () => {
  const r = await parseReceiptDocument(F.malformed());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_a_pdf");
});

test("⑦ PDF مقطوع: رفض مفهوم بلا انهيار", async () => {
  const r = await parseReceiptDocument(F.truncated());
  assert.equal(r.ok, false);
  assert.ok(["unreadable_pdf", "no_pages"].includes(r.reason), `سببٌ مفيد، وصل: ${r.reason}`);
});

test("⑦ ملفّ فارغ يُرفض قبل أي قراءة", async () => {
  for (const empty of [Buffer.alloc(0), null, undefined]) {
    const r = await parseReceiptDocument(empty);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "empty_file");
  }
});

/* ⑧ لا صفحة تُتخطّى بصمت: كل صفحة في مدى أو في orphanPages. */
test("⑧ Σ صفحات المديات + اليتيمة = عدد صفحات المصدر", async () => {
  for (const [name, buf] of [
    ["مجمّع عشرة", F.bundle(10)],
    ["مجمّع بامتداد", F.bundleWithSpan()],
    ["مجمّع بصفحة يتيمة", F.bundleLeadingOrphan()],
  ]) {
    const r = await parseReceiptDocument(buf);
    assert.equal(r.ok, true, `${name}: ${r.reason}`);
    const covered = r.receipts.reduce((a, x) => a + (x.pageTo - x.pageFrom + 1), 0);
    assert.equal(covered + r.orphanPages.length, r.sourcePages, `${name}: صفحة ضائعة`);
  }
});

test("⑧ مجمّع عشرة إيصالات يُنتج عشرة مديات صفحةً صفحة", async () => {
  const r = await parseReceiptDocument(F.bundle(10));
  assert.equal(r.sourcePages, 10);
  assert.equal(r.receipts.length, 10);
  for (const [i, rec] of r.receipts.entries()) {
    assert.equal(rec.pageFrom, i + 1);
    assert.equal(rec.pageTo, i + 1);
    assert.equal(rec.fields.iban, F.iban(i + 1), `الإيصال ${i + 1} يحمل IBANه`);
  }
  /* وهويات الإيصالات العشرة متمايزة. */
  assert.equal(new Set(r.receipts.map((x) => x.receiptHash)).size, 10);
});

/* ⑨ القاعدة المؤقّتة: صفحة بلا IBAN بعد إيصال بدأ = تكملته. */
test("⑨ صفحة بلا IBAN بعد صفحة بـIBAN = تكملة لا إيصال جديد", async () => {
  const r = await parseReceiptDocument(F.bundleWithSpan());
  assert.equal(r.sourcePages, 3);
  assert.equal(r.receipts.length, 2, "ثلاث صفحات، إيصالان");
  assert.deepEqual([r.receipts[0].pageFrom, r.receipts[0].pageTo], [1, 2], "الأول يمتدّ صفحتين");
  assert.deepEqual([r.receipts[1].pageFrom, r.receipts[1].pageTo], [3, 3]);
  /* وحقول الإيصال الممتدّ تُقرأ من صفحتيه معًا. */
  assert.match(r.receipts[0].text, /CONTINUED/);
  assert.equal(r.receipts[0].fields.iban, F.iban(21));
});

test("⑨ صفحة بلا IBAN قبل أي إيصال تُبلَّغ ولا تصير إيصالًا وهميًا", async () => {
  const r = await parseReceiptDocument(F.bundleLeadingOrphan());
  assert.deepEqual(r.orphanPages, [1]);
  assert.equal(r.receipts.length, 1);
  assert.equal(r.receipts[0].pageFrom, 2);
});

/* القاعدة قابلة للاستبدال — Risk مفتوحة حتى مجمّع حقيقي. */
test("⑨ قاعدة التقسيم مُمرَّرة اعتماديةً ويمكن استبدالها", async () => {
  const eachPageAlone = (pages) => ({
    ranges: pages.map((p) => ({ pageFrom: p.pageNo, pageTo: p.pageNo })),
    orphanPages: [], rule: "one_page_one_receipt",
  });
  const r = await parseReceiptDocument(F.bundleWithSpan(), { splitRule: eachPageAlone });
  assert.equal(r.receipts.length, 3, "قاعدة بديلة تُنتج ثلاثة");
  assert.equal(r.rule, "one_page_one_receipt", "والقاعدة المستعملة مُعلَنة في الردّ");
});

/* ⑩ درس NaN من المرحلة الأولى: كل مقارنة معه false، فيمرّ من الحواجز. */
test("⑩ مبلغ غير رقمي ⇒ null لا NaN", async () => {
  const r = await parseReceiptDocument(F.badAmount());
  const f = first(r).fields;
  assert.equal(f.amount, null);
  assert.equal(f.amountHalalas, null);
  assert.ok(!Number.isNaN(f.amount), "NaN يهرب من كل مقارنة — null لا يهرب");
  assert.ok(f.issues.includes("amount_unparseable"), "ويُفرَّق عن «لا مبلغ مطبوع»");
});

test("⑩ toHalalas يُرجع null لا NaN على كل قيمة شاذّة", () => {
  for (const bad of ["", "--", "abc", "SAR", null, undefined, {}]) {
    assert.equal(toHalalas(bad), null, `${JSON.stringify(bad)} يجب أن يكون null`);
  }
  assert.equal(toHalalas("3,412.08"), 341208);
  assert.equal(toHalalas("0.00"), 0, "الصفر قيمة لا فراغ");
});

/* ═══ ما وراء العشرة: التباس لا يُخمَّن ═══ */

test("مبلغان متناقضان ⇒ لا يُختار أحدهما", async () => {
  const r = await parseReceiptDocument(F.conflictingAmounts());
  const f = first(r).fields;
  assert.equal(f.amount, null, "اختيار الأول تخمينٌ مبنيّ على تخطيط المستند");
  assert.ok(f.issues.includes("amount_conflict"));
});

test("مبلغان متطابقان ⇒ يُقبلان قيمةً واحدة", async () => {
  const r = await parseReceiptDocument(F.repeatedAmount());
  const f = first(r).fields;
  assert.equal(f.amount, 900.5, "تكرار المبلغ صيغة شائعة لا تناقض");
  assert.deepEqual(f.issues, []);
});

test("IBANان في صفحة واحدة ⇒ المستفيد غير محدّد، فلا يُختار", async () => {
  const r = await parseReceiptDocument(F.twoIbans());
  const f = first(r).fields;
  assert.equal(f.iban, null);
  assert.equal(f.ibans.length, 2);
  assert.ok(f.issues.includes("multiple_ibans"));
  assert.equal(hasHardKey(f), false, "مفتاحان متساويان ليسا مفتاحًا قاطعًا");
});

test("IBAN مكرّر مرّتين هو IBAN واحد", () => {
  const ib = "SA9100010001000100010001";
  const f = extractFields(`${ib}\nشيء\n${ib}`);
  assert.equal(f.iban, ib, "التكرار النصّي ليس التباسًا");
  assert.ok(!f.issues.includes("multiple_ibans"), "ولا يُعدّ IBANين");
});

/* رقم حساب المستفيد يحتاج وسمًا يقترن به: الإيصال يطبع حساب المُرسِل
   غالبًا، ونسبةُ رقمٍ طويل إلى المستفيد قد تربطه بحساب الشركة. */
test("رقم حساب المُرسِل لا يُنسَب إلى المستفيد", async () => {
  const r = await parseReceiptDocument(F.single());
  const f = first(r).fields;
  assert.match(first(r).text, /ACCOUNT NO: 010800000000000099/, "الرقم مطبوع فعلًا");
  assert.equal(f.account, null, "ومع ذلك لا يُنسَب إلى المستفيد");
});

test("حساب المستفيد يُقرأ بوسمه الصريح وحده", () => {
  const f = extractFields("BENEFICIARY ACCOUNT: 12345678901234\nOTHER: 99999999999999");
  assert.equal(f.account, "12345678901234");
  const ar = extractFields("رقم حساب المستفيد: 55555555555555");
  assert.equal(ar.account, "55555555555555");
});

/* ═══ التطبيع والهوية ═══ */

test("النصّ الفارغ لا يُنتج حقولًا ولا ينهار", () => {
  for (const v of ["", null, undefined]) {
    const f = extractFields(v);
    assert.equal(f.iban, null);
    assert.equal(f.amount, null);
    assert.ok(f.issues.includes("no_iban"));
    assert.ok(f.issues.includes("no_amount"));
  }
});

test("عنصر بإحداثي غير رقمي يُتخطّى ولا يُسقط الصفحة", () => {
  const text = normalizePageText([
    { x: 60, y: 700, str: "GOOD" },
    { x: 60, y: NaN, str: "BAD" },
    { x: 60, y: null, str: "ALSO BAD" },
  ]);
  assert.equal(text, "GOOD");
});

test("هوية الإيصال الممتدّ تُحسَب على صفحتيه معًا", async () => {
  const r = await parseReceiptDocument(F.bundleWithSpan());
  const spanned = r.receipts[0];
  /* لو حُسبت على الصفحة الأولى وحدها لطابقت هوية إيصالٍ بصفحة واحدة
     يحمل النصّ نفسه — فيُوسم مرشّحًا للتكرار خطأً. */
  assert.equal(spanned.receiptHash, receiptHash(spanned.text));
  assert.notEqual(spanned.receiptHash, receiptHash(spanned.text.split("\nTRANSACTION DETAILS - CONTINUED")[0]));
});

test("readPages يُرجع الصفحات بنصّها وترتيبها", async () => {
  const r = await readPages(F.bundle(3));
  assert.equal(r.ok, true);
  assert.deepEqual(r.pages.map((p) => p.pageNo), [1, 2, 3]);
  for (const p of r.pages) assert.ok(p.text.length > 0);
});

test("splitByNewIban تُعلن قاعدتها ولا تُسقط صفحة", () => {
  const pages = [
    { pageNo: 1, text: "لا شيء" },
    { pageNo: 2, text: "SA9100010001000100010001" },
    { pageNo: 3, text: "تكملة" },
    { pageNo: 4, text: "SA9200020002000200020002" },
  ];
  const s = splitByNewIban(pages);
  assert.equal(s.rule, "new_iban_starts_receipt");
  assert.deepEqual(s.orphanPages, [1]);
  assert.deepEqual(s.ranges, [{ pageFrom: 2, pageTo: 3 }, { pageFrom: 4, pageTo: 4 }]);
});

test("findIbans يتجاهل الفراغ ولا يخترع تطابقًا", () => {
  assert.deepEqual(findIbans("SA91000100010001\n00010001"), ["SA9100010001000100010001"]);
  assert.deepEqual(findIbans("SA910001"), [], "أقصر من 24 ليس IBAN");
  assert.deepEqual(findIbans("لا شيء هنا"), []);
});

/* حاجز السياسة على هذه العيّنات تحديدًا. */
test("العيّنات خالية من أي IBAN أو حساب حقيقي", async () => {
  const r = await parseReceiptDocument(F.bundle(10));
  for (const rec of r.receipts) {
    /* الحقيقي SA02 — والعيّنة SA9x، فلا تصادم ممكن. */
    assert.match(rec.fields.iban, /^SA9\d/);
  }
});

/* ═══ انحدار: لا يُخترع IBAN لم يُطبع ═══
   =========================================================================
   أخطر ما يمكن أن يفعله محلّل: يُنتج حسابًا لا وجود له، فيقابل موظفًا
   حقيقيًا بالخطأ ويُرفق إيصالُ غيره ببطاقته.

   وقد حدث. النسخة الأولى جرّدت النصّ كلّه من الفراغ ثم بحثت فيه —
   فلصقت أجزاءً ليست متجاورة. وصفحةٌ بعمودين (بادئتا إيصالين في سطر
   وذيلاهما في التالي) أنتجت «SA98…0007»: بادئة أحدهما وذيل الآخر.

   وحصر اللصق في سطرين لم يكفِ وحده — قيسَ فأنتج الاختراع نفسه. فالحاجز
   على النتيجة: بادئة SA تبقى بعد إزالة كل IBAN اكتمل تعني تخطيطًا لم
   نتوقّعه، وحينها لا يُوثَق بأي تطابق. */

const { ibanScan } = require("../lib/payroll/receiptFields");

const PRINTED = ["SA9700070007000700070007", "SA9800080008000800080008"];

test("انحدار: صفحة بعمودين لا تُنتج IBAN لم يُطبع", () => {
  /* بادئتا إيصالين في سطر، وذيلاهما في السطر التالي. */
  const twoColumn = "SA97000700070007 SA98000800080008\n00070007 00080008";
  const got = findIbans(twoColumn);
  const invented = got.filter((x) => !PRINTED.includes(x));
  assert.deepEqual(invented, [], "لا يجوز أن يخرج حسابٌ لم يُطبع");
  /* والصمت مرفوض أيضًا: يُعلَن أن التخطيط غير متوقّع. */
  const f = extractFields(twoColumn);
  assert.equal(f.iban, null);
  assert.ok(f.issues.includes("iban_layout_unexpected"));
  assert.equal(hasHardKey(f), false);
});

test("انحدار: بادئة IBAN لم تُكمَل تُعلَن ولا تُبتلَع", () => {
  /* مقطوع على ثلاثة أسطر — ظاهرة لم نرَها، فلا تُخمَّن. */
  const s = ibanScan("SA94\n0004000400040004\n0004");
  assert.equal(s.suspicious, true);
  assert.equal(s.leftover, 1);
  const f = extractFields("SA94\n0004000400040004\n0004");
  assert.ok(f.issues.includes("iban_layout_unexpected"));
  /* ويُفرَّق عن «لا IBAN إطلاقًا»: هنا حسابٌ مطبوع لم يُقرأ. */
  assert.ok(!f.issues.includes("no_iban"));
});

test("والتكرار النصّي ليس التباسًا: نفس IBAN مرّتين", () => {
  const ib = "SA9100010001000100010001";
  const s = ibanScan(`${ib}\nشيء\n${ib}`);
  assert.equal(s.suspicious, false, "الإيصال يطبع IBANه مرّتين أحيانًا");
  assert.equal(s.leftover, 0);
  assert.deepEqual(s.ibans, [ib]);
});

test("وIBANان مشروعان في صفحة يُقرآن كليهما", () => {
  const s = ibanScan("SA9100010001000100010001\nX\nSA9200020002000200020002");
  assert.equal(s.suspicious, false);
  assert.equal(s.ibans.length, 2, "التباس المستفيد لا التباس التخطيط");
});

test("وIBAN مقطوع سليم يبقى مقروءًا — التحصين لا يكسر الحالة الشائعة", async () => {
  const r = await parseReceiptDocument(F.single());
  assert.equal(first(r).fields.iban, F.iban(1));
  assert.deepEqual(first(r).fields.issues, []);
});

/* ═══ انحدار: الرسوم ليست مبلغ التحويل ═══
   =========================================================================
   نمط «كل رقم بـSAR» يجمع الرسوم والعمولة والضريبة مع مبلغ التحويل،
   فيُنتج amount_conflict كاذبًا. أمسكه إيصالٌ يمتدّ صفحتين وصفحته
   الثانية تحمل «CHARGES: 0.00 SAR» — وكان سيُصنّف كل إيصال يحمل رسومًا
   needs_review، أي عملًا يدويًا على كل إيصال. */

test("انحدار: رسومٌ في الإيصال لا تُعارض مبلغ التحويل", async () => {
  const r = await parseReceiptDocument(F.bundleWithSpan());
  const spanned = r.receipts[0];
  assert.match(spanned.text, /CHARGES: 0\.00 SAR/, "الرسوم مطبوعة فعلًا");
  assert.equal(spanned.fields.amount, 2000, "ومبلغ التحويل هو الموسوم به");
  assert.ok(!spanned.fields.issues.includes("amount_conflict"));
});

test("الوسم مرجّح لا أساس: بلا وسمٍ إطلاقًا يبقى التعارض مُعلَنًا", () => {
  const f = extractFields("700.00 SAR\n800.00 SAR");
  assert.equal(f.amount, null, "رقمان بلا وسم — لا يُخمَّن أيّهما");
  assert.ok(f.issues.includes("amount_conflict"));
});

test("وسم الرسوم بالعربية يُستبعد أيضًا", () => {
  const f = extractFields("مبلغ الخصم: 1,500.00 SAR\nرسوم التحويل: 15.00 SAR\nضريبة: 2.25 SAR");
  assert.equal(f.amount, 1500);
  assert.ok(!f.issues.includes("amount_conflict"), "الرسوم والضريبة لا تُعارضان");
});

test("مبلغان موسومان بالتحويل واختلفا ⇒ تعارض حقيقي", () => {
  const f = extractFields("AMOUNT: 700.00 SAR\nAMOUNT: 800.00 SAR");
  assert.equal(f.amount, null);
  assert.ok(f.issues.includes("amount_conflict"));
});

test("رسومٌ وحدها بلا مبلغ تحويل ⇒ لا مبلغ لا رسوم", () => {
  const f = extractFields("CHARGES: 15.00 SAR");
  assert.equal(f.amount, null, "الرسوم ليست مبلغ التحويل أبدًا");
  assert.ok(f.issues.includes("no_amount") || f.issues.includes("amount_unparseable"));
});

test("الموسوم بالتحويل يُقدَّم على رقمٍ بلا وسم", () => {
  /* الإيصال يطبع أرقامًا أخرى بلا وسم — رصيدًا أو إجماليًا. فوجودُ
     موسومٍ بالتحويل يحسم، ولا يُعدّ التعدّد تعارضًا. */
  const f = extractFields("AMOUNT: 1,000.00 SAR\n2,000.00 SAR");
  assert.equal(f.amount, 1000, "الموسوم يحسم");
  assert.ok(!f.issues.includes("amount_conflict"));
  /* وبلا موسومٍ إطلاقًا، الرقمان يتعارضان ولا يُخمَّن أيّهما. */
  const g = extractFields("1,000.00 SAR\n2,000.00 SAR");
  assert.equal(g.amount, null);
  assert.ok(g.issues.includes("amount_conflict"));
});
