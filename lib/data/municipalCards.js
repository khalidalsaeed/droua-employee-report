const crypto = require("crypto");
const { getSql } = require("../db");

/* البطاقات البلدية (الشهادات الصحية) — /api/data/municipal-cards.
   =========================================================================
   مصدر كل حقل هو ملفّ الشهادة نفسه (lib/municipal/extractCard.js)، ولا
   يُخزَّن الملفّ: يُقرأ عند الرفع ثم يُرمى. يبقى منه في القاعدة:
     - الحقول المطبوعة على البطاقة (رقم الشهادة، الهوية، الاسم، …)
     - نصّ رمز QR — رابط تحقّق رسمي على eservices.alriyadh.gov.sa. لا يخرج
       في أي استجابة JSON: الواجهة تطلب صورة الرمز من
       /api/files/municipal-qr التي تعيد فحص الصلاحية في كل طلب.
     - صورة البطاقة (JPEG الأصلي كما في الملفّ) — تُقدَّم من
       /api/files/municipal-photo بالفحص نفسه.

   بطاقة واحدة لكل رقم هوية: رفع شهادة مجدَّدة للموظف نفسه يستبدل السابقة
   (ON CONFLICT (id_number)). الربط بسجلّ الموظف يتمّ في الواجهة برقم
   الإقامة، كما في تصاريح أجير.

   الجدول: scripts/setup-municipal-cards.js. قبل تشغيله ترجع القائمة فارغة
   مع setupRequired بدل أن تكسر الصفحة. */
const section = "municipal";

const COLS = `cert_no, id_number, name_on_card, issuer, gender, nationality, occupation,
  expiry_hijri, to_char(expiry_date,'YYYY-MM-DD') AS expiry_date,
  (qr_text IS NOT NULL) AS has_qr, (photo_b64 IS NOT NULL) AS has_photo, photo_sha256,
  to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`;

function toItem(row) {
  return {
    id: row.cert_no,
    certNo: row.cert_no,
    idNumber: row.id_number,
    name: row.name_on_card || null,
    issuer: row.issuer || null,
    gender: row.gender || null,
    nationality: row.nationality || null,
    occupation: row.occupation || null,
    expiryHijri: row.expiry_hijri || null,
    expiryDate: row.expiry_date || null,
    hasQr: !!row.has_qr,
    hasPhoto: !!row.has_photo,
    /* بصمة قصيرة تكسر ذاكرة المتصفّح حين تُستبدل الصورة. */
    photoVersion: row.photo_sha256 ? String(row.photo_sha256).slice(0, 12) : null,
    updatedAt: row.updated_at || null,
  };
}

const missingTable = (err) => err && (err.code === "42P01" || /municipal_cards.*does not exist/i.test(String(err.message)));

async function list() {
  const sql = getSql();
  try {
    const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM municipal_cards ORDER BY expiry_date NULLS LAST, cert_no`;
    return rows.map(toItem);
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

async function get(certNo) {
  const sql = getSql();
  const rows = await sql`SELECT ${sql.unsafe(COLS)} FROM municipal_cards WHERE cert_no = ${String(certNo)}`;
  return rows[0] ? toItem(rows[0]) : null;
}

/* للخادم وحده: نصّ الرمز والصورة. لا يمرّ عبر toItem فلا يصل إلى JSON. */
async function getSecret(certNo, what) {
  const sql = getSql();
  const rows = what === "qr"
    ? await sql`SELECT qr_text FROM municipal_cards WHERE cert_no = ${String(certNo)}`
    : await sql`SELECT photo_b64, photo_sha256 FROM municipal_cards WHERE cert_no = ${String(certNo)}`;
  return rows[0] || null;
}

const clip = (v, n = 160) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/* يُستدعى من مسار الرفع بنتيجة extractMunicipalCard فقط — لا من جسم طلب
   حرّ: POST /api/data/municipal-cards مرفوض (create أدناه). */
async function upsertExtracted(card, actor) {
  if (!card || !/^\d{3,}-\d{4}$/.test(card.certNo || "") || !/^\d{10}$/.test(card.idNumber || "")) {
    throw new Error("الملفّ لا يحمل رقم شهادة ورقم هوية صالحين");
  }
  const sql = getSql();
  const photo = Buffer.isBuffer(card.photo) ? card.photo : null;
  const photoB64 = photo ? photo.toString("base64") : null;
  const photoSha = photo ? crypto.createHash("sha256").update(photo).digest("hex") : null;
  const qrText = clip(card.qrText, 4096);

  const previous = await sql`SELECT cert_no FROM municipal_cards WHERE id_number = ${card.idNumber}`;
  /* رقم الشهادة نفسه لهوية أخرى = ملفّ متضارب؛ يُرفض بدل أن ينقل البطاقة. */
  const clash = await sql`SELECT id_number FROM municipal_cards WHERE cert_no = ${card.certNo}`;
  if (clash[0] && clash[0].id_number !== card.idNumber) throw new Error("رقم الشهادة مسجّل لموظف آخر");

  await sql`
    INSERT INTO municipal_cards
      (cert_no, id_number, name_on_card, issuer, gender, nationality, occupation,
       expiry_hijri, expiry_date, qr_text, photo_b64, photo_sha256, updated_by)
    VALUES (${card.certNo}, ${card.idNumber}, ${clip(card.name)}, ${clip(card.issuer)}, ${clip(card.gender, 20)},
            ${clip(card.nationality, 60)}, ${clip(card.occupation)}, ${clip(card.expiryHijri, 10)},
            ${isIso(card.expiryDate) ? card.expiryDate : null}, ${qrText}, ${photoB64}, ${photoSha},
            ${actor ? actor.email || actor.id || null : null})
    ON CONFLICT (id_number) DO UPDATE SET
      cert_no = EXCLUDED.cert_no, name_on_card = EXCLUDED.name_on_card, issuer = EXCLUDED.issuer,
      gender = EXCLUDED.gender, nationality = EXCLUDED.nationality, occupation = EXCLUDED.occupation,
      expiry_hijri = EXCLUDED.expiry_hijri, expiry_date = EXCLUDED.expiry_date, qr_text = EXCLUDED.qr_text,
      photo_b64 = EXCLUDED.photo_b64, photo_sha256 = EXCLUDED.photo_sha256,
      updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return { item: await get(card.certNo), replaced: previous[0] ? previous[0].cert_no : null };
}

async function create() { throw new Error("تُضاف البطاقة برفع ملفّ الشهادة (PDF)"); }
async function update() { throw new Error("تُحدَّث البطاقة برفع ملفّ الشهادة المجدَّدة"); }

async function remove(certNo) {
  const sql = getSql();
  const rows = await sql`DELETE FROM municipal_cards WHERE cert_no = ${String(certNo)} RETURNING cert_no`;
  if (!rows[0]) throw new Error("البطاقة غير موجودة");
}

module.exports = { section, list, get, getSecret, upsertExtracted, create, update, remove, toItem };
