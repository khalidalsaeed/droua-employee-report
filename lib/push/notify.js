const { getSql } = require("../db");
const { riyadhDateString } = require("../reports/period");
const { findByIdRaw } = require("../auth/users");
const { hasPermission } = require("../auth/permissions");
const subscriptions = require("./subscriptions");
const { sendToSubscription } = require("./send");
const { isConfigured } = require("./vapid");

/* تنبيهات انتهاء الوثائق عبر الدفع.
   =========================================================================
   هذا الملف لا يقرّر متى تنتهي وثيقة ولا أيّها يستحقّ تنبيهًا: التنبيهات
   تصله جاهزة من scanExpirations() في lib/notifications/scan.js — سلّم
   التصعيد نفسه الذي يغذّي البريد منذ البداية (٥ و٢ و٠ أيام، ثم يوميًا بعد
   التجاوز). مسحٌ واحد في الـCron يغذّي القناتين.

   ملاحظة مقصودة: هذه ليست نافذة الـ٩٠ يومًا في doc-status.js. تلك للوحة
   المؤشّرات في المتصفّح، وهذه لِما يستحقّ إزعاج جوال أحدهم به. الخلط
   بينهما يعني إشعارًا يوميًا عن وثيقة باقٍ لها تسعة وثمانون يومًا.

   الجمهور: كل مستخدم له اشتراك نشط ويملك employees:view — أي يستطيع رؤية
   البيانات التي يتحدّث عنها الإشعار. لا علاقة لجدول recipients هنا: ذاك
   قائمة بريد قد لا يملك أصحابها حسابات ولا أجهزة أصلًا. */

const AUDIENCE_PERMISSION = { section: "employees", action: "view" };

/* ملخّص واحد للجهاز في اليوم لا إشعار لكل وثيقة: ستّ عشرة وثيقة تعني ستّ
   عشرة اهتزازة، ونهايتها أن يُطفئ المستخدم الإشعارات كلها. */
function buildExpiryDigest(alerts) {
  const overdue = alerts.filter((a) => a.stage === "overdue").length;
  const today = alerts.filter((a) => a.stage === "today").length;
  const n = alerts.length;

  const countPhrase =
    n === 1 ? "وثيقة واحدة تحتاج إلى إجراء"
    : n === 2 ? "وثيقتان تحتاجان إلى إجراء"
    : n <= 10 ? `${n} وثائق تحتاج إلى إجراء`
    : `${n} وثيقة تحتاج إلى إجراء`;

  const parts = [];
  if (overdue) parts.push(`${overdue} منتهية`);
  if (today) parts.push(`${today} تنتهي اليوم`);
  const detail = parts.length ? `${parts.join(" · ")}.` : "";

  /* أول ثلاثة أسماء تعطي الإشعار معنى قبل فتحه؛ ما زاد يُختصر. */
  const names = [...new Set(alerts.map((a) => a.employeeName).filter(Boolean))];
  const who = names.length
    ? (names.length <= 3 ? names.join(" · ") : `${names.slice(0, 3).join(" · ")} وآخرون`)
    : "";

  return {
    kind: "expiry",
    title: `تنبيه وثائق — ${countPhrase}`,
    body: [detail, who].filter(Boolean).join(" ") || "راجع الوثائق القريبة من الانتهاء.",
    url: "/expiring.html",
    tag: "droua-expiry",
    count: n,
  };
}

/* حاجز عدم التكرار — نفس نمط monthly_reports حرفيًا:
   INSERT ... ON CONFLICT DO NOTHING RETURNING id
   من يفوز بالصفّ يُرسل، ومن يخسر يتوقّف. تكرار تشغيل الـCron أو إعادة
   محاولة أو تشغيلان متزامنان تُنتج إرسالًا واحدًا لا أكثر. */
async function claim(subscriptionId, dedupKey) {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO push_notification_log (subscription_id, dedup_key, status)
    VALUES (${subscriptionId}, ${dedupKey}, 'pending')
    ON CONFLICT (subscription_id, dedup_key) DO NOTHING
    RETURNING id`;
  return rows[0] ? Number(rows[0].id) : null;
}

async function settleClaim(logId, status, error) {
  const sql = getSql();
  await sql`
    UPDATE push_notification_log
       SET status = ${status}, error = ${error ? String(error).slice(0, 500) : null}, sent_at = now()
     WHERE id = ${logId}`;
}

/* حجزٌ فشل إرساله يُحذف بدل أن يبقى 'failed': بقاؤه يمنع أي محاولة لاحقة
   في اليوم نفسه، فيضيع التنبيه كليًا بسبب عطل شبكة عابر. */
async function releaseClaim(logId) {
  const sql = getSql();
  await sql`DELETE FROM push_notification_log WHERE id = ${logId}`;
}

/* الاشتراكات المؤهَّلة: يُبدأ من جدول الاشتراكات لا من جدول المستخدمين،
   لأن حسابَي الاحتياط في متغيّرات البيئة ليسا صفّين في users. كل معرّف
   يُحلّ عبر findByIdRaw التي تعرف الاثنين، ومن حُذف حسابه أو عُطّل أو
   فقد الصلاحية يسقط من القائمة تلقائيًا. */
async function eligibleSubscriptions() {
  const all = await subscriptions.listAll();
  if (!all.length) return [];
  const byUser = new Map();
  for (const s of all) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }
  const out = [];
  for (const [userId, subs] of byUser) {
    const user = await findByIdRaw(userId);
    if (!user || user.status !== "active") continue;
    if (!hasPermission(user, AUDIENCE_PERMISSION.section, AUDIENCE_PERMISSION.action)) continue;
    out.push(...subs);
  }
  return out;
}

/* يُستدعى من الـCron بعد المسح. `alerts` هي مخرجات scanExpirations نفسها
   التي بُني منها البريد. */
async function sendExpiryDigest(alerts, now = new Date()) {
  if (!isConfigured()) return { ok: true, skipped: "vapid_not_configured", sent: 0 };
  if (!alerts || !alerts.length) return { ok: true, sent: 0, alerts: 0 };

  const subs = await eligibleSubscriptions();
  if (!subs.length) return { ok: true, sent: 0, alerts: alerts.length, devices: 0 };

  /* مفتاح اليوم بتوقيت الرياض — نفس المنطقة التي يحسب بها التقرير الشهري
     يومه، فلا يختلف تعريف «اليوم» بين قناتين في المنصّة نفسها. */
  const dedupKey = `expiry:${riyadhDateString(now)}`;
  const payload = buildExpiryDigest(alerts);

  let sent = 0, skipped = 0, gone = 0, failed = 0;
  for (const sub of subs) {
    const logId = await claim(sub.id, dedupKey);
    if (!logId) { skipped++; continue; }          // أُرسل لهذا الجهاز اليوم
    const res = await sendToSubscription(sub, payload);
    if (res.ok) {
      await settleClaim(logId, "sent", null);
      sent++;
    } else if (res.gone) {
      /* الصفّ حُذف مع الاشتراك عبر ON DELETE CASCADE — لا شيء يُسوّى. */
      gone++;
    } else {
      await releaseClaim(logId);                  // يُعاد في التشغيل التالي
      failed++;
    }
  }
  return { ok: true, alerts: alerts.length, devices: subs.length, sent, skipped, gone, failed, dedupKey };
}

/* الإشعار التجريبي. لا يمسّ push_notification_log إطلاقًا — لا حجز ولا
   صفّ — فلا يستهلك مفتاح اليوم ولا يمنع التنبيه الحقيقي من الوصول بعده. */
function buildTestPayload() {
  return {
    kind: "test",
    title: "تجربة إشعارات ذروة",
    body: "تم تفعيل إشعارات الجوال بنجاح. اضغط لفتح الوثائق القريبة من الانتهاء.",
    url: "/expiring.html",
    tag: "droua-test",
  };
}

module.exports = {
  sendExpiryDigest, buildExpiryDigest, buildTestPayload,
  eligibleSubscriptions, AUDIENCE_PERMISSION,
};
