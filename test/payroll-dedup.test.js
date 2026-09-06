const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeSql } = require("./helpers/fake-sql");
const { runScheduledPayroll, ensureMonthlyRun } = require("../lib/payroll/monthlyRun");

/* عدم التكرار — القاعدة الأهمّ في الميزة.
   =========================================================================
   الحاجزان في القاعدة لا في منطق التطبيق، فالاختبار يحاكي نتيجتهما:
   INSERT يُرجع صفًّا (فاز) أو لا يُرجع (خسر السباق)، وكذلك حجز
   notified_at. ما يُقاس هو ما تفعله الشيفرة بكل نتيجة: هل تُرسل؟ */

const FIRST_OF_SEPTEMBER = new Date("2026-09-01T03:00:00Z");

const EMPLOYEES = [
  { "الرقم الوظيفي": "1001", "اسم العامل": "أحمد علي", "المهنة": "سائق" },
  { "الرقم الوظيفي": "1002", "اسم العامل": "سعيد محمد", "المهنة": "فنّي" },
];

/* بيئة تشغيل كاملة: القاعدة مُزيَّفة، والبريد والدفع يُسجَّلان ولا يخرجان. */
function harness({ runInsertWins = true, notifyClaimWins = true, mailThrows = null, push = { ok: true, sent: 1 } } = {}) {
  const mails = [];
  const pushes = [];
  const logs = [];
  const sql = makeFakeSql((call) => {
    if (/INSERT INTO payroll_runs/.test(call.text)) return runInsertWins ? [{ id: "2026-08" }] : [];
    if (/UPDATE payroll_runs SET notified_at = now\(\)/.test(call.text)) return notifyClaimWins ? [{ id: "2026-08" }] : [];
    return [];
  });
  return {
    sql, mails, pushes, logs,
    deps: {
      sql,
      listEmployees: async () => EMPLOYEES,
      sendMail: async (m) => {
        if (mailThrows) throw new Error(mailThrows);
        mails.push(m);
        return { messageId: "<test>" };
      },
      sendPush: async (run) => { pushes.push(run); return push; },
      log: (e) => logs.push(e),
    },
  };
}

test("التشغيل الأول: ينشئ المسير ويُرسل البريد والدفع مرّة واحدة", async () => {
  const h = harness();
  const res = await runScheduledPayroll(FIRST_OF_SEPTEMBER, h.deps);

  assert.equal(res.ran, true);
  assert.equal(res.created, true);
  assert.equal(res.notified, true);
  assert.equal(res.runId, "2026-08");
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].subject, "تم إنشاء مسير رواتب أغسطس 2026");
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].id, "2026-08");
});

/* الحالة التي يقع فيها الـCron كل يوم بعد الأول: المسير موجود. */
test("المسير منشأ سابقًا: لا إنشاء ولا بريد ولا دفع", async () => {
  const h = harness({ runInsertWins: false });
  const res = await runScheduledPayroll(FIRST_OF_SEPTEMBER, h.deps);

  assert.equal(res.ran, false);
  assert.equal(res.reason, "already_exists");
  assert.equal(h.mails.length, 0, "لا يُرسل تنبيه لمسير منشأ سابقًا");
  assert.equal(h.pushes.length, 0);
  /* ولا يُلمس صفّ الموظفين ولا المرفقات: لا كتابة بعد INSERT الخاسر. */
  assert.equal(h.sql.matching(/INSERT INTO payroll_transfer_proofs/).length, 0);
  assert.equal(h.sql.matching(/INSERT INTO payroll_attachments/).length, 0);
});

/* تشغيلان متزامنان: أحدهما يفوز بالإنشاء ويخسر حجز التنبيه (سبقه الآخر). */
test("سباق على حجز التنبيه: من يخسره لا يُرسل", async () => {
  const h = harness({ notifyClaimWins: false });
  const res = await runScheduledPayroll(FIRST_OF_SEPTEMBER, h.deps);

  assert.equal(res.notified, false);
  assert.equal(res.reason, "already_notified");
  assert.equal(h.mails.length, 0);
  assert.equal(h.pushes.length, 0);
});

/* فشل SMTP يجب أن يُفرج عن الحجز، وإلّا ضاع تنبيه الشهر كليًا بسبب عطل
   شبكة عابر — والمحاولة التالية تقع غدًا داخل نافذة التدارك. */
test("فشل البريد يُفرج عن الحجز ليُعاد غدًا", async () => {
  const h = harness({ mailThrows: "535 BadCredentials" });
  const res = await runScheduledPayroll(FIRST_OF_SEPTEMBER, h.deps);

  assert.equal(res.notified, false);
  assert.equal(res.reason, "notify_failed");
  const release = h.sql.matching(/SET notified_at = NULL/);
  assert.equal(release.length, 1, "الحجز يُفرج عنه");
  assert.ok(h.logs.some((l) => l.type === "payroll_run_notify_failed"));
  assert.equal(h.pushes.length, 0, "لا دفع بعد فشل البريد — تُعاد المحاولتان معًا");
});

/* الاتجاه المعاكس: البريد خرج فعلًا. الإفراج كان سيُرسله ثانيةً، فيبقى
   الحجز ويُسجَّل خطأ الدفع وحده. */
test("فشل الدفع وحده لا يُفرج عن الحجز", async () => {
  const h = harness({ push: { ok: false, error: "push service 500" } });
  const res = await runScheduledPayroll(FIRST_OF_SEPTEMBER, h.deps);

  assert.equal(res.notified, true);
  assert.equal(h.mails.length, 1);
  assert.equal(h.sql.matching(/SET notified_at = NULL/).length, 0, "البريد خرج — لا إفراج");
  assert.equal(h.sql.matching(/SET notify_error =/).length, 1, "يُسجَّل خطأ الدفع");
});

test("خارج نافذة التدارك: لا يلمس القاعدة إطلاقًا", async () => {
  const h = harness();
  const res = await runScheduledPayroll(new Date("2026-09-09T03:00:00Z"), h.deps);

  assert.equal(res.ran, false);
  assert.equal(res.reason, "outside_window");
  assert.equal(res.day, 9);
  assert.equal(h.sql.calls.length, 0);
  assert.equal(h.mails.length, 0);
});

test("داخل نافذة التدارك (اليوم الخامس) ما زال يعمل", async () => {
  const h = harness();
  const res = await runScheduledPayroll(new Date("2026-09-05T03:00:00Z"), h.deps);
  assert.equal(res.created, true);
  assert.equal(res.runId, "2026-08", "التدارك ينشئ مسير أغسطس لا سبتمبر");
});

/* اللقطة تُكتب صفًّا لكل موظف، بمعرّفه صراحةً. */
test("الإنشاء يبذر صفّ إثبات لكل موظف وثلاثة مرفقات للشهر", async () => {
  const h = harness();
  const res = await ensureMonthlyRun(FIRST_OF_SEPTEMBER, h.deps);

  assert.equal(res.created, true);
  assert.equal(res.employees, 2);
  const proofInserts = h.sql.matching(/INSERT INTO payroll_transfer_proofs/);
  assert.equal(proofInserts.length, 2);
  assert.deepEqual(proofInserts.map((c) => c.values[1]), ["1001", "1002"]);
  assert.equal(h.sql.matching(/INSERT INTO payroll_attachments/).length, 3);
});

/* المسير أُنشئ وحُجز الشهر؛ تعطّل قراءة سجلّ الموظفين لا يصحّ أن يُلغيه. */
test("فشل قراءة سجلّ الموظفين لا يُسقط المسير", async () => {
  const h = harness();
  h.deps.listEmployees = async () => { throw new Error("DATABASE_URL غير مُهيّأ"); };
  const res = await ensureMonthlyRun(FIRST_OF_SEPTEMBER, h.deps);

  assert.equal(res.created, true);
  assert.equal(res.employees, 0);
  assert.ok(h.logs.some((l) => l.type === "payroll_run_snapshot_failed"));
});
