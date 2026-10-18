#!/usr/bin/env node
/* المدير المباشر مرجعًا ذاتيًا في جدول الموظفين — هجرة مقترحة، غير مُطبَّقة.
   =========================================================================
   ⛔ لا تُشغَّل على الإنتاج قبل موافقة صريحة. الهيكل التنظيمي في هذه النسخة
   يقرأ لقطة Excel (lib/org/source.js) ولا يحتاج هذا العمود ليعمل.

   ما تضيفه:
     employees.manager_eid  TEXT NULL → employees(eid)
       - ON DELETE SET NULL: حذف المدير لا يحذف تابعيه، يتركهم بلا مدير
         فيظهرون في فاحص الهيكل «بلا مدير».
       - ON UPDATE CASCADE: تغيير رقم ضمان المدير يتبعه تلقائيًا.
     CHECK (manager_eid <> eid)     — لا موظف مديرٌ لنفسه.
     مُشغّل BEFORE INSERT/UPDATE    — يرفض أي تعيين يُغلق حلقة (A↔B أو أطول)
                                      بتتبّع سلسلة المدراء صعودًا. حاجزٌ في
                                      القاعدة نفسها: لا يتجاوزه SQL مباشر ولا
                                      سباق بين طلبين.
     فهرس على manager_eid           — لجلب التابعين المباشرين.

   التحقّق في التطبيق (lib/org/managerGuard.js) يعطي رسالة عربية مفهومة
   قبل الكتابة؛ المُشغّل هو الضمان الصلب. التعريفان يطابقان
   OrgCore.checkManagerAssignment.

   آمن وقابل لإعادة التشغيل (IF NOT EXISTS / OR REPLACE). لا يملأ بيانات:
   ربط المدراء الخمسة المرجعيين بسجلّاتهم خطوة لاحقة منفصلة.

   المعاينة:   node scripts/setup-org-manager.js --dry-run
   التطبيق:    node scripts/setup-org-manager.js            (بعد الموافقة فقط)
   الرجوع:     node scripts/setup-org-manager.js --rollback [--dry-run] */

const STATEMENTS = [
  {
    label: "عمود manager_eid مرجعًا ذاتيًا إلى employees(eid)",
    sql: `
      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS manager_eid TEXT NULL
        REFERENCES employees(eid) ON UPDATE CASCADE ON DELETE SET NULL`,
  },
  {
    label: "قيد: لا موظف مديرٌ لنفسه",
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_manager_not_self') THEN
          ALTER TABLE employees ADD CONSTRAINT employees_manager_not_self CHECK (manager_eid IS NULL OR manager_eid <> eid);
        END IF;
      END $$`,
  },
  {
    label: "فهرس التابعين المباشرين",
    sql: `CREATE INDEX IF NOT EXISTS idx_employees_manager_eid ON employees (manager_eid) WHERE manager_eid IS NOT NULL`,
  },
  {
    label: "دالّة رفض الحلقات الإدارية",
    sql: `
      CREATE OR REPLACE FUNCTION employees_reject_manager_cycle() RETURNS trigger AS $$
      DECLARE
        cur TEXT := NEW.manager_eid;
        steps INT := 0;
      BEGIN
        IF NEW.manager_eid IS NULL THEN RETURN NEW; END IF;
        WHILE cur IS NOT NULL LOOP
          IF cur = NEW.eid THEN
            RAISE EXCEPTION 'manager_cycle: تعيين % مديرًا لـ % يُنشئ تسلسلًا إداريًا دائريًا', NEW.manager_eid, NEW.eid
              USING ERRCODE = 'check_violation';
          END IF;
          steps := steps + 1;
          IF steps > 10000 THEN EXIT; END IF; -- حلقة قائمة لا تمرّ بهذا الموظف
          SELECT manager_eid INTO cur FROM employees WHERE eid = cur;
        END LOOP;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`,
  },
  {
    label: "مُشغّل رفض الحلقات قبل الإدراج والتعديل",
    sql: `
      DROP TRIGGER IF EXISTS trg_employees_manager_cycle ON employees;
      CREATE TRIGGER trg_employees_manager_cycle
        BEFORE INSERT OR UPDATE OF manager_eid, eid ON employees
        FOR EACH ROW EXECUTE FUNCTION employees_reject_manager_cycle()`,
  },
];

/* الرجوع الكامل بالترتيب العكسي — يُزيل كل ما أضافته الهجرة ولا يمسّ غيره. */
const ROLLBACK = [
  { label: "حذف المُشغّل", sql: `DROP TRIGGER IF EXISTS trg_employees_manager_cycle ON employees` },
  { label: "حذف الدالّة", sql: `DROP FUNCTION IF EXISTS employees_reject_manager_cycle()` },
  { label: "حذف الفهرس", sql: `DROP INDEX IF EXISTS idx_employees_manager_eid` },
  { label: "حذف القيد", sql: `ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_manager_not_self` },
  { label: "حذف العمود", sql: `ALTER TABLE employees DROP COLUMN IF EXISTS manager_eid` },
];

async function run(sql, statements, { onProgress } = {}) {
  for (const s of statements) {
    await sql.query(s.sql);
    if (onProgress) onProgress(s);
  }
  return statements.length;
}

async function main() {
  const rollback = process.argv.includes("--rollback");
  const list = rollback ? ROLLBACK : STATEMENTS;
  if (process.argv.includes("--dry-run")) {
    console.log(`— معاينة ${rollback ? "الرجوع" : "الهجرة"} فقط، بلا اتّصال بالقاعدة —\n`);
    for (const s of list) console.log(`${s.label}:\n${s.sql.trim()}\n`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ. صدّره أوّلًا أو شغّل مع --dry-run.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  await run(getSql(), list, { onProgress: (s) => console.log(`${s.label} ... تم`) });
  console.log(rollback ? "\nاكتمل الرجوع." : "\nاكتملت الهجرة. لم تُمسّ أي بيانات قائمة.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nفشلت العملية:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { STATEMENTS, ROLLBACK, run };
