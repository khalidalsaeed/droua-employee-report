/* تجديد بطاقة بلدية من الواجهة: رفع الشهادة المجدَّدة على بطاقة موجودة.
   =========================================================================
   المسار كاملًا على الخادم، وبالترتيب الذي تعرضه شاشة التقدّم:
     read    قراءة الملفّ (PDF سليم)
     type    هل هو شهادة صحية من الأمانة؟ وهل سُجّل مسبقًا (بصمة/رقم)؟
     match   رقم الهوية على الشهادة = رقم إقامة صاحب البطاقة (employees.iqama)
             — مفتاح الاستيراد نفسه (lib/municipal/match.js)، لا الاسم.
     verify  الانتهاء أبعد من الحالي ومنطقي، والرمز الأصلي يُستخرج ويُقرأ
             إلى النصّ نفسه المقروء من الملفّ.
   ثم فقط: رسم وجه الشهادة، ورفع الكائنين خاصّين إلى المتجر نفسه، وقراءة
   راجعة بالبصمة، ثم تحديث الفهرس آخرًا.

   لا شيء يُكتب قبل نجاح كل الخطوات. فشلُ ما بعد الرفع يحذف الكائنات الجديدة
   ويترك الفهرس كما هو.

   التاريخ: المدخل يحتفظ بـcardId نفسه (فالبطاقة في الواجهة هي هي)، ويُضاف
   المستند السابق إلى history بحقوله ومفاتيح كائناته — لا تُحذف من المتجر.
   ملفّ PDF لا يُخزَّن، كما في الاستيراد: بصمته فقط. */

const crypto = require("crypto");
const store = require("./store");
const { extractMunicipalCard } = require("./extractCard");
const { decideRenewal, riyadhToday } = require("../renewal/rules");

const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function employeeByEid(sql, eid) {
  const rows = await sql`SELECT eid, iqama, name FROM employees WHERE eid = ${String(eid)} LIMIT 1`;
  return rows[0] || null;
}
async function employeeByIqama(sql, iqama) {
  if (!iqama) return null;
  const rows = await sql`SELECT eid, iqama, name FROM employees WHERE iqama = ${String(iqama)} LIMIT 2`;
  return rows.length === 1 ? rows[0] : null;
}

/* deps قابلة للحقن في الاختبارات: sql، render، today. */
async function renewMunicipalCard({ cardId, pdf, actor, oidcToken, sql, render, today }) {
  const t = today || riyadhToday();
  const index = await store.readIndex(oidcToken, { fresh: true });
  const entry = store.entryById(index, cardId);
  if (!entry) return { ok: false, httpStatus: 404, stage: "read", reason: "not_found", message: "البطاقة غير موجودة" };

  const fileHash = sha256hex(pdf);
  const extracted = extractMunicipalCard(pdf);
  const card = extracted.card || {};

  const employee = await employeeByEid(sql, entry.employeeEid);
  const otherEmployee = card.idNumber ? await employeeByIqama(sql, card.idNumber) : null;

  /* الرمز يُتحقَّق منه فقط إن وصلنا إليه: لا رسم لملفّ مرفوض. */
  let qr = null;
  const qrOk = () => {
    if (!card.qrText) return false;
    qr = (render || require("./render")).originalQrPng(pdf);
    return !!(qr && qr.pixelsIdentical && qr.roundTrip === card.qrText);
  };

  const preliminary = {
    ok: extracted.ok,
    reason: extracted.reason,
    docNumber: card.certNo,
    idNumber: card.idNumber,
    name: card.name,
    expiryDate: card.expiryDate,
  };
  const current = {
    docNumber: entry.certificateNumber,
    expiryDate: entry.expiryDate,
    nameOnDoc: entry.nameOnCard,
    employee: employee ? { eid: String(employee.eid), name: employee.name, iqama: employee.iqama } : null,
    knownHashes: [entry.sourceFileHash].concat(entry.history.map((h) => h.sourceFileHash)).filter(Boolean),
    knownDocNumbers: entry.history.map((h) => h.certificateNumber),
  };
  /* القرار مرّتين: أولًا بلا رمز (لا رسم لملفّ سيُرفض)، ثم بالرمز. */
  let verdict = decideRenewal({ kind: "municipal", current, extracted: { ...preliminary, qrOk: true }, fileHash, otherEmployee, today: t });
  if (verdict.ok) verdict = decideRenewal({ kind: "municipal", current, extracted: { ...preliminary, qrOk: qrOk() }, fileHash, otherEmployee, today: t });
  if (!verdict.ok) return { ...verdict, httpStatus: 422 };

  /* ── الكتابة ── */
  const face = await (render || require("./render")).renderCardFace(pdf);
  const now = new Date().toISOString();
  const next = {
    ...entry,
    certificateNumber: card.certNo,
    issuePlace: card.issuer || entry.issuePlace || null,
    expiryDate: card.expiryDate,
    expiryHijri: card.expiryHijri || null,
    nameOnCard: card.name || null,
    occupation: card.occupation || entry.occupation || null,
    cardKey: store.newObjectKey("card"),
    cardSha256: sha256hex(face.png),
    qrKey: store.newObjectKey("qr"),
    qrSha256: sha256hex(qr.png),
    qrTarget: card.qrText,
    sourceFileHash: fileHash,
    updatedAt: now,
    history: [{
      certificateNumber: entry.certificateNumber,
      issuePlace: entry.issuePlace,
      expiryDate: entry.expiryDate,
      expiryHijri: entry.expiryHijri,
      nameOnCard: entry.nameOnCard,
      cardKey: entry.cardKey, cardSha256: entry.cardSha256,
      qrKey: entry.qrKey, qrSha256: entry.qrSha256,
      sourceFileHash: entry.sourceFileHash,
      replacedAt: now,
      replacedById: actor && actor.id ? String(actor.id) : null,
      replacedByName: actor && actor.name ? String(actor.name) : null,
    }].concat(entry.history).slice(0, store.HISTORY_CAP),
  };
  const valid = store.validEntry(next);
  if (!valid) return { ok: false, httpStatus: 422, stage: "verify", reason: "invalid_entry", message: "تعذّر اعتماد بيانات المستند" };

  const written = [];
  try {
    for (const [key, bytes] of [[next.cardKey, face.png], [next.qrKey, qr.png]]) {
      await store.putObject(key, bytes, oidcToken);
      written.push(key);
    }
    /* قراءة راجعة بالبصمة قبل أن يشير الفهرس إلى الكائنين. */
    if (!(await store.readObject(valid, "card", oidcToken)) || !(await store.readObject(valid, "qr", oidcToken))) {
      throw new Error("readback_failed");
    }
    /* قفل تفاؤلي: إن تغيّر المدخل منذ قرأناه (تجديد متزامن أو استيراد)، لا نكتب. */
    const fresh = await store.readIndex(oidcToken, { fresh: true });
    const live = store.entryById(fresh, cardId);
    if (!live || live.sourceFileHash !== entry.sourceFileHash || live.cardKey !== entry.cardKey) {
      await store.deleteObjects(written, oidcToken);
      return { ok: false, httpStatus: 409, stage: "verify", reason: "changed_meanwhile", message: "تغيّرت البطاقة أثناء العملية — أعد المحاولة" };
    }
    fresh.cards = fresh.cards.map((c) => (c.cardId === cardId ? valid : c));
    await store.writeIndex(fresh, oidcToken);
  } catch (err) {
    await store.deleteObjects(written, oidcToken).catch(() => {});
    throw err;
  }

  return {
    ok: true,
    entry: valid,
    summary: {
      kind: "municipal",
      employeeName: (employee && employee.name) || card.name || null,
      documentLabel: "بطاقة بلدية",
      previousNumber: entry.certificateNumber,
      newNumber: valid.certificateNumber,
      previousExpiry: verdict.previousExpiry,
      newExpiry: verdict.newExpiry,
      extendedDays: verdict.extendedDays,
      daysLeft: verdict.daysLeft,
      nameMatch: verdict.nameMatch,
    },
  };
}

module.exports = { renewMunicipalCard };
