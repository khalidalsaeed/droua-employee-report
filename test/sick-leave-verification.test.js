const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-sick-leave";

const { makeSickLeavePdf, makeScannedPdf, makeMobileStylePdf, appendIncrementalUpdate, DEFAULT } = require("./helpers/sick-leave-fixtures");
const { makeFakeSql } = require("./helpers/fake-sql");
const { validateUpload, displayName } = require("../lib/sickLeave/validate");
const { extractSickLeave, parseDate, qrSummaryFromText } = require("../lib/sickLeave/extract");
const { compareWithOfficial, compareNames } = require("../lib/sickLeave/compare");
const { runLookup, manualProvider } = require("../lib/sickLeave/provider");
const http = require("../lib/sickLeave/http");
const { SECTION_BY_KEY, PAGE_PERMISSION, defaultPermissionsForRole } = require("../lib/auth/permissions");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* التحقق من الإجازات المرضية: القراءة، والمطابقة، والمسارات، وحرّاس الخصوصية.
   الملفّات هنا اصطناعية تُبنى في الذاكرة — لا إجازة حقيقية في المستودع. */

let pdfCache = null;
async function validPdf() {
  if (!pdfCache) pdfCache = await makeSickLeavePdf({});
  return pdfCache;
}

const FILE = { leaveId: DEFAULT.leaveId, idNumber: DEFAULT.idNumber, name: DEFAULT.name, startDate: "2026-09-15", endDate: "2026-09-17", days: 3 };
const found = (record) => ({ status: "found", record: { leaveId: FILE.leaveId, idNumber: FILE.idNumber, startDate: FILE.startDate, endDate: FILE.endDate, ...record } });

/* ─── الفحص قبل القراءة ─── */

test("validate: يُحكم على النوع من التوقيع لا من الاسم أو الإعلان", async () => {
  const pdf = await validPdf();
  assert.equal(validateUpload(pdf, "application/pdf").kind, "pdf");
  assert.equal(validateUpload(pdf, "application/octet-stream").kind, "pdf");
  assert.equal(validateUpload(pdf, "image/png").reason, "type_mismatch");
  assert.equal(validateUpload(Buffer.from("MZ".padEnd(200, "x")), "application/pdf").reason, "unsupported_type");
  assert.equal(validateUpload(Buffer.from("<html><script>alert(1)</script>".padEnd(200, " ")), "application/pdf").reason, "unsupported_type");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  assert.equal(validateUpload(png, "image/png").kind, "png");
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
  assert.equal(validateUpload(jpeg, "image/jpeg").kind, "jpeg");
  assert.equal(validateUpload(Buffer.alloc(0), "application/pdf").reason, "empty");
  assert.equal(validateUpload(Buffer.alloc(5 * 1024 * 1024, 0x25), "application/pdf").reason, "too_large");
});

test("validate: لا فحص شكليًّا لـ%%EOF — المحلّل هو الحَكَم، والترويسة ضمن أوّل 1024 بايتًا", async () => {
  const pdf = await validPdf();
  assert.equal(validateUpload(pdf.subarray(0, Math.floor(pdf.length / 2)), "application/pdf").kind, "pdf");
  assert.equal(validateUpload(Buffer.concat([Buffer.from("\r\n junk\n"), pdf]), "application/pdf").kind, "pdf");
  assert.equal(validateUpload(Buffer.concat([Buffer.alloc(1100, 0x20), pdf]), "application/pdf").reason, "unsupported_type");
});

test("validate: اسم الملف للعرض فقط — بلا مسارات ولا محارف تحكّم", () => {
  assert.equal(displayName(encodeURIComponent("../../etc/passwd")), "passwd");
  assert.equal(displayName("..%2F..%2Fsecret.pdf"), "secret.pdf");
  assert.equal(displayName("C:\\Users\\x\\leave.pdf"), "leave.pdf");
  assert.equal(displayName("a\u0000b<script>.pdf"), "abscript.pdf");
  assert.equal(displayName(""), "ملف");
  assert.ok(displayName("x".repeat(500)).length <= 120);
});

/* ─── القراءة ─── */

test("extract: PDF صالح — المفاتيح الأربعة والاسم والأيام والبيانات الإضافية", async () => {
  const r = await extractSickLeave(await validPdf());
  assert.equal(r.ok, true);
  assert.equal(r.status, "extracted");
  assert.deepEqual(r.missing, []);
  assert.equal(r.fields.leaveId, "GSL25091234567");
  assert.equal(r.fields.idNumber, "2456789012");
  assert.equal(r.fields.name, "AHMED MOHAMMED ALI");
  assert.equal(r.fields.startDate, "2026-09-15");
  assert.equal(r.fields.endDate, "2026-09-17");
  assert.equal(r.fields.days, 3);
  assert.equal(r.fields.issueDate, "2026-09-15");
  assert.equal(r.fields.practitioner, "Dr. Sara Khalid");
  assert.equal(r.fields.employer, "Test Trading Co");
  assert.deepEqual(r.warnings, []);
});

test("extract: PDF تالف البنية → malformed، لا استثناء", async () => {
  const junk = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >>\nendobj\ngarbage garbage\n%%EOF\n", "latin1");
  const r = await extractSickLeave(junk);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "malformed");
});

test("extract: ملف ليس إجازة مرضية → not_sick_leave", async () => {
  const r = await extractSickLeave(await makeSickLeavePdf({}, { notSickLeave: true }));
  assert.deepEqual(r, { ok: false, reason: "not_sick_leave" });
});

test("extract: ملف ممسوح بلا طبقة نصّ → scanned (إدخال يدوي، لا OCR)", async () => {
  assert.deepEqual(await extractSickLeave(makeScannedPdf()), { ok: false, reason: "scanned" });
});

test("extract: ملف بصفحات كثيرة (PDF bomb محتمل) يُرفض قبل قراءة أي صفحة", async () => {
  const PdfPrinter = require("pdfmake/src/printer");
  const fonts = { Thmanyah: { normal: path.join(ROOT, "assets/fonts/thmanyah-sans-400.ttf") } };
  const doc = new PdfPrinter(fonts).createPdfKitDocument({
    content: Array.from({ length: 12 }, (_, i) => ({ text: `Sick Leave page ${i}`, pageBreak: i ? "before" : undefined })),
    defaultStyle: { font: "Thmanyah" },
  });
  const buf = await new Promise((resolve) => { const c = []; doc.on("data", (x) => c.push(x)); doc.on("end", () => resolve(Buffer.concat(c))); doc.end(); });
  assert.equal((await extractSickLeave(buf)).reason, "too_many_pages");
});

test("extract: مهلة القراءة محدودة → timeout بدل تعليق الدالّة", async () => {
  const r = await extractSickLeave(await validPdf(), { timeoutMs: 1 });
  /* على جهاز سريع جدًا قد تنتهي القراءة قبل المهلة؛ المهمّ ألا تتجاوزها بصمت. */
  assert.ok(r.ok || r.reason === "timeout");
});

test("extract: حقل ناقص → partial مع قائمة الناقص، لا تخمين", async () => {
  const r = await extractSickLeave(await makeSickLeavePdf({ idNumber: null }));
  assert.equal(r.status, "partial");
  assert.deepEqual(r.missing, ["idNumber"]);
  assert.equal(r.fields.idNumber, null);
});

test("extract: أيام مطبوعة لا تطابق التاريخين → تحذير", async () => {
  const r = await extractSickLeave(await makeSickLeavePdf({ days: "5" }));
  assert.ok(r.warnings.includes("days_inconsistent"));
});

test("extract: التواريخ — dd-mm-yyyy و yyyy-mm-dd والهجري، ولا تاريخ مستحيل", () => {
  assert.equal(parseDate("15-09-2026").iso, "2026-09-15");
  assert.equal(parseDate("2026/09/15").iso, "2026-09-15");
  assert.equal(parseDate("٠١-٠٢-٢٠٢٦").iso, "2026-02-01");
  assert.equal(parseDate("31-02-2026"), null);
  assert.equal(parseDate("1448-03-01").calendar, "hijri");
});

/* ─── المطابقة ─── */

test("compare: كل المفاتيح متطابقة → verified", () => {
  const r = compareWithOfficial(FILE, found({ name: FILE.name, days: "3" }));
  assert.equal(r.status, "verified");
  assert.deepEqual(r.differences, []);
});

test("compare: رقم إجازة خاطئ — لا نتيجة في صحة → not_found", () => {
  const r = compareWithOfficial({ ...FILE, leaveId: "GSL25091234568" }, { status: "not_found" });
  assert.equal(r.status, "not_found");
  assert.equal(r.differences[0].code, "leave_not_found");
});

test("compare: رقم إجازة يختلف بخانة واحدة → mismatch (لا مطابقة تقريبية)", () => {
  const r = compareWithOfficial(FILE, found({ leaveId: "GSL25091234568" }));
  assert.equal(r.status, "mismatch");
  assert.deepEqual(r.differences.map((d) => d.code), ["leave_id_mismatch"]);
});

test("compare: هوية خاطئة → mismatch بـid_mismatch", () => {
  const r = compareWithOfficial(FILE, found({ idNumber: "2456789013" }));
  assert.equal(r.status, "mismatch");
  assert.deepEqual(r.differences.map((d) => d.code), ["id_mismatch"]);
});

test("compare: اختلاف التواريخ → كل تاريخ باسمه", () => {
  const r = compareWithOfficial(FILE, found({ startDate: "2026-09-14", endDate: "2026-09-19" }));
  assert.equal(r.status, "mismatch");
  assert.deepEqual(r.differences.map((d) => d.code), ["start_date_mismatch", "end_date_mismatch"]);
  assert.equal(r.differences[0].file, "2026-09-15");
  assert.equal(r.differences[0].official, "2026-09-14");
});

test("compare: اختلاف عدد الأيام وحده → mismatch", () => {
  const r = compareWithOfficial(FILE, found({ days: "5" }));
  assert.deepEqual(r.differences.map((d) => d.code), ["days_mismatch"]);
});

test("compare: اختلاف إملائي بسيط في الاسم فقط → verified مع تنبيه", () => {
  const r = compareWithOfficial(FILE, found({ name: "AHMAD MOHAMMED ALI" }));
  assert.equal(r.status, "verified");
  assert.deepEqual(r.notes.map((n) => n.code), ["name_minor_difference"]);
  const ar = compareNames("أحمد محمد عبد الله", "احمد محمد عبدالله");
  assert.equal(ar.result, "exact");
  assert.equal(compareNames("فاطمة علي", "فاطمه على").result, "exact");
  assert.equal(compareNames("AHMED ALI", "AHMED MOHAMMED ALI").result, "minor");
});

test("compare: اسم مختلف فعلًا → mismatch بـname_mismatch", () => {
  const r = compareWithOfficial(FILE, found({ name: "KHALID SAAD OTAIBI" }));
  assert.equal(r.status, "mismatch");
  assert.deepEqual(r.differences.map((d) => d.code), ["name_mismatch"]);
});

test("compare: اسم بلغة أخرى لا يُقارَن ولا يُسقط التحقّق", () => {
  const r = compareWithOfficial(FILE, found({ name: "أحمد محمد علي" }));
  assert.equal(r.status, "verified");
  assert.deepEqual(r.notes.map((n) => n.code), ["name_not_comparable"]);
});

test("compare: تعطّل صحة → unavailable، وليس invalid", () => {
  const r = compareWithOfficial(FILE, { status: "unavailable", reason: "service_unavailable" });
  assert.equal(r.status, "unavailable");
  assert.deepEqual(r.differences, []);
});

/* ─── مصدر النتيجة الرسمية ─── */

test("provider: عطل الخدمة / المهلة / تجاوز الحدّ → unavailable بسببه", async () => {
  const down = await runLookup({ source: "x", lookup: () => { throw new Error("ECONNRESET"); } }, {});
  assert.deepEqual([down.status, down.reason], ["unavailable", "service_unavailable"]);
  const slow = await runLookup({ source: "x", lookup: () => new Promise(() => {}) }, {}, { timeoutMs: 20 });
  assert.deepEqual([slow.status, slow.reason], ["unavailable", "timeout"]);
  const limited = await runLookup({ source: "x", lookup: () => { const e = new Error("Too Many Requests"); e.status = 429; throw e; } }, {});
  assert.deepEqual([limited.status, limited.reason], ["unavailable", "rate_limited"]);
  const garbage = await runLookup({ source: "x", lookup: () => ({ weird: true }) }, {});
  assert.deepEqual([garbage.status, garbage.reason], ["unavailable", "bad_response"]);
});

test("provider: المصدر اليدوي يحمل وسمه ولا يتّصل بالشبكة", async () => {
  const r = await runLookup(manualProvider({ outcome: "found", startDate: "2026-09-15", endDate: "2026-09-17" }), {});
  assert.equal(r.status, "found");
  assert.equal(r.source, "seha_manual");
  assert.equal((await runLookup(manualProvider({ outcome: "unavailable" }), {})).status, "unavailable");
  assert.equal((await runLookup(manualProvider({ outcome: "not_found" }), {})).status, "not_found");
});

/* ─── المسارات ─── */

function harness(opts = {}) {
  const events = [];
  const perms = new Set(opts.perms || ["sick_leave:view", "sick_leave:verify"]);
  let now = opts.now || Date.UTC(2026, 9, 27, 9, 0, 0);
  const sql = makeFakeSql((call) => {
    if (/FROM audit_log/.test(call.text)) {
      const type = call.values.find((v) => v === http.EV_EXTRACT || v === http.EV_VERIFY);
      const recent = opts.recent != null ? opts.recent : events.filter((e) => e.type === type).length;
      const ref = call.values.find((v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v));
      const dup = ref ? events.find((e) => e.meta && e.meta.fileRef === ref && e.type === http.EV_EXTRACT) : null;
      return [{ recent, dup_ts: dup ? "2026-10-27T08:59:00.000Z" : null }];
    }
    if (/FROM employees/.test(call.text)) return opts.employees ? opts.employees.filter((e) => e.iqama === call.values[0]) : [];
    return [];
  });
  const deps = {
    hasPermission: (actor, s, a) => perms.has(`${s}:${a}`),
    logEvent: async (e) => { events.push(JSON.parse(JSON.stringify(e))); },
    parseBody: (req) => req.body,
    getSql: () => sql,
    readBody: async (req) => req.raw,
    now: () => now,
  };
  const actor = opts.actor || { id: "u-1", email: "hr@example.test" };
  async function call(action, req) {
    const res = {
      statusCode: 200, headers: {}, body: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this.body = o; return this; },
      setHeader(k, v) { this.headers[k] = v; },
    };
    await http.handle({ method: "POST", headers: {}, ...req }, res, actor, action, deps);
    return res;
  }
  const extract = (buf, type = "application/pdf", name = "leave.pdf") =>
    call("extract", { raw: buf, headers: { "content-type": type, "x-filename": encodeURIComponent(name) } });
  const verify = (body) => call("verify", { body });
  return { call, extract, verify, events, sql, advance: (ms) => { now += ms; }, deps };
}

const OFFICIAL_OK = { outcome: "found", startDate: "2026-09-15", endDate: "2026-09-17", name: "AHMED MOHAMMED ALI" };

test("http: مسار كامل — رفع ثم تحقق → verified، والهوية مقنَّعة في الردّ", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  assert.equal(ex.statusCode, 200);
  assert.equal(ex.body.status, "extracted");
  assert.equal(ex.body.fields.idMasked, "••••••9012");
  assert.equal(ex.body.fileName, "leave.pdf");
  const v = await h.verify({ token: ex.body.token, official: OFFICIAL_OK });
  assert.equal(v.statusCode, 200);
  assert.equal(v.body.status, "verified");
  assert.match(v.body.verificationId, /^slv_[0-9a-f]{16}$/);
  assert.equal(v.body.leave.idMasked, "••••••9012");
  assert.equal(v.body.source, "seha_manual");
  assert.equal(v.body.fileSource, "pdf_text");
  assert.ok(!JSON.stringify(v.body).includes("2456789012"), "الردّ لا يحمل الهوية كاملة");
});

test("http: هوية خاطئة — الفرق يُعرض مقنَّعًا", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const v = await h.verify({ token: ex.body.token, official: { ...OFFICIAL_OK, idNumber: "1098765432" } });
  assert.equal(v.body.status, "mismatch");
  assert.deepEqual(v.body.differences, [{ field: "idNumber", code: "id_mismatch", file: "••••••9012", official: "••••••5432" }]);
});

test("http: الحقول المقروءة موقَّعة — تعديلها من المتصفّح لا يغيّر شيئًا", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const v = await h.verify({ token: ex.body.token, file: { startDate: "2026-09-14", leaveId: "GSL000000001" }, official: { ...OFFICIAL_OK, startDate: "2026-09-14" } });
  assert.equal(v.body.status, "mismatch");
  assert.deepEqual(v.body.manualFields, []);
  const [b, s] = ex.body.token.split(".");
  const forged = Buffer.from(b, "base64url").toString().replace("2026-09-15", "2026-09-14");
  const bad = await h.verify({ token: `${Buffer.from(forged).toString("base64url")}.${s}`, official: OFFICIAL_OK });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.reason, "bad_token");
});

test("http: التوكن لمستخدمه ولمدّة محدودة", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const other = harness({ actor: { id: "u-2", email: "x@example.test" } });
  assert.equal((await other.verify({ token: ex.body.token, official: OFFICIAL_OK })).body.reason, "bad_token");
  h.advance(31 * 60 * 1000);
  assert.equal((await h.verify({ token: ex.body.token, official: OFFICIAL_OK })).body.reason, "bad_token");
});

test("http: ملف ممسوح → needs_manual ثم تحقّق بإدخال يدوي موسوم", async () => {
  const h = harness();
  const ex = await h.extract(makeScannedPdf());
  assert.equal(ex.statusCode, 200);
  assert.equal(ex.body.status, "needs_manual");
  const missingFile = await h.verify({ token: ex.body.token, official: OFFICIAL_OK });
  assert.equal(missingFile.statusCode, 400);
  assert.deepEqual(Object.keys(missingFile.body.fields).sort(), ["endDate", "idNumber", "leaveId", "startDate"]);
  const v = await h.verify({ token: ex.body.token, file: { ...FILE }, official: OFFICIAL_OK });
  assert.equal(v.body.status, "verified");
  assert.equal(v.body.fileSource, "manual_entry");
});

test("http: صورة PNG مقبولة بأمان → إدخال يدوي (لا OCR)", async () => {
  const h = harness();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  const ex = await h.extract(png, "image/png", "leave.png");
  assert.equal(ex.body.status, "needs_manual");
  assert.equal(ex.body.reason, "image");
});

test("http: PDF تالف / ليس إجازة / نوع مزيّف → رسائل واضحة بأكواد صحيحة", async () => {
  const h = harness();
  const pdf = await validPdf();
  /* ملفّ لم يقرأه المحلّل لا يُرفض: يُكمل المستخدم الحقول يدويًا. */
  const torn = await h.extract(pdf.subarray(0, 600));
  assert.equal(torn.statusCode, 200);
  assert.equal(torn.body.status, "needs_manual");
  const notLeave = await h.extract(await makeSickLeavePdf({}, { notSickLeave: true }));
  assert.equal(notLeave.statusCode, 422);
  assert.equal(notLeave.body.reason, "not_sick_leave");
  const spoof = await h.extract(pdf, "image/jpeg", "x.jpg");
  assert.equal(spoof.body.reason, "type_mismatch");
});

test("http: تعطّل صحة → unavailable وليست «غير صحيحة»", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const v = await h.verify({ token: ex.body.token, official: { outcome: "unavailable" } });
  assert.equal(v.body.status, "unavailable");
  assert.deepEqual(v.body.differences, []);
});

test("http: رقم إجازة غير موجود في صحة → not_found", async () => {
  const h = harness();
  const ex = await h.extract(await makeSickLeavePdf({ leaveId: "GSL99999999999" }));
  const v = await h.verify({ token: ex.body.token, official: { outcome: "not_found" } });
  assert.equal(v.body.status, "not_found");
});

test("http: الحدّ من الاستخدام يُعدّ في audit_log → 429 مع Retry-After", async () => {
  const h = harness({ recent: http.RATE.maxExtracts });
  const ex = await h.extract(await validPdf());
  assert.equal(ex.statusCode, 429);
  assert.equal(ex.body.reason, "rate_limited");
  assert.ok(ex.headers["Retry-After"]);
  assert.ok(h.sql.matching(/FROM audit_log/).length, "العدّ من القاعدة لا من الذاكرة");
});

test("http: رفع الملف نفسه مرّتين يُعلَّم duplicate ولا يُحجب", async () => {
  const h = harness();
  const pdf = await validPdf();
  const first = await h.extract(pdf);
  const second = await h.extract(pdf);
  assert.equal(first.body.duplicate, null);
  assert.ok(second.body.duplicate && second.body.duplicate.at);
  assert.equal(second.body.status, "extracted");
});

test("http: تحقّقات متتالية مستقلّة — لكل منها معرّف وسجلّ", async () => {
  const h = harness();
  const a = await h.extract(await validPdf());
  const b = await h.extract(await makeSickLeavePdf({ leaveId: "PSL26100000042", idNumber: "1012345678", name: "SARA ALI", start: "01-10-2026", end: "02-10-2026", days: "2" }));
  const va = await h.verify({ token: a.body.token, official: OFFICIAL_OK });
  const vb = await h.verify({ token: b.body.token, official: { outcome: "found", startDate: "2026-10-01", endDate: "2026-10-03" } });
  const vc = await h.verify({ token: a.body.token, official: { outcome: "unavailable" } });
  assert.deepEqual([va.body.status, vb.body.status, vc.body.status], ["verified", "mismatch", "unavailable"]);
  assert.equal(new Set([va.body.verificationId, vb.body.verificationId, vc.body.verificationId]).size, 3);
  assert.equal(vb.body.leave.leaveId, "PSL26100000042");
  assert.equal(h.events.filter((e) => e.type === http.EV_VERIFY).length, 3);
});

test("http: سجلّ التدقيق بلا هوية كاملة ولا اسم ولا رقم إجازة صريح", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  await h.verify({ token: ex.body.token, official: { ...OFFICIAL_OK, name: "AHMAD MOHAMMED ALI" } });
  const dump = JSON.stringify(h.events);
  for (const secret of ["2456789012", "AHMED", "AHMAD", "GSL25091234567", "Sara"]) assert.ok(!dump.includes(secret), `audit يحمل ${secret}`);
  const v = h.events.find((e) => e.type === http.EV_VERIFY);
  assert.deepEqual(Object.keys(v.meta).sort(), ["differences", "employeeEid", "fileRef", "fileSource", "leaveRef", "maskedId", "notes", "officialEntry", "reason", "source", "status", "verificationId"]);
  assert.equal(v.meta.maskedId, "••••••9012");
  assert.match(v.meta.leaveRef, /^[0-9a-f]{32}$/);
  assert.deepEqual(v.meta.notes, ["name_minor_difference"]);
});

test("http: الربط بموظف اختياري — بالهوية حرفيًا وبصلاحية employees:view فقط", async () => {
  const employees = [{ eid: "503", iqama: "2456789012", name: "أحمد" }];
  const withPerm = harness({ perms: ["sick_leave:view", "sick_leave:verify", "employees:view"], employees });
  const ex = await withPerm.extract(await validPdf());
  const v = await withPerm.verify({ token: ex.body.token, official: OFFICIAL_OK });
  assert.deepEqual(v.body.employee, { eid: "503", name: "أحمد" });
  const noPerm = harness({ employees });
  const ex2 = await noPerm.extract(await validPdf());
  const v2 = await noPerm.verify({ token: ex2.body.token, official: OFFICIAL_OK });
  assert.equal(v2.body.employee, null);
  assert.equal(v2.body.status, "verified", "ليس موظفًا في المنصّة ولا يمنع التحقّق");
  assert.equal(noPerm.sql.matching(/FROM employees/).length, 0);
});

test("http: الصلاحيات — view وحدها لا ترفع ولا تتحقّق، وبلا view لا شيء", async () => {
  const viewOnly = harness({ perms: ["sick_leave:view"] });
  assert.equal((await viewOnly.extract(await validPdf())).statusCode, 403);
  const cfg = await viewOnly.call("config", { method: "GET" });
  assert.equal(cfg.body.canVerify, false);
  assert.equal(cfg.body.directIntegration, false);
  const none = harness({ perms: [] });
  assert.equal((await none.call("config", { method: "GET" })).statusCode, 403);
  assert.equal((await viewOnly.call("extract", { method: "GET" })).statusCode, 403);
  const h = harness();
  assert.equal((await h.call("extract", { method: "GET" })).statusCode, 405);
  assert.equal((await h.call("nope", {})).statusCode, 404);
});

test("http: مدخلات نتيجة صحة تُتحقَّق صيغتها", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const r = await h.verify({ token: ex.body.token, official: { outcome: "found", startDate: "not-a-date" } });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(Object.keys(r.body.fields).sort(), ["officialEndDate", "officialStartDate"]);
  const r2 = await h.verify({ token: ex.body.token, official: { outcome: "maybe" } });
  assert.equal(r2.body.fields.outcome, "required");
});

/* ─── حرّاس البنية ─── */

test("structure: الوحدة مستقلّة — لا أجير، ولا تخزين، ولا شبكة، ولا ذكاء اصطناعي", () => {
  const dir = path.join(ROOT, "lib/sickLeave");
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of ["permits", "ajeer", "lib/blob", "@vercel/blob", "require(\"https\")", "require(\"http\")", "fetch(", "writeFile", "console.log", "openai", "anthropic", "tesseract", "puppeteer", "playwright"]) {
      assert.ok(!code.toLowerCase().includes(banned.toLowerCase()), `${f} يذكر ${banned}`);
    }
  }
});

test("structure: لا دالّة خادمة جديدة، والمسارات والصلاحيات مسجّلة", () => {
  const fns = fs.readdirSync(path.join(ROOT, "api"), { recursive: true }).filter((f) => /\.js$/.test(f)).sort();
  assert.deepEqual(fns, ["app.js", path.join("cron", "check-expirations.js")]);
  const vercel = JSON.parse(read("vercel.json"));
  assert.ok(vercel.rewrites.some((r) => r.source === "/sick-leave.html" && r.destination.includes("page=sick-leave")));
  assert.ok(vercel.rewrites.some((r) => r.source === "/api/sick-leave/:path*"));
  assert.deepEqual(SECTION_BY_KEY.sick_leave.actions, ["view", "verify"]);
  assert.equal(PAGE_PERMISSION["sick-leave"], "sick_leave:view");
  assert.ok(defaultPermissionsForRole("hr").includes("sick_leave:verify"));
  assert.ok(!defaultPermissionsForRole("finance").includes("sick_leave:view"));
  assert.ok(!defaultPermissionsForRole("viewer").includes("sick_leave:verify"));
});

test("structure: الصفحة — الحالات الست، والرابط الرسمي بلا referrer، ولا تخزين في المتصفّح", () => {
  const html = read("sick-leave-shell.html");
  const js = read("sick-leave.js");
  for (const s of ["جاهز للتحقق", "جاري قراءة الملف", "جاري التحقق من صحة", "تم التحقق", "غير مطابق", "تعذر التحقق حاليًا"]) assert.ok(js.includes(s), s);
  assert.match(html, /href="https:\/\/www\.seha\.sa\/ui#\/inquiries\/slenquiry" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /name="viewport"/);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(js.replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("structure: لا ملفّات إجازات في المستودع", () => {
  const tracked = require("node:child_process").execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n");
  assert.ok(!tracked.some((f) => /sick|leave|اجاز|إجاز/i.test(f) && /\.(pdf|png|jpe?g)$/i.test(f)));
});

/* ─── تقليل الإدخال اليدوي ─── */

test("http: تأكيد «مطابق» يأخذ القيمة من الملف الموقَّع — بلا إعادة كتابة", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const v = await h.verify({ token: ex.body.token, official: { outcome: "found", same: ["startDate", "endDate", "days", "name"] } });
  assert.equal(v.body.status, "verified");
  assert.equal(v.body.officialEntry, "confirmed");
  assert.equal(h.events.find((e) => e.type === http.EV_VERIFY).meta.officialEntry, "confirmed");
});

test("http: سطر «مختلف» يُكتب كما في صحة، والباقي مؤكَّد → الفرق باسمه", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const v = await h.verify({ token: ex.body.token, official: { outcome: "found", same: ["startDate", "name"], endDate: "2026-09-19" } });
  assert.equal(v.body.status, "mismatch");
  assert.equal(v.body.officialEntry, "confirmed_and_typed");
  assert.deepEqual(v.body.differences.map((d) => d.code), ["end_date_mismatch"]);
});

test("http: «مطابق» لا يقبل حقلًا مكتوبًا معه، ولا حقلًا غائبًا عن الملف", async () => {
  const h = harness();
  const ex = await h.extract(await validPdf());
  const both = await h.verify({ token: ex.body.token, official: { outcome: "found", same: ["startDate", "endDate"], endDate: "2026-09-17" } });
  assert.equal(both.statusCode, 400);
  assert.equal(both.body.fields.officialEndDate, "conflict");
  const scan = await h.extract(makeScannedPdf());
  const nothing = await h.verify({ token: scan.body.token, official: { outcome: "found", same: ["startDate", "endDate"] } });
  assert.equal(nothing.statusCode, 400);
  assert.equal(nothing.body.fields.officialStartDate, "nothing_to_confirm");
  /* بعد الإدخال اليدوي من الملف يصير التأكيد ممكنًا. */
  const ok = await h.verify({ token: scan.body.token, file: { ...FILE }, official: { outcome: "found", same: ["startDate", "endDate"] } });
  assert.equal(ok.body.status, "verified");
});

test("qr: رابط صحة الرسمي يُفتح، والمواقع المنتحلة تُعلَّم", () => {
  const off = qrSummaryFromText("https://www.seha.sa/ui#/inquiries/slenquiry?x=GSL1", "GSL1");
  assert.deepEqual([off.officialHost, off.lookalike, !!off.url, off.mentionsLeaveId], [true, false, true, true]);
  const fake = qrSummaryFromText("https://seha-sa-ue-inquiris-slenquiry.netlify.app/", "GSL1");
  assert.deepEqual([fake.officialHost, fake.lookalike, fake.url], [false, true, null]);
  assert.equal(qrSummaryFromText("https://seha.sa.evil.example/", "").officialHost, false);
  assert.equal(qrSummaryFromText("http://www.seha.sa/x", "").url, null, "http لا يُفتح");
  assert.equal(qrSummaryFromText("javascript:alert(1)", "").url, null);
  assert.deepEqual(qrSummaryFromText(null), { found: false });
});

/* ─── ملفّات PDF صالحة من مولّدات مختلفة لا تُرفض ─── */

const EXPECT = ["GSL25091234567", "2456789012", "2026-09-15", "2026-09-17"];
const crit = (r) => [r.fields.leaveId, r.fields.idNumber, r.fields.startDate, r.fields.endDate];

test("pdf: أسلوب الجوال/واتساب (PDF 1.5، Object Streams، xref stream مضغوط)", async () => {
  const r = await extractSickLeave(makeMobileStylePdf());
  assert.equal(r.status, "extracted");
  assert.deepEqual(crit(r), EXPECT);
});

test("pdf: تحديثات متراكمة (incremental update) — لملفّ كلاسيكي ولملفّ xref stream", async () => {
  for (const buf of [appendIncrementalUpdate(await validPdf()), appendIncrementalUpdate(makeMobileStylePdf())]) {
    const r = await extractSickLeave(buf);
    assert.equal(r.status, "extracted");
    assert.deepEqual(crit(r), EXPECT);
  }
});

test("pdf: بلا %%EOF، أو ببايتات زائدة بعده، أو startxref خاطئ، أو بايتات قبل الترويسة — يُقرأ", async () => {
  const base = await validPdf();
  const latin = base.toString("latin1");
  const variants = {
    noEOF: Buffer.from(latin.replace(/%%EOF\s*$/, ""), "latin1"),
    trailingJunk: Buffer.concat([base, Buffer.alloc(400, 0)]),
    badStartxref: Buffer.from(latin.replace(/startxref\s+\d+/, "startxref\n999999"), "latin1"),
    leadingBytes: Buffer.concat([Buffer.from("\r\n\r\n junk\n", "latin1"), base]),
  };
  for (const [name, buf] of Object.entries(variants)) {
    assert.equal(validateUpload(buf, "application/pdf").ok, true, name);
    const r = await extractSickLeave(buf);
    assert.equal(r.status, "extracted", name);
    assert.deepEqual(crit(r), EXPECT, name);
  }
});

test("http: الأشكال نفسها عبر المسار الكامل → extracted، والممسوح → إدخال يدوي", async () => {
  const h = harness();
  for (const buf of [makeMobileStylePdf(), appendIncrementalUpdate(await validPdf())]) {
    const ex = await h.extract(buf, "application/pdf", "DOC-20261018-WA0035.pdf");
    assert.equal(ex.statusCode, 200);
    assert.equal(ex.body.status, "extracted");
    assert.equal(ex.body.fileName, "DOC-20261018-WA0035.pdf");
  }
  assert.equal((await h.extract(makeScannedPdf())).body.status, "needs_manual");
});

test("pdf: بيئة Vercel بلا @napi-rs/canvas — يُقرأ الملفّ (كان: DOMMatrix is not defined → «ملف تالف»)", () => {
  const script = `
    const F = require(${JSON.stringify(path.join(__dirname, "helpers/sick-leave-fixtures"))});
    const { extractSickLeave } = require(${JSON.stringify(path.join(ROOT, "lib/sickLeave/extract"))});
    (async () => {
      const out = [];
      for (const b of [await F.makeSickLeavePdf({}), F.makeMobileStylePdf()]) {
        const r = await extractSickLeave(b);
        out.push(r.ok ? r.status + ":" + r.fields.leaveId : "fail:" + r.reason);
      }
      let canvas = true; try { require("@napi-rs/canvas"); } catch { canvas = false; }
      process.stdout.write(JSON.stringify({ out, canvas }));
    })();`;
  const res = require("node:child_process").spawnSync(process.execPath, ["--require", path.join(__dirname, "helpers/no-canvas.js"), "-e", script], { encoding: "utf8", timeout: 60000 });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.canvas, false, "المحاكاة تحجب canvas فعلًا");
  assert.deepEqual(parsed.out, ["extracted:GSL25091234567", "extracted:GSL25091234567"]);
});

test("pdf: عطل تحميل المحلّل يُسمّى عطل خادم ويُحوَّل لإدخال يدوي — لا «ملف تالف»", async () => {
  const env = require("../lib/sickLeave/pdfjsEnv");
  const original = env.loadPdfjs;
  env.loadPdfjs = () => Promise.reject(new ReferenceError("DOMMatrix is not defined"));
  try {
    const r = await extractSickLeave(await validPdf());
    assert.equal(r.reason, "parser_unavailable");
    assert.equal(r.diagnostic.name, "ReferenceError");
    const h = harness();
    const ex = await h.extract(await validPdf());
    assert.equal(ex.statusCode, 200);
    assert.equal(ex.body.status, "needs_manual");
    assert.equal(ex.body.reason, "parser_unavailable");
  } finally {
    env.loadPdfjs = original;
  }
});

test("pdfjsEnv: مصفوفة DOMMatrix البديلة صحيحة رياضيًا", () => {
  const { DOMMatrix2D } = require("../lib/sickLeave/pdfjsEnv");
  const m = new DOMMatrix2D([2, 0, 0, 3, 10, 20]);
  assert.deepEqual(m.transformPoint({ x: 1, y: 1 }), { x: 12, y: 23, z: 0, w: 1 });
  const id = m.inverse().multiply(m);
  [id.a, id.b, id.c, id.d, id.e, id.f].forEach((v, i) => assert.ok(Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-9));
  assert.ok(new DOMMatrix2D().isIdentity);
});

test("pdf: العامل يُحمَّل في الخيط نفسه — لا بحث عن pdf.worker.mjs بمسار محسوب (كان: Setting up fake worker failed)", () => {
  /* workerSrc يُوجَّه إلى ملفّ غير موجود — كما على Vercel حين لا يُضمَّن العامل.
     القراءة يجب أن تنجح لأن العامل مسجَّل مسبقًا في globalThis.pdfjsWorker. */
  const script = `
    const env = require(${JSON.stringify(path.join(ROOT, "lib/sickLeave/pdfjsEnv"))});
    const F = require(${JSON.stringify(path.join(__dirname, "helpers/sick-leave-fixtures"))});
    const { extractSickLeave } = require(${JSON.stringify(path.join(ROOT, "lib/sickLeave/extract"))});
    (async () => {
      const pdfjs = await env.loadPdfjs();
      pdfjs.GlobalWorkerOptions.workerSrc = "/nonexistent/pdf.worker.mjs";
      const r = await extractSickLeave(F.makeMobileStylePdf());
      process.stdout.write(JSON.stringify({ status: r.status || r.reason, worker: !!(globalThis.pdfjsWorker && globalThis.pdfjsWorker.WorkerMessageHandler) }));
    })();`;
  const run = (s) => require("node:child_process").spawnSync(process.execPath, [
    "--require", path.join(__dirname, "helpers/no-canvas.js"),
    "--import", require("node:url").pathToFileURL(path.join(__dirname, "helpers/no-pdf-worker.mjs")).href,
    "-e", s], { encoding: "utf8", timeout: 60000 });
  assert.deepEqual(JSON.parse(run(script).stdout), { status: "extracted", worker: true });
  /* المحاكاة حقيقية: pdfjs وحده بلا تسجيل العامل يفشل بالخطأ نفسه الذي ظهر على Preview. */
  const bare = run(`
    (async () => {
      globalThis.DOMMatrix = require(${JSON.stringify(path.join(ROOT, "lib/sickLeave/pdfjsEnv"))}).DOMMatrix2D;
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      try { await pdfjs.getDocument({ data: new Uint8Array(require("fs").readFileSync(process.argv[1] || "/dev/null")) }).promise; process.stdout.write("ok"); }
      catch (e) { process.stdout.write(String(e.message)); }
    })();`);
  assert.match(bare.stdout, /fake worker failed/i);
});

test("structure: ملفّ عامل pdfjs مُضمَّن في حزمة الدالّة، وباستيراد ثابت", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.match(vercel.functions["api/app.js"].includeFiles, /pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs/);
  assert.match(read("lib/sickLeave/pdfjsEnv.js"), /import\("pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs"\)/);
});
