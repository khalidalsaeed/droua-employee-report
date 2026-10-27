const zlib = require("zlib");
const { extractQrTextFromPdf, looksLikePdf } = require("../pdf/qrFromPdf");
const { hijriToGregorian } = require("../pdf/hijri");

/* ─── Reads a Riyadh-municipality health certificate PDF, server-side ───

   The certificates (Title "ArkanMedicalCertificateCard", rendered by SQL Server
   Reporting Services) have a broken text layer: every Arabic run is drawn in an
   Identity-H font whose ToUnicode CMap is wrong, so pdfjs / pdftotext return
   garbage for the name, nationality and occupation. The embedded fonts still
   carry their own `cmap` table, which maps code points — including the Arabic
   presentation forms (U+FE70…) that each shaped glyph stands for — to glyph
   ids. Inverting it recovers the text: glyph id → code point → NFKC (folds
   the presentation forms back to plain letters), then the run is reversed
   because it was laid out visually, right to left.

   Each card row is a clip cell (`q … re W n BT … ET Q`): the value cell is
   drawn first, then its label cell. So a value is simply the cell right before
   the label that names it — no coordinate guessing. A value that wraps onto
   several lines (or onto the next page) is joined with spaces.

   Nothing is guessed: a field the file doesn't carry is left out, and the
   caller decides whether what came back is enough (certNo + idNumber).
   Pure parsing — no network, no fetching of the QR payload. */

const LIMITS = { maxBytes: 5 * 1024 * 1024, maxPages: 6, maxPhotoBytes: 300 * 1024, maxField: 120 };

/* Labels as printed on the card, after normalizeLabel(). */
const LABELS = {
  "رقم الشهاده": "certNo",
  "مكان الاصدار": "issuer",
  "نهايه الصلاحيه": "expiryHijri",
  "تاريخ الانتهاء": "expiryHijri",
  "الاسم": "name",
  "رقم الهويه": "idNumber",
  "الجنس": "gender",
  "الجنسيه": "nationality",
  "المهنه": "occupation",
};

const normalizeLabel = (s) =>
  String(s).normalize("NFKC").replace(/[إأآ]/g, "ا").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();

/* ---------- PDF objects ---------- */

function readObjects(buf) {
  const latin = buf.toString("latin1"); // byte-preserving: index == byte offset
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const end = latin.indexOf("endobj", m.index);
    if (end < 0) break;
    const body = latin.slice(m.index + m[0].length, end);
    const s = body.indexOf("stream");
    let dict = body;
    let stream = null;
    if (s >= 0) {
      dict = body.slice(0, s);
      let start = m.index + m[0].length + s + "stream".length;
      if (latin[start] === "\r") start++;
      if (latin[start] === "\n") start++;
      const len = Number((dict.match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/) || [])[1]);
      const stop = len ? start + len : latin.lastIndexOf("endstream", end);
      stream = buf.subarray(start, stop);
    }
    objects.set(Number(m[1]), { dict, stream });
    re.lastIndex = end;
  }
  return objects;
}

function decoded(obj) {
  if (!obj || !obj.stream) return null;
  if (!/\/FlateDecode/.test(obj.dict)) return obj.stream;
  try { return zlib.inflateSync(obj.stream); } catch { return null; }
}

const ref = (dict, key) => {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`));
  return m ? Number(m[1]) : null;
};

/* ---------- TrueType `cmap` table → glyph id to code point ---------- */

/* Returns a Map(glyphId → code point) from the font's Unicode cmap subtable
   (format 12 preferred, else format 4). When several code points share one
   glyph (ا and its isolated form ﺍ), the first wins — NFKC folds them alike. */
function glyphCodepoints(font) {
  if (!font || font.length < 12) return null;
  const numTables = font.readUInt16BE(4);
  let cmap = null;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > font.length) return null;
    if (font.toString("latin1", rec, rec + 4) === "cmap") cmap = font.readUInt32BE(rec + 8);
  }
  if (cmap == null || cmap + 4 > font.length) return null;
  const subtables = [];
  const count = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < count; i++) {
    const r = cmap + 4 + i * 8;
    if (r + 8 > font.length) break;
    const platform = font.readUInt16BE(r), encoding = font.readUInt16BE(r + 2);
    const off = cmap + font.readUInt32BE(r + 4);
    if (off + 4 > font.length) continue;
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode) subtables.push({ off, format: font.readUInt16BE(off) });
  }
  const pick = subtables.find((t) => t.format === 12) || subtables.find((t) => t.format === 4);
  if (!pick) return null;

  const map = new Map();
  const add = (cp, gid) => { if (gid && !map.has(gid)) map.set(gid, cp); };
  const o = pick.off;
  if (pick.format === 12) {
    const groups = font.readUInt32BE(o + 12);
    for (let g = 0; g < groups && o + 16 + g * 12 + 12 <= font.length; g++) {
      const b = o + 16 + g * 12;
      const start = font.readUInt32BE(b), stop = font.readUInt32BE(b + 4), gid = font.readUInt32BE(b + 8);
      for (let cp = start; cp <= stop && cp - start < 0x10000; cp++) add(cp, gid + (cp - start));
    }
    return map;
  }
  const segX2 = font.readUInt16BE(o + 6);
  const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  if (ranges + segX2 > font.length) return null;
  for (let i = 0; i < segX2; i += 2) {
    const stop = font.readUInt16BE(ends + i), start = font.readUInt16BE(starts + i);
    const delta = font.readInt16BE(deltas + i), rangeOff = font.readUInt16BE(ranges + i);
    for (let cp = start; cp <= stop && cp !== 0xffff; cp++) {
      let gid;
      if (!rangeOff) gid = (cp + delta) & 0xffff;
      else {
        const at = ranges + i + rangeOff + (cp - start) * 2;
        if (at + 2 > font.length) continue;
        gid = font.readUInt16BE(at);
        if (gid) gid = (gid + delta) & 0xffff;
      }
      add(cp, gid);
    }
  }
  return map;
}

/* Resolves each font resource of a page to a decoder: Identity-H fonts decode
   2-byte glyph ids through the post table, simple fonts read bytes as Latin. */
function fontDecoders(objects, pageDict) {
  const decoders = {};
  const fontBlock = (pageDict.match(/\/Font\s*<<([^>]*)>>/) || [])[1] || "";
  for (const [, name, num] of fontBlock.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
    const font = objects.get(Number(num));
    if (!font) continue;
    if (!/\/Identity-H/.test(font.dict)) { decoders[name] = { cid: false }; continue; }
    const desc = objects.get(Number((font.dict.match(/\/DescendantFonts\s*\[\s*(\d+)/) || [])[1]));
    const fd = desc && objects.get(ref(desc.dict, "FontDescriptor"));
    const file = fd && objects.get(ref(fd.dict, "FontFile2"));
    decoders[name] = { cid: true, cps: glyphCodepoints(decoded(file)) };
  }
  return decoders;
}

/* ---------- content stream → clip cells of text ---------- */

function unescapeLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) =>
    /^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[c] || c));
}

function decodeRun(operand, dec) {
  if (!dec) return "";
  const parts = [...operand.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)];
  if (!dec.cid) return parts.map((p) => (p[2] != null ? unescapeLiteral(p[2]) : "")).join("");
  if (!dec.cps) return "";
  let visual = "";
  for (const p of parts) {
    const hex = (p[1] || "").replace(/\s+/g, "");
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      const cp = dec.cps.get(parseInt(hex.slice(i, i + 4), 16));
      if (cp) visual += String.fromCodePoint(cp);
    }
  }
  return [...visual].reverse().join("").normalize("NFKC");
}

function pageCells(content, decoders) {
  const cells = [];
  const cellRe = /q\s+[\d.\s-]+re\s+W\s+n\s+((?:BT[\s\S]*?ET\s*)+)Q/g;
  let m;
  while ((m = cellRe.exec(content)) !== null) {
    const lines = [];
    for (const bt of m[1].matchAll(/BT([\s\S]*?)ET/g)) {
      const font = (bt[1].match(/\/(\w+)\s+[\d.]+\s+Tf/) || [])[1];
      const runs = [...bt[1].matchAll(/(\[[\s\S]*?\]\s*TJ|(?:<[0-9a-fA-F\s]*>|\((?:\\.|[^\\)])*\))\s*Tj)/g)];
      const text = runs.map((r) => decodeRun(r[1], decoders[font])).join("").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
    if (lines.length) cells.push(lines.join(" "));
  }
  return cells;
}

function pageList(objects) {
  const root = [...objects.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict) && /\/Kids/.test(o.dict));
  const kids = root ? [...((root.dict.match(/\/Kids\s*\[([^\]]*)\]/) || [])[1] || "").matchAll(/(\d+)\s+0\s+R/g)].map((k) => Number(k[1])) : [];
  return kids.map((n) => objects.get(n)).filter((o) => o && /\/Type\s*\/Page\b/.test(o.dict)).slice(0, LIMITS.maxPages);
}

/* ---------- fields ---------- */

function collectFields(objects) {
  const fields = {};
  let pending = null; // last value cell not yet claimed by a label
  for (const page of pageList(objects)) {
    const contentRef = ref(page.dict, "Contents");
    const content = decoded(objects.get(contentRef));
    if (!content) continue;
    for (const cell of pageCells(content.toString("latin1"), fontDecoders(objects, page.dict))) {
      const key = LABELS[normalizeLabel(cell)];
      if (key) {
        if (pending && !fields[key]) fields[key] = pending.slice(0, LIMITS.maxField);
        pending = null;
      } else {
        /* A value split across pages arrives as two cells before its label. */
        pending = pending ? `${pending} ${cell}` : cell;
      }
    }
  }
  return fields;
}

/* The card photo is the only DCTDecode image; kept as the original JPEG bytes. */
function extractPhoto(objects) {
  for (const o of objects.values()) {
    if (!/\/Subtype\s*\/Image/.test(o.dict) || !/\/DCTDecode/.test(o.dict) || !o.stream) continue;
    const jpeg = o.stream;
    if (jpeg.length > LIMITS.maxPhotoBytes || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) continue;
    return Buffer.from(jpeg);
  }
  return null;
}

function hijriParts(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? { d: +m[1], m: +m[2], y: +m[3] } : null;
}

/* Returns { ok, card, reason }. Never throws. */
function extractMunicipalCard(buf) {
  try {
    if (!looksLikePdf(buf)) return { ok: false, reason: "not_pdf" };
    if (buf.length > LIMITS.maxBytes) return { ok: false, reason: "too_large" };
    const objects = readObjects(buf);
    const f = collectFields(objects);

    const card = {};
    const certNo = (f.certNo || "").replace(/[^\d-]/g, "");
    if (/^\d{3,}-\d{4}$/.test(certNo)) card.certNo = certNo;
    const idNumber = (f.idNumber || "").replace(/\D/g, "");
    if (/^\d{10}$/.test(idNumber)) card.idNumber = idNumber;
    for (const k of ["name", "issuer", "gender", "nationality", "occupation"]) if (f[k]) card[k] = f[k];

    const h = hijriParts(f.expiryHijri);
    if (h) {
      card.expiryHijri = `${h.y}-${String(h.m).padStart(2, "0")}-${String(h.d).padStart(2, "0")}`;
      const g = hijriToGregorian(h.y, h.m, h.d);
      if (g) card.expiryDate = g;
    }

    const qrText = extractQrTextFromPdf(buf);
    if (qrText) card.qrText = qrText;
    const photo = extractPhoto(objects);
    if (photo) card.photo = photo;

    if (!card.certNo || !card.idNumber) return { ok: false, reason: "not_a_municipal_card", card };
    return { ok: true, card };
  } catch (err) {
    return { ok: false, reason: "parse_failed" };
  }
}

module.exports = { extractMunicipalCard, glyphCodepoints, normalizeLabel, LABELS, LIMITS };
