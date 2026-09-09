#!/usr/bin/env node
/* تهيئة جداول بيانات القسم: المسيرات، والملفّات، والملاحظات.
   =========================================================================
   ⛔ ولا جدول للموظفين: القسم لا يمسك سجلًّا للموظفين أصلًا — يقرأ ما في
   ملفّات الشهر ويقارن، ولا يبني قاعدة ثانية عنهم.

   على نمط scripts/setup-droua-gate.js حرفيًا: كل عبارة IF NOT EXISTS، ولا
   يحذف شيئًا ولا يعدّل جدولًا قائمًا ولا يمسّ بيانات. تشغيله مرّتين لا يفعل
   شيئًا في الثانية.

   التشغيل:   node scripts/setup-droua-files.js
   المعاينة:  node scripts/setup-droua-files.js --dry-run
              تطبع ما سيُنفَّذ ولا تتّصل بالقاعدة إطلاقًا. */

const STATEMENTS = [
  {
    label: "جدول droua_payroll_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_payroll_runs (
        id          uuid PRIMARY KEY,
        -- شهرٌ واحد لا يتكرّر. والتفرّد هنا هو ما يمنع «سبتمبر» مرّتين
        -- بملفّين مختلفين — وهو خطأ لا يُكتشف إلا بعد مقارنةٍ كاذبة.
        period      text NOT NULL UNIQUE CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        status      text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'ready', 'analyzed', 'closed')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        analyzed_at timestamptz,
        closed_at   timestamptz
      )`,
  },
  {
    label: "جدول droua_payroll_files",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_payroll_files (
        -- هو fileId نفسه: يُولَّد على الخادم **قبل** التشفير، ويدخل الـAAD.
        -- فتحويره في القاعدة يكسر فكّ التشفير بدل أن يُقدّم ملفًّا آخر.
        id             uuid PRIMARY KEY,
        -- CASCADE عمدًا **لا** RESTRICT: حذف الشهر يمرّ بمسار حذفٍ يمحو
        -- البايتات صفًّا صفًّا قبل أن يبلغ الشهر نفسه (lib/droua/runs.js).
        -- فحين تصل القاعدة إلى هنا لم يبقَ إلا شواهد قبورٍ مطهَّرة.
        run_id         uuid NOT NULL REFERENCES droua_payroll_runs (id) ON DELETE CASCADE,

        -- القيد في القاعدة لا في التطبيق وحده: kind جزءٌ من الـAAD، وقيمةٌ
        -- تتسلّل خارج القائمة تعني ملفًّا لا يُفكّ بعد اليوم.
        kind           text NOT NULL CHECK (kind IN ('cash', 'full', 'transfer', 'employees')),

        -- موضع لا هويّة. UNIQUE يمنع صفّين يشيران إلى كائن واحد — فحذف
        -- أحدهما كان سيُفقد الآخر بلا إنذار.
        blob_pathname  text NOT NULL UNIQUE
                       CHECK (blob_pathname ~ '^droua-payroll-audit/[0-9a-f-]{36}/[0-9a-f]{32}$'),

        -- للعرض والتنزيل فقط. لا يدخل المسار ولا الـAAD.
        -- ومنع محارف التحكّم هنا هو الطبقة الثانية تحت ترويسة التنزيل:
        -- سطرٌ جديد في اسم ملفّ = حقن ترويسات في Content-Disposition.
        file_name      text NOT NULL CHECK (
                         char_length(file_name) BETWEEN 1 AND 255
                         AND file_name !~ '[[:cntrl:]]'
                         AND strpos(file_name, '/') = 0
                         AND strpos(file_name, '\') = 0),

        format         text NOT NULL CHECK (format IN ('pdf', 'xlsx', 'xls', 'csv')),
        content_type   text NOT NULL,

        -- بايتات النصّ الصريح. الحدّ نفسه المفروض في storage.js — والحدّان
        -- معًا لا أحدهما: التطبيق يحمي من الرفع، والقاعدة تحمي من كاتبٍ آخر.
        size_bytes     bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),

        -- بصمة **الملفّ الأصليّ** قبل التشفير. الاسم يقولها فلا يُخمَّن لاحقًا.
        plaintext_sha256 text NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),

        enc_algo       text NOT NULL CHECK (enc_algo = 'aes-256-gcm'),
        -- به تُقرأ الملفّات، لا بالمفتاح النشط. صيغته تطابق حلقة المفاتيح.
        enc_key_id     text NOT NULL CHECK (enc_key_id ~ '^k[1-9][0-9]{0,2}$'),
        enc_iv         text NOT NULL CHECK (enc_iv ~ '^[0-9a-f]{24}$'),
        enc_tag        text NOT NULL CHECK (enc_tag ~ '^[0-9a-f]{32}$'),

        created_at     timestamptz NOT NULL DEFAULT now(),

        -- ثلاثة أزمنة، لكلٍّ معنًى واحد لا يشاركه غيره:
        --   superseded_at: لم يعد النسخة الحالية (استُبدل أو حُذف).
        --   deleted_at   : حذفٌ مقصود — الصفّ شاهدُ قبرٍ يُزال بعد الكائن.
        --   purged_at    : الكائن نفسه لم يعد موجودًا في المتجر.
        -- وبها وحدها يُميَّز «تاريخُ نسخةٍ يُحتفظ به» عن «بقيّةُ حذفٍ تُكنس».
        superseded_at  timestamptz,
        deleted_at     timestamptz,
        purged_at      timestamptz,

        -- النوع ونوع المحتوى يُقفلان معًا: ملفّ يُقدَّم بـtext/html من
        -- نطاقنا يصير XSS مخزَّنًا في سياق يملك كوكي المنصّة وكوكي البوابة
        -- معًا. والقيد هنا يمنع الزوج المتناقض حتى لو أخطأ كاتبٌ مستقبليّ.
        CONSTRAINT droua_payroll_files_type_pair CHECK (
          (format = 'pdf'  AND content_type = 'application/pdf') OR
          (format = 'xlsx' AND content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') OR
          (format = 'xls'  AND content_type = 'application/vnd.ms-excel') OR
          (format = 'csv'  AND content_type = 'text/csv')),

        -- لا يُطهَّر كائنُ ملفٍّ ما زال هو النسخة الحالية، ولا يُشطب صفٌّ
        -- لم يُرفع عنه وصفُ «الحاليّ» أوّلًا.
        CONSTRAINT droua_payroll_files_lifecycle CHECK (
          (purged_at IS NULL OR superseded_at IS NOT NULL)
          AND (deleted_at IS NULL OR superseded_at IS NOT NULL))
      )`,
  },
  {
    label: "جدول droua_payroll_findings",
    sql: `
      CREATE TABLE IF NOT EXISTS droua_payroll_findings (
        id             uuid PRIMARY KEY,
        run_id         uuid NOT NULL REFERENCES droua_payroll_runs (id) ON DELETE CASCADE,

        -- بصمة الملاحظة: قاعدة + نطاق + موظّف + حقل. وهي ما يجعل إعادة
        -- التحليل **تُحدِّث** ملاحظةً قائمة بدل أن تُنشئ ثانيةً مثلها —
        -- فتبقى حالتُها وملاحظةُ المستخدم عليها. وبدونها يفقد المستخدم
        -- عملَه كلَّه مع كل إعادة رفع، وهو أسوأ ما يمكن أن يفعله النظام به.
        fingerprint    text NOT NULL,
        rule           text NOT NULL,
        scope          text NOT NULL CHECK (scope IN ('within_month', 'vs_previous')),
        severity       text NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),

        title          text NOT NULL,
        employee_ref   text,
        employee_name  text,
        field          text,
        -- قيمٌ نصّية مقتطعة. ⛔ ولا رقم حساب كاملًا هنا بحال — تفرضه
        -- lib/droua/findings.js وتحرسه اختبارات.
        previous_value text,
        current_value  text,
        delta          numeric,
        description    text,

        status         text NOT NULL DEFAULT 'needs_review'
                       CHECK (status IN ('needs_review', 'verified', 'approved_change', 'needs_fix')),
        user_note      text CHECK (user_note IS NULL OR char_length(user_note) <= 2000),

        first_seen_at  timestamptz NOT NULL DEFAULT now(),
        last_seen_at   timestamptz NOT NULL DEFAULT now(),
        -- تُضبط حين تختفي الملاحظة من تحليلٍ تالٍ: أي أن الرفع الجديد
        -- عالجها. ولا تُحذف — اختفاءُ ملاحظةٍ حدثٌ يستحقّ البقاء.
        resolved_at    timestamptz,

        UNIQUE (run_id, fingerprint)
      )`,
  },
  {
    label: "فهرس فريد جزئيّ: نسخة حالية واحدة لكل (run_id, kind)",
    // هذا هو الجواب على «هل يُسمح بأكثر من ملفّ لنفس الشهر والنوع؟»:
    // نعم للتاريخ، ولا للحاضر. الفريد **الجزئيّ** يسمح بعددٍ غير محدود من
    // النسخ المستبدَلة ويمنع وجود اثنتين حاليّتين — فلا re-upload مكسور،
    // ولا غموض في «أيّهما المعتمد».
    //
    // وهو أيضًا ما يجعل تسابق استبدالين ينتهي بفشل أحدهما لا بصفّين
    // حاليّين: القاعدة تحسم، لا ترتيبُ الوصول.
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_droua_payroll_files_current
            ON droua_payroll_files (run_id, kind) WHERE superseded_at IS NULL`,
  },
];

/* ── لماذا فهرسان لا خمسة ──
   الجدول يستقبل أربعة ملفّات في الشهر: نحو 48 صفًّا في السنة، ومئات في عمر
   النظام. وعلى هذا الحجم لا يوفّر أي فهرس بحثٍ شيئًا — المسح الكامل أسرع من
   قراءة الفهرس ثمّ الصفّ. فكلّ فهرس إضافي كلفةُ كتابةٍ ومساحةٍ بلا مقابل،
   وقد سبق إسقاط فهرس زائد في جداول البوابة للسبب نفسه.

   فما بقي هنا ليس للسرعة أصلًا بل **للسلامة**: الفريد على blob_pathname،
   والفريد الجزئيّ على (run_id, kind). كلاهما قيدٌ ينفّذه محرّك القاعدة ولا
   يعتمد على تذكّر كاتبٍ مستقبليّ. ويُعاد النظر يوم يصير للجدول حجمٌ يُقاس. */

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
    for (const s of STATEMENTS) console.log(`▸ ${s.label}\n${s.sql.trim()}\n`);
    console.log(`المجموع: ${STATEMENTS.length} عبارة.`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مضبوط.");
    process.exitCode = 1;
    return;
  }
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  const count = await run(sql, { onProgress: (s) => console.log(`✅ ${s.label}`) });
  console.log(`\nتمّت ${count} عبارة.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("فشلت التهيئة:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, run };
