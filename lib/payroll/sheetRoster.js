/* استخراج قائمة موظفي شهرٍ ما من كشف رواتبه نفسه.
   =========================================================================
   لماذا هذا الملفّ أصلًا: مسير 2026-08 أُنشئ يدويًا قبل ميزة اللقطة، فلا
   صفوف موظفين له. و«قائمة الموظفين الحاليين» ليست جوابًا صحيحًا: من
   التحق في سبتمبر ليس من موظفي أغسطس، ومن غادر بعد أغسطس كان منهم.

   لكن المنصّة تحتفظ بالجواب الصحيح أصلًا: كشف رواتب الشهر المرفوع على
   المسير يسرد بالضبط من صُرف له راتب ذلك الشهر. فهو المصدر الوحيد الذي
   يثبت العضوية وقتها، وهذا الملفّ يقرأه.

   بنية الكشف كما يُخرجها pdfjs: كل صف موظف عناصره مرتّبة بصريًا من
   اليسار (صافي الراتب) إلى اليمين (رقم الموظف)، لأن المستند RTL. فرقم
   الموظف هو آخر عنصر أفقيًا، وصف الإجماليات يخلو منه — وهذا ما يميّز
   الصفّين بلا اعتماد على ترتيب أو عدد صفوف ثابت.

   حاجز السلامة: مجموع صوافي الصفوف المستخرجة يجب أن يطابق صافي صف
   الإجماليات المطبوع في الكشف. تخطّي صفٍّ واحد يكسر المطابقة فورًا، فلا
   يمكن أن يمرّ استخراجٌ ناقص صامتًا ويُنتج مسيرًا ينقصه موظف. */

const isMoney = (s) => /^-?[\d,]+\.\d{2}$/.test(String(s).trim());
const toNumber = (s) => Number(String(s).replace(/,/g, ""));
const isEid = (s) => /^\d{1,6}$/.test(String(s).trim());

/* أقلّ عدد أعمدة نقدية يجعل الصفّ صفَّ بيانات لا سطر عنوان أو حاشية. */
const MIN_MONEY_COLUMNS = 8;
const MIN_TOTALS_COLUMNS = 10;

/* الاسم يُستخرج للاستئناس فقط لا للتخزين: الخطوط المُجزّأة في الكشف
   تُخرج الحروف بصور العرض وبترتيب بصري، فإعادة تشكيلها تفقد فواصل
   الكلمات («شكيبميا ه»). الأسماء تؤخذ من جدول employees وحده. */
function nameHintFrom(parts) {
  return [...parts.join("")].reverse().join("").normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function rowsFromPdf(buffer) {
  // pdfjs ESM فقط والمشروع CommonJS — نفس الاستيراد الديناميكي في lib/pdf/documentDates.js
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const byLine = new Map();
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const item of content.items) {
      /* الصفّ يُعرَّف بالإحداثي الرأسي مقرَّبًا، مع رقم الصفحة كي لا
         يختلط صفٌّ في صفحة بصفٍّ على الارتفاع نفسه في أخرى. */
      const key = `${p}:${Math.round(item.transform[5])}`;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push({ x: item.transform[4], s: item.str });
    }
  }
  return [...byLine.values()].map((items) => items.sort((a, b) => a.x - b.x).map((i) => i.s));
}

/* يُرجع { ok, staff:[{eid, net, nameHint}], sumNet, totalNet, reason }.
   لا يرمي على كشف غير مفهوم: يُرجع ok:false وسببًا، فالمُنادي يقرّر. */
async function extractRoster(buffer) {
  let lines;
  try {
    lines = await rowsFromPdf(buffer);
  } catch (err) {
    return { ok: false, reason: "unreadable_pdf", error: (err && err.message) || String(err) };
  }

  const staff = [];
  const totals = [];
  for (const cells of lines) {
    const trimmed = cells.map((c) => String(c).trim()).filter((c) => c !== "");
    if (!trimmed.length) continue;
    const last = trimmed[trimmed.length - 1];
    const money = trimmed.filter(isMoney);
    if (isEid(last) && money.length >= MIN_MONEY_COLUMNS) {
      staff.push({
        eid: last,
        net: toNumber(trimmed[0]),
        nameHint: nameHintFrom(cells.slice(0, cells.lastIndexOf(last)).filter((c) => !isMoney(c))),
      });
    } else if (!isEid(last) && money.length >= MIN_TOTALS_COLUMNS) {
      totals.push(toNumber(trimmed[0]));
    }
  }

  if (!staff.length) return { ok: false, reason: "no_employee_rows" };

  /* رقم موظف مكرّر يعني أن القارئ فسّر شيئًا آخر رقمًا وظيفيًا. */
  const seen = new Set();
  for (const s of staff) {
    if (seen.has(s.eid)) return { ok: false, reason: "duplicate_eid", eid: s.eid };
    seen.add(s.eid);
  }

  const sumNet = staff.reduce((a, s) => a + s.net, 0);
  if (!totals.length) return { ok: false, reason: "no_totals_row", staff, sumNet };
  const totalNet = totals[0];
  /* فرق قرش واحد يكفي للرفض: الأرقام مطبوعة بمنزلتين، فالمطابقة تامّة
     أو الاستخراج ناقص. */
  if (Math.abs(sumNet - totalNet) >= 0.005) {
    return { ok: false, reason: "totals_mismatch", staff, sumNet, totalNet };
  }
  return { ok: true, staff, sumNet, totalNet };
}

module.exports = { extractRoster, isMoney, isEid, nameHintFrom };
