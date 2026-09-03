const { getSql } = require("../db");

/* اشتراكات الدفع — صفّ لكل جهاز.
   =========================================================================
   endpoint هو معرّف الجهاز عند خدمة الدفع وهو UNIQUE في الجدول، فإعادة
   الاشتراك من الجهاز نفسه تُحدِّث صفّه ولا تُنشئ ثانيًا. هذا ما يحقّق
   «عند التفعيل من الجوال يُسجَّل الجهاز الحالي فقط».

   user_id نصّ بلا مفتاح أجنبي إلى users عن قصد: حسابا الاحتياط
   (env-owner و env-hr-specialist) يعيشان في متغيّرات البيئة ولا صفّ لهما
   في الجدول، فأي FK كان سيرفض تسجيل أجهزتهما. */

function shape(r) {
  return {
    id: Number(r.id),
    userId: r.user_id,
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
    userAgent: r.user_agent,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    lastSuccessAt: r.last_success_at,
    failureCount: r.failure_count,
  };
}

/* يتحقّق من شكل الاشتراك القادم من المتصفّح قبل لمس القاعدة. */
function normalize(sub) {
  const endpoint = sub && typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
  const p256dh = sub && sub.keys && typeof sub.keys.p256dh === "string" ? sub.keys.p256dh.trim() : "";
  const auth = sub && sub.keys && typeof sub.keys.auth === "string" ? sub.keys.auth.trim() : "";
  if (!/^https:\/\//.test(endpoint)) throw new Error("اشتراك غير صالح: العنوان مفقود أو غير آمن");
  if (!p256dh || !auth) throw new Error("اشتراك غير صالح: مفاتيح التعمية ناقصة");
  if (endpoint.length > 2000) throw new Error("اشتراك غير صالح: العنوان أطول من المسموح");
  return { endpoint, p256dh, auth };
}

/* إعادة الاشتراك من الجهاز نفسه تُحدِّث الصفّ. تحديث user_id مقصود: إن
   سجّل شخص آخر دخوله على الجهاز نفسه وفعّل الإشعارات، فالجهاز صار له —
   ولا يصحّ أن تبقى إشعارات المستخدم السابق تصل إليه. */
async function upsert(userId, rawSub, userAgent) {
  const sql = getSql();
  const { endpoint, p256dh, auth } = normalize(rawSub);
  const ua = userAgent ? String(userAgent).slice(0, 400) : null;
  const rows = await sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES (${userId}, ${endpoint}, ${p256dh}, ${auth}, ${ua})
    ON CONFLICT (endpoint) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent = EXCLUDED.user_agent,
          last_seen_at = now(),
          failure_count = 0
    RETURNING *`;
  return shape(rows[0]);
}

async function listForUser(userId) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM push_subscriptions WHERE user_id = ${userId} ORDER BY id`;
  return rows.map(shape);
}

async function listAll() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM push_subscriptions ORDER BY id`;
  return rows.map(shape);
}

/* الحذف مقيَّد بصاحب الاشتراك: لا يستطيع مستخدم إلغاء تسجيل جهاز غيره
   حتى لو عرف عنوانه. */
async function removeByEndpoint(userId, endpoint) {
  const sql = getSql();
  const rows = await sql`
    DELETE FROM push_subscriptions
     WHERE endpoint = ${String(endpoint || "")} AND user_id = ${userId}
     RETURNING id`;
  return rows.length > 0;
}

/* يُستدعى حين ترد خدمة الدفع بـ404 أو 410: الاشتراك زال من الجهاز نهائيًا
   (إلغاء تثبيت، مسح بيانات، تجديد الرمز) فلا معنى للاحتفاظ به. */
async function removeById(id) {
  const sql = getSql();
  await sql`DELETE FROM push_subscriptions WHERE id = ${id}`;
}

async function markSuccess(id) {
  const sql = getSql();
  await sql`UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = ${id}`;
}

async function markFailure(id) {
  const sql = getSql();
  await sql`UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ${id}`;
}

module.exports = {
  upsert, listForUser, listAll, removeByEndpoint, removeById,
  markSuccess, markFailure, normalize, shape,
};
