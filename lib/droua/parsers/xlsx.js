/* ─── قارئ XLSX (OOXML داخل حاوية ZIP) ────────────────────────────────
   =========================================================================
   بلا اعتماد خارجيّ: الحاوية ZIP، وNode يحمل `zlib` أصلًا، والمحتوى XML
   بسيط الشكل. والمطلوب ضيّق: قيم الخلايا نصًّا وأرقامًا لا غير.

   ── ما يستحقّ الانتباه في هذه الصيغة ──
   ① النصوص لا تعيش في الورقة بل في `sharedStrings.xml`، والخليّة تحمل
      فهرسًا إليها (`t="s"`). فقارئٌ يقرأ `<v>` كما هو يُخرج أرقامًا مكان
      كل اسم.
   ② والخلايا **متفرّقة**: صفٌّ لا يحمل إلا الخلايا غير الفارغة، ومرجعها
      في `r="C7"` لا في ترتيبها. فقراءتها بالتسلسل تُزيح الأعمدة كلَّها عند
      أول خليّة فارغة — وهو أخطر عطلٍ ممكن هنا: أرقامٌ صحيحة في أعمدة
      خاطئة، تبدو سليمة تمامًا.
   ③ والتواريخ أرقامٌ متسلسلة بلا نوع مميّز. ولا نحوّلها: ما يلزمنا نصوصٌ
      ومبالغ، وتحويلُ رقمٍ إلى تاريخ بالتخمين يفسد مبلغًا. */

const zlib = require("zlib");
const csv = require("./csv");

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/* ── فكّ حاوية ZIP من دليلها المركزيّ ──
   ولا نمشي على الترويسات المحلّية: بعض المولِّدات تكتب فيها أطوالًا صفرية
   وتؤجّلها إلى واصفٍ بعد البيانات، فيقرأ الماشي على المحلّية صفرًا. */
function unzip(buf) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ليست حاوية ZIP سليمة");

  const count = buf.readUInt16LE(eocd + 10);
  const files = new Map();
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count && p + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");

    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(start, start + compSize);
    try {
      files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch (err) {
      /* إدخالٌ تالف لا يُسقط الملفّ كلَّه: قد يكون صورةً أو نمطًا لا نقرؤه. */
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m, e) => {
  if (ENTITIES[e]) return ENTITIES[e];
  const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});

/* «C7» → 2. أساسٌ 26 بلا صفر: A=1 … Z=26 … AA=27. */
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  /* كل <si> قد يحوي عدّة <t> (نصّ غنيّ) — تُضمّ بترتيبها. */
  for (const si of String(xml).split("<si>").slice(1)) {
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
    out.push(parts.join(""));
  }
  return out;
}

function readSheet(xml, sst) {
  const rows = [];
  let maxCol = -1;
  for (const rowMatch of String(xml).matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIndex = Number(rowMatch[1]) - 1;
    const cells = [];
    /* ⚠️ السمات **كسولة** لا نهمة. والنهمة تبتلع الشرطة المائلة في
       الخليّة الفارغة المُنسَّقة `<c r="H1" s="10"/>`، فيفشل فرعُ الإغلاق
       الذاتيّ ويُطابَق فرعُ الجسم — فيمتدّ إلى `</c>` **الخليّة التالية**:
       تُبتلع الخليّة التالية كاملةً فتختفي من الصفّ، وتُنسب قيمتُها الخام
       إلى عمود الفارغة. وإن كانت نصًّا مشتركًا ظهر **فهرسُه رقمًا**.

       والأثر أخبثُ من فقدِ عمود: الأعمدة **تنزاح**، فتُقرأ أرقامٌ صحيحة
       في أعمدةٍ خاطئة وتبدو سليمة تمامًا. */
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || "";
      const refMatch = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!refMatch) continue;
      const col = columnIndex(refMatch[1]);
      const typeMatch = /\bt="([^"]*)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : "n";

      let value = "";
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (inline) value = decodeXml(inline[1]);
      else if (v) {
        const raw = decodeXml(v[1]);
        if (type === "s") value = sst[Number(raw)] === undefined ? "" : sst[Number(raw)];
        else if (type === "e") value = "";           // خطأ صيغة: يُترك فارغًا لا يُخمَّن
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else value = raw;
      }
      cells[col] = value;
      if (col > maxCol) maxCol = col;
    }
    rows[rowIndex] = cells;
  }
  /* تسوية الشبكة: الخلايا متفرّقة، والمقارنة تحتاج مصفوفة مستطيلة. */
  const width = maxCol + 1;
  const out = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const filled = [];
    for (let c = 0; c < width; c += 1) filled.push(row[c] === undefined ? "" : row[c]);
    out.push(filled);
  }
  return out;
}

function readWorkbook(bytes) {
  const zip = unzip(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const workbookXml = zip.get("xl/workbook.xml");
  if (!workbookXml) throw new Error("لا xl/workbook.xml في الحاوية");

  const sst = readSharedStrings(zip.get("xl/sharedStrings.xml"));

  /* ترتيب الأوراق من workbook.xml، ومسار كل ورقة من ملفّ العلاقات. */
  const relsXml = (zip.get("xl/_rels/workbook.xml.rels") || Buffer.alloc(0)).toString("utf8");
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)) {
    rels.set(m[1], m[2].replace(/^\/?xl\//, "").replace(/^\.\//, ""));
  }

  const sheets = [];
  for (const m of String(workbookXml).matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = /\bname="([^"]*)"/.exec(tag);
    const rid = /\br:id="([^"]*)"/.exec(tag);
    const target = rid && rels.get(rid[1]);
    const key = target ? `xl/${target}` : null;
    const xml = key && zip.get(key);
    if (!xml) continue;
    sheets.push({ name: name ? decodeXml(name[1]) : `Sheet${sheets.length + 1}`, rows: readSheet(xml, sst) });
  }

  /* احتياطًا: مصنّفٌ بلا علاقات صالحة — تُقرأ الأوراق بترتيب أسمائها. */
  if (!sheets.length) {
    for (const key of [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()) {
      sheets.push({ name: key, rows: readSheet(zip.get(key), sst) });
    }
  }
  return { sheets, warnings: [] };
}

function parse({ kind, bytes }) {
  const book = readWorkbook(bytes);
  const sheet = csv.pickSheet(book.sheets, kind);
  if (!sheet) {
    return { kind, rows: [], meta: {
      source: "xlsx", rowCount: 0, warnings: ["لا ورقة فيها بيانات"],
      mapping: {}, unknownColumns: [], confidence: 0, needsManualReview: true,
    } };
  }
  const { header, dataRows, headerRow, headerRows } = csv.findHeader(sheet.rows, kind);
  const out = csv.normalizeRows(kind, header, dataRows);
  out.meta.source = "xlsx";
  out.meta.sheet = sheet.name;
  out.meta.headerRow = headerRow;
  /* صفّان للترويسة: يُعلَن كي يُرى في المراجعة — بنيةٌ غير مألوفة
     قُرئت، لا صمتٌ عنها. */
  out.meta.headerRows = headerRows || 1;
  return out;
}

module.exports = { format: "xlsx", available: true, parse, readWorkbook, unzip, columnIndex, decodeXml };
