const zlib = require("zlib");
const jsQRmodule = require("jsqr");

const jsQR = jsQRmodule.default || jsQRmodule;

/* ─── Reads the QR code out of an Ajeer permit PDF, server-side ───

   Ajeer permits embed their verification QR as a plain raster image XObject
   (FlateDecode, 8 bits/component, DeviceGray or DeviceRGB, PNG-predicted), so
   the whole job is: inflate the stream with Node's built-in zlib, undo the PNG
   predictor, and hand the pixels to jsQR. No page rasterizing, no native
   canvas, no OCR, and no extra Serverless Function.

   SECURITY: the decoded value is treated as opaque text. It is never fetched,
   parsed as a URL, or executed — this module does no network I/O at all. */

const PDF_MAGIC = "%PDF-";

/* Bounds so a hostile or malformed file can't turn one upload into a
   long-running CPU/memory job. Real permits sit far under all of these. */
const LIMITS = {
  maxPdfBytes: 20 * 1024 * 1024,
  maxImages: 24, // candidates collected before we stop scanning
  maxPixels: 4_000_000, // per image (~2000x2000)
  maxDecodeAttempts: 8, // jsQR calls per PDF
  maxTextLength: 4096, // stored QR payload cap
};

function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 5 && buf.subarray(0, 5).toString("latin1") === PDF_MAGIC;
}

/* PDF /DecodeParms /Predictor >= 10 means the stream is PNG-filtered: every row
   is prefixed with a filter-type byte that has to be reversed. Same algorithm
   as the PNG spec (None/Sub/Up/Average/Paeth). */
function undoPngPredictor(raw, bytesPerRow, bpp) {
  const stride = bytesPerRow + 1;
  const rows = Math.floor(raw.length / stride);
  const out = Buffer.alloc(rows * bytesPerRow);
  let prev = Buffer.alloc(bytesPerRow);
  for (let r = 0; r < rows; r++) {
    const filterType = raw[r * stride];
    const src = raw.subarray(r * stride + 1, (r + 1) * stride);
    const cur = Buffer.alloc(bytesPerRow);
    for (let i = 0; i < bytesPerRow; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; // left
      const b = prev[i]; // above
      const c = i >= bpp ? prev[i - bpp] : 0; // upper-left
      let v = src[i];
      if (filterType === 1) v += a;
      else if (filterType === 2) v += b;
      else if (filterType === 3) v += (a + b) >> 1;
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, r * bytesPerRow);
    prev = cur;
  }
  return out;
}

/* Collects decodable image XObjects. Deliberately narrow: only the uncompressed
   8-bit Flate forms that Ajeer PDFs actually use. Anything else (JPEG/JPX/CCITT,
   1-bit masks, exotic colour spaces) is skipped rather than half-handled — the
   caller degrades to "couldn't extract" and the manual upload stays available. */
function extractImages(buf) {
  const latin = buf.toString("latin1"); // byte-preserving: string index == byte offset
  const images = [];
  const objRe = /(\d+)\s+(\d+)\s+obj/g;
  let match;
  while ((match = objRe.exec(latin)) !== null && images.length < LIMITS.maxImages) {
    const start = match.index;
    const endObj = latin.indexOf("endobj", start);
    if (endObj < 0) continue;
    const block = latin.slice(start, endObj);
    if (!/\/Subtype\s*\/Image/.test(block)) continue;
    if (!/\/FlateDecode/.test(block)) continue;

    const width = Number((block.match(/\/Width\s+(\d+)/) || [])[1]);
    const height = Number((block.match(/\/Height\s+(\d+)/) || [])[1]);
    const bpc = Number((block.match(/\/BitsPerComponent\s+(\d+)/) || [])[1]);
    const channels = /\/DeviceRGB/.test(block) ? 3 : /\/DeviceGray/.test(block) ? 1 : 0;
    if (!width || !height || bpc !== 8 || !channels) continue;
    if (width * height > LIMITS.maxPixels) continue;

    const streamKeyword = block.indexOf("stream");
    if (streamKeyword < 0) continue;
    let dataStart = start + streamKeyword + "stream".length;
    if (latin[dataStart] === "\r") dataStart++;
    if (latin[dataStart] === "\n") dataStart++;
    const endStream = latin.indexOf("endstream", dataStart);
    if (endStream < 0) continue;

    let raw;
    try {
      raw = zlib.inflateSync(buf.subarray(dataStart, endStream));
    } catch {
      continue; // not a stream we can read; skip quietly
    }

    const bytesPerRow = width * channels;
    const predictor = Number((block.match(/\/Predictor\s+(\d+)/) || [])[1] || 1);
    if (predictor >= 10) raw = undoPngPredictor(raw, bytesPerRow, channels);
    if (raw.length < width * height * channels) continue; // truncated

    images.push({ width, height, channels, raw });
  }
  return images;
}

function toRGBA({ width, height, channels, raw }) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b;
    if (channels === 1) {
      r = g = b = raw[i];
    } else {
      r = raw[i * 3];
      g = raw[i * 3 + 1];
      b = raw[i * 3 + 2];
    }
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = 255;
  }
  return px;
}

/* Returns the decoded QR text, or null when there's nothing readable.
   Never throws — a permit upload must succeed even if extraction doesn't. */
function extractQrTextFromPdf(buf) {
  try {
    if (!looksLikePdf(buf) || buf.length > LIMITS.maxPdfBytes) return null;

    /* A QR is square, so try the squarest (then smallest) candidates first —
       that lands on the QR immediately instead of grinding through the
       full-width header graphics on every upload. */
    const ranked = extractImages(buf)
      .map((im) => ({ im, squareness: Math.abs(im.width / im.height - 1), area: im.width * im.height }))
      .sort((a, b) => a.squareness - b.squareness || a.area - b.area)
      .slice(0, LIMITS.maxDecodeAttempts);

    for (const { im } of ranked) {
      const result = jsQR(toRGBA(im), im.width, im.height);
      const text = result && typeof result.data === "string" ? result.data.trim() : "";
      if (text) return text.slice(0, LIMITS.maxTextLength);
    }
    return null;
  } catch (err) {
    console.error("QR extraction failed:", err && err.message);
    return null;
  }
}

module.exports = { extractQrTextFromPdf, looksLikePdf, LIMITS };
