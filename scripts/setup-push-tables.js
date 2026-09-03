#!/usr/bin/env node
/* إنشاء جدولَي إشعارات الدفع في Neon.
   =========================================================================
   المستودع لا يحوي نظام migrations، والجداول القائمة أُنشئت يدويًا. هذا
   السكربت يؤدّي الدور نفسه من داخل المشروع باستعمال DATABASE_URL نفسه
   الذي يستعمله التطبيق، بلا فتح لوحة Neon.

   آمن وقابل لإعادة التشغيل: كل عبارة IF NOT EXISTS، ولا يحذف شيئًا ولا
   يعدّل جدولًا قائمًا ولا يلمس بيانات. تشغيله مرّتين لا يفعل شيئًا في
   الثانية.

   التشغيل:   node scripts/setup-push-tables.js
   المعاينة:  node scripts/setup-push-tables.js --dry-run
              تطبع ما سيُنفَّذ ولا تتّصل بالقاعدة إطلاقًا. */

const STATEMENTS = [
  {
    label: "جدول push_subscriptions",
    sql: `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id              bigserial PRIMARY KEY,
        -- نصّ بلا مفتاح أجنبي إلى users: حسابا الاحتياط (env-owner و
        -- env-hr-specialist) يعيشان في متغيّرات البيئة ولا صفّ لهما في
        -- الجدول، وأي FK كان سيرفض تسجيل أجهزتهما.
        user_id         text NOT NULL,
        -- معرّف الجهاز عند خدمة الدفع. UNIQUE هو ما يجعل إعادة الاشتراك
        -- من الجهاز نفسه تُحدِّث صفّه بدل أن تُنشئ ثانيًا.
        endpoint        text NOT NULL UNIQUE,
        p256dh          text NOT NULL,
        auth            text NOT NULL,
        user_agent      text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        last_seen_at    timestamptz NOT NULL DEFAULT now(),
        last_success_at timestamptz,
        failure_count   integer NOT NULL DEFAULT 0
      )`,
  },
  {
    label: "فهرس push_subscriptions(user_id)",
    sql: `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id)`,
  },
  {
    label: "جدول push_notification_log",
    sql: `
      CREATE TABLE IF NOT EXISTS push_notification_log (
        id              bigserial PRIMARY KEY,
        -- CASCADE: حذف اشتراك ميّت (404/410) يُنظّف سجلّه معه.
        subscription_id bigint NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        -- مفتاح عدم التكرار. للتنبيه اليومي: expiry:YYYY-MM-DD بتوقيت الرياض.
        dedup_key       text NOT NULL,
        status          text NOT NULL,
        error           text,
        sent_at         timestamptz NOT NULL DEFAULT now(),
        -- الحاجز الفعلي: INSERT ... ON CONFLICT DO NOTHING عليه يضمن
        -- إرسالًا واحدًا لكل جهاز لكل مفتاح مهما تكرّر تشغيل الـCron.
        UNIQUE (subscription_id, dedup_key)
      )`,
  },
  {
    label: "فهرس push_notification_log(sent_at)",
    sql: `CREATE INDEX IF NOT EXISTS idx_push_log_sent_at ON push_notification_log (sent_at DESC)`,
  },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("— معاينة فقط: لن يُفتح أي اتصال بقاعدة البيانات —\n");
    for (const s of STATEMENTS) console.log(`── ${s.label} ──${s.sql}\n`);
    console.log(`المجموع: ${STATEMENTS.length} عبارة، كلها IF NOT EXISTS.`);
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
    /* عبارات DDL ثابتة مكتوبة في هذا الملف — لا مُدخَل من مستخدم يصل
       إليها، فلا سطح لحقن SQL هنا. */
    await sql.query(s.sql);
    console.log("✔", s.label);
  }

  const check = await sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('push_subscriptions','push_notification_log')
     ORDER BY table_name`;
  console.log("\nالجداول الموجودة الآن:", check.map((r) => r.table_name).join("، ") || "لا شيء");
}

main().catch((err) => {
  console.error("فشل الإعداد:", (err && err.message) || err);
  process.exitCode = 1;
});
