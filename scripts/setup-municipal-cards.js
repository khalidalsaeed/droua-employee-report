#!/usr/bin/env node
/* إنشاء جدول البطاقات البلدية (الشهادات الصحية) في Neon.
   =========================================================================
   على نمط scripts/setup-push-tables.js: عبارات IF NOT EXISTS فقط، لا حذف
   ولا تعديل لجدول قائم. إعادة التشغيل لا تفعل شيئًا.

   التشغيل:   node scripts/setup-municipal-cards.js
   المعاينة:  node scripts/setup-municipal-cards.js --dry-run */

const STATEMENTS = [
  {
    label: "جدول municipal_cards",
    sql: `
      CREATE TABLE IF NOT EXISTS municipal_cards (
        id            bigserial PRIMARY KEY,
        -- رقم الشهادة كما طُبع (مثل 31319-1448).
        cert_no       text NOT NULL UNIQUE,
        -- رقم الهوية/الإقامة. UNIQUE: بطاقة واحدة سارية لكل موظف، ورفع
        -- الشهادة المجدَّدة يستبدل السابقة.
        id_number     text NOT NULL UNIQUE,
        name_on_card  text,
        issuer        text,
        gender        text,
        nationality   text,
        occupation    text,
        -- الانتهاء كما طُبع (هجري YYYY-MM-DD) ومقابله الميلادي بتقويم أم القرى.
        expiry_hijri  text,
        expiry_date   date,
        -- رابط التحقّق الرسمي المقروء من رمز QR. لا يخرج في JSON أبدًا.
        qr_text       text,
        -- صورة البطاقة (JPEG الأصلي). صغيرة (< 300KB) وتُقدَّم بفحص الصلاحية.
        photo_b64     text,
        photo_sha256  text,
        updated_by    text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`,
  },
];

async function main() {
  if (process.argv.includes("--dry-run")) {
    console.log("— معاينة فقط: لن يُفتح أي اتصال بقاعدة البيانات —\n");
    for (const s of STATEMENTS) console.log(`── ${s.label} ──${s.sql}\n`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ في البيئة.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  const sql = getSql();
  for (const s of STATEMENTS) {
    await sql.query(s.sql); // DDL ثابت في هذا الملفّ — لا مُدخَل مستخدم
    console.log("✔", s.label);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("فشل الإعداد:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS };
