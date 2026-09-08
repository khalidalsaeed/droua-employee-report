#!/usr/bin/env node
/* تهيئة قاعدة البيانات لميزة مسير الرواتب الشهري التلقائي.
   =========================================================================
   المستودع لا يحوي نظام migrations، والجداول القائمة أُنشئت يدويًا — هذا
   السكربت يؤدّي الدور نفسه من داخل المشروع باستعمال DATABASE_URL نفسه،
   على نمط scripts/setup-push-tables.js حرفيًا.

   آمن وقابل لإعادة التشغيل: كل عبارة IF NOT EXISTS، ولا يحذف شيئًا ولا
   يعدّل بيانات قائمة. تشغيله مرّتين لا يفعل شيئًا في الثانية.

   ما لا يفعله عمدًا: لا يبذر صفوف موظفين لأي مسير قائم. مسير يوليو 2026
   وما قبله يبقى كما هو حرفًا بحرف — قسم إثباتات التحويل لا يظهر فيه
   أصلًا لأن لا صفوف له، والميزة تبدأ من أول مسير يُنشئه الـCron.

   التشغيل:   node scripts/setup-payroll-monthly.js
   المعاينة:  node scripts/setup-payroll-monthly.js --dry-run
              تطبع ما سيُنفَّذ ولا تتّصل بالقاعدة إطلاقًا. */

const STATEMENTS = [
  {
    label: "جدول payroll_transfer_proofs",
    sql: `
      CREATE TABLE IF NOT EXISTS payroll_transfer_proofs (
        id            bigserial PRIMARY KEY,
        -- CASCADE: حذف المسير يُسقط صفوف إثباتاته معه. ملفّات Blob
        -- تُحذف في lib/data/payrollRuns.js:remove — القاعدة لا تعرفها.
        run_id        text NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
        employee_eid  text NOT NULL,
        -- لقطة وقت الإنشاء لا مفتاح أجنبي إلى employees: مسير شهرٍ مضى
        -- يجب ألّا يتغيّر بتعديل سجلّ الموظف ولا أن يختفي صفّه بحذفه.
        employee_name text NOT NULL,
        job_title     text,
        file_url      text,
        file_name     text,
        uploaded_at   timestamptz,
        uploaded_by   text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        -- الحاجز الذي يمنع اختلاط إثبات بموظف آخر: صفّ واحد لا غير لكل
        -- (مسير، موظف)، وكل كتابة مقيّدة بهذين المفتاحين معًا.
        UNIQUE (run_id, employee_eid)
      )`,
  },
  {
    label: "فهرس payroll_transfer_proofs(run_id)",
    sql: `CREATE INDEX IF NOT EXISTS idx_payroll_proofs_run ON payroll_transfer_proofs (run_id)`,
  },
  {
    label: "عمود payroll_transfer_proofs.sheet_amount",
    /* «راتب المسير» — صافي الموظف في كشف رواتب ذلك الشهر، مُلقَطًا من
       الكشف نفسه ومجمَّدًا في صفّه. هو المرجع الذي تُقاس عليه بقية
       القيم في مطابقة إيصالات التحويل:
         sheet_amount    صافيه في الكشف                    ← هذا العمود
         invoice_amount  «صافي الراتب الشهري» في الفاتورة  ← مرحلة تالية
         receipt_amount  المبلغ المحوَّل فعلًا              ← مرحلة تالية

       ولا يُقرأ حيًّا من سجلّ الموظف عند المقارنة: الراتب يتغيّر شهرًا
       بعد شهر — وقتٌ إضافي وغياب وسلف وخصميات — فراتب سبتمبر ليس مرجعًا
       لأغسطس. القيمة الصحيحة الوحيدة ما طُبع في كشف الشهر نفسه.

       NULL مسموح ومعناه صريح: «لم تُزامَن بعد» لا «صفر». والمسيرات
       القائمة تبقى NULL حتى تُشغَّل المزامنة عليها — لا تُمسّ بياناتها.
       numeric(12,2) لا عائم: المال يُخزَّن بمنزلتين مضبوطتين، والمقارنة
       بسماحية صفر لا تصحّ على عائم. */
    sql: `ALTER TABLE payroll_transfer_proofs ADD COLUMN IF NOT EXISTS sheet_amount numeric(12,2)`,
  },
  {
    label: "عمود payroll_runs.source",
    // 'manual' افتراضًا فالمسيرات القائمة توصَف بصدق دون تعديل بياناتها.
    sql: `ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`,
  },
  {
    label: "عمود payroll_runs.notified_at",
    // حجز التنبيه: UPDATE ... WHERE notified_at IS NULL هو ما يجعل
    // الإشعار يخرج مرّة واحدة مهما تكرّر تشغيل الـCron.
    sql: `ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS notified_at timestamptz`,
  },
  {
    label: "عمود payroll_runs.notify_error",
    sql: `ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS notify_error text`,
  },
];

/* ينفّذ العبارات واحدةً واحدة على `sql` المُمرَّر.
   =========================================================================
   sql.query() هي واجهة تنفيذ نصّ استعلام كامل في @neondatabase/serverless.
   وهذا ليس تفصيلًا أسلوبيًا: sql.unsafe() ليست دالّة تنفيذ أصلًا — تُرجع
   كائن UnsafeRawSql وصفيًّا ({sql}) معدًّا للتضمين داخل قالب موسوم، فهو
   ليس Promise. و await على غير Promise يحلّ فورًا بقيمته.

   لذلك كان `await sql.unsafe(s.sql)` يبني وصفًا ويرميه: صفر طلبات إلى
   القاعدة، ومع ذلك يطبع «تم» بعد كل عبارة ويخرج بنجاح. عطلٌ يكذب: كنّا
   سنظنّ القاعدة مهيّأة ثم يفشل أول استعلام حقيقي بـ«الجدول غير موجود».
   لذلك يُثبته اختبار انحدار يعدّ الطلبات الخارجة لا مجرّد النداءات.

   الدالّة تأخذ `sql` معاملًا بدل أن تُنشئه بنفسها كي يستطيع الاختبار
   تمرير مُشغّل حقيقي بشبكة مُعترَضة. */
async function run(sql, { onProgress } = {}) {
  for (const s of STATEMENTS) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return STATEMENTS.length;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
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
  /* التقدّم يُطبع قبل كل عبارة وبعدها، فالتوقّف عند عبارة بعينها ظاهرٌ
     في المخرجات. وكل عبارة IF NOT EXISTS، فتوقّفٌ في المنتصف يُعالَج
     بإعادة التشغيل: ما نُفِّذ يُتخطّى وما بقي يُستكمل. */
  const count = await run(getSql(), {
    onProgress: (s) => console.log(`${s.label} ... تم`),
  });
  console.log(`\nاكتملت التهيئة (${count} عبارة). لم تُمسّ أي بيانات قائمة.`);
}

/* لا يعمل عند الاستيراد — الاختبار يستورد STATEMENTS و run بلا تنفيذ. */
if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشلت التهيئة:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, run };
