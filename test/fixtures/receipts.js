#!/usr/bin/env node
/* عيّنات إيصالات تحويل مُعقَّمة — تُبنى بالكود لا تُنسخ من مستند حقيقي.
   =========================================================================
   ما تحافظ عليه من بنية الإيصال البنكي الحقيقي، لأنه بالضبط ما يقرؤه
   lib/payroll/receiptDoc.js و receiptFields.js:

     · IBAN مقطوع على عنصرين نصّيين في سطرين مختلفين. هذه أهمّ ظاهرة
       في المستند: قِيس في الإيصال الحقيقي عند y=422 و y=407 —
       «SA02050000682076» ثم «18169000». محلّل يعمل سطرًا سطرًا لن
       يجد IBAN إطلاقًا، فيصير كل إيصال unreadable.
     · المبلغ بصيغة «2,065.00 SAR» — فاصلة ألفية ومنزلتان ورمز عملة.
     · مرجع العملية بحروف كبيرة وأرقام (TBC…).
     · المستفيد والبنك بأحرف لاتينية كبيرة.
     · الوسوم — لاتينية هنا، وعربية في المستند الحقيقي. المحلّل يقبل
       الاثنين، والأنماط أساسه لا الوسوم.

   وما استُبدل: كل هوية وكل مبلغ. لا IBAN حقيقي ولا حساب ولا اسم شخص.
   أرقام IBAN تبدأ بـSA9x (الحقيقية SA02) فلا يمكن أن تشير إلى حساب
   قائم حتى بالخطأ.

   حالة الثماني هللات محفوظة (3,412.08) — قيمة الرقم لا تهمّ، الذي يهمّ
   أن الكسر موجود، فتبقى المطابقة بسماحية صفر قابلة للاختبار.

   التوليد:  node test/fixtures/receipts.js --write */

const { buildPdf, textOp } = require("./pdf-writer");

/* IBAN سعودي: SA + منزلتان تحقّق + 20 رقم حساب = 24 محرفًا.
   البادئة 9x مُختلقة: الحقيقية 02، فلا تصادم ممكن. */
const iban = (n) => `SA9${n % 10}${String(n).padStart(4, "0").repeat(5)}`;

/* الإحداثيات منقولة من قياس الإيصال الحقيقي: الجزء الأول من الـIBAN
   عند y=422 والثاني عند y=407 — خمسة عشر نقطة بينهما. */
const IBAN_Y1 = 422;
const IBAN_Y2 = 407;
const IBAN_SPLIT_AT = 16; // «SA» + 14 رقمًا في السطر الأول

function receipt(o) {
  const ops = [textOp(60, 780, "TRANSACTION DETAILS", 13)];
  if (o.date) ops.push(textOp(60, 750, `DATE: ${o.date}`));
  if (o.sender) {
    ops.push(textOp(60, 700, "FROM:"));
    ops.push(textOp(120, 700, o.sender));
  }
  if (o.senderAccount) ops.push(textOp(60, 680, `ACCOUNT NO: ${o.senderAccount}`));
  if (o.beneficiary) {
    ops.push(textOp(60, 640, "TO:"));
    ops.push(textOp(120, 640, o.beneficiary));
  }
  if (o.bank) ops.push(textOp(60, 620, `BANK: ${o.bank}`));

  /* الـIBAN مقطوعًا — الظاهرة المقصودة. وكل IBAN على زوج أسطر خاصّ به:
     إيصالان يطبعان IBANيهما عند الإحداثيين نفسهما لا يحدث في مستند
     حقيقي، ووضعهما هكذا كان يجعل العيّنة تختبر حالةً مستحيلة. */
  for (const [k, ib] of (o.ibans || []).entries()) {
    ops.push(textOp(60, IBAN_Y1 - k * 40, ib.slice(0, IBAN_SPLIT_AT)));
    ops.push(textOp(60, IBAN_Y2 - k * 40, ib.slice(IBAN_SPLIT_AT)));
  }
  /* أو متّصلًا في عنصر واحد — بعض البنوك تفعل. */
  if (o.ibanWhole) ops.push(textOp(60, IBAN_Y1, o.ibanWhole));

  if (o.amountText) ops.push(textOp(60, 360, `AMOUNT: ${o.amountText}`));
  if (o.extraAmountText) ops.push(textOp(60, 340, `AMOUNT IN BENEFICIARY CURRENCY: ${o.extraAmountText}`));
  if (o.reference) ops.push(textOp(60, 300, `REFERENCE NO: ${o.reference}`));
  if (o.valueDate) ops.push(textOp(60, 280, `VALUE DATE: ${o.valueDate}`));
  for (const [i, line] of (o.extraLines || []).entries()) ops.push(textOp(60, 240 - i * 18, line));
  ops.push(textOp(60, 60, "SANITIZED FIXTURE - NO REAL PERSON, ACCOUNT OR AMOUNT", 7));
  return ops.join("\n");
}

/* صفحة تكملة: تحمل بقية تفاصيل الإيصال السابق وتخلو من أي IBAN.
   قاعدة التقسيم المعتمدة مؤقّتًا تعدّها تكملةً لا إيصالًا جديدًا. */
function continuationPage(n) {
  return [
    textOp(60, 780, "TRANSACTION DETAILS - CONTINUED", 11),
    textOp(60, 740, `PAGE 2 OF RECEIPT ${n}`),
    textOp(60, 700, "PURPOSE: SALARY TRANSFER"),
    textOp(60, 680, "CHARGES: 0.00 SAR"),
    textOp(60, 60, "SANITIZED FIXTURE", 7),
  ].join("\n");
}

const SENDER = "SANITIZED CONTRACTING CO";
const BANK = "SANITIZED NATIONAL BANK";

/* ─── العيّنات ─── */

/* إيصال سليم واحد: IBAN مقطوع، ومبلغ ينتهي بـ.08 */
const single = () => buildPdf([receipt({
  date: "13-08-2026", sender: SENDER, senderAccount: "010800000000000099",
  beneficiary: "BENEFICIARY ONE", bank: BANK,
  ibans: [iban(1)], amountText: "3,412.08 SAR",
  reference: "TBC2608130000001", valueDate: "13-08-2026",
})]);

/* إيصال بـIBAN متّصل في عنصر واحد — يجب أن يُقرأ أيضًا */
const wholeIban = () => buildPdf([receipt({
  date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY TWO", bank: BANK,
  ibanWhole: iban(2), amountText: "1,000.00 SAR", reference: "TBC2608130000002",
})]);

/* بلا IBAN إطلاقًا — لا مفتاح قاطع */
const noIban = () => buildPdf([receipt({
  date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY THREE", bank: BANK,
  amountText: "500.00 SAR", reference: "TBC2608130000003",
})]);

/* مبلغ غير رقمي — يجب أن يُرجَع null لا NaN */
const badAmount = () => buildPdf([receipt({
  date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY FOUR", bank: BANK,
  ibans: [iban(4)], amountText: "-- SAR", reference: "TBC2608130000004",
})]);

/* مبلغان متناقضان — لا يُخمَّن أيّهما */
const conflictingAmounts = () => buildPdf([receipt({
  date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY FIVE", bank: BANK,
  ibans: [iban(5)], amountText: "700.00 SAR", extraAmountText: "800.00 SAR",
  reference: "TBC2608130000005",
})]);

/* مبلغان متطابقان — صيغة شائعة في الإيصال الحقيقي، ويجب أن تُقبل */
const repeatedAmount = () => buildPdf([receipt({
  date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY SIX", bank: BANK,
  ibans: [iban(6)], amountText: "900.50 SAR", extraAmountText: "900.50 SAR",
  reference: "TBC2608130000006",
})]);

/* IBANان في صفحة واحدة — التبس المستفيد، فلا يُختار أحدهما */
const twoIbans = () => buildPdf([receipt({
  date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY SEVEN", bank: BANK,
  ibans: [iban(7), iban(8)], amountText: "1,100.00 SAR", reference: "TBC2608130000007",
})]);

/* مجمّع: صفحة لكل إيصال */
function bundle(count = 10) {
  const pages = [];
  for (let i = 1; i <= count; i++) {
    pages.push(receipt({
      date: "13-08-2026", sender: SENDER, senderAccount: "010800000000000099",
      beneficiary: `BENEFICIARY ${String(i).padStart(2, "0")}`, bank: BANK,
      ibans: [iban(i)], amountText: `${(1000 + i * 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} SAR`,
      reference: `TBC260813000${String(i).padStart(4, "0")}`, valueDate: "13-08-2026",
    }));
  }
  return buildPdf(pages);
}

/* مجمّع فيه إيصال يمتدّ صفحتين: الصفحة الثانية بلا IBAN */
function bundleWithSpan() {
  return buildPdf([
    receipt({ date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY AA", bank: BANK,
      ibans: [iban(21)], amountText: "2,000.00 SAR", reference: "TBC2608130000021" }),
    continuationPage(21),
    receipt({ date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY BB", bank: BANK,
      ibans: [iban(22)], amountText: "3,000.00 SAR", reference: "TBC2608130000022" }),
  ]);
}

/* أول صفحة بلا IBAN — لا إيصال بدأ بعد، فهي ليست تكملة لشيء */
function bundleLeadingOrphan() {
  return buildPdf([
    continuationPage(0),
    receipt({ date: "13-08-2026", sender: SENDER, beneficiary: "BENEFICIARY CC", bank: BANK,
      ibans: [iban(23)], amountText: "4,000.00 SAR", reference: "TBC2608130000023" }),
  ]);
}

/* ملفّ مشوّه: بايتات ليست PDF إطلاقًا */
const malformed = () => Buffer.from("هذا ليس ملفّ PDF على الإطلاق\n".repeat(20), "utf8");

/* PDF مقطوع: ترويسة سليمة وبقية مبتورة */
const truncated = () => single().slice(0, 200);

const FIXTURES = {
  single, wholeIban, noIban, badAmount, conflictingAmounts, repeatedAmount,
  twoIbans, bundle, bundleWithSpan, bundleLeadingOrphan, malformed, truncated,
};

module.exports = { ...FIXTURES, iban, receipt, continuationPage, SENDER, BANK, IBAN_Y1, IBAN_Y2 };

if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const write = process.argv.includes("--write");
  for (const [name, fn] of Object.entries(FIXTURES)) {
    const buf = fn();
    if (write) {
      const out = path.join(__dirname, `receipt-${name}.pdf`);
      fs.writeFileSync(out, buf);
    }
    console.log(`  ${name.padEnd(22)} ${String(buf.length).padStart(7)} بايت`);
  }
  console.log(write ? "\nكُتبت الملفّات." : "\nأضف --write لكتابة الملفّات (غير مطلوب: الاختبارات تبنيها في الذاكرة).");
}
