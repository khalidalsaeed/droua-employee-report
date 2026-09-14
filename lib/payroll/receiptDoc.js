/* قراءة ملفّ إيصالات وتقسيمه إلى إيصالات — طبقة المستند.
   =========================================================================
   تفصل قراءة الـPDF عن استخراج الحقول (lib/payroll/receiptFields.js):
   الأولى تحتاج pdfjs وملفًّا، والثانية نقيّة تُختبر بنصٍّ في سطرين.

   ── قاعدة التقسيم مؤقّتة وقابلة للاستبدال ──
   ⚠️ لم نرَ مجمّع إيصالات حقيقيًا بعد. القاعدة المُطبَّقة الآن:

       صفحة تحمل IBAN جديدًا  =  بداية إيصال
       صفحة بلا IBAN بعد إيصال بدأ  =  تكملته
       صفحة بلا IBAN ولم يبدأ إيصال  =  صفحة يتيمة، تُبلَّغ ولا تُدرَج

   وهي افتراض معقول لا حقيقة مُثبَتة. فهي مُمرَّرة اعتماديةً
   (splitRule) لا مدسوسة في المنطق: استبدالها بعد رؤية المجمّع الحقيقي
   لا يمسّ قراءة الملفّ ولا استخراج الحقول ولا حساب الهوية.

   Risk مفتوحة حتى يُتحقّق منها على مستند فعلي. */

const { normalizePageText, receiptHash, extractFields, ibanScanItems, ibanScan,
        splitSections, accountIn } = require("./receiptFields");

/* ─── قراءة الـPDF ─── */

/* لا يرمي على ملفّ غير مفهوم: يُرجع ok:false وسببًا، فالمُنادي يقرّر —
   نفس عقد lib/payroll/sheetRoster.js. وانهيارٌ هنا كان سيُسقط تحليل
   دفعة كاملة بسبب ملفّ واحد مشوّه. */
async function readPages(buffer, deps = {}) {
  if (!buffer || !buffer.length) return { ok: false, reason: "empty_file" };
  /* ترويسة PDF قبل أي عمل: ملفّ ليس PDF إطلاقًا يُرفض برسالة مفهومة
     بدل أن يُترك لرسالة داخلية من pdfjs. */
  if (buffer.slice(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, reason: "not_a_pdf" };
  }
  let pdfjs;
  try {
    // pdfjs ESM فقط والمشروع CommonJS — نفس الاستيراد الديناميكي في sheetRoster
    pdfjs = deps.pdfjs || (await import("pdfjs-dist/legacy/build/pdf.mjs"));
  } catch (err) {
    return { ok: false, reason: "reader_unavailable", error: (err && err.message) || String(err) };
  }
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      const items = content.items.map((it) => ({
        x: it.transform[4], y: it.transform[5], str: it.str,
      }));
      pages.push({ pageNo: p, items, text: normalizePageText(items) });
    }
    if (!pages.length) return { ok: false, reason: "no_pages" };
    return { ok: true, pages };
  } catch (err) {
    return { ok: false, reason: "unreadable_pdf", error: (err && err.message) || String(err) };
  }
}

/* ─── التقسيم ─── */

/* معرّف المستفيد في صفحة: IBAN إن وُجد، وإلّا رقم حساب في نطاق «إلى».
   =========================================================================
   IBAN أولًا لأنه أقوى: يحمل رمز البلد ومنزلتي تحقّق. والحساب بديلٌ
   مشروع أثبته المستند الحقيقي — ثمانية من عشرة إيصالات تحويلٍ داخل
   البنك نفسه لا تطبع IBAN إطلاقًا. ولا يُقرأ الحساب إلّا من نطاق
   «إلى»، فحساب المُرسِل لا يصير حدًّا لإيصال. */
function beneficiaryIdOf(page) {
  const scan = page.items ? ibanScanItems(page.items) : ibanScan(page.text || "");
  if (!scan.suspicious && scan.ibans.length === 1) {
    return { id: scan.ibans[0], type: "iban" };
  }
  const account = accountIn(splitSections(String(page.text || "").split("\n")).beneficiary);
  if (account) return { id: account, type: "account" };
  return null;
}

/* التقسيم بحدّ معرّف المستفيد — القاعدة المعتمدة بعد المجمّع الحقيقي.
   =========================================================================
   القاعدة السابقة (IBAN يبدأ إيصالًا) فشلت على أول مجمّع حقيقي: أنتجت
   إيصالين من عشرة، وابتلع أحدهما ستّ صفحات، وخرجت صفحتان يتيمتين —
   لأن ثمانية من العشرة بلا IBAN.

   والحدّ هنا **وجود معرّف مستفيد** لا تغيّره:

     صفحة تحمل معرّفًا (IBAN أو حساب في نطاق «إلى») = بداية إيصال
     صفحة بلا معرّف بعد إيصال بدأ                    = تكملته
     صفحة بلا معرّف ولم يبدأ إيصال                    = يتيمة، تُبلَّغ

   ولماذا «الوجود» لا «التغيّر»: موظف قد يتلقّى تحويلين في الشهر نفسه
   (split payment — حالة مشروعة معتمدة في المخطّط)، وإيصالاهما متتاليان
   يحملان المعرّف نفسه. فقاعدة «التغيّر» تدمجهما في إيصال واحد وتُخفي
   أحدهما — وذاك أسوأ من false split لأنه يُنقص مبلغًا بصمت.

   وصفحة التكملة تُعرَف بأنها **لا تحمل معرّفًا** أصلًا، فلا تلتبس
   بإيصال ثانٍ.

   ⚠️ حدٌّ مُعلَن: لم نرَ إيصالًا حقيقيًا يمتدّ صفحتين. فلو كرّر مستندٌ
   المعرّف في صفحة التكملة، قسمَ هذا الحدُّ الإيصال إلى اثنين. ولذلك
   يُوسَم كل إيصال يحمل معرّف سابقه بـsameIdentifierAsPrevious، فيراه
   الإنسان ولا يُخمَّن له معنى. */
function splitByBeneficiaryIdentifier(pages) {
  const ranges = [];
  const orphanPages = [];
  let current = null;
  let previousId = null;
  for (const page of pages) {
    const found = beneficiaryIdOf(page);
    if (found) {
      current = {
        pageFrom: page.pageNo, pageTo: page.pageNo,
        identifier: found.id, identifierType: found.type,
        startReason: found.type === "iban" ? "beneficiary_iban" : "beneficiary_account",
        sameIdentifierAsPrevious: previousId !== null && previousId === found.id,
      };
      ranges.push(current);
      previousId = found.id;
    } else if (current) {
      current.pageTo = page.pageNo;
    } else {
      orphanPages.push(page.pageNo);
    }
  }
  if (!ranges.length && pages.length) {
    return {
      ranges: [{
        pageFrom: pages[0].pageNo, pageTo: pages[pages.length - 1].pageNo,
        identifier: null, identifierType: null,
        startReason: "no_identifier_whole_document", sameIdentifierAsPrevious: false,
      }],
      orphanPages: [], rule: "no_identifier_whole_document",
    };
  }
  return { ranges, orphanPages, rule: "beneficiary_identifier_boundary" };
}

/* القاعدة المؤقّتة. تُرجع { ranges, orphanPages } ولا تُسقط صفحة صامتةً:
   كل صفحة إمّا في مدى أو في orphanPages، ومجموعهما يساوي عدد الصفحات —
   وهو ما يُثبته اختبار «Σ المديات = source_pages». */
function splitByNewIban(pages) {
  const ranges = [];
  const orphanPages = [];
  let current = null;
  for (const page of pages) {
    /* الكشف على العناصر حين تتوفّر: القطع الحقيقي يفرّق جزأي الـIBAN
       بأسطر أخرى، فمسح النصّ لا يجده. وبلا عناصر يُمسح النصّ — فتبقى
       القاعدة قابلة للاختبار بصفحاتٍ نصّية مجرّدة. */
    const scan = page.items ? ibanScanItems(page.items) : ibanScan(page.text || "");
    const hasIban = scan.ibans.length > 0;
    if (hasIban) {
      current = { pageFrom: page.pageNo, pageTo: page.pageNo };
      ranges.push(current);
    } else if (current) {
      current.pageTo = page.pageNo; // تكملة الإيصال الجاري
    } else {
      /* صفحة بلا IBAN ولم يبدأ إيصال — ترويسة دفعة أو غلاف أو صفحة
         مصوّرة. تُبلَّغ صريحةً ولا تُدرَج إيصالًا وهميًا. */
      orphanPages.push(page.pageNo);
    }
  }
  /* ⚠️ مستندٌ لا IBAN فيه إطلاقًا كان يُنتج صفر إيصالات، فيضيع الملفّ
     كليًا ولا يظهر للمراجعة — وهو نقيض المبدأ المعتمد: لا يُسقط إيصالًا
     بصمت. فيُعدّ المستند كلّه إيصالًا واحدًا بلا مفتاح قاطع، وطبقة
     الربط تُصنّفه unreadable فيراه الإنسان ويربطه يدويًا.

     أمّا صفحةٌ يتيمة قبل إيصالٍ بدأ — ترويسة دفعة أو غلاف — فتُبلَّغ في
     orphanPages ولا تصير إيصالًا وهميًا. */
  if (!ranges.length && pages.length) {
    return {
      ranges: [{ pageFrom: pages[0].pageNo, pageTo: pages[pages.length - 1].pageNo }],
      orphanPages: [], rule: "no_iban_whole_document",
    };
  }
  return { ranges, orphanPages, rule: "new_iban_starts_receipt" };
}

/* ─── التحليل الكامل ─── */

/* يُرجَع { ok, sourcePages, receipts, orphanPages, rule, reason }.
   كل إيصال: { pageFrom, pageTo, text, receiptHash, fields }.

   لا يقرّر link_status ولا dup_state: الأول يحتاج سجلّ الموظفين
   والثاني يحتاج بقية صفوف المسير — وكلاهما من شأن طبقة الربط. هذه
   الطبقة تصف ما في المستند وتتوقّف. */
async function parseReceiptDocument(buffer, deps = {}) {
  const read = await readPages(buffer, deps);
  if (!read.ok) return read;

  const splitRule = deps.splitRule || splitByBeneficiaryIdentifier;
  const { ranges, orphanPages, rule } = splitRule(read.pages);

  const byNo = new Map(read.pages.map((p) => [p.pageNo, p]));
  const receipts = ranges.map((r) => {
    /* نصّ الإيصال هو نصّ صفحاته كلّها موصولًا — فإيصال يمتدّ صفحتين
       تُقرأ حقوله من الصفحتين، وهويته تُحسَب عليهما معًا. */
    const parts = [];
    for (let p = r.pageFrom; p <= r.pageTo; p++) {
      const page = byNo.get(p);
      if (page) parts.push(page.text);
    }
    const text = parts.join("\n");
    /* العناصر تُجمع من صفحات الإيصال كلها: إيصالٌ يمتدّ صفحتين قد يقع
       جزء IBANه في إحداهما. */
    const items = [];
    for (let p = r.pageFrom; p <= r.pageTo; p++) {
      const page = byNo.get(p);
      if (page) items.push(...(page.items || []));
    }
    return {
      pageFrom: r.pageFrom, pageTo: r.pageTo,
      /* سبب الحدّ ونوع المعرّف يُنقلان كما قرّرتهما القاعدة — فالتقرير
         يقول لماذا بدأ كل إيصال، ولا يُعاد استنتاجه. */
      startReason: r.startReason || null,
      identifierType: r.identifierType || null,
      sameIdentifierAsPrevious: !!r.sameIdentifierAsPrevious,
      text,
      receiptHash: receiptHash(text),
      fields: extractFields(text, { ibanScan: ibanScanItems(items) }),
    };
  });

  return {
    ok: true,
    sourcePages: read.pages.length,
    receipts, orphanPages, rule,
  };
}

module.exports = {
  readPages, parseReceiptDocument,
  splitByBeneficiaryIdentifier, beneficiaryIdOf,
  /* القاعدة السابقة تبقى مُصدَّرة: فشلها على المجمّع الحقيقي موثَّق
     باختبار، وحذفها يُفقد ذلك التوثيق. */
  splitByNewIban,
};
