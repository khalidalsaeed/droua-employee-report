/* ─── Arabic text shaping for pdfmake ───

   pdfmake/pdfkit draw a run's words left-to-right in logical order, and do not
   implement the bidi algorithm. For Arabic that puts the FIRST word furthest
   left, i.e. the whole line reads backwards. Three things are therefore done
   here, and the order matters:

   1. WORD order is reversed, but each word's letters are left in logical order.
      fontkit (under pdfkit) shapes and connects the letters from the logical
      form, so reversing letters — which a full bidi reorder does — produces
      disconnected, mirrored text. Reversing only whole words gives correct
      right-to-left reading while keeping shaping intact, and leaves embedded
      Latin/numbers ("TKT-2026-0007", "Pending") internally left-to-right.

   2. Every word and every space becomes its own inline fragment. pdfmake's text
      breaker otherwise loses part of the inter-word space width, which makes
      words look glued together.

   3. Long text is wrapped HERE rather than by pdfmake, because word order has to
      be reversed per visual line. If a reversed string were handed to pdfmake to
      wrap, the end of the sentence would land on the first line. Widths are
      measured with the same font pdfmake will use, so the breaks match.

   Arabic-Indic digits are folded to 0-9: they inherit the run's RTL direction
   and come out reversed ("٢٠٢٦/٠٨/٣١" → "١٣/٨٠/٦٢٠٢"). */

const fs = require("fs");
const path = require("path");

const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const toWesternDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => AR_DIGITS[d]);

/* Paired punctuation has to be swapped when a run is laid out right-to-left —
   the Unicode "mirroring" step. Without it "(ملاحظة)" comes out as ")ملاحظة(". */
const MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«", "‹": "›", "›": "‹" };
const mirrorPairs = (s) => String(s).replace(/[()[\]{}<>«»‹›]/g, (c) => MIRROR[c]);

/* fontkit instances are cached: opening a 236 KB face per cell would dominate
   report generation time. */
const cache = new Map();
function loadFont(file) {
  if (cache.has(file)) return cache.get(file);
  const fontkit = require("@foliojs-fork/fontkit");
  const f = fontkit.openSync(file);
  cache.set(file, f);
  return f;
}

/* Width in points of a single token, using the real font metrics. */
function tokenWidth(font, token, fontSize) {
  if (!token) return 0;
  const run = font.layout(token);
  const units = run.glyphs.reduce((sum, g) => sum + g.advanceWidth, 0);
  return (units / font.unitsPerEm) * fontSize;
}

/* Greedy line breaking over whitespace, in LOGICAL order. */
function breakIntoLines(font, text, maxWidth, fontSize) {
  const words = toWesternDigits(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [[]];
  const spaceW = tokenWidth(font, " ", fontSize);
  const lines = [];
  let line = [];
  let width = 0;
  for (const w of words) {
    const ww = tokenWidth(font, w, fontSize);
    const add = line.length ? spaceW + ww : ww;
    if (line.length && width + add > maxWidth) {
      lines.push(line);
      line = [w];
      width = ww;
    } else {
      line.push(w);
      width += add;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

/* Each fragment becomes its own run, and fontkit lays out a run's own direction
   correctly — but it does NOT reorder across runs. So the fragment ORDER has to
   be the visual one, which means reversing it.

   Splitting has to happen at direction boundaries INSIDE a word too, not just
   at spaces: "و60" is one token but two direction runs, and left whole it
   renders as "و06" with the digits flipped. Latin/digit sequences (and the
   separators inside them, so "2026-08-31" and "TKT-2026-0007" stay intact) form
   one LTR run; everything else is treated as RTL. */
const LTR_RUN = /[A-Za-z0-9][A-Za-z0-9._\-/:%+]*/g;

function directionRuns(token) {
  const runs = [];
  let last = 0;
  let m;
  LTR_RUN.lastIndex = 0;
  while ((m = LTR_RUN.exec(token)) !== null) {
    if (m.index > last) runs.push(token.slice(last, m.index));
    runs.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < token.length) runs.push(token.slice(last));
  return runs.filter((r) => r.length);
}

/* A visual line: word order reversed, direction runs inside each word reversed
   too, and spaces emitted as their own full-width fragments. */
function lineToFragments(words) {
  const pieces = [];
  [...words].reverse().forEach((w, i) => {
    if (i) pieces.push(" ");
    // reverse the run order within the word, keep each run's own text as-is
    for (const run of directionRuns(w).reverse()) pieces.push(run);
  });
  const out = pieces.map((p) => ({ text: p === " " ? " " : mirrorPairs(p) }));
  return out.length ? out : [{ text: "" }];
}

/* ── public API ── */

/* Single-line Arabic: use for titles, labels, table headers and short cells. */
function arLine(text) {
  const words = toWesternDigits(String(text ?? "—")).split(/\s+/).filter(Boolean);
  return lineToFragments(words);
}

/* Arabic that may need to wrap inside a known width. Returns a pdfmake stack so
   each visual line keeps its own reversed word order.
   `available` is the usable width in points (column width minus cell padding). */
function arBlock(text, { available, fontSize = 10, bold = false, fonts, style = {} } = {}) {
  const file = bold ? fonts.bold : fonts.normal;
  const font = loadFont(file);
  /* Break a little narrower than the true width. Our measurement and pdfmake's
     differ by a hair (kerning, rounding); if a composed line ends up even
     slightly too wide, pdfmake re-wraps it and pushes the LAST fragment onto a
     new line — which after reversal is the line's first word, so it appears
     orphaned. Leaving headroom keeps the composed lines authoritative. */
  const safe = Math.max(24, available * 0.96);
  const lines = breakIntoLines(font, String(text ?? "—"), safe, fontSize);
  if (lines.length === 1) return { text: lineToFragments(lines[0]), alignment: "right", fontSize, bold, ...style };
  return {
    stack: lines.map((l) => ({ text: lineToFragments(l), alignment: "right", fontSize, bold })),
    ...style,
  };
}

/* Does this text fit on one line at this width? Lets callers skip the stack. */
function fitsOneLine(text, { available, fontSize = 10, bold = false, fonts }) {
  const font = loadFont(bold ? fonts.bold : fonts.normal);
  return breakIntoLines(font, String(text ?? ""), available, fontSize).length === 1;
}

module.exports = { arLine, arBlock, fitsOneLine, toWesternDigits, tokenWidth, breakIntoLines, loadFont };
