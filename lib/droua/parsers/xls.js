/* ─── قارئ XLS (BIFF8 داخل حاوية OLE2) ────────────────────────────────
   =========================================================================
   بلا اعتماد خارجيّ. والصيغة قديمة وموثَّقة جيّدًا، والمطلوب منها هنا ضيّق:
   قراءة خلايا ورقةٍ واحدة نصًّا وأرقامًا. فلا تنسيقات، ولا صيغ، ولا رسوم.

   ── لماذا لا مكتبة ──
   مكتبة قراءة xlsx/xls تجرّ مساحةً كبيرة وسلسلة توريد كاملة إلى مشروعٍ
   يقرأ أربعة ملفّات في الشهر. وما يلزم منها هنا أقلّ من خمس مئة سطر
   موصوفة في مواصفة مفتوحة — والكلفة الحقيقية للمكتبة ليست حجمها بل أنها
   تصير بابًا ثالثًا إلى بيانات الرواتب.

   ── طبقتان ──
   ① حاوية OLE2 (CFB): جدول تخصيص قطاعات، ودليل، ومجرى صغير للملفّات
      الصغيرة. نُخرج منها مجرى «Workbook».
   ② سجلّات BIFF8: [نوع u16][طول u16][بيانات]. نقرأ ما يحمل قيمة خليّة
      وحده، ونتخطّى الباقي.

   وما لا نفهمه **يُتخطّى ولا يُخمَّن**: خليّةٌ بنوعٍ غير مدعوم تبقى فارغة
   ويُعلَن ذلك في التحذيرات — لا تُملأ بصفرٍ صامت. */

const csv = require("./csv");

/* ── ① حاوية OLE2 ─────────────────────────────────────────────────────── */

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const MINI_CUTOFF = 4096;

function readCompound(buf) {
  if (buf.length < 512 || !buf.slice(0, 8).equals(OLE_SIGNATURE)) {
    throw new Error("ليست حاوية OLE2");
  }
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSectorSize = 1 << buf.readUInt16LE(32);
  const fatCount = buf.readUInt32LE(44);
  const dirStart = buf.readUInt32LE(48);
  const miniFatStart = buf.readUInt32LE(60);
  const difatStart = buf.readUInt32LE(68);
  const difatCount = buf.readUInt32LE(72);

  const sectorOffset = (s) => (s + 1) * sectorSize;
  const sectorAt = (s) => buf.slice(sectorOffset(s), sectorOffset(s) + sectorSize);

  /* DIFAT: أول 109 مدخلًا في الترويسة، والبقيّة في قطاعات متسلسلة. */
  const difat = [];
  for (let i = 0; i < 109 && i < fatCount; i += 1) difat.push(buf.readUInt32LE(76 + i * 4));
  let next = difatStart;
  for (let n = 0; n < difatCount && next !== END_OF_CHAIN && next !== FREE_SECTOR; n += 1) {
    const sector = sectorAt(next);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i += 1) {
      const entry = sector.readUInt32LE(i * 4);
      if (entry !== FREE_SECTOR) difat.push(entry);
    }
    next = sector.readUInt32LE(sectorSize - 4);
  }

  /* FAT: سلسلة القطاعات لكل مجرى. */
  const fat = [];
  for (const s of difat) {
    if (s === FREE_SECTOR || sectorOffset(s) + sectorSize > buf.length) continue;
    const sector = sectorAt(s);
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(sector.readUInt32LE(i * 4));
  }

  const chain = (start, limit) => {
    const out = [];
    let s = start;
    /* حدٌّ صريح على طول السلسلة: ملفٌّ تالف قد يحمل حلقةً مغلقة، وبلا هذا
       الحدّ تدور القراءة إلى ما لا نهاية بدل أن تفشل. */
    while (s !== END_OF_CHAIN && s !== FREE_SECTOR && out.length < limit) {
      out.push(s);
      s = fat[s];
      if (s === undefined) break;
    }
    return out;
  };

  const readChain = (start, size, mini, miniStream) => {
    const unit = mini ? miniSectorSize : sectorSize;
    const sectors = chain(start, Math.ceil(buf.length / unit) + 8);
    const parts = sectors.map((s) => (mini
      ? miniStream.slice(s * miniSectorSize, (s + 1) * miniSectorSize)
      : sectorAt(s)));
    return Buffer.concat(parts).slice(0, size);
  };

  /* الدليل: مدخلات 128 بايت، الاسم UTF-16، والجذر يحمل المجرى الصغير. */
  const dirSectors = chain(dirStart, Math.ceil(buf.length / sectorSize) + 8);
  const dir = Buffer.concat(dirSectors.map(sectorAt));
  const entries = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = dir.readUInt16LE(p + 64);
    if (nameLen < 2 || nameLen > 64) continue;
    const name = dir.slice(p, p + nameLen - 2).toString("utf16le");
    entries.push({
      name,
      type: dir.readUInt8(p + 66),
      start: dir.readUInt32LE(p + 116),
      size: dir.readUInt32LE(p + 120),
    });
  }

  const root = entries.find((e) => e.type === 5);
  const miniStream = root && root.size
    ? readChain(root.start, root.size, false, null)
    : Buffer.alloc(0);
  /* المجرى الصغير نفسه له جدول تخصيصه — يُقرأ بسلسلة FAT العادية. */
  const miniFat = [];
  if (miniFatStart !== END_OF_CHAIN && miniFatStart !== FREE_SECTOR) {
    const mf = Buffer.concat(chain(miniFatStart, Math.ceil(buf.length / sectorSize) + 8).map(sectorAt));
    for (let i = 0; i < mf.length / 4; i += 1) miniFat.push(mf.readUInt32LE(i * 4));
  }

  const readMini = (start, size) => {
    const parts = [];
    let s = start;
    let guard = 0;
    while (s !== END_OF_CHAIN && s !== FREE_SECTOR && guard < 1e6) {
      parts.push(miniStream.slice(s * miniSectorSize, (s + 1) * miniSectorSize));
      s = miniFat[s];
      guard += 1;
      if (s === undefined) break;
    }
    return Buffer.concat(parts).slice(0, size);
  };

  const stream = (name) => {
    const entry = entries.find((e) => e.name === name && e.type === 2);
    if (!entry) return null;
    if (!entry.size) return Buffer.alloc(0);
    return entry.size < MINI_CUTOFF
      ? readMini(entry.start, entry.size)
      : readChain(entry.start, entry.size, false, null);
  };

  return { stream, names: entries.map((e) => e.name) };
}

/* ── ② سجلّات BIFF8 ───────────────────────────────────────────────────── */

const REC = {
  BOF: 0x0809, EOF: 0x000a, BOUNDSHEET: 0x0085, SST: 0x00fc, CONTINUE: 0x003c,
  LABELSST: 0x00fd, LABEL: 0x0204, RK: 0x027e, MULRK: 0x00bd, NUMBER: 0x0203,
  FORMULA: 0x0006, STRING: 0x0207, BLANK: 0x0201, MULBLANK: 0x00be,
  RSTRING: 0x00d6, BOOLERR: 0x0205,
};

function records(buf) {
  const out = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (p + 4 + size > buf.length) break;
    out.push({ type, data: buf.slice(p + 4, p + 4 + size) });
    p += 4 + size;
  }
  return out;
}

/* نصّ BIFF8: طول، ثمّ بايت سمات — بتّه الأول يقول أهو UTF-16 أم مضغوط إلى
   بايت لكل حرف. والغنيّ والشرق-آسيويّ يسبقهما عدّادان يُتخطّيان. */
function readUnicode(buf, offset, lengthBytes = 2) {
  const cch = lengthBytes === 2 ? buf.readUInt16LE(offset) : buf.readUInt8(offset);
  let p = offset + lengthBytes;
  const grbit = buf.readUInt8(p);
  p += 1;
  const wide = (grbit & 0x01) !== 0;
  const rich = (grbit & 0x08) !== 0;
  const farEast = (grbit & 0x04) !== 0;
  let runs = 0;
  let extra = 0;
  if (rich) { runs = buf.readUInt16LE(p); p += 2; }
  if (farEast) { extra = buf.readUInt32LE(p); p += 4; }
  const bytes = cch * (wide ? 2 : 1);
  const text = wide
    ? buf.slice(p, p + bytes).toString("utf16le")
    : Buffer.from(buf.slice(p, p + bytes)).toString("latin1");
  return { text, end: p + bytes + runs * 4 + extra };
}

/* جدول النصوص المشتركة قد يمتدّ على سجلّات CONTINUE، وكل امتداد يبدأ ببايت
   سمات جديد — فقد يتغيّر ترميز النصّ في منتصفه. وهذا أشهر ما يُخطأ فيه في
   قرّاء BIFF، وأثره نصوصٌ عربية تخرج حروفًا لاتينية مبعثرة. */
function readSst(chunks) {
  const buf = Buffer.concat(chunks.map((c) => c.data));
  /* حدود القطع كي نعرف أين يبدأ بايت سمات جديد. */
  const bounds = [];
  let acc = 0;
  for (const c of chunks) { acc += c.data.length; bounds.push(acc); }
  const isBoundary = (p) => bounds.includes(p);

  const unique = buf.readUInt32LE(4);
  const out = [];
  let p = 8;
  for (let i = 0; i < unique && p + 3 <= buf.length; i += 1) {
    const cch = buf.readUInt16LE(p);
    p += 2;
    let grbit = buf.readUInt8(p);
    p += 1;
    let wide = (grbit & 0x01) !== 0;
    const rich = (grbit & 0x08) !== 0;
    const farEast = (grbit & 0x04) !== 0;
    let runs = 0;
    let extra = 0;
    if (rich) { runs = buf.readUInt16LE(p); p += 2; }
    if (farEast) { extra = buf.readUInt32LE(p); p += 4; }

    let left = cch;
    let text = "";
    while (left > 0 && p < buf.length) {
      const step = wide ? 2 : 1;
      /* المسافة حتى نهاية القطعة الحالية. */
      const nextBound = bounds.find((b) => b > p);
      const room = Math.min(left, Math.floor(((nextBound === undefined ? buf.length : nextBound) - p) / step));
      if (room > 0) {
        const bytes = room * step;
        text += wide
          ? buf.slice(p, p + bytes).toString("utf16le")
          : Buffer.from(buf.slice(p, p + bytes)).toString("latin1");
        p += bytes;
        left -= room;
      }
      if (left > 0) {
        if (!isBoundary(p)) break;
        grbit = buf.readUInt8(p);
        p += 1;
        wide = (grbit & 0x01) !== 0;
      }
    }
    p += runs * 4 + extra;
    out.push(text);
  }
  return out;
}

/* RK: عددٌ محشور في 32 بت — إمّا صحيحٌ في 30 بت، أو أعلى نصف double.
   وبتُّه الأول يعني «مقسومٌ على مئة». */
function decodeRk(rk) {
  const isMultiplied = (rk & 0x01) !== 0;
  const isInteger = (rk & 0x02) !== 0;
  let value;
  if (isInteger) {
    value = rk >> 2;
  } else {
    const tmp = Buffer.alloc(8);
    tmp.writeInt32LE(0, 0);
    tmp.writeInt32LE(rk & 0xfffffffc, 4);
    value = tmp.readDoubleLE(0);
  }
  return isMultiplied ? value / 100 : value;
}

/* ── القراءة إلى جدول ──────────────────────────────────────────────────── */

function readSheets(workbook) {
  const recs = records(workbook);
  const sst = [];
  const sheets = [];
  const warnings = [];

  /* أسماء الأوراق ومواضعها في المجرى. */
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i];
    if (r.type === REC.BOUNDSHEET) {
      const pos = r.data.readUInt32LE(0);
      const { text } = readUnicode(r.data, 6, 1);
      sheets.push({ name: text, pos, cells: new Map(), maxRow: -1, maxCol: -1 });
    } else if (r.type === REC.SST) {
      const chunks = [r];
      let j = i + 1;
      while (j < recs.length && recs[j].type === REC.CONTINUE) { chunks.push(recs[j]); j += 1; }
      try {
        sst.push(...readSst(chunks));
      } catch (err) {
        warnings.push("تعذّرت قراءة جدول النصوص المشتركة");
      }
      i = j - 1;
    }
  }

  /* كل ورقة تبدأ عند BOF في موضعها. ونمشي على السجلّات من ذلك الموضع. */
  const offsets = [];
  let p = 0;
  for (const r of records(workbook)) {
    offsets.push({ offset: p, rec: r });
    p += 4 + r.data.length;
  }

  const put = (sheet, row, col, value) => {
    if (value === null || value === undefined) return;
    sheet.cells.set(`${row}:${col}`, value);
    if (row > sheet.maxRow) sheet.maxRow = row;
    if (col > sheet.maxCol) sheet.maxCol = col;
  };

  for (const sheet of sheets) {
    const startIndex = offsets.findIndex((o) => o.offset === sheet.pos);
    if (startIndex < 0) { warnings.push(`تعذّر بلوغ الورقة: ${sheet.name}`); continue; }
    for (let i = startIndex + 1; i < offsets.length; i += 1) {
      const { rec } = offsets[i];
      if (rec.type === REC.EOF) break;
      const d = rec.data;
      switch (rec.type) {
        case REC.LABELSST: {
          const idx = d.readUInt32LE(6);
          put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), sst[idx] === undefined ? null : sst[idx]);
          break;
        }
        case REC.LABEL:
        case REC.RSTRING: {
          const { text } = readUnicode(d, 6, 2);
          put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), text);
          break;
        }
        case REC.RK:
          put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), decodeRk(d.readInt32LE(6)));
          break;
        case REC.MULRK: {
          const row = d.readUInt16LE(0);
          const first = d.readUInt16LE(2);
          const count = Math.floor((d.length - 6) / 6);
          for (let k = 0; k < count; k += 1) {
            put(sheet, row, first + k, decodeRk(d.readInt32LE(4 + k * 6 + 2)));
          }
          break;
        }
        case REC.NUMBER:
          put(sheet, d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
          break;
        case REC.FORMULA: {
          /* نتيجة الصيغة ثمانية بايت: إن كانت نصًّا جاء بعدها سجلّ STRING،
             وإلّا فهي double. ونتائج المنطق والخطأ تُتخطّى — لا تُخمَّن. */
          const row = d.readUInt16LE(0);
          const col = d.readUInt16LE(2);
          const isText = d.readUInt16LE(12) === 0xffff && d.readUInt8(6) === 0x00;
          if (isText) {
            const nextRec = offsets[i + 1] && offsets[i + 1].rec;
            if (nextRec && nextRec.type === REC.STRING) {
              put(sheet, row, col, readUnicode(nextRec.data, 0, 2).text);
              i += 1;
            }
          } else if (d.readUInt16LE(12) !== 0xffff) {
            put(sheet, row, col, d.readDoubleLE(6));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return { sheets, warnings };
}

/* ── الواجهة ──────────────────────────────────────────────────────────── */

function toTable(sheet) {
  const rows = [];
  for (let r = 0; r <= sheet.maxRow; r += 1) {
    const row = [];
    for (let c = 0; c <= sheet.maxCol; c += 1) {
      const v = sheet.cells.get(`${r}:${c}`);
      row.push(v === undefined ? "" : v);
    }
    rows.push(row);
  }
  return rows;
}

/* يقرأ الملفّ إلى أوراق نصّية. مُصدَّرة كي يُختبر التفكيك وحده. */
function readWorkbook(bytes) {
  const cfb = readCompound(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  const workbook = cfb.stream("Workbook") || cfb.stream("Book");
  if (!workbook) throw new Error("لا مجرى Workbook في الحاوية");
  const { sheets, warnings } = readSheets(workbook);
  return {
    warnings,
    sheets: sheets.map((s) => ({ name: s.name, rows: toTable(s) })),
  };
}

function parse({ kind, bytes }) {
  const book = readWorkbook(bytes);
  const sheet = csv.pickSheet(book.sheets, kind);
  if (!sheet) {
    return { kind, rows: [], meta: {
      source: "xls", rowCount: 0, warnings: ["لا ورقة فيها بيانات"],
      mapping: {}, unknownColumns: [], confidence: 0, needsManualReview: true,
    } };
  }
  const { header, dataRows, headerRow, headerRows } = csv.findHeader(sheet.rows, kind);
  const out = csv.normalizeRows(kind, header, dataRows);
  out.meta.source = "xls";
  out.meta.sheet = sheet.name;
  out.meta.headerRow = headerRow;
  /* صفّان للترويسة: يُعلَن كي يُرى في المراجعة — بنيةٌ غير مألوفة
     قُرئت، لا صمتٌ عنها. */
  out.meta.headerRows = headerRows || 1;
  out.meta.warnings = [...book.warnings, ...out.meta.warnings];
  return out;
}

module.exports = { format: "xls", available: true, parse, readWorkbook, decodeRk, readUnicode };
