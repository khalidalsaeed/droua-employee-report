const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

const { buildCertificate, rowsWith, JPEG, QR_TEXT } = require("./helpers/municipal-fixture");
const { buildAjeerPermit, officialQr } = require("./helpers/ajeer-permit-fixture");
const { decideRenewal, nameSimilarity, daysBetween } = require("../lib/renewal/rules");
const { extractAjeerPermit } = require("../lib/ajeer/extractPermit");
const perms = require("../lib/auth/permissions");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const TODAY = "2026-11-15";

/* «تجديد المستند» — البطاقات البلدية وتصاريح أجير.
   كل المستندات هنا اصطناعية (test/helpers/*-fixture.js): لا شهادة ولا تصريح
   حقيقي، والأسماء والأرقام والروابط مخترعة. */

/* ─── بيئة وهمية: متجر Blob في الذاكرة + قاعدة مُزيَّفة ─── */
function fakeBlob() {
  const objects = new Map();
  const api = {
    objects,
    async get(key) {
      if (!objects.has(key)) throw new Error("BlobNotFoundError: 404");
      return { stream: [objects.get(key)] };
    },
    async put(key, bytes, opts) {
      assert.equal(opts.access, "private");
      assert.ok(!opts.token, "لا توكن قراءة/كتابة دائم");
      objects.set(key, Buffer.from(bytes));
      return { pathname: key, url: `https://x.private.blob.vercel-storage.com/${key}` };
    },
    async del(keys) { for (const k of [].concat(keys)) objects.delete(k); },
  };
  return api;
}

async function withMunicipalStore(fn) {
  const id = require.resolve("@vercel/blob");
  const saved = require.cache[id];
  const blob = fakeBlob();
  const stub = new Module(id, null);
  stub.filename = id; stub.loaded = true; stub.exports = blob;
  require.cache[id] = stub;
  const env = { MUNICIPAL_CARDS_STORE_ID: process.env.MUNICIPAL_CARDS_STORE_ID };
  process.env.MUNICIPAL_CARDS_STORE_ID = "store_CARDSTEST";
  const store = require("../lib/municipal/store");
  store._resetCache();
  try {
    return await fn(blob, store);
  } finally {
    if (saved) require.cache[id] = saved; else delete require.cache[id];
    if (env.MUNICIPAL_CARDS_STORE_ID == null) delete process.env.MUNICIPAL_CARDS_STORE_ID; else process.env.MUNICIPAL_CARDS_STORE_ID = env.MUNICIPAL_CARDS_STORE_ID;
    store._resetCache();
  }
}

const EMPLOYEES = [
  { eid: "501", iqama: "2500000001", name: "سالم مراد" },
  { eid: "502", iqama: "2500000002", name: "أحمد خالد" },
  { eid: "601", iqama: "2999000001", name: "شاكر ميا" },
  { eid: "602", iqama: "2999000002", name: "رحيم علي" },
];
function fakeSql(extra) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    calls.push({ text, values });
    if (/FROM employees WHERE eid = \?/.test(text)) return EMPLOYEES.filter((e) => e.eid === values[0]);
    if (/FROM employees WHERE iqama = \?/.test(text)) return EMPLOYEES.filter((e) => e.iqama === values[0]);
    if (extra) return extra(text, values) || [];
    return [];
  };
  sql.calls = calls;
  return sql;
}

const PNG = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);

/* بطاقة قائمة للموظف 501: شهادة 10001-1447 تنتهي 2026-12-28. */
async function seedCard(blob, store, overrides) {
  const oldPdf = buildCertificate({ rows: rowsWith({}), qrText: QR_TEXT, jpeg: JPEG });
  const face = PNG("old-face"), qr = PNG("old-qr");
  const entry = {
    cardId: "a".repeat(16), employeeEid: "501", certificateNumber: "10001-1447", issuePlace: "أمانة مدينة الرياض",
    expiryDate: "2026-12-28", expiryHijri: "1448-07-19", nameOnCard: "سالم مراد", occupation: "عامل مخزن",
    cardKey: `municipal-cards/card/${"1".repeat(32)}.png`, cardSha256: sha(face),
    qrKey: `municipal-cards/qr/${"2".repeat(32)}.png`, qrSha256: sha(qr), qrTarget: QR_TEXT,
    sourceFileHash: sha(oldPdf), createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
    ...(overrides || {}),
  };
  blob.objects.set(entry.cardKey, face);
  blob.objects.set(entry.qrKey, qr);
  await store.writeIndex({ version: 1, cards: [entry] }, "tok");
  return { entry, oldPdf };
}

const NEW_QR = "https://eservices.alriyadh.gov.sa/DownloadFile?RENEWED0001";
const newCertificate = (o = {}) => buildCertificate({
  rows: rowsWith({ certNo: "10002-1448", expiryHijri: "19/07/1449", ...o }),
  qrText: o.qrText || NEW_QR, jpeg: JPEG,
});

async function renewCard(pdf, opts = {}) {
  const { renewMunicipalCard } = require("../lib/municipal/renew");
  return renewMunicipalCard({
    cardId: "a".repeat(16), pdf, actor: { id: "u-1", name: "مدير النظام" }, oidcToken: "tok",
    sql: fakeSql(), today: TODAY, ...opts,
  });
}

/* ═════════ القواعد المشتركة ═════════ */

test("تشابه الأسماء: تعزيز لا قرار — قريب، جزئي، مختلف جذريًا", () => {
  assert.equal(nameSimilarity("سالم مراد", "سالم مراد"), 1);
  assert.ok(nameSimilarity("SHAKIB MIA", "MD SHAKIB MIA") >= 0.75);
  assert.ok(nameSimilarity("سالم مراد", "سالم مرادي") >= 0.6);
  assert.ok(nameSimilarity("سالم مراد", "JOHN SMITH") < 0.34);
  assert.equal(nameSimilarity("", "x"), null);
  assert.equal(daysBetween("2026-12-28", "2027-12-17"), 354);
});

test("القواعد: الهوية تقرّر، والاسم وحده لا يكفي أبدًا", () => {
  const current = { docNumber: "A", expiryDate: "2026-12-28", nameOnDoc: "سالم مراد", employee: { eid: "501", name: "سالم مراد", iqama: "2500000001" } };
  const ok = { ok: true, docNumber: "B", idNumber: "2500000001", name: "سالم مراد", expiryDate: "2027-12-17", qrOk: true };
  assert.equal(decideRenewal({ kind: "municipal", current, extracted: ok, today: TODAY }).ok, true);
  /* اسم مطابق تمامًا بلا هوية مقروءة: يُرفض. */
  const noId = decideRenewal({ kind: "municipal", current, extracted: { ...ok, idNumber: null }, today: TODAY });
  assert.deepEqual([noId.ok, noId.stage, noId.reason], [false, "match", "no_identifier"]);
  /* هوية مختلفة لا يملكها أحد. */
  assert.equal(decideRenewal({ kind: "municipal", current, extracted: { ...ok, idNumber: "2500009999" }, today: TODAY }).reason, "id_mismatch");
  /* اختلاف جذري في الاسم مع هوية مطابقة: يُرفض احتياطًا. */
  assert.equal(decideRenewal({ kind: "municipal", current, extracted: { ...ok, name: "JOHN SMITH" }, today: TODAY }).reason, "name_mismatch");
  /* موظف بلا إقامة مسجّلة: لا مطابقة. */
  assert.equal(decideRenewal({ kind: "municipal", current: { ...current, employee: { eid: "501", iqama: "" } }, extracted: ok, today: TODAY }).reason, "no_employee_identifier");
  /* منتهٍ أصلًا، وتاريخ بعيد غير منطقي. */
  assert.equal(decideRenewal({ kind: "municipal", current: { ...current, expiryDate: "2026-01-01" }, extracted: { ...ok, expiryDate: "2026-06-01" }, today: TODAY }).reason, "expired");
  assert.equal(decideRenewal({ kind: "ajeer", current, extracted: { ...ok, expiryDate: "2031-01-01" }, today: TODAY }).reason, "implausible_expiry");
  /* ملفّ غير مقروء ونوع خاطئ. */
  assert.equal(decideRenewal({ kind: "municipal", current, extracted: { ok: false, reason: "not_pdf" } }).stage, "read");
  assert.equal(decideRenewal({ kind: "municipal", current, extracted: { ok: false, reason: "not_a_municipal_card" } }).reason, "wrong_type");
});

/* ═════════ البلدية ═════════ */

test("البلدية: مستند جديد لنفس الموظف بالهوية → تُستبدل البطاقة، ويُحفظ السابق في السجلّ، والرمز الجديد يُقدَّم", async () => {
  await withMunicipalStore(async (blob, store) => {
    const { entry } = await seedCard(blob, store);
    const out = await renewCard(newCertificate());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.summary.previousExpiry, "2026-12-28");
    assert.equal(out.summary.newExpiry, "2027-12-17");
    assert.equal(out.summary.extendedDays, 354);
    assert.equal(out.summary.daysLeft, 397);
    assert.equal(out.summary.employeeName, "سالم مراد");

    const idx = await store.readIndex("tok", { fresh: true });
    assert.equal(idx.cards.length, 1);
    const live = idx.cards[0];
    assert.equal(live.cardId, entry.cardId, "البطاقة نفسها في الواجهة");
    assert.equal(live.certificateNumber, "10002-1448");
    assert.equal(live.expiryDate, "2027-12-17");
    assert.equal(live.qrTarget, NEW_QR);
    assert.notEqual(live.qrKey, entry.qrKey);
    /* الرمز الفعّال هو الجديد: يُقرأ إلى رابط الشهادة الجديدة. */
    const jsQR = require("jsqr");
    const { createCanvas, loadImage } = require("@napi-rs/canvas");
    const img = await loadImage(await store.readObject(live, "qr", "tok"));
    const c = createCanvas(img.width, img.height); const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    assert.equal(jsQR(ctx.getImageData(0, 0, img.width, img.height).data, img.width, img.height).data, NEW_QR);
    /* السجلّ: المستند السابق بانتهائه ومن استبدله ومتى، وكائناته باقية. */
    assert.equal(live.history.length, 1);
    const h = live.history[0];
    assert.deepEqual([h.certificateNumber, h.expiryDate, h.replacedByName, h.replacedById], ["10001-1447", "2026-12-28", "مدير النظام", "u-1"]);
    assert.ok(h.replacedAt);
    assert.ok(blob.objects.has(entry.cardKey) && blob.objects.has(entry.qrKey), "كائنات المستند السابق لا تُحذف");
    /* JSON الواجهة: السجلّ بلا مفاتيح ولا بصمات. */
    const item = require("../lib/data/municipalCards").toItem(live);
    const json = JSON.stringify(item);
    assert.equal(item.history[0].certificateNumber, "10001-1447");
    assert.ok(!json.includes("municipal-cards/") && !json.includes(NEW_QR) && !json.includes(h.sourceFileHash));
  });
});

test("البلدية: الاسم مختلف قليلًا لكن الهوية صحيحة → تُقبل", async () => {
  await withMunicipalStore(async (blob, store) => {
    await seedCard(blob, store);
    const out = await renewCard(newCertificate({ name: "سالم مرادي" }));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(["close", "partial"].includes(out.summary.nameMatch), out.summary.nameMatch);
  });
});

/* حالات الرفض: لا كائن جديد ولا تغيير في الفهرس. */
async function assertRejected(pdf, expected) {
  return withMunicipalStore(async (blob, store) => {
    await seedCard(blob, store);
    const before = new Map(blob.objects);
    const out = await renewCard(pdf);
    assert.equal(out.ok, false);
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(out[k], v, `${k}: ${JSON.stringify(out)}`);
    assert.deepEqual([...blob.objects.keys()].sort(), [...before.keys()].sort(), "لا كتابة في المتجر");
    for (const [k, v] of before) assert.ok(blob.objects.get(k).equals(v), k);
    return out;
  });
}

test("البلدية: المستند يخص موظفًا آخر → تحذير باسمه ولا نقل ولا استبدال", async () => {
  const out = await assertRejected(newCertificate({ idNumber: "2500000002", name: "أحمد خالد" }), { stage: "match", reason: "other_employee" });
  assert.deepEqual(out.otherEmployee, { eid: "502", name: "أحمد خالد" });
});

test("البلدية: مستند أقدم من الحالي → يُرفض", async () => {
  await assertRejected(newCertificate({ expiryHijri: "19/07/1447" }), { stage: "verify", reason: "older" });
});

test("البلدية: الملفّ نفسه مرّة أخرى → «هذا المستند مسجل مسبقًا»", async () => {
  await withMunicipalStore(async (blob, store) => {
    const { oldPdf } = await seedCard(blob, store);
    const out = await renewCard(oldPdf);
    assert.deepEqual([out.ok, out.reason, out.message], [false, "duplicate", "هذا المستند مسجل مسبقًا"]);
  });
  /* والمستند المسجّل نفسه بملفّ مختلف البايتات (الرقم والانتهاء نفسهما). */
  await assertRejected(buildCertificate({ rows: rowsWith({ occupation: "عامل" }), qrText: QR_TEXT, jpeg: JPEG }), { reason: "duplicate" });
});

test("البلدية: ملفّ ليس شهادة، وملفّ تالف، ورمز لا يُقرأ → رفض بلا كتابة", async () => {
  const notCard = await buildAjeerPermit();
  await assertRejected(notCard, { stage: "type", reason: "wrong_type" });
  await assertRejected(Buffer.from("%PDF-1.4 broken"), { reason: "wrong_type" });
  const { renewMunicipalCard } = require("../lib/municipal/renew");
  await withMunicipalStore(async (blob, store) => {
    await seedCard(blob, store);
    const badQr = { originalQrPng: () => ({ png: PNG("x"), roundTrip: "https://other.example/", pixelsIdentical: true }), renderCardFace: async () => ({ png: PNG("f") }) };
    const out = await renewMunicipalCard({ cardId: "a".repeat(16), pdf: newCertificate(), actor: {}, oidcToken: "tok", sql: fakeSql(), today: TODAY, render: badQr });
    assert.deepEqual([out.ok, out.reason], [false, "qr_invalid"]);
  });
});

test("البلدية: تغيّر البطاقة أثناء العملية → لا كتابة للفهرس وتُحذف الكائنات الجديدة", async () => {
  await withMunicipalStore(async (blob, store) => {
    const { entry } = await seedCard(blob, store);
    const realPut = blob.put;
    let raced = false;
    blob.put = async (key, bytes, opts) => {
      const r = await realPut(key, bytes, opts);
      if (!raced && /\/qr\//.test(key)) {
        raced = true; // استيراد متزامن يستبدل المدخل
        const idx = JSON.parse(blob.objects.get(store.INDEX_KEY).toString());
        idx.cards[0].sourceFileHash = "9".repeat(64);
        blob.objects.set(store.INDEX_KEY, Buffer.from(JSON.stringify(idx)));
      }
      return r;
    };
    const out = await renewCard(newCertificate());
    assert.equal(out.reason, "changed_meanwhile");
    const keys = [...blob.objects.keys()].filter((k) => k !== store.INDEX_KEY).sort();
    assert.deepEqual(keys, [entry.cardKey, entry.qrKey].sort());
  });
});

/* ═════════ أجير ═════════ */

test("أجير: المستخرِج يقرأ رقم التصريح والهوية والاسم والتواريخ والرمز الرسمي", async () => {
  const r = await extractAjeerPermit(await buildAjeerPermit());
  assert.equal(r.ok, true);
  assert.equal(r.permit.permitNo, "TQ9900001");
  assert.equal(r.permit.idNumber, "2999000001");
  assert.equal(r.permit.name, "TEST WORKER ONE");
  assert.equal(r.permit.startDate, "2026-11-02");
  assert.equal(r.permit.endDate, "2026-12-02");
  assert.equal(r.permit.qrText, officialQr("TQ9900001"));
  assert.equal(r.permit.qrOfficial, true);
  /* ليس تصريحًا: لا عنوان أجير. */
  assert.equal((await extractAjeerPermit(await buildAjeerPermit({ title: "مستند آخر" }))).reason, "not_an_ajeer_permit");
  assert.equal((await extractAjeerPermit(Buffer.from("not a pdf"))).reason, "not_pdf");
});

const CURRENT_PERMIT = { permit: "TQ9900001", iqama: "2999000001", nameOnPermit: "TEST WORKER ONE", issueDate: "2026-10-02", expiryDate: "2026-11-02", file: "https://abc.public.blob.vercel-storage.com/ajeer-permits/TQ9900001/1-p.pdf", qrText: officialQr("TQ9900001") };

function ajeerDeps({ existing = [CURRENT_PERMIT] } = {}) {
  const created = [], uploaded = [], removed = [];
  const permits = {
    get: async (no) => existing.find((p) => p.permit === no) || null,
    create: async (item, actor, opts) => { created.push({ item, actor, opts }); return { ...item, qr: "/api/files/qr" }; },
  };
  const sql = fakeSql((text, values) => {
    if (/FROM ajeer_permits WHERE permit_no = \?/.test(text)) return existing.filter((p) => p.permit === values[0] || p.qrText === values[1]).map((p) => ({ permit_no: p.permit }));
    return [];
  });
  return {
    created, uploaded, removed,
    deps: {
      permitNo: "TQ9900001", actor: { id: "u-1", name: "مدير النظام" }, sql, permits, today: TODAY,
      upload: async (p, body, type) => { uploaded.push({ p, type, size: body.length }); return `https://abc.public.blob.vercel-storage.com/${p}`; },
      remove: async (url) => { removed.push(url); },
    },
  };
}
const renewPermit = (pdf, d) => require("../lib/ajeer/renew").renewAjeerPermit({ ...d.deps, pdf });
const NEXT = { permitNo: "TQ9900777", startDate: "2026-11-02", endDate: "2026-12-02" };

test("أجير: تصريح جديد لنفس الموظف → تصريح جديد برقمه ورمزه الرسمي، وسجلّ renewed بالسابق", async () => {
  const d = ajeerDeps();
  const out = await renewPermit(await buildAjeerPermit(NEXT), d);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([out.summary.previousNumber, out.summary.newNumber], ["TQ9900001", "TQ9900777"]);
  assert.deepEqual([out.summary.previousExpiry, out.summary.newExpiry, out.summary.extendedDays, out.summary.daysLeft], ["2026-11-02", "2026-12-02", 30, 17]);
  assert.equal(d.uploaded.length, 1);
  assert.match(d.uploaded[0].p, /^ajeer-permits\/TQ9900777\/\d+-renewal\.pdf$/);
  const { item, opts } = d.created[0];
  assert.equal(item.permit, "TQ9900777");
  assert.equal(item.iqama, "2999000001");
  assert.equal(item.qrText, officialQr("TQ9900777"), "الرمز الرسمي من الملفّ لا رمز مولَّد");
  assert.equal(item.expiryDate, "2026-12-02");
  assert.equal(opts.source, "permit_renewed");
  assert.deepEqual(opts.fallbackPrevious, { permit_no: "TQ9900001", expiry: "2026-11-02" });
});

async function assertPermitRejected(o, expected, existing) {
  const d = ajeerDeps(existing ? { existing } : undefined);
  const out = await renewPermit(Buffer.isBuffer(o) ? o : await buildAjeerPermit({ ...NEXT, ...o }), d);
  assert.equal(out.ok, false);
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(out[k], v, `${k}: ${JSON.stringify(out)}`);
  assert.deepEqual([d.uploaded.length, d.created.length], [0, 0], "لا رفع ولا إنشاء");
  return out;
}

test("أجير: تصريح يخص موظفًا آخر → تحذير باسمه بلا استبدال", async () => {
  const out = await assertPermitRejected({ idNumber: "2999000002", name: "RAHIM ALI" }, { stage: "match", reason: "other_employee" });
  assert.equal(out.otherEmployee.name, "رحيم علي");
});

test("أجير: تصريح أقدم، ومكرّر (التصريح الحالي نفسه، أو رقم مسجّل)، ورمز غير رسمي → رفض", async () => {
  await assertPermitRejected({ endDate: "2026-10-30" }, { stage: "verify", reason: "older" });
  await assertPermitRejected({ permitNo: "TQ9900001", endDate: "2026-11-02" }, { reason: "duplicate", message: "هذا المستند مسجل مسبقًا" });
  await assertPermitRejected({}, { reason: "duplicate" }, [CURRENT_PERMIT, { permit: "TQ9900777", iqama: "2999000001" }]);
  await assertPermitRejected({ qrText: "https://evil.example/verify" }, { stage: "verify", reason: "qr_invalid" });
  await assertPermitRejected({ idNumber: null }, { stage: "match", reason: "no_identifier" });
  /* يبدأ يوم بداية الحالي: كان سيبقي السابق معروضًا — يُرفض. */
  await assertPermitRejected({ startDate: "2026-10-02" }, { stage: "verify", reason: "not_newer" });
  await assertPermitRejected(buildCertificate({ rows: rowsWith({}), qrText: QR_TEXT }), { stage: "type", reason: "wrong_type" });
});

test("أجير: تصريح مسجّل لعامل آخر يُبلَّغ «يخص موظفًا آخر» لا «مسجّل مسبقًا»", async () => {
  const other = { permit: "TQ9900888", iqama: "2999000002", qrText: officialQr("TQ9900888") };
  const out = await assertPermitRejected({ permitNo: "TQ9900888", idNumber: "2999000002", name: "RAHIM ALI" }, { stage: "match", reason: "other_employee" }, [CURRENT_PERMIT, other]);
  assert.equal(out.otherEmployee.eid, "602");
});

test("أجير: فشل إنشاء السجلّ بعد الرفع → يُحذف الملفّ المرفوع", async () => {
  const d = ajeerDeps();
  d.deps.permits.create = async () => { throw new Error("db down"); };
  await assert.rejects(renewPermit(await buildAjeerPermit(NEXT), d), /db down/);
  assert.equal(d.removed.length, 1);
});

test("أجير: permits.create يسجّل renewed بالمصدر permit_renewed وبالسابق الاحتياطي حين يخلو السجلّ", async () => {
  const dbId = require.resolve("../lib/db");
  const saved = require.cache[dbId];
  const sql = fakeSql((text) => {
    if (/INSERT INTO ajeer_permits/.test(text)) return [{ permit_no: "TQ9900777" }];
    if (/SELECT .* FROM ajeer_permits WHERE permit_no/.test(text)) return [{ permit_no: "TQ9900777", iqama: "2999000001", expiry_date: "2026-12-02" }];
    return [];
  });
  sql.unsafe = (s) => s;
  const stub = new Module(dbId, null); stub.filename = dbId; stub.loaded = true; stub.exports = { getSql: () => sql };
  require.cache[dbId] = stub;
  const permitsId = require.resolve("../lib/data/permits");
  delete require.cache[permitsId];
  try {
    const permits = require("../lib/data/permits");
    await permits.create({ permit: "TQ9900777", iqama: "2999000001", expiryDate: "2026-12-02" }, { id: "u-1", name: "x" },
      { source: "permit_renewed", fallbackPrevious: { permit_no: "TQ9900001", expiry: "2026-11-02" } });
    const journal = sql.calls.find((c) => /INSERT INTO ajeer_permit_history/.test(c.text));
    assert.ok(journal.values.includes("renewed"));
    assert.ok(journal.values.includes("permit_renewed"));
    assert.ok(journal.values.includes("TQ9900001") && journal.values.includes("2026-11-02"));
  } finally {
    if (saved) require.cache[dbId] = saved; else delete require.cache[dbId];
    delete require.cache[permitsId];
  }
});

/* ═════════ الصلاحيات ═════════ */

const user = (role, permissions) => ({ id: "x", role, permissions: permissions === undefined ? null : permissions });

test("الصلاحيات: العرض منفصل عن التجديد", () => {
  for (const r of ["owner", "admin"]) {
    assert.equal(perms.canRenew(user(r), "municipal"), true, r);
    assert.equal(perms.canRenew(user(r), "ajeer"), true, r);
  }
  for (const r of ["hr", "viewer", "finance"]) {
    assert.equal(perms.canRenew(user(r), "municipal"), false, r);
    assert.equal(perms.canRenew(user(r), "ajeer"), false, r);
  }
  /* أجير: ajeer:manage وحدها تجدّد. الإنشاء ورفع الملفّات (ولو كاملة) لا تجدّد. */
  assert.equal(perms.canRenew(user("hr", ["ajeer:view", "ajeer:create", "ajeer:upload_files", "ajeer:edit", "ajeer:delete", "ajeer:delete_files"]), "ajeer"), false);
  assert.equal(perms.canRenew(user("hr", ["ajeer:view", "ajeer:manage"]), "ajeer"), true);
  /* الكتالوج: تظهر في إدارة الصلاحيات، وللمالك والمدير وحدهما افتراضيًا. */
  assert.ok(perms.SECTION_BY_KEY.ajeer.actions.includes("manage"));
  for (const r of ["owner", "admin"]) assert.ok(perms.defaultPermissionsForRole(r).includes("ajeer:manage"), r);
  for (const r of ["hr", "viewer", "finance"]) assert.ok(!perms.defaultPermissionsForRole(r).includes("ajeer:manage"), r);
  assert.equal(perms.canRenew(user("hr", ["municipal:view", "municipal:manage"]), "municipal"), true);
});

test("فراس (حساب HR على افتراضيات الدور): يرى القسمين والبطاقات والباركود، ولا يجدّد", () => {
  /* الحساب كما تُنشئه migrateHrSpecialistToDb في lib/auth/users.js. */
  const firas = { id: "env-hr-specialist", role: "hr", permissions: null };
  const effective = perms.resolvePermissions(firas);
  for (const p of ["ajeer:view", "municipal:view", "employees:view"]) assert.ok(effective.includes(p), p);
  for (const p of ["municipal:manage", "ajeer:create", "ajeer:upload_files", "ajeer:edit", "ajeer:delete"]) assert.ok(!effective.includes(p), p);
  assert.equal(perms.canRenew(firas, "municipal"), false);
  assert.equal(perms.canRenew(firas, "ajeer"), false);
});

test("فراس بسجلّه المخصّص الفعلي (يضيف تصاريح ويرفع ملفّاتها): يرى البلدية وأجير ولا يجدّد أيًّا منهما", () => {
  /* الصلاحيات المتعلّقة بالقسمين كما في صفّه على القاعدة بعد إضافة municipal:view. */
  const firas = { id: "env-hr-specialist", role: "hr", permissions: [
    "employees:view", "ajeer:view", "ajeer:create", "ajeer:edit", "ajeer:delete", "ajeer:upload_files", "ajeer:delete_files", "municipal:view",
  ] };
  for (const [s, a] of [["ajeer", "view"], ["ajeer", "create"], ["ajeer", "upload_files"], ["municipal", "view"]]) assert.equal(perms.hasPermission(firas, s, a), true, `${s}:${a}`);
  assert.equal(perms.canRenew(firas, "ajeer"), false);
  assert.equal(perms.canRenew(firas, "municipal"), false);
});

test("المسار: canRenew قبل أي قراءة للجسم، والاستجابة بلا رابط ملفّ، والحدثان في سجلّ التدقيق", () => {
  const app = read("api/app.js");
  const at = app.indexOf("async function filesRenewDocument");
  const fn = app.slice(at, app.indexOf("\n}\n", at));
  assert.ok(fn.indexOf("canRenew(actor, kind)") < fn.indexOf("readRequestBody"));
  assert.match(fn, /municipal_card_renewed/);
  assert.match(fn, /ajeer_permit_renewed/);
  assert.match(fn, /delete item\.file/);
  assert.match(app, /action === "municipal-renew"\) return filesRenewDocument\(req, res, actor, "municipal"\)/);
  assert.match(app, /action === "ajeer-renew"\) return filesRenewDocument\(req, res, actor, "ajeer"\)/);
});

/* ═════════ الواجهة ═════════ */

test("الواجهة: زر «تجديد المستند» محروس بصلاحية التجديد في القسمين، والنافذة بخطواتها الأربع", () => {
  const ui = read("doc-renewal.js");
  const shell = read("app-shell.html");
  const mc = read("municipal-cards.js");
  assert.match(mc, /AdminUI\.can\("municipal", ?"manage"\)/);
  assert.match(shell, /DocRenewal\.canRenew\("ajeer"\)/);
  assert.match(ui, /A\.can\("ajeer", "manage"\)/);
  assert.doesNotMatch(ui, /upload_files/);
  for (const s of ["جاري قراءة المستند", "جاري تحديد نوع المستند", "جاري مطابقة بيانات الموظف", "جاري التحقق من بيانات التجديد"]) assert.ok(ui.includes(s), s);
  assert.ok(ui.includes("تمت مطابقة المستند بنجاح"));
  assert.ok(ui.includes("تعذر مطابقة المستند مع الموظف الحالي"));
  assert.match(ui, /prefers-reduced-motion/);
  assert.doesNotMatch(ui, /blob\.vercel-storage|municipal-cards\//);
  assert.match(shell, /<script src="\/doc-renewal\.js\?v=\d+"><\/script>/);
  assert.match(shell, /href="\/doc-renewal\.css\?v=\d+"/);
});

test("لا مستند حقيقي جديد في المستودع", () => {
  const { execSync } = require("node:child_process");
  const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n");
  assert.deepEqual(tracked.filter((f) => /\.pdf$/i.test(f) && !/^(permits|payroll)\//.test(f)), []);
  for (const f of ["test/helpers/ajeer-permit-fixture.js", "test/helpers/municipal-fixture.js", "test/document-renewal.test.js"]) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    assert.doesNotMatch(read(f), /base64,[A-Za-z0-9+/]{200}/, f);
  }
});
