#!/usr/bin/env node
/* تهيئة جداول بوابة القسم السرّي.
   =========================================================================
   ثلاثة جداول، **كلّها تخصّ البوابة وحدها**: الجلسة، ومحاولات الفتح،
   والتدقيق الأمنيّ. ⛔ ولا جدول لمسيرات ولا موظفين ولا ملفات — تلك مراحل
   لاحقة لها سكربتها.

   على نمط scripts/setup-payroll-monthly.js حرفيًا: كل عبارة IF NOT EXISTS،
   ولا يحذف شيئًا ولا يعدّل جدولًا قائمًا ولا يمسّ بيانات. تشغيله مرّتين لا
   يفعل شيئًا في الثانية.

   التشغيل:   node scripts/setup-droua-gate.js
   المعاينة:  node scripts/setup-droua-gate.js --dry-run
              تطبع ما سيُنفَّذ ولا تتّصل بالقاعدة إطلاقًا. */

const STATEMENTS = [
  {
    label: "جدول droua_gate_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_gate_sessions (
        -- المفتاح هو sha256 لمعرّف الجلسة، لا المعرّف نفسه ولا التوكن.
        -- التوكن لا يُخزَّن إطلاقًا، فتسريب القاعدة وحده لا يعطي ما يُستعمل.
        sid_hash      text PRIMARY KEY,
        user_id       text NOT NULL,
        issued_at     timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz NOT NULL DEFAULT now(),
        -- ينزلق مع النشاط، ولا يتجاوز absolute_exp أبدًا.
        idle_exp      timestamptz NOT NULL,
        -- يُثبَّت عند الفتح ولا يُمدَّد. هو ما يمنع جلسة أبديّة بنشاط مصطنع.
        absolute_exp  timestamptz NOT NULL,
        -- الإبطال الحقيقي: توكن موقَّع لا يُبطَل بلا صفّ في القاعدة.
        revoked_at    timestamptz
        -- عمدًا بلا ip ولا user_agent: الربط بالـUA حماية ضعيفة تقطع جلسة
        -- مشروعة مع كل تحديث متصفّح ولا تمنع من ينسخ الترويسة.
      )`,
  },
  {
    label: "فهرس droua_gate_sessions(user_id)",
    sql: `CREATE INDEX IF NOT EXISTS idx_droua_gate_sessions_user ON droua_gate_sessions (user_id)`,
  },
  {
    label: "جدول droua_gate_attempts",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_gate_attempts (
        id       bigserial PRIMARY KEY,
        user_id  text NOT NULL,
        -- 'fail' | 'success' — ولا شيء عن كلمة المرور: لا هي، ولا طولها،
        -- ولا أول حرف منها، ولا هاشها.
        --
        -- القيد في القاعدة لا في التطبيق وحده: سلامةُ الحقل الذي يُبنى
        -- عليه القفل يجب ألّا تعتمد على أن كل كاتبٍ مستقبليّ سيتذكّر
        -- القيمتين. قيمةٌ ثالثة تتسلّل تعني عدّادًا يُحسب خطأً — أي قفلًا
        -- لا يقع حين يجب.
        -- ('success' غير مكتوب اليوم: النجاح يمسح العدّاد بدل أن يُسجَّل،
        --  ويبقى مسموحًا في القيد تحسّبًا لتغيّر ذلك.)
        outcome  text NOT NULL CHECK (outcome IN ('fail', 'success')),
        ts       timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    label: "فهرس droua_gate_attempts(user_id, outcome, ts) — لعدّ الإخفاقات",
    // شكل استعلام failureCounts حرفيًا: WHERE user_id = $ AND outcome =
    // 'fail' ثم ثلاث نوافذ على ts. الأعمدة الثلاثة بهذا الترتيب تجعل
    // الاستعلام يُخدَم من الفهرس وحده. ويخدم clearFailures بالمسند نفسه.
    //
    // وهو يُغني عن (user_id, ts DESC) تمامًا: عمودُه الرائد نفسه، فكلّ ما
    // كان ذاك يخدمه يخدمه هذا وزيادة. ولذلك أُسقط القديم من المخطّط قبل
    // الإنشاء — فهرسان بمقدّمة واحدة كلفةُ كتابةٍ ومساحةٍ بلا مقابل.
    // (لا حذف من قاعدة: لم تُنشأ بعد.)
    sql: `CREATE INDEX IF NOT EXISTS idx_droua_gate_attempts_lookup
            ON droua_gate_attempts (user_id, outcome, ts DESC)`,
  },
  {
    label: "فهرس droua_gate_attempts(ts) — للتقليم",
    // prune يحذف بـ WHERE ts < $ بلا user_id، و ts عمودٌ تالٍ في الفهرس
    // أعلاه فلا يُستعمل — فيصير الحذف مسحًا كاملًا يثقل كلّما كبر الجدول.
    sql: `CREATE INDEX IF NOT EXISTS idx_droua_gate_attempts_ts ON droua_gate_attempts (ts)`,
  },
  {
    label: "جدول droua_gate_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_gate_audit (
        id       bigserial PRIMARY KEY,
        ts       timestamptz NOT NULL DEFAULT now(),
        event    text NOT NULL,
        user_id  text,
        -- يمرّ بمُنقّي قائمة مسموحة في lib/droua/audit.js قبل الكتابة.
        meta     jsonb NOT NULL DEFAULT '{}'::jsonb,
        -- HMAC مقطوع بمفتاح البوابة مع فصل مجال. ليس عنوانًا ولا يُعكس.
        ip_hash  text
      )`,
  },
  {
    label: "فهرس droua_gate_audit(ts)",
    sql: `CREATE INDEX IF NOT EXISTS idx_droua_gate_audit_ts ON droua_gate_audit (ts DESC)`,
  },
  {
    label: "فهرس droua_gate_audit(event, ip_hash, ts) — لكتم تكرار أحداث الاستكشاف",
    // يخدم مسند NOT EXISTS في lib/droua/audit.js:logThrottled. بلا هذا
    // الفهرس يصير فحصُ الكتم مسحًا كاملًا يثقل كلّما كبر الجدول — فينقلب
    // الحدُّ الذي وُضع لحماية القاعدة عبئًا عليها.
    sql: `CREATE INDEX IF NOT EXISTS idx_droua_gate_audit_dedup ON droua_gate_audit (event, ip_hash, ts DESC)`,
  },
];

/* sql.query() هي واجهة تنفيذ نصٍّ كامل في @neondatabase/serverless.
   sql.unsafe() ليست دالّة تنفيذ أصلًا — تُرجع وصفًا لا Promise، و await
   عليه يحلّ فورًا فتُطبع «تم» بلا أن يصل شيء إلى القاعدة. نفس الملاحظة
   الموثّقة في scripts/setup-payroll-monthly.js، ويحرسها اختبار انحدار. */
async function run(sql, { onProgress } = {}) {
  for (const s of STATEMENTS) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return STATEMENTS.length;
}

async function main() {
  if (process.argv.includes("--dry-run")) {
    console.log("— معاينة فقط، بلا اتّصال بالقاعدة —\n");
    for (const s of STATEMENTS) console.log(`${s.label}:\n${s.sql.trim()}\n`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  const count = await run(getSql(), { onProgress: (s) => console.log(`${s.label} ... تم`) });
  console.log(`\nاكتملت التهيئة (${count} عبارة). لم تُمسّ أي بيانات قائمة.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشلت التهيئة:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, run };
