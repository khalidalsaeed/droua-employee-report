/* ─── قرّاء ملفّ التحويل: بايتات ⇄ صفوف نصّية ───
   =========================================================================
   ثلاث صيغ بالأولوية المطلوبة — PDF بنكي، وExcel ‏(XLSX)، وCSV — بلا أي
   اعتماد جديد: zlib من Node لحاوية XLSX، وpdfjs-dist القائم أصلًا في
   المشروع (يقرأ به كشف جسر) لطبقة نصّ PDF.

   لا OCR. ملفّ PDF بلا طبقة نصّ (صورة ممسوحة) يُرفض بسبب صريح
   "scanned_pdf" بدل أن يُخمَّن شيء من صورة.

   وهذا الملفّ لا يعرف شيئًا عن الموظفين ولا عن المطابقة: يُرجع صفوفًا من
   خلايا نصّية، وما بعده يقرّر معناها.

   ملاحظة عزل: قارئا XLSX/CSV هنا مستقلّان عمدًا عن قرّاء قسم المراجعة —
   ذاك القسم معزول بقرار أمني ولا تستورد المنصّة وحداته. */

const zlib = require("zlib");

class TransferFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TransferFileError";
    this.code = code;
  }
}

/* الصيغة من البايتات لا من الامتداد وحده: امتدادٌ يمكن أن يكذب، والتوقيع لا. */
function detectFormat(bytes, fileName) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const name = String(fileName || "").toLowerCase();
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50) return "xlsx";
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0) return "xls";
  if (/\.(csv|txt)$/.test(name) || looksLikeText(b)) return "csv";
  return null;
}

function looksLikeText(b) {
  const sample = b.subarray(0, Math.min(b.length, 4096));
  if (!sample.length) return false;
  let bad = 0;
  for (const c of sample) if (c === 0 || (c < 9) || (c > 13 && c < 32)) bad++;
  return bad === 0;
}

/* ── CSV ── فاصل تلقائي (, ; tab)، واقتباس، وBOM، وترميز UTF-8 أو UTF-16. */
function decodeText(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  return b.toString("utf8");
}

function readCsv(bytes) {
  let text = decodeText(Buffer.from(bytes));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLines = text.split(/\r?\n/).slice(0, 10).join("\n");
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of firstLines) if (ch in counts) counts[ch]++;
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return [{ name: "csv", rows: rows.filter((r) => r.some((c) => String(c).trim() !== "")) }];
}

/* ── XLSX ── ZIP من الدليل المركزي، ثم sharedStrings وأوراق العمل. الخلايا
   متفرّقة ومرجعها في r="C7"، فتوضع في عمودها لا بترتيب ظهورها — وإلّا
   انزاحت الأعمدة عند أول خليّة فارغة. */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new TransferFileError("unreadable_file", "ملفّ Excel تالف أو غير مكتمل");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    try { files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw)); } catch (e) { /* إدخال لا نحتاجه */ }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, "&");

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(bytes) {
  const zip = unzip(Buffer.from(bytes));
  const sstXml = zip.get("xl/sharedStrings.xml");
  const sst = sstXml
    ? String(sstXml).split(/<si>|<si\s[^>]*>/).slice(1).map((si) => [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join(""))
    : [];
  const keys = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!keys.length) throw new TransferFileError("unreadable_file", "لا توجد ورقة عمل في ملفّ Excel");
  return keys.map((key) => {
    const rows = [];
    for (const rm of String(zip.get(key)).matchAll(/<row\b[^>]*?>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+)\d+"/.exec(cm[1]);
        if (!ref) continue;
        const type = (/\bt="([^"]*)"/.exec(cm[1]) || [])[1] || "n";
        const body = cm[2] || "";
        const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        let value = "";
        if (inline) value = decodeXml(inline[1]);
        else if (v) value = type === "s" ? sst[Number(v[1])] || "" : type === "e" ? "" : decodeXml(v[1]);
        cells[colIndex(ref[1])] = value;
      }
      rows.push(Array.from(cells, (c) => (c === undefined ? "" : c)));
    }
    return { name: key, rows: rows.filter((r) => r.some((c) => String(c).trim() !== "")) };
  });
}

/* ── PDF ── طبقة النصّ عبر pdfjs. كل سطر = العناصر على الارتفاع نفسه
   (مقرَّبًا) داخل الصفحة نفسها، مرتّبةً من اليسار إلى اليمين. ثم تُضمّ
   العناصر المتلاصقة (المسافة الأفقية صغيرة) في خليّة واحدة، فالخطوط التي
   تُخرج حرفًا لكل عنصر لا تُنتج عشرات الخلايا من كلمة واحدة. */
const MIN_TEXT_CHARS = 20;

async function readPdf(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise;
  } catch (err) {
    if (/password/i.test(String(err && err.name) + String(err && err.message))) {
      throw new TransferFileError("encrypted_pdf", "ملفّ PDF محميّ بكلمة مرور — صدّره من البنك بلا حماية ثم أعد الرفع");
    }
    throw new TransferFileError("unreadable_file", "تعذّرت قراءة ملفّ PDF");
  }
  const lines = [];
  let textChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const byY = new Map();
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      textChars += it.str.trim().length;
      const y = Math.round(it.transform[5] / 2) * 2;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: it.transform[4], w: it.width || 0, s: it.str });
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      const items = byY.get(y).sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = null;
      for (const it of items) {
        if (cur && it.x - (cur.x + cur.w) < 3) { cur.s += it.s; cur.w = it.x + it.w - cur.x; }
        else { cur = { x: it.x, w: it.w, s: it.s }; cells.push(cur); }
      }
      lines.push({ page: p, y, cells: cells.map((c) => ({ x: c.x, s: c.s.trim() })).filter((c) => c.s) });
    }
  }
  if (textChars < MIN_TEXT_CHARS) {
    throw new TransferFileError("scanned_pdf",
      "ملفّ PDF لا يحتوي على طبقة نصّ (صورة ممسوحة ضوئيًا). القراءة الضوئية OCR غير مفعّلة — اطلب من البنك نسخة PDF إلكترونية أو Excel/CSV");
  }
  return { pages: doc.numPages, lines };
}

module.exports = { TransferFileError, detectFormat, readCsv, readXlsx, readPdf, unzip, MIN_TEXT_CHARS };
