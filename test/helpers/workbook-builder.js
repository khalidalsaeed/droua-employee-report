/* بناة مصنّفات **مصنوعة** لاختبار القرّاء.
   =========================================================================
   ⛔ لا بيان حقيقيّ: أسماء مخترعة وأرقام مؤلَّفة.

   ولماذا نبني المصنّف بدل أن نضع ملفًّا جاهزًا في المستودع: ملفٌّ ثنائيّ
   محفوظ لا يقول ما الذي يختبره، ولا يمكن تعديله لاختبار حالة. أمّا البنّاء
   فيجعل كل حالةٍ صريحة — نصّ يمتدّ على CONTINUE، أو خليّة RK كسرية، أو
   خليّة غائبة في منتصف الصفّ. */

const zlib = require("zlib");

/* ── XLSX: حاوية ZIP فيها XML ─────────────────────────────────────────── */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.from(content, "utf8");
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const colName = (i) => {
  let n = i + 1;
  let out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
};

/* rows: مصفوفة صفوف، كل خليّة نصّ أو رقم أو null (غائبة تمامًا). */
function buildXlsx(rows, { sheetName = "ورقة", sheets = null } = {}) {
  const all = sheets || [{ name: sheetName, rows }];
  const strings = [];
  const sstIndex = new Map();
  const idOf = (text) => {
    if (!sstIndex.has(text)) { sstIndex.set(text, strings.length); strings.push(text); }
    return sstIndex.get(text);
  };

  const sheetXmls = all.map((sheet) => {
    const body = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (cell === null || cell === undefined || cell === "") return "";
        const ref = `${colName(c)}${r + 1}`;
        if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
        return `<c r="${ref}" t="s"><v>${idOf(String(cell))}</v></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0"?><worksheet xmlns="http://x"><sheetData>${body}</sheetData></worksheet>`;
  });

  const sst = `<?xml version="1.0"?><sst xmlns="http://x" count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("") + "</sst>";

  const entries = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://x"/>'],
    ["_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://x"/>'],
    ["xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://x" xmlns:r="http://r"><sheets>'
      + all.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
      + "</sheets></workbook>"],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://x">'
      + all.map((s, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
      + "</Relationships>"],
    ["xl/sharedStrings.xml", sst],
    ...sheetXmls.map((xml, i) => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
  ];
  return zip(entries);
}

/* ── XLS: حاوية OLE2 فيها سجلّات BIFF8 ────────────────────────────────── */

const SECTOR = 512;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;

function record(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

function unicodeString(text) {
  const wide = Buffer.from(text, "utf16le");
  const head = Buffer.alloc(3);
  head.writeUInt16LE(text.length, 0);
  head.writeUInt8(0x01, 2);
  return Buffer.concat([head, wide]);
}

/* يبني مجرى Workbook بصيغة BIFF8.
   `splitSst` يجبر جدول النصوص على الامتداد إلى CONTINUE — وهو المسار الذي
   يكسر أغلب القرّاء، فيصير النصّ العربيّ حروفًا مبعثرة. */
function buildBiff(rows, { sheetName = "Payroll Report", splitSst = false, pad = 5000 } = {}) {
  const strings = [];
  const index = new Map();
  const idOf = (text) => {
    if (!index.has(text)) { index.set(text, strings.length); strings.push(text); }
    return index.get(text);
  };
  for (const row of rows) for (const cell of row) {
    if (typeof cell === "string" && cell !== "") idOf(cell);
  }

  /* جسم SST: عدّادان ثمّ النصوص. */
  const parts = [];
  const counts = Buffer.alloc(8);
  counts.writeUInt32LE(strings.length, 0);
  counts.writeUInt32LE(strings.length, 4);
  parts.push(counts);
  for (const s of strings) parts.push(unicodeString(s));
  const sstBody = Buffer.concat(parts);

  const sstRecords = [];
  if (!splitSst) {
    sstRecords.push(record(0x00fc, sstBody));
  } else {
    /* القطع **في منتصف نصّ** — وهو ما يفعله Excel فعلًا حين يتجاوز الجدول
       حدّ السجلّ. والقطع يقع على حدّ محرف (زوج بايت في UTF-16)، ويبدأ
       الامتداد ببايت سمات جديد يقول ترميز البقيّة.

       وهذا المسار هو ما يكسر أغلب القرّاء: من يتجاهل بايت السمات الجديد
       يقرأ بقيّة النصّ العربيّ بترميز لاتينيّ فيخرج حروفًا مبعثرة. */
    const first = strings[0] || "";
    const header = 8 + 3;
    const cut = header + Math.max(2, (Math.floor(first.length / 2) * 2));
    const head = sstBody.slice(0, cut);
    const grbit = Buffer.from([0x01]);
    const tail = Buffer.concat([grbit, sstBody.slice(cut)]);
    sstRecords.push(record(0x00fc, head));
    sstRecords.push(record(0x003c, tail));
  }

  const cellRecords = [];
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === "") return;
      if (typeof cell === "number") {
        const d = Buffer.alloc(14);
        d.writeUInt16LE(r, 0); d.writeUInt16LE(c, 2); d.writeUInt16LE(0, 4);
        d.writeDoubleLE(cell, 6);
        cellRecords.push(record(0x0203, d));
      } else {
        const d = Buffer.alloc(10);
        d.writeUInt16LE(r, 0); d.writeUInt16LE(c, 2); d.writeUInt16LE(0, 4);
        d.writeUInt32LE(idOf(String(cell)), 6);
        cellRecords.push(record(0x00fd, d));
      }
    });
  });

  const bof = () => {
    const d = Buffer.alloc(16);
    d.writeUInt16LE(0x0600, 0);
    d.writeUInt16LE(0x0005, 2);
    return record(0x0809, d);
  };

  /* الترتيب: BOF عامّ، SST، BOUNDSHEET (بموضع BOF الورقة)، EOF، ثمّ الورقة.
     وموضع الورقة يُحسب بعد بناء ما قبله. */
  const head = Buffer.concat([bof(), ...sstRecords]);
  const nameBuf = Buffer.from(sheetName, "utf16le");
  const boundData = Buffer.alloc(8 + nameBuf.length);
  boundData.writeUInt8(sheetName.length, 4);
  boundData.writeUInt8(0x01, 5);
  nameBuf.copy(boundData, 6);
  const boundRec = record(0x0085, boundData);
  const globalEof = record(0x000a, Buffer.alloc(0));
  const sheetStart = head.length + boundRec.length + globalEof.length;
  boundData.writeUInt32LE(sheetStart, 0);
  const bound = record(0x0085, boundData);

  const sheetBody = Buffer.concat([bof(), ...cellRecords, record(0x000a, Buffer.alloc(0))]);
  const padding = pad > 0 ? record(0x0100, Buffer.alloc(pad)) : Buffer.alloc(0);
  return Buffer.concat([head, bound, globalEof, sheetBody, padding]);
}

function buildXls(rows, options = {}) {
  const stream = buildBiff(rows, options);
  /* هذا البنّاء يكتب المجرى في قطاعات FAT العادية دائمًا. والمجرى الصغير
     (دون 4096 بايت) له جدول تخصيصٍ آخر لا يبنيه — والقارئ يدعمه، لكن
     اختبارُه يحتاج بنّاءً ثانيًا. فالحشو يُبقي المجرى فوق الحدّ، ويُصرَّح
     بالفجوة بدل أن تبدو عطلًا في القارئ. */
  if (stream.length < 4096) {
    throw new Error("البنّاء لا يُخرج مجرًى صغيرًا — ارفع pad فوق 4096");
  }
  const dataSectors = Math.ceil(stream.length / SECTOR) || 1;
  const dirSector = 1 + dataSectors;
  const totalSectors = dirSector + 1;

  const header = Buffer.alloc(SECTOR, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(0x0003, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);          // عدد قطاعات FAT
  header.writeUInt32LE(dirSector, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(END, 60);
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(END, 68);
  header.writeUInt32LE(0, 72);
  header.writeUInt32LE(0, 76);          // DIFAT[0] = القطاع 0
  for (let i = 1; i < 109; i += 1) header.writeUInt32LE(FREE, 76 + i * 4);

  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(FATSECT, 0);
  for (let i = 0; i < dataSectors; i += 1) {
    fat.writeUInt32LE(i === dataSectors - 1 ? END : 2 + i, 4 + i * 4);
  }
  fat.writeUInt32LE(END, 4 + dataSectors * 4);

  const data = Buffer.alloc(dataSectors * SECTOR, 0);
  stream.copy(data, 0);

  const dir = Buffer.alloc(SECTOR, 0);
  const entry = (offset, name, type, start, size) => {
    const n = Buffer.from(name, "utf16le");
    n.copy(dir, offset);
    dir.writeUInt16LE(n.length + 2, offset + 64);
    dir.writeUInt8(type, offset + 66);
    dir.writeUInt32LE(FREE, offset + 68);
    dir.writeUInt32LE(FREE, offset + 72);
    dir.writeUInt32LE(FREE, offset + 76);
    dir.writeUInt32LE(start, offset + 116);
    dir.writeUInt32LE(size, offset + 120);
  };
  entry(0, "Root Entry", 5, END, 0);
  entry(128, "Workbook", 2, 1, stream.length);

  return Buffer.concat([header, fat, data, dir], totalSectors * SECTOR + SECTOR);
}

module.exports = { buildXlsx, buildXls, buildBiff, zip };
