/* ─── حارس الوصول الموحّد ─────────────────────────────────────────────
   =========================================================================
   نقطة القرار الوحيدة: من يدخل القسم أصلًا. كل مسار — صفحةً كان أو API —
   يمرّ من هنا أوّلًا بلا استثناء.

   ثلاثة مبادئ:

   ① الدور لا يُستشار إطلاقًا. hasPermission لا تُستدعى في هذه الوحدة ولا
     في القسم كلّه — يفرضه اختبار عزل. فـowner و admin يمرّان من الطريق
     نفسه ويُردّان بـ404 كأي مستخدم آخر. الحماية مستقلّة عن نظام الصلاحيات
     من أصلها لا مضافة إليه.

   ② الشرطان معًا: المستخدم في DROUA_AUDIT_USER_IDS **و** في
     PROTECTED_USER_IDS. حمايةُ حسابٍ لسببٍ إداريّ آخر لا تمنحه القسم،
     ونزعُ الحماية يقفله ولا يكشفه.

   ③ الرفض المبكّر بلا قاعدة بيانات. توكن الجلسة يُتحقّق منه محلّيًا
     (HMAC، بلا شبكة) ويُقرأ منه sub؛ فإن لم يكن في القائمة رُدّ فورًا.
     وهذا ليس تحسين أداء بل شرطُ إخفاء: لو استعلمنا القاعدة أوّلًا لصار
     ردّ /secure-audit أبطأ بجولة قاعدة من ردّ مسار غير موجود — وفرقٌ
     يُقاس هو دليلٌ على أن هنا ما يُحرَس. ولا يُوثَق بـsub في الاتجاه
     الإيجابي: من يجتاز هذا الفحص يُقرأ من القاعدة كاملًا بعده. */

const { verify: verifyPlatformToken } = require("../auth/tokens");
const { requireUser } = require("../auth/requireAuth");
const protectedUsers = require("../auth/protectedUsers");
const config = require("./config");

/* قارئ كوكي محلّي بدل استيراد lib/auth/cookies.js: تلك الوحدة تُصدّر أيضًا
   بنّاءَ كوكي جلسة المنصّة، واستيرادها يربط القسم بمنطقٍ ليس له. */
function readCookie(req, name) {
  const header = (req && req.headers && req.headers.cookie) || "";
  const found = header.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

/* يُرجع:
     { ok: true,  user, cfg }
     { ok: false, kind: "unauthenticated" }   → 302 أو 401 حسب نوع الطلب
     { ok: false, kind: "hidden", denied }    → 404 دائمًا
   `denied` يميّز الرفض المستحقّ للتدقيق عن مجرّد غياب الإعداد. */
async function evaluate(req) {
  const cfg = config.load();
  if (!cfg) return { ok: false, kind: "hidden", denied: false };

  const token = readCookie(req, "session");
  const payload = token ? verifyPlatformToken(token) : null;
  if (!payload) return { ok: false, kind: "unauthenticated" };

  /* الرفض المستحقّ يحمل cfg معه: بلا سرّ التوقيع لا يمكن تجزئة عنوان
     الطالب، فيُسجَّل استكشافُ القسم بلا أي بصمة جهاز — وهو أهمّ ما يُرصد
     هنا أصلًا. */
  const denied = { ok: false, kind: "hidden", denied: true, cfg };

  /* الرفض المبكّر — بلا رحلة إلى القاعدة (المبدأ ③). */
  if (!cfg.userIds.includes(String(payload.sub))) return denied;

  const user = await requireUser(req);
  /* التوكن صالح لكن الحساب غائب أو معطَّل: يُخفى لا يُصرَّح بحاله. */
  if (!user) return denied;

  if (!cfg.userIds.includes(user.id)) return denied;
  if (!protectedUsers.isProtected(user.id)) return denied;
  if (!cfg.emails.includes(String(user.email || "").trim().toLowerCase())) return denied;
  return { ok: true, user, cfg };
}

module.exports = { evaluate, readCookie };
