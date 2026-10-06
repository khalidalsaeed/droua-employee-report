const test = require("node:test");
const assert = require("node:assert/strict");

/* ─── منطق الوحدة الخالص: التحقّق والأنواع والملفّات والواجهة ───────────── */

const V = require("../lib/medins/validate");
const benefits = require("../lib/medins/data/benefits");
const catalog = require("../lib/medins/data/catalog");
const offers = require("../lib/medins/data/offers");
const files = require("../lib/medins/files");
const limits = require("../lib/medins/limits");

test("الغياب ليس صفرًا: الفارغ null، والصفر الصريح صفر", () => {
  for (const blank of [undefined, null, "", "   "]) {
    assert.equal(V.int(blank, { label: "x", min: 0, max: 9 }), null);
    assert.equal(V.money(blank, { label: "x" }), null);
    assert.equal(V.percent(blank, { label: "x" }), null);
  }
  assert.equal(V.int(0, { label: "x", min: 0, max: 9 }), 0);
  assert.equal(V.money("0", { label: "x" }), "0");
  assert.equal(V.percent(0, { label: "x" }), "0");
  assert.equal(V.money("1,250,000.50", { label: "x" }), "1250000.50");
  for (const bad of ["-1", "1.234", "abc", "1e5"]) assert.throws(() => V.money(bad, { label: "x" }));
  assert.throws(() => V.percent("100.5", { label: "x" }));
  assert.throws(() => V.date("2026-02-29", { label: "x" }));
  assert.equal(V.date("2028-02-29", { label: "x" }), "2028-02-29");
  assert.throws(() => V.coordinate("24.12345678", { label: "x", min: -90, max: 90 }));
});

test("الحقول: المجهول يُرفض، والممنوع يُرفض باسمه", () => {
  assert.throws(() => V.pick({ a: 1, foo: 2 }, ["a"]), /foo/);
  for (const forbidden of ["id", "premiumPerHead", "approvedAt", "blobPathname", "encKeyId", "role", "userId", "verifiedAt", "partCount"]) {
    assert.throws(() => V.pick({ [forbidden]: 1 }, ["title"]), new RegExp(`لا يُقبل من الطلب: ${forbidden}`));
  }
  assert.throws(() => V.pick([], ["a"]));
  assert.throws(() => V.pick(null, ["a"]));
});

test("النصوص: محارف التحكّم وقلب الاتجاه تُنزع، والحدّ يُفرض", () => {
  assert.equal(V.text("‮abc\u0007 ", { label: "x", max: 10 }), "abc");
  assert.equal(V.text("a\nb", { label: "x", max: 10 }), "a b");
  assert.equal(V.text("a\nb", { label: "x", max: 10, multiline: true }), "a\nb");
  assert.throws(() => V.text("x".repeat(11), { label: "x", max: 10 }));
  assert.throws(() => V.text("  ", { label: "x", max: 10, required: true }));
});

const CATALOG = new Map([
  ["amt", { code: "amt", label_ar: "مبلغ", value_type: "amount", active: true }],
  ["pct", { code: "pct", label_ar: "نسبة", value_type: "percent", active: true }],
  ["yes", { code: "yes", label_ar: "نعم", value_type: "boolean", active: true }],
  ["cnt", { code: "cnt", label_ar: "عدد", value_type: "count", active: true }],
  ["txt", { code: "txt", label_ar: "نص", value_type: "text", active: true }],
  ["old", { code: "old", label_ar: "قديم", value_type: "amount", active: false }],
]);

test("القيم: known تحتاج قيمة صالحة لنوع البند بالضبط", () => {
  const p = (e) => benefits.parseEntry(e, CATALOG);
  assert.equal(p({ code: "amt", status: "known", value: 0 }).amount, "0");
  assert.equal(p({ code: "pct", status: "known", value: "12.5" }).percent, "12.5");
  assert.equal(p({ code: "yes", status: "known", value: false }).bool, false);
  assert.equal(p({ code: "cnt", status: "known", value: 0 }).count, 0);
  assert.equal(p({ code: "txt", status: "known", value: "جناح" }).text, "جناح");
  const one = p({ code: "amt", status: "known", value: 5 });
  assert.deepEqual([one.percent, one.bool, one.count, one.text], [null, null, null, null], "قيمةٌ في عمودين");
  for (const bad of [
    { code: "amt", status: "known" }, { code: "amt", status: "known", value: "" },
    { code: "pct", status: "known", value: 101 }, { code: "yes", status: "known", value: "true" },
    { code: "cnt", status: "known", value: 1.5 }, { code: "amt", status: "known", value: -1 },
    { code: "txt", status: "known", value: "  " }, { code: "nope", status: "unknown" },
    { code: "amt", status: "maybe" }, { code: "old", status: "known", value: 1 },
    { code: "amt", status: "known", value: 1, extra: 1 },
  ]) assert.throws(() => p(bad), JSON.stringify(bad));
});

test("القيم: unknown و not_applicable لا يحملان قيمة — والقيمة المرفقة تُرفض لا تُتجاهل", () => {
  for (const status of ["unknown", "not_applicable"]) {
    const e = benefits.parseEntry({ code: "amt", status }, CATALOG);
    assert.deepEqual([e.amount, e.percent, e.bool, e.count, e.text], [null, null, null, null, null]);
    assert.throws(() => benefits.parseEntry({ code: "amt", status, value: 0 }, CATALOG), /لا تُرسل قيمة/);
    assert.throws(() => benefits.parseEntry({ code: "yes", status, value: false }, CATALOG), /لا تُرسل قيمة/);
  }
  /* بندٌ معطَّل يقبل «غير معروف» (تصحيح قيمٍ قديمة) ولا يقبل قيمة جديدة */
  assert.equal(benefits.parseEntry({ code: "old", status: "unknown" }, CATALOG).status, "unknown");
});

test("القراءة: القيمة تُعرض بنوعها، وما ليس known قيمته null", () => {
  assert.equal(benefits.view({ value_status: "known", amount_value: "0.00" }).value, 0);
  assert.equal(benefits.view({ value_status: "known", bool_value: false }).value, false);
  assert.equal(benefits.view({ value_status: "unknown" }).value, null);
  assert.equal(benefits.view({ value_status: "not_applicable" }).value, null);
});

test("الكتالوج: الوحدة تطابق النوع", () => {
  catalog.checkUnit("amount", "SAR");
  catalog.checkUnit("percent", "percent");
  catalog.checkUnit("count", "session");
  catalog.checkUnit("boolean", null);
  for (const [t, u] of [["amount", "percent"], ["percent", "SAR"], ["boolean", "SAR"], ["text", "day"], ["count", "SAR"]]) {
    assert.throws(() => catalog.checkUnit(t, u), `${t}/${u}`);
  }
  assert.ok(catalog.CODE_RE.test("annual_limit"));
  for (const bad of ["Annual", "1abc", "ab", "a-b", "a b"]) assert.ok(!catalog.CODE_RE.test(bad), bad);
});

test("دورة الحالة: لا قفز إلى الاعتماد، والمؤرشف يعود مسودّة فقط", () => {
  const T = offers.TRANSITIONS;
  assert.ok(!T.draft.includes("approved"));
  assert.deepEqual(T.archived, ["draft"]);
  for (const s of offers.STATUSES) assert.ok(Array.isArray(T[s]));
  for (const s of offers.STATUSES) if (s !== "archived") assert.ok(T[s].includes("archived"), s);
});

test("الملفّات: عدد الأجزاء وحجم كلٍّ منها يحسبهما الخادم", () => {
  const P = limits.FILES.PART_BYTES;
  const { partCountFor, expectedPartSize } = files.pure;
  assert.equal(partCountFor(1), 1);
  assert.equal(partCountFor(P), 1);
  assert.equal(partCountFor(P + 1), 2);
  assert.equal(partCountFor(limits.FILES.MAX_FILE_BYTES), limits.FILES.MAX_PARTS);
  assert.equal(expectedPartSize(P + 10, 2, 0), P);
  assert.equal(expectedPartSize(P + 10, 2, 1), 10);
});

test("الملفّات: التوقيع الحقيقيّ لكل صيغة، وCSV بـUTF-8 صارم", () => {
  const { SIGNATURES, fullSignatureOk } = files.pure;
  assert.ok(SIGNATURES.pdf(Buffer.from("%PDF-1.7")));
  assert.ok(!SIGNATURES.pdf(Buffer.from("MZ\x90\x00")));
  assert.ok(SIGNATURES.xlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])));
  assert.ok(!SIGNATURES.xlsx(Buffer.from("%PDF-")));
  assert.ok(SIGNATURES.xls(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])));
  assert.ok(!SIGNATURES.csv(Buffer.from([0x61, 0x00])));
  assert.ok(fullSignatureOk("csv", Buffer.from("مستشفى,حي\n", "utf8")));
  assert.ok(!fullSignatureOk("csv", Buffer.from([0x61, 0xff])));
  assert.ok(!fullSignatureOk("exe", Buffer.from("MZ")));
});

test("الملفّات: الاسم يُنقّى ولا يصير مسارًا", () => {
  const { normalizeFileName } = files.pure;
  assert.equal(normalizeFileName("../../etc/passwd.pdf"), ".._.._etc_passwd.pdf");
  assert.equal(normalizeFileName("a\\b.pdf"), "a_b.pdf");
  assert.equal(normalizeFileName("fdp.exe‮.pdf"), "fdp.exe.pdf");
  assert.equal(normalizeFileName("a\r\nb.pdf"), "ab.pdf");
  assert.throws(() => normalizeFileName("\u0000\u0001"));
  assert.throws(() => normalizeFileName("x".repeat(256)));
});

test("الملفّات: ملفّات الوحدة لا تُلمس خارج سياق البوابة", async () => {
  for (const name of ["init", "putPart", "complete", "downloadPart", "remove", "meta", "listForOffer", "listRows", "sweep", "purgeTombstones"]) {
    await assert.rejects(Promise.resolve().then(() => files[name]({})), /لا سياق بوابة/, name);
  }
});

test("الواجهة: الشيفرة المضمَّنة صالحة، وبلا style مضمَّن يُسقطه CSP، وبلا تخزين محلّي", () => {
  const { appClient } = require("../lib/medins/views/client");
  const { gateClient } = require("../lib/medins/views/gate");
  for (const fn of [appClient, gateClient]) {
    const src = fn.toString();
    assert.doesNotThrow(() => new Function(`(${src})`));
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|eval\(|innerHTML\s*=\s*[^;]*\b(location\.(href|hash|search)|document\.cookie)/);
    assert.doesNotMatch(src, /style="/);
  }
  const html = require("../lib/medins/views/app")("bm9uY2U=", { role: "viewer" });
  assert.match(html, /<script nonce="bm9uY2U=">/);
  assert.match(html, /data-role="viewer"/);
  assert.doesNotMatch(html, /<script(?! nonce)/);
  const forged = require("../lib/medins/views/app")("n", { role: '"><script>alert(1)</script>' });
  assert.match(forged, /data-role="viewer"/, "الدور يُحقن في السمة بلا تقييد");
});
