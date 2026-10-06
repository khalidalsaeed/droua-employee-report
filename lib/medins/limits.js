/* ─── حدود الوحدة: المكان الوحيد للأرقام ───────────────────────────────
   =========================================================================
   كل حدٍّ يُقرأ من هنا. وقيود القاعدة في scripts/setup-medins-core.js تحمل
   الأرقام نفسها نصًّا (CHECK لا يقرأ JavaScript) — واختبارٌ في
   test/medins-migration-sql.test.js يقارن الاثنين، فلا ينحرف أحدهما وحده.

   تغيير حدٍّ = تعديل هذا الملفّ + قيد القاعدة المقابل في هجرةٍ إضافية. */

const MiB = 1024 * 1024;

const FILES = Object.freeze({
  /* الحجم الأقصى للملفّ الأصليّ (نصًّا صريحًا). */
  MAX_FILE_BYTES: 20 * MiB,
  /* حجم الجزء: 2.5MiB تصير قرابة 3.4MB بعد base64 — دون حدّ 4.5MB لجسم
     الطلب والردّ على Vercel بهامش. */
  PART_BYTES: 2.5 * MiB,
  MAX_PARTS: 8,
  /* رفعٌ لم يكتمل خلال هذه المدّة يُكنس. */
  UPLOAD_TTL_MS: 60 * 60 * 1000,
  MAX_FILE_NAME: 255,
  FORMATS: Object.freeze({
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    csv: "text/csv",
  }),
  KINDS: Object.freeze(["quote", "benefits", "policy", "other"]),
});

if (FILES.MAX_PARTS * FILES.PART_BYTES < FILES.MAX_FILE_BYTES) {
  throw new Error("limits: الأجزاء لا تتّسع للحجم الأقصى");
}

const SESSION = Object.freeze({
  IDLE_MINUTES: Object.freeze({ fallback: 15, min: 5, max: 60 }),
  ABSOLUTE_MINUTES: Object.freeze({ fallback: 60, min: 15, max: 480 }),
  /* أرضية زمنية لمسار الفتح: لا يكشف الزمنُ سببَ الفشل. */
  RESPONSE_FLOOR_MS: 600,
});

const TEXT = Object.freeze({
  INSURER_NAME: 120,
  OFFER_TITLE: 200,
  OFFER_REFERENCE: 100,
  OFFER_NOTES: 4000,
  CLASS_LABEL: 80,
  TERM_BODY: 2000,
  BENEFIT_TEXT: 500,
  SOURCE_EXCERPT: 500,
  LOCATION_LABEL: 80,
  CATALOG_LABEL: 120,
});

const MONEY_MAX = 999999999999.99; // numeric(14,2)

const LIST = Object.freeze({ AUDIT_PAGE: 100 });

module.exports = { FILES, SESSION, TEXT, MONEY_MAX, LIST, MiB };
