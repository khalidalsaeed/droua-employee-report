/* تحويل ملفّ إيصالات إلى صفوف مُعدّة للتخزين — نقيّ، بلا قاعدة ولا Blob.
   =========================================================================
   يقف بين المحلّل (lib/payroll/receiptDoc.js) وطبقة التخزين: يأخذ
   بايتات ملفّ وصفوف المسير القائمة، ويُرجع ما **سيُدرَج** وما سيُتخطّى
   ولماذا — بلا أن يكتب حرفًا.

   فصلُه عن القاعدة مقصود: منطق «هل هذا الإيصال جديد أم مكرّر» هو ما
   يستحقّ الاختبار، ويجب أن يُختبر بصفوفٍ في الذاكرة لا بـPostgres.

   ── ما يحمله كل صفّ ──
   هوية الإيصال (receiptHash) · مداه في المصدر (pageFrom/pageTo) · هوية
   المصدر (sourceHash) · معرّف المستفيد ونوعه · المبلغ والمرجع والتاريخ
   · وسبب الحدّ الذي بدأ عنده.

   ── التكرار: ثلاث حالات، ولا واحدة منها تُسقط إيصالًا ──
   ① نفس (sourceHash, pageFrom, pageTo) موجود  ⇒ لا يُدرَج، ويُبلَّغ
      «مُحلَّل سابقًا». إعادة تحليل الملفّ نفسه لا تُنتج تكرارًا ولا
      تصمت.
   ② نفس receiptHash في صفٍّ آخر بمصدر مختلف ⇒ **يُدرَج** ويُوسَم
      candidate، والصفّ الأسبق يُوسَم معه. ولا يُحتسب أيٌّ منهما حتى
      يحسم إنسان — لأن احتساب الأسبق وحده تخمينٌ مبنيّ على ترتيب الرفع.
   ③ إيصالان متطابقان داخل الملفّ الواحد ⇒ مداهما مختلف فيُدرجان، ويُوسم
      الثاني candidate كحالة ②. */

const { parseReceiptDocument } = require("./receiptDoc");

/* حالات التكرار — البُعد الثالث، مستقلّ عن حالة الربط. */
const DUP_NONE = "none";
const DUP_CANDIDATE = "candidate";

/* يبني صفًّا من إيصال مُحلَّل. أسماء الحقول هي أسماء أعمدة
   payroll_receipts كما في مخطّط 2.1، فالطبقة التالية تُدرجها كما هي. */
function toRow(receipt, source) {
  const f = receipt.fields || {};
  return {
    sourceHash: source.sourceHash,
    sourceName: source.sourceName || null,
    sourceUrl: source.sourceUrl || null,
    sourcePages: source.sourcePages,

    pageFrom: receipt.pageFrom,
    pageTo: receipt.pageTo,
    receiptHash: receipt.receiptHash,

    /* المعرّف ونوعه كما قرّرهما حدُّ التقسيم — لا يُعاد استنتاجهما. */
    identifierType: receipt.identifierType || null,
    startReason: receipt.startReason || null,
    sameIdentifierAsPrevious: !!receipt.sameIdentifierAsPrevious,

    extIban: f.iban || null,
    extAccount: f.account || null,
    extBeneficiary: f.beneficiary || null,
    extBank: f.bank || null,
    extSender: f.sender || null,
    extAmount: f.amount === undefined ? null : f.amount,
    extDate: f.date || null,
    extReference: f.reference || null,

    issues: f.issues || [],
    dupState: DUP_NONE,
    duplicateOf: null,
  };
}

/* المفتاح الذي يمنع إدراج الإيصال نفسه من المصدر نفسه مرّتين — وهو
   قيد UNIQUE (run_id, source_hash, page_from, page_to) في القاعدة. */
const sourceKey = (r) => `${r.sourceHash}#${r.pageFrom}-${r.pageTo}`;

/* يُحلّل ملفًّا ويُرجع ما سيُدرَج وما سيُتخطّى.
   existing — صفوف payroll_receipts القائمة لهذا المسير، بأقلّ ما يلزم:
   { id, sourceHash, pageFrom, pageTo, receiptHash, dupState }.

   يُرجَع { ok, sourcePages, rule, rows, skipped, orphanPages, markDuplicate }
   حيث markDuplicate هي معرّفات الصفوف القائمة التي يجب أن تُوسَم
   candidate لأن الملفّ الجديد حمل نظيرها. */
async function ingestDocument(buffer, options = {}) {
  const { sourceHash, sourceName, sourceUrl, existing = [], deps = {} } = options;
  if (!sourceHash) return { ok: false, reason: "missing_source_hash" };

  const parsed = await parseReceiptDocument(buffer, deps);
  if (!parsed.ok) return parsed;

  const source = { sourceHash, sourceName, sourceUrl, sourcePages: parsed.sourcePages };

  const existingByKey = new Map();
  const existingByHash = new Map();
  for (const e of existing) {
    existingByKey.set(sourceKey(e), e);
    if (!existingByHash.has(e.receiptHash)) existingByHash.set(e.receiptHash, []);
    existingByHash.get(e.receiptHash).push(e);
  }

  const rows = [];
  const skipped = [];
  const markDuplicate = new Set();
  /* هويات هذا الملفّ نفسه — لكشف الحالة ③. */
  const seenInThisFile = new Map();

  for (const receipt of parsed.receipts) {
    const row = toRow(receipt, source);

    /* ① نفس المدى من نفس المصدر: مُحلَّل سابقًا. */
    if (existingByKey.has(sourceKey(row))) {
      skipped.push({ ...row, skipReason: "already_ingested" });
      continue;
    }

    /* ② نظيرٌ بهوية واحدة في مصدر آخر — أو ③ داخل هذا الملفّ. */
    const priorExternal = existingByHash.get(row.receiptHash) || [];
    const priorInFile = seenInThisFile.get(row.receiptHash);
    if (priorExternal.length || priorInFile) {
      row.dupState = DUP_CANDIDATE;
      /* المرجع إلى الأسبق: صفٌّ مخزَّن إن وُجد، وإلّا الصفّ السابق في
         هذا الملفّ (معرّفه يُعرَف بعد الإدراج، فيُمرَّر بالمدى). */
      row.duplicateOf = priorExternal.length ? priorExternal[0].id : null;
      row.duplicateOfKey = priorInFile ? sourceKey(priorInFile) : null;
      /* والأسبق يُوسَم معه: لا يُحتسب أحدهما اعتباطًا. */
      for (const p of priorExternal) if (p.dupState !== DUP_CANDIDATE) markDuplicate.add(p.id);
      if (priorInFile && priorInFile.dupState !== DUP_CANDIDATE) {
        priorInFile.dupState = DUP_CANDIDATE;
      }
    }

    seenInThisFile.set(row.receiptHash, row);
    rows.push(row);
  }

  return {
    ok: true,
    sourcePages: parsed.sourcePages,
    rule: parsed.rule,
    orphanPages: parsed.orphanPages,
    rows,
    skipped,
    markDuplicate: [...markDuplicate],
  };
}

module.exports = { ingestDocument, toRow, sourceKey, DUP_NONE, DUP_CANDIDATE };
