/* استخراج حقول إيصال التحويل من نصّه — نقيّ، بلا PDF ولا شبكة ولا قاعدة.
   =========================================================================
   مفصول عن قراءة الـPDF عن قصد: هذا هو المنطق الذي يستحقّ الاختبار
   فعلًا، ويجب أن يُختبر بنصٍّ مجرّد لا بملفّ — فتُكتب حالة الحدّ في
   سطرين لا في مستند.

   ── القاعدة المعتمدة: الأنماط أساس والوسوم تعزيز ──
   الحقول التي يقوم عليها الربط كلّها غير عربية: IBAN بنمط ثابت
   (SA + 22 رقمًا)، والمبلغ برقمٍ ورمز عملة، والمرجع بحروف كبيرة
   وأرقام. فتُستخرج بالأنماط وحدها، ولا تتعطّل باختلاف وسوم البنوك ولا
   بإعادة تشكيل النصّ العربي.

   والوسوم — عربيةً أو لاتينية — تُسمّي ما لا يميّزه نمط: أيّ اسم
   للمستفيد وأيّه للبنك وأيّه للمرسل. وهي تعزيزٌ لا أساس: غيابها يُنقص
   العرض ولا يمنع الربط.

   ── لا تخمين ──
   ما التبس يُرجَع null ومعه سبب في issues، ولا يُختار أحد المرشّحين:
   IBANان في صفحة واحدة يعنيان أن المستفيد غير محدّد، ومبلغان مختلفان
   يعنيان أن المبلغ غير معروف. اختيار الأول اعتمادًا على ترتيب الظهور
   تخمينٌ مبنيّ على تخطيط المستند لا على معناه.

   ── المال ──
   مبلغ غير قابل للتحويل يُرجَع null لا NaN. وقد كلّفنا NaN عطلًا في
   المرحلة الأولى: يهرب من كل مقارنة لأن كل مقارنة معه false، فيُخزَّن
   NULL صامتًا على صفٍّ زُومن فعلًا. */

const crypto = require("node:crypto");

/* ─── التطبيع ─── */

/* يبني نصّ الصفحة من عناصر pdfjs بترتيب القراءة: الأعلى أولًا، ثم من
   اليسار إلى اليمين داخل السطر. الصفّ يُعرَّف بالإحداثي الرأسي مقرَّبًا
   — نفس ما يفعله lib/payroll/sheetRoster.js على كشف الرواتب.

   والترتيب حتمي: هو ما يجعل receiptHash مستقرًّا عبر التشغيلات، فلا
   يُوسم إيصالٌ مرشّحًا للتكرار لمجرّد أن القارئ رتّب عناصره مرّتين
   بترتيبين. */
function normalizePageText(items) {
  const byLine = new Map();
  for (const it of items || []) {
    /* typeof قبل isFinite: Number(null) صفرٌ منتهٍ، فعنصرٌ بإحداثي
       مفقود كان يصير سطرًا عند y=0 ويُدخل نصًّا لم يُطبع في الهوية. */
    if (typeof it.y !== "number" || !Number.isFinite(it.y)) continue;
    const y = Math.round(it.y);
    if (!byLine.has(y)) byLine.set(y, []);
    byLine.get(y).push({ x: Number(it.x) || 0, s: String(it.str == null ? "" : it.str) });
  }
  const lines = [...byLine.entries()]
    .sort((a, b) => b[0] - a[0])
    /* NFKC يُرجع صور العرض العربية إلى حروفها الأساسية: المستند يُخرج
       «ﻣﻦ» (U+FEE3 U+FEE6) لا «من»، فوسمٌ مكتوب بالحروف العادية لا
       يطابق شيئًا. وهذا وحده كان يُفقد المستفيد والبنك والمرسل في
       عشرة إيصالات من عشرة. ويُوحّد أيضًا الأرقام العربية-الهندية
       باللاتينية، فتُقرأ المبالغ أيًّا كانت صيغة طباعتها. */
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.s).join(" ")
      .normalize("NFKC").replace(/\s+/g, " ").trim())
    .filter((l) => l !== "");
  return lines.join("\n");
}

/* هوية الإيصال: تُحسَب من النصّ المطبّع لا من بايتات الملفّ المقتطَع.
   مكتبة الاقتطاع قد تُنتج بايتات مختلفة قليلًا لنفس الإدخال (ترتيب
   كائنات، طوابع)، فالـhash عليها غير مستقرّ. والنصّ مستقرّ، ويتوفّر
   قبل الاقتطاع فيُكشَف التكرار قبل أن يُنفَق عمل عليه. */
function receiptHash(normalizedText) {
  return crypto.createHash("sha256").update(String(normalizedText), "utf8").digest("hex");
}

/* ─── الأنماط: الأساس ─── */

/* IBAN سعودي: SA ثم منزلتا تحقّق ثم 20 رقمًا = 24 محرفًا.
   يُبحث في نصٍّ مُجرَّد من كل فراغ، لأن المستند الحقيقي يقطعه على
   عنصرين في سطرين — قِيس عند y=422 و y=407. محلّل يعمل سطرًا سطرًا
   لا يجده إطلاقًا، فيصير كل إيصال unreadable. */
const IBAN_RE = /SA\d{22}/g;
/* نسخة بلا علم g للفحص بـ.test — الregex العالمي يحفظ lastIndex بين
   النداءات، فـ.test عليه يُرجع نتائج متبدّلة لنفس المدخل. أوقعني هذا
   في ibanScanItems: IBAN متّصل في عنصر واحد كان يُقرأ مرّةً ويُهمَل
   مرّةً بحسب موضع lastIndex. */
const IBAN_ANY = /SA\d{22}/;
const IBAN_EXACT = /^SA\d{22}$/;
const stripSpace = (s) => String(s).replace(/\s+/g, "");

/* ⚠️ لا يُجرَّد النصّ كلّه من الفراغ ثم يُبحَث فيه: ذلك يلصق أجزاءً
   ليست متجاورة **فيخترع IBAN لم يُطبع**. أمسكه اختبار صفحةٍ فيها
   إيصالان: لصقُ الكلّ أنتج «SA98…0007» — بادئة أحدهما وذيل الآخر،
   وهو حساب لا وجود له وقد يقابل موظفًا بالخطأ.

   فالبحث محصور في سطرٍ واحد أو سطرين متجاورين — وهو بالضبط ما يحاكي
   الظاهرة الفعلية: IBAN مقطوع على عنصرين في سطرين متتاليين (قِيس عند
   y=422 و y=407). ثلاثة أسطر أو أكثر ليست ظاهرةً رأيناها، فلا تُفترض. */
/* بادئة IBAN: SA ثم رقم واحد على الأقل. تُعدّ كي يُقارَن عددها بعدد
   الـIBANات المكتملة — انظر ibanScan. */
const IBAN_PREFIX_RE = /SA\d/g;

/* يمسح النصّ ويُرجع { ibans, prefixes, suspicious }.
   =========================================================================
   حصر اللصق في سطرين وحده **لا يكفي**، وهذا مقيس: صفحةٌ بعمودين تطبع
   بادئتي إيصالين في سطر وذيليهما في السطر التالي، فلصق السطرين يُنتج
   «SA98…0007» — بادئة أحدهما وذيل الآخر. حسابٌ لم يُطبع في المستند
   وقد يقابل موظفًا حقيقيًا بالخطأ. وذاك أخطر ما يمكن أن يفعله محلّل.

   فالحاجز على النتيجة لا على الطريقة: عدد بادئات SA يجب أن يساوي عدد
   الـIBANات المكتملة. بادئةٌ لم تُكمَل تعني تخطيطًا غير متوقّع —
   عمودين، أو قطعًا على ثلاثة أسطر، أو نصًّا ناقصًا — وحينها لا يُوثَق
   بأي تطابق: يُرفع suspicious ويُترك القرار لطبقة الربط، التي ستُصنّف
   الإيصال unreadable فيراه إنسان.

   والثمن معلوم ومقبول: IBAN مقطوع على ثلاثة أسطر يُرفض بدل أن يُخمَّن. */
function ibanScan(text) {
  const raw = String(text == null ? "" : text);
  const lines = raw.split("\n");
  const seen = new Set();
  const collect = (chunk) => {
    for (const m of stripSpace(chunk).matchAll(IBAN_RE)) seen.add(m[0]);
  };
  for (let i = 0; i < lines.length; i++) {
    collect(lines[i]);
    if (i + 1 < lines.length) collect(lines[i] + lines[i + 1]);
  }
  const ibans = [...seen];
  /* البادئات **المتبقّية** بعد إزالة كل IBAN اكتمل — لا مجرّد عددها:
     الإيصال يطبع IBANه مرّتين أحيانًا، وعدّ البادئات وحده كان يعدّ ذلك
     التباسًا وهو صيغة مشروعة. أمّا بادئةٌ تبقى بعد الإزالة فتعني حسابًا
     مطبوعًا لم نُكمل قراءته. */
  let residue = stripSpace(raw);
  for (const ib of ibans) residue = residue.split(ib).join("");
  const leftover = (residue.match(IBAN_PREFIX_RE) || []).length;
  return { ibans, leftover, suspicious: leftover > 0 };
}

/* ─── تجميع IBAN من العناصر بإحداثياتها ───
   =========================================================================
   قاعدة «سطران متجاوران» تعمل على العيّنات وتفشل على المستند الحقيقي.
   قيسَ إيصال راتب فعلي: الجزء الأول عند (x=217, y=422) بطول 16، والثاني
   عند (x=291, y=407) بطول 8 — وبينهما في ترتيب الأسطر سطرا اسم المستفيد
   واسم البنك. فالجزآن ليسا متجاورين نصًّا ولا في العمود نفسه: الثاني
   أُزيح يمينًا أربعًا وسبعين نقطة.

   والقاعدة الصحيحة هي الجوار **الرأسي القريب** مع **إكمال الطول إلى
   أربعة وعشرين بالضبط**:

     · عنصر يبدأ بـSA وأرقام، وطوله أقصر من IBAN كامل  = بادئة
     · العنصر الرقمي المحض الذي يقع تحته بفارق رأسي صغير، ويُكمل الطول
       إلى 24 بالضبط                                    = ذيله

   وإكمال الطول هو الحاجز الأقوى: عنصرٌ بطول آخر لا يُكمل، فلا يُلصَق.
   وإن وُجد أكثر من مرشّح يُكمل الطول ⇒ التباس، ولا يُخمَّن أيّهما —
   لأن ذلك بالضبط ما يُنتج حسابًا لم يُطبع. */

const IBAN_LEN = 24;
/* أقصى فارق رأسي بين البادئة وذيلها: سطر أو سطران. أكبر من ذلك ليس
   تتمّةً بل عنصرٌ آخر في المستند. */
const IBAN_MAX_DY = 32;

function ibanScanItems(items) {
  const list = (items || []).filter(
    (it) => typeof it.x === "number" && typeof it.y === "number" && Number.isFinite(it.x) && Number.isFinite(it.y)
  ).map((it) => ({ x: it.x, y: it.y, s: String(it.str == null ? "" : it.str).replace(/\s+/g, "") }));

  const whole = new Set();
  const prefixes = [];
  const digitRuns = [];
  for (const it of list) {
    if (IBAN_ANY.test(it.s)) { for (const m of it.s.matchAll(IBAN_RE)) whole.add(m[0]); continue; }
    if (/^SA\d+$/.test(it.s) && it.s.length < IBAN_LEN) prefixes.push(it);
    else if (/^\d+$/.test(it.s)) digitRuns.push(it);
  }

  const joined = new Set();
  let ambiguous = false;
  const unresolved = [];
  for (const pre of prefixes) {
    const need = IBAN_LEN - pre.s.length;
    /* تحته وبفارق رأسي صغير، ويُكمل الطول بالضبط. */
    const fits = digitRuns.filter((d) => d.y < pre.y && pre.y - d.y <= IBAN_MAX_DY && d.s.length === need);
    if (fits.length === 1) {
      const candidate = pre.s + fits[0].s;
      if (IBAN_EXACT.test(candidate)) joined.add(candidate);
      else unresolved.push(pre);
    } else if (fits.length > 1) {
      /* مرشّحان يُكملان الطول: أيّهما الذيل؟ لا يُخمَّن. */
      ambiguous = true;
      unresolved.push(pre);
    } else {
      unresolved.push(pre);
    }
  }

  const ibans = [...new Set([...whole, ...joined])];
  return {
    ibans,
    leftover: unresolved.length,
    suspicious: ambiguous || unresolved.length > 0,
    fromItems: true,
  };
}

function findIbans(text) {
  const scan = ibanScan(text);
  /* بادئةٌ لم تُكمَل ⇒ لا يُوثَق بشيء ممّا خرج. */
  return scan.suspicious ? [] : scan.ibans;
}

/* المبلغ: رقمٌ بمنزلتين ورمز عملة — **قبله أو بعده**.
   الترتيب يختلف باختلاف نوع التحويل في البنك نفسه: قيسَ فوُجد
   «#,###.## SAR» في التحويل المحلي و«SAR #,###.##» في التحويل البنكي،
   لأن الصفّ RTL فاختلاف ترتيب الأعمدة يعكس الاثنين. واشتراط جهة واحدة
   كان يُفقد المبلغ في ثمانية إيصالات من عشرة. */
const CURRENCY = "(?:SAR|SR|ر\\.?\\s*س)";
const AMOUNT_RE = new RegExp(`(?:(-?[\\d,]+\\.\\d{2})\\s*${CURRENCY}|${CURRENCY}\\s*(-?[\\d,]+\\.\\d{2}))`, "gi");

/* الإيصال يحمل مبالغ أخرى غير مبلغ التحويل: رسوم وعمولة وضريبة. ونمط
   «كل رقم بـSAR» يجمعها كلها فيُنتج تعارضًا كاذبًا — أمسكه إيصالٌ يمتدّ
   صفحتين وصفحته الثانية تحمل «CHARGES: 0.00 SAR».

   فالوسم يفصل بين الفئتين. وهذا استعمالٌ للوسم مرجّحًا لا أساسًا: النمط
   يجد المبالغ، والوسم يقول أيّها مبلغ التحويل. وبلا وسمٍ إطلاقًا تبقى
   القاعدة كما هي — تعارضٌ يُعلَن ولا يُخمَّن. */
const TRANSFER_LABELS = /(?:AMOUNT|DEBIT|مبلغ\s*الخصم|المبلغ|مبلغ\s*التحويل)/i;
const FEE_LABELS = /(?:CHARGE|CHARGES|FEE|FEES|COMMISSION|VAT|TAX|رسوم|رسم|عمولة|ضريبة|ضرائب)/i;
/* والوسم بلا رقم صالح: يُميّز «لا مبلغ مطبوع» من «مبلغ مطبوع غير مقروء». */
const AMOUNT_LABEL_RE = /(?:AMOUNT|مبلغ|المبلغ)[^\n]*/gi;

/* اشتراط شكل الرقم لا مجرّد قابليةٍ للتحويل: Number("") و Number(null)
   كلاهما صفرٌ منتهٍ، فمبلغٌ مفقود كان يُقرأ 0.00 — وذاك أسوأ من null:
   يبدو مبلغًا صحيحًا ويُقارَن كأنه صفر فعلي. نفس الفخّ أوقعنا في
   المرحلة الأولى على sheet_amount. */
const toHalalas = (s) => {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const t = String(s).replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/* المرجع البنكي: بادئة حروف كبيرة ثم أرقام. */
const REFERENCE_RE = /\b[A-Z]{2,6}\d{6,}\b/g;
/* نسخٌ بلا g للفحص بـ.test — الregex العالمي يحفظ lastIndex. */
const REFERENCE_ANY = /\b[A-Z]{2,6}\d{6,}\b/;
/* التاريخ كما طُبع — لا تُفترض صيغة ولا يُعاد تشكيلها. */
const DATE_RE = /\b(?:\d{2}[-/]\d{2}[-/]\d{4}|\d{4}-\d{2}-\d{2})\b/g;
const DATE_ANY = /\b(?:\d{2}[-/]\d{2}[-/]\d{4}|\d{4}-\d{2}-\d{2})\b/;
/* رقم حساب طويل: 10 إلى 20 رقمًا متّصلة، وليس جزءًا من رقم أطول. */
const ACCOUNT_RE = /(?<!\d)\d{10,20}(?!\d)/g;

/* ─── الوسوم: تعزيز ─── */

/* لكل حقل وسومه بالعربية واللاتينية معًا. البنوك السعودية تطبع الاثنين
   كثيرًا، والمحلّل يقبل أيّهما وُجد — فلا يتعطّل باختلاف بنك. */
const LABELS = {
  beneficiary: ["اسم المستفيد", "المستفيد", "BENEFICIARY NAME", "TO"],
  bank:        ["اسم البنك", "البنك", "BENEFICIARY BANK", "BANK"],
  sender:      ["اسم المرسل", "المرسل", "من", "SENDER", "FROM"],
  reference:   ["الرقم المرجعي", "المرجع", "REFERENCE NO", "REFERENCE", "REF"],
  valueDate:   ["تاريخ القيمة", "VALUE DATE"],
  date:        ["التاريخ", "DATE"],
  account:     ["حساب المستفيد", "رقم حساب المستفيد", "BENEFICIARY ACCOUNT"],
};

/* يقرأ ما يلي وسمًا في سطره. وإن خلا ما بعده في السطر — وهو شائع في
   المستند العربي حيث يفترق الوسم عن قيمته — يُقرأ السطر التالي. */
/* الوسم يُعرَف بموضعه لا بمجرّد وجود حروفه: إمّا في بداية السطر،
   وإمّا متبوعًا بفاصل (: أو -). بلا هذا القيد كان «SENDER» يُطابَق
   داخل القيمة «FROM: SENDER CO» فتُقرأ «CO» اسمًا للمرسل.

   والوسوم مرتّبة من الأطول إلى الأقصر كي لا يسبق «TO» وسمًا يحويه. */
/* سطرُ عناوين الأعمدة كان يُقرأ قيمةً: «الرقم المرجعي · تاريخ القيمة ·
   مبلغ الخصم» يُرجع «تاريخ القيمة مبلغ الخصم» مرجعًا — نصًّا واحدًا
   لكل الإيصالات، فخرجت المراجع العشرة متطابقة وبدت العملية ناجحة.

   والعلاج ليس هنا بل في ترتيب الأولوية: النمط أساس والوسم تعزيز. جرّبتُ
   إضافة تحقّق من شكل القيمة داخل هذه الدالّة فلم يُغيّر سلوكًا في أي
   حالة استطعتُ بناءها — المسارات النمطية تسبقه دائمًا — فأُزيل. شيفرةٌ
   لا يقيسها اختبار لا تُحفظ. */
function valueAfterLabel(lines, labels) {
  const ok = (v) => !!v;
  const ordered = [...labels].sort((a, b) => b.length - a.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const upper = line.toUpperCase();
    for (const label of ordered) {
      const L = label.toUpperCase();
      let at = -1;
      let from = 0;
      /* أول موضع يصلح وسمًا: بدايةُ سطر أو متبوعٌ بفاصل. */
      for (;;) {
        const idx = upper.indexOf(L, from);
        if (idx < 0) break;
        const after = line.slice(idx + label.length);
        if (idx === 0 || /^[\s]*[:：\-—]/.test(after)) { at = idx; break; }
        from = idx + 1;
      }
      if (at < 0) continue;
      const rest = line.slice(at + label.length).replace(/^[\s:：\-—]+/, "").trim();
      if (ok(rest)) return rest;
      const next = (lines[i + 1] || "").trim();
      if (ok(next)) return next;
    }
  }
  return null;
}

/* اسمٌ لاتيني: أحرف كبيرة ومسافات ونقاط، ثلاثة محارف على الأقل، وليس
   IBAN ولا رقمًا. يُستعمل لتنقية ما بعد الوسم لا لتخمين اسم بلا وسم. */
const looksLikeName = (s) =>
  typeof s === "string" && s.length >= 3 && /^[A-Z][A-Z .'&-]{2,}$/.test(s.trim()) && !/^SA\d/.test(s.trim());

/* ─── نطاقات المستند: من · إلى · التفاصيل ───
   =========================================================================
   الإيصال يطبع رقم حساب تحت «من» (المُرسِل) وآخر تحت «إلى» (المستفيد).
   وقيسَ فوُجد الأول ست عشرة خانة والثاني خمس عشرة — فرقٌ لا يصلح قاعدة،
   إذ قد يتساويان في إيصال آخر. فالتمييز **بالموضع لا بالطول**: كل رقم
   يُنسب إلى النطاق الذي ورد فيه.

   وهذا ما يجعل قاعدة «لا يُنسَب حساب المُرسِل إلى المستفيد» بنيويةً لا
   انضباطية: لا يوجد مسارٌ يقرأ رقمًا من نطاق «من» ويضعه في account.

   والوسوم بصور العرض في المستند («ﻣﻦ» لا «من»)، وقد طُبّعت بـNFKC في
   normalizePageText قبل الوصول إلى هنا. */

const SECTION_MARKS = [
  ["sender", /^(?:من|FROM)$/i],
  ["beneficiary", /^(?:إلى|الى|TO)$/i],
  ["details", /^(?:التفاصيل|DETAILS)$/i],
];

/* يُرجع { head, sender, beneficiary, details } — مصفوفة أسطر لكل نطاق.
   سطرٌ يحمل وسمًا قسميًا **وحده** يبدأ نطاقًا؛ وسطرٌ يحوي الكلمة ضمن
   نصٍّ أطول ليس وسمًا. وبلا وسوم إطلاقًا يبقى كل شيء في head، فيعمل
   المحلّل كما كان — مستندٌ بلا أقسام لا يُكسر. */
function splitSections(lines) {
  const out = { head: [], sender: [], beneficiary: [], details: [] };
  let current = "head";
  for (const raw of lines) {
    const line = String(raw).trim();
    const mark = SECTION_MARKS.find(([, re]) => re.test(line));
    if (mark) { current = mark[0]; continue; }
    out[current].push(line);
  }
  return out;
}

/* أطول سلسلة أرقام في نطاق، ضمن مدى أرقام الحسابات. أكثر من واحدة
   يعني التباسًا فلا تُختار. */
const ACCOUNT_IN_RANGE = /(?<!\d)\d{10,20}(?!\d)/g;
function accountIn(lines) {
  const found = new Set();
  for (const l of lines) for (const m of l.matchAll(ACCOUNT_IN_RANGE)) found.add(m[0]);
  const list = [...found];
  return list.length === 1 ? list[0] : null;
}

/* هل هذا «الحساب» في حقيقته قطعةٌ من IBAN استُخرج من المستند نفسه؟
   المقارنة على الاحتواء الحرفي بعد إزالة الفراغ والشرطات — حتمية، بلا
   تقريب ولا اشتقاق مفترض. وتشمل كل IBAN اكتمل في المسح لا الوحيد
   المختار، فمستندٌ بآيبانين لا يفلت منه. */
const bareId = (v) => String(v == null ? "" : v).replace(/[\s-]/g, "").toUpperCase();
function isIbanFragment(account, ibans) {
  const a = bareId(account);
  if (!a) return false;
  return (Array.isArray(ibans) ? ibans : ibans ? [ibans] : []).some((i) => {
    const full = bareId(i);
    return full.length > a.length && full.includes(a);
  });
}

/* القطع النصّية اللاتينية في نطاق، بعد إزالة المعرّفات الرقمية. الأولى
   اسم المستفيد والباقي اسم بنكه — قاعدة موحّدة تعمل على النوعين:
   حيث يُطبع البنك في سطر مستقلّ، وحيث يُطبع بجانب رقم الحساب. */
/* وسوم الحقول المعروفة — عربيةً ولاتينية. سطرٌ يحمل اثنين منها أو أكثر
   هو **سطر عناوين أعمدة** لا قيمة: «FULL NAME · ACCOUNT NO · BANK NAME».
   استبعاده ضروري وإلّا أُخذ اسمًا للمستفيد.

   ونجا المستند الحقيقي من هذا صدفةً لأن عناوينه عربية فلم تمرّ بمرشّح
   اللاتينية — وبنكٌ يُخرج عناوينه بالإنجليزية كان سيكسره. فالقاعدة على
   المعنى لا على اللغة. */
const FIELD_LABELS = [
  "FULL NAME", "ACCOUNT NO", "ACCOUNT NUMBER", "BANK NAME", "SHORT NAME",
  "REFERENCE NO", "VALUE DATE", "DEBIT AMOUNT", "AMOUNT",
  "الاسم الكامل", "رقم الحساب", "اسم البنك", "الاسم المختصر",
  "الرقم المرجعي", "تاريخ القيمة", "مبلغ الخصم",
];

function isHeaderRow(line) {
  const upper = String(line).toUpperCase();
  let hits = 0;
  for (const label of FIELD_LABELS) if (upper.includes(label.toUpperCase())) hits++;
  return hits >= 2;
}

function latinChunks(lines) {
  const chunks = [];
  for (const l of lines) {
    if (isHeaderRow(l)) continue;
    const stripped = l.replace(/SA\d{2,}/g, " ").replace(/\d/g, " ").replace(/\s+/g, " ").trim();
    /* حرفان لاتينيان على الأقلّ — يستبعد الشرطات والفواصل وحدها. */
    if (stripped.length >= 3 && /[A-Za-z]{2}/.test(stripped)) chunks.push(stripped);
  }
  return chunks;
}

/* ─── الاستخراج ─── */

/* يُرجَع { iban, ibans, account, beneficiary, bank, sender, amount,
   amountHalalas, date, reference, issues }.

   issues يصف ما رآه المحلّل ولا يقرّر حالة الإيصال: تحويل ذلك إلى
   link_status قرارٌ يخصّ طبقة الربط، لأنه يحتاج سجلّ الموظفين. */
/* opts.ibanScan — نتيجة ibanScanItems حين تتوفّر العناصر. تُقدَّم على
   مسح النصّ لأنها تعمل على الإحداثيات فتُصيب القطع الحقيقي. وبلا عناصر
   (اختبارٌ نصّي، أو نصٌّ من مصدر آخر) يبقى مسح النصّ عاملًا. */
function extractFields(text, opts = {}) {
  const raw = String(text == null ? "" : text);
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const issues = [];

  /* ① IBAN — المفتاح القاطع. */
  const scan = opts.ibanScan || ibanScan(raw);
  const ibans = scan.suspicious ? [] : scan.ibans;
  let iban = null;
  if (scan.suspicious) {
    /* بادئة IBAN لم تُكمَل: تخطيطٌ لم نتوقّعه. يُفرَّق عن «لا IBAN
       إطلاقًا» لأن الإجراء مختلف — هنا يوجد حساب مطبوع لم نقرأه. */
    issues.push("iban_layout_unexpected");
  } else if (ibans.length === 1) iban = ibans[0];
  else if (ibans.length === 0) issues.push("no_iban");
  else issues.push("multiple_ibans");

  /* ② المبلغ — مصنّفًا بوسم سطره: تحويلٌ أم رسوم أم مجهول. */
  const transfer = new Set();
  const other = new Set();
  let sawAmountToken = false;
  for (const line of lines) {
    for (const m of line.matchAll(AMOUNT_RE)) {
      sawAmountToken = true;
      const h = toHalalas(m[1] || m[2]);
      if (h === null) continue;
      /* الرسوم تُستبعد دائمًا — ولو حمل السطر وسم تحويل أيضًا: رسمٌ
         لا يكون مبلغَ التحويل أبدًا، فسطرٌ يحمل الوسمين ملتبسٌ
         واستبعاده أسلم من احتسابه. وما لا وسم له يبقى مرشّحًا يُستعمل
         حين لا يوجد موسومٌ بالتحويل. */
      if (FEE_LABELS.test(line)) continue;
      (TRANSFER_LABELS.test(line) ? transfer : other).add(h);
    }
  }
  /* الموسوم بالتحويل أولى، فإن غاب فالمجهول. */
  const halalasSeen = transfer.size ? transfer : other;
  let amountHalalas = null;
  if (halalasSeen.size === 1) amountHalalas = [...halalasSeen][0];
  else if (halalasSeen.size > 1) issues.push("amount_conflict");
  else if (sawAmountToken) issues.push("amount_unparseable");
  else {
    /* وسمٌ بلا رقم صالح: مبلغ مطبوع لم يُقرأ — لا «لا مبلغ». */
    const labelled = raw.match(AMOUNT_LABEL_RE);
    issues.push(labelled && labelled.length ? "amount_unparseable" : "no_amount");
  }
  /* المال بمنزلتين مضبوطتين، ومصدر الحقيقة هي الهللات الصحيحة.
     null يبقى null — لا صفرًا ولا NaN. */
  const amount = amountHalalas === null ? null : amountHalalas / 100;

  /* ③ المرجع — بالوسم أوّلًا ثم بالنمط. */
  /* النمط أساس والوسم تعزيز — وهو المبدأ المعتمد، وقد خُولف هنا مرّةً
     فقُدِّم الوسم فخرجت المراجع العشرة متطابقة. والوسم لا يُقبل الآن
     إلّا إذا كان ما بعده يطابق شكل المرجع. */
  const refMatches = [...new Set(raw.replace(/\s+/g, " ").match(REFERENCE_RE) || [])];
  const refByLabel = valueAfterLabel(lines, LABELS.reference);
  const reference =
    refMatches[0] ||
    (refByLabel && (refByLabel.match(REFERENCE_RE) || [])[0]) ||
    null;

  /* ④ التاريخ — تاريخ القيمة أولى بالمعنى من تاريخ الطباعة. */
  const pickDate = (v) => (v && (v.match(DATE_RE) || [])[0]) || null;
  const date =
    pickDate(valueAfterLabel(lines, LABELS.valueDate)) ||
    pickDate(valueAfterLabel(lines, LABELS.date)) ||
    (raw.match(DATE_RE) || [])[0] ||
    null;

  /* ⑤ الأسماء — بالوسم وحده. لا تخمين اسمٍ من سطر لاتيني بلا وسم:
     الإيصال يحمل عدّة أسماء (مستفيد، بنك، مرسل)، ونسبةُ أحدها بلا
     وسمٍ اختيارٌ اعتباطي. */
  const clean = (v) => {
    if (!v) return null;
    const t = String(v).replace(/^[\s:：\-—]+/, "").trim();
    return t && !/^SA\d/.test(t) ? t : null;
  };
  /* النطاقات أولًا — فالوسم القسمي أوثق من وسمٍ داخل سطر. وبلا نطاقات
     يُرجَع إلى الوسوم السطرية، فلا ينكسر مستندٌ بتخطيط آخر. */
  const sections = splitSections(lines);
  const benChunks = latinChunks(sections.beneficiary);
  const sndChunks = latinChunks(sections.sender);

  const beneficiary = benChunks[0] || clean(valueAfterLabel(lines, LABELS.beneficiary));
  const bank = (benChunks.length > 1 ? benChunks.slice(1).join(" ") : null) || clean(valueAfterLabel(lines, LABELS.bank));
  const sender = sndChunks[0] || clean(valueAfterLabel(lines, LABELS.sender));

  /* ⑥ رقم حساب المستفيد — بوسمٍ يقترن به وحده.
     ولا يُستخرج بالنمط: الإيصال يطبع رقم حساب المُرسِل غالبًا، وأرقامًا
     أخرى (مراجع، تواريخ بلا فواصل). فنسبةُ رقمٍ طويل إلى المستفيد بلا
     وسم قد تربط الإيصال بحساب الشركة لا بحساب الموظف. */
  /* من نطاق المستفيد وحده. والتحويل داخل البنك نفسه يطبع رقم حساب بدل
     IBAN — أثبته المستند الحقيقي — فصار الحساب معرّفًا مشروعًا للمستفيد
     حين يرد في نطاقه، لا حين يرد في أي موضع. */
  const accountByLabel = valueAfterLabel(lines, LABELS.account);
  const accountRaw =
    accountIn(sections.beneficiary) ||
    (accountByLabel ? (accountByLabel.match(ACCOUNT_RE) || [])[0] || null : null);
  /* قطعةٌ من IBAN ليست رقم حساب. أثبته التنسيق الحقيقي: البنك يطبع
     الآيبان مقطوعًا على عنصرين، فيلتقط `ACCOUNT_IN_RANGE` القطعة الأولى
     (أربعة عشر رقمًا بعد `SA`) ويُخرجها «رقم حساب» — وهو رقم لم يُطبع
     قطّ بهذه الصفة.

     وهذا عين نمط «الاستخراج الذي يخترع بيانًا»: قيمةٌ تبدو معرّفًا
     صالحًا وتُخزَّن في `ext_account` فتصير بيانًا يُعتمد عليه لاحقًا.
     فالحاجز على النتيجة: ما احتواه IBAN مستخرج من المستند نفسه لا
     يُخزَّن حسابًا. والربط لا يتضرّر — IBAN أقوى ولا نزول منه. */
  const account = isIbanFragment(accountRaw, scan.ibans) ? null : accountRaw;
  if (accountRaw && account === null) issues.push("account_is_iban_fragment");
  /* حساب المُرسِل يُستخرج للتدقيق ولا يُستعمل في الربط إطلاقًا. */
  const senderAccount = accountIn(sections.sender);

  return {
    iban, ibans,
    account, senderAccount,
    beneficiary, bank, sender,
    amount, amountHalalas,
    date, reference,
    issues,
  };
}

/* هل يحمل الإيصال مفتاحًا قاطعًا فريدًا يصلح للربط؟ */
const hasHardKey = (fields) => !!(fields && (fields.iban || fields.account));

module.exports = {
  normalizePageText, receiptHash, extractFields, hasHardKey,
  findIbans, ibanScan, ibanScanItems, toHalalas,
  splitSections, accountIn, isIbanFragment, latinChunks, isHeaderRow, looksLikeName, valueAfterLabel,
  IBAN_RE, IBAN_ANY, IBAN_EXACT, AMOUNT_RE, REFERENCE_RE, DATE_RE, LABELS,
};
