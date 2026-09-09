/* ─── واجهة قراءة الملفّات ─────────────────────────────────────────────
   =========================================================================
   ما بعد هذه الوحدة **لا يعرف صيغة ملفّ**. محرّك المقارنة يرى جداول مطبَّعة
   وحدها، فيُكتب مرّة ويعمل على CSV اليوم وعلى PDF غدًا بلا تغيير حرف.

   ── العقد المطبَّع ──
   ```
   { kind, rows: [Row], meta: { source, rowCount, warnings: [] } }

   Row (مسير رواتب): { empNo, name, iban4, bank, method,
                       basic, allowances, deductions, net }
   Row (قائمة موظفين): { empNo, name, jobTitle, status, iban4 }
   ```
   • `empNo` مفتاح المطابقة — نصًّا لا رقمًا: الأصفار البادئة جزءٌ منه.
   • `iban4` **آخر أربع خانات فقط**. الرقم الكامل لا يخرج من الملفّ المشفَّر
     ولا يبلغ هذه البنية أصلًا — يُقتطع هنا عند القراءة.
   • المبالغ أعدادٌ بعد تطبيع الأرقام العربية والفواصل.

   ── ولماذا تُبنى الواجهة قبل وجود عيّنة حقيقية ──
   لأن كل ما بعدها — المقارنة، والملاحظات، والواجهة، ودورة إعادة الرفع —
   يُبنى ويُختبر على هذا العقد بعيّنات مصنوعة. فحين تصل العيّنة الحقيقية لا
   يبقى إلا **قارئ الصيغة وحده**، لا النظام. */

const csv = require("./csv");

class ParserUnavailable extends Error {
  constructor(format) {
    super(`لا قارئ لهذه الصيغة بعد: ${format}`);
    this.name = "ParserUnavailable";
    this.code = "parser_unavailable";
    this.format = format;
  }
}

/* هيكلٌ لا قارئ: يُملأ يوم تصل عيّنة حقيقية. ورميُه صريحًا هنا أفضل من
   قارئٍ يخمّن أعمدةً ويُنتج أرقامًا خاطئة تبدو صحيحة. */
function skeleton(format) {
  return {
    format,
    available: false,
    parse() { throw new ParserUnavailable(format); },
  };
}

const PARSERS = {
  csv,
  /* PDF: العقد المطلوب من قارئه — استخراج نصّ الجدول بترتيب الأعمدة، ثمّ
     تمريره إلى المطبِّع نفسه في csv.js. والمشروع يحمل pdfjs-dist أصلًا
     لمسير أجير، فلا اعتماد جديد يوم يُكتب. */
  pdf: skeleton("pdf"),
  /* Excel: يحتاج مكتبة قراءة xlsx — ولا تُضاف قبل رؤية عيّنة حقيقية،
     فالقرار بينها وبين استخراجٍ يدويّ يعتمد على شكل الملفّ الفعليّ. */
  xlsx: skeleton("xlsx"),
  xls: skeleton("xls"),
};

const available = (format) => Boolean(PARSERS[format] && PARSERS[format].available);

function parse({ format, kind, bytes }) {
  const parser = PARSERS[String(format || "")];
  if (!parser) throw new ParserUnavailable(String(format || ""));
  if (!parser.available) throw new ParserUnavailable(String(format));
  return parser.parse({ kind, bytes });
}

module.exports = { parse, available, PARSERS, ParserUnavailable };
