#!/usr/bin/env node
/* يولّد lib/org/source.js من «تقرير قائمة الموظفين» بصيغة xlsx.
   =========================================================================
   هذه النسخة من الهيكل التنظيمي تقرأ لقطة مستخرجة من ملف Excel لا من
   قاعدة البيانات: الملف هو مصدر الحقيقة الحالي للقسم والموقع والمدير
   المباشر، وهي حقول لا يحملها سجلّ الموظف في المنصّة بعد.

   لا يُكتب الملف يدويًا أبدًا — يُعاد توليده بهذا السكربت كلما صدر تقرير
   جديد، فتبقى اللقطة نسخة حرفية من الأعمدة السبعة بلا إضافة ولا تصحيح.
   الإملاء يُحفظ كما هو («ادارة الإنتاج» و«إدارة التشغيل» معًا)؛ التطبيع
   للمقارنة يجري في org-core.js وقت القراءة لا هنا.

   قارئ xlsx ذاتيّ صغير (zlib المدمج في Node) بلا اعتماديات: قارئ قسم
   المراجعة محظور الاستيراد خارجه (test/droua-isolation.test.js).

   التشغيل:   node scripts/import-org-xlsx.js "<path>.xlsx"
   المعاينة:  node scripts/import-org-xlsx.js "<path>.xlsx" --dry-run */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* عنوان العمود في التقرير → مفتاح اللقطة. أي عمود آخر يُتجاهل، وأي عمود
   من هذه ناقص يُوقف التوليد بدل أن يُنتج لقطة بحقل فارغ صامت. */
const COLUMNS = {
  "حالة الموظف": "status",
  "القسم": "department",
  "الموقع": "location",
  "المدير المباشر": "managerName",
  "البريد الإلكتروني": "email",
  "الاسم كاملاً باللغة الانجليزية": "nameEn",
  "الاسم كاملاً باللغة العربية": "nameAr",
};

function unzip(buf) {
  const files = new Map();
  /* سجلّ نهاية الدليل المركزي ثم مدخلاته — أدقّ من المسح التسلسلي لأن
     الأحجام في الترويسة المحلية قد تكون صفرًا (data descriptor). */
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ليس ملف xlsx صالحًا (لا دليل مركزي)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("دليل مركزي تالف");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    const lName = buf.readUInt16LE(local + 26), lExtra = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    files.set(name, method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
const textOf = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");
const colIndex = (ref) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function readFirstSheet(bytes) {
  const zip = unzip(bytes);
  const sstXml = zip.get("xl/sharedStrings.xml");
  const sst = sstXml ? [...sstXml.toString("utf8").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const sheetKey = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetKey) throw new Error("لا ورقة في المصنّف");
  const xml = zip.get(sheetKey).toString("utf8");
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNo = Number((/\br="(\d+)"/.exec(rm[1]) || [])[1]);
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || "";
      const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      let v = null;
      if (type === "inlineStr") v = textOf(body);
      else {
        const raw = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        if (raw != null) v = type === "s" ? sst[Number(raw)] : decode(raw);
      }
      if (ref) cells[colIndex(ref)] = v;
    }
    rows.push({ rowNo, cells });
  }
  return rows;
}

function extract(bytes) {
  const rows = readFirstSheet(bytes);
  const headerAt = rows.findIndex((r) => r.cells.some((c) => c && String(c).trim() === "المدير المباشر"));
  if (headerAt < 0) throw new Error("لم يُعثر على صفّ العناوين (عمود «المدير المباشر»)");
  const header = rows[headerAt].cells.map((c) => (c == null ? "" : String(c).trim()));
  const index = {};
  for (const [title, key] of Object.entries(COLUMNS)) {
    const i = header.indexOf(title);
    if (i < 0) throw new Error(`العمود «${title}» غير موجود في التقرير`);
    index[key] = i;
  }
  const out = [];
  for (const r of rows.slice(headerAt + 1)) {
    const rec = { row: r.rowNo };
    for (const [key, i] of Object.entries(index)) {
      const v = r.cells[i];
      rec[key] = v == null || String(v).trim() === "" ? null : String(v).trim();
    }
    if (Object.keys(index).every((k) => rec[k] == null)) continue; // صفّ فارغ
    out.push(rec);
  }
  return out;
}

function render(records, sourceName) {
  return `/* مُولَّد آليًا — لا يُعدَّل يدويًا. أعد التوليد بـ:
     node scripts/import-org-xlsx.js "<path>.xlsx"
   المصدر: ${sourceName}
   الأعمدة السبعة كما وردت في التقرير، بلا إضافة ولا تصحيح إملائي.
   row = رقم الصفّ في ورقة Excel، للرجوع إلى الأصل عند المراجعة. */
module.exports = {
  SOURCE_NAME: ${JSON.stringify(sourceName)},
  ROWS: ${JSON.stringify(records, null, 2).replace(/\n/g, "\n  ")},
};
`;
}

function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) { console.error("الاستعمال: node scripts/import-org-xlsx.js <file.xlsx> [--dry-run] [--name=<اسم المصدر>]"); process.exitCode = 1; return; }
  const nameArg = process.argv.find((a) => a.startsWith("--name="));
  const sourceName = nameArg ? nameArg.slice(7) : path.basename(file);
  const records = extract(fs.readFileSync(file));
  if (process.argv.includes("--dry-run")) { console.log(JSON.stringify(records, null, 2)); return; }
  const target = path.join(__dirname, "..", "lib", "org", "source.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(records, sourceName));
  console.log(`كُتب ${records.length} صفًّا إلى ${path.relative(process.cwd(), target)}`);
}

if (require.main === module) main();

module.exports = { extract, render, unzip, COLUMNS };
