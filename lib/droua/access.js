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
const gateToken = require("./gateToken");
const gateSessions = require("./gateSessions");
const gateContext = require("./gateContext");

/* اسم كوكي البوابة يُعرَّف هنا ويُستورَد في الموجّه: قيمةٌ واحدة مكتوبة
   مرّتين تنحرف يومًا، والانحراف هنا يعني كوكيًا يُوضع بمسمّى ولا يُقرأ. */
const GATE_COOKIE_NAME = "droua_gate";

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

/* ─── المدخل الموحَّد لما بعد البوابة ──────────────────────────────────
   evaluate تجيب «هل هذا هو المستخدم؟». وهذه تجيب السؤالين معًا: هو
   المستخدم، **وبوابته مفتوحة الآن**. وتُرجع معهما `run` — وهو ما يفتح سياق
   البوابة، فلا يبلغ files.js إلا من مرّ من هنا.

   والتحقّق هنا **للقراءة فقط**: لا يُجدِّد الكوكي ولا يُنزلق مهلة الخمول.
   التجديد يبقى للموجّه في مساره الحاليّ، وكلا الطريقين يستندان إلى
   gateSessions.isUsable نفسها — فلا معياران للصلاحية. */
async function requireDrouaAccess(sql, req, { needGate = false } = {}) {
  const base = await evaluate(req);
  if (!base.ok) return base;
  if (!needGate) return { ...base, gate: null, run: null };

  const now = Date.now();
  const raw = readCookie(req, GATE_COOKIE_NAME);
  const payload = raw ? gateToken.verify(raw, base.cfg.secret, now) : null;
  /* البوابة مقفلة ليست حالة إخفاء: صاحبها معروف ومصرَّح له، وإنما انتهت
     جلسته. والمُنادي يترجمها إلى طلب كلمة المرور من جديد. */
  if (!payload || payload.sub !== base.user.id) return { ok: false, kind: "locked" };

  const sidHash = gateToken.hashSid(payload.sid);
  const session = await gateSessions.load(sql, sidHash);
  if (!gateSessions.isUsable(session, base.user.id, now)) return { ok: false, kind: "locked" };

  return {
    ok: true,
    user: base.user,
    cfg: base.cfg,
    gate: { sidHash, session },
    run: (fn) => gateContext.runWithGate({ userId: base.user.id, sidHash }, fn),
  };
}

module.exports = { evaluate, requireDrouaAccess, readCookie, GATE_COOKIE_NAME };
