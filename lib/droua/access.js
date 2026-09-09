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

/* ─── جلسة البوابة الحيّة — التحقّق الوحيد في القسم ────────────────────
   موضعٌ واحد يقرّر «هل البوابة مفتوحة الآن؟»، ويستعمله الموجّه ومداخل
   البيانات معًا. وتوحيدُه مقصود: طريقان إلى حكمٍ أمنيّ واحد ينحرفان يومًا،
   وكلّ شرطٍ جديد للصلاحية يجب أن يدخل مكانًا واحدًا لا مكانين.

   `renew` هو الفارق الوحيد بين المُنادين: الصفحة والبيانات تُنزلقان مهلة
   الخمول، والفحص المجرَّد لا يمسّ شيئًا. */
async function liveGate(sql, req, user, cfg, now, { renew = true } = {}) {
  const raw = readCookie(req, GATE_COOKIE_NAME);
  const payload = raw ? gateToken.verify(raw, cfg.secret, now) : null;
  if (!payload || payload.sub !== user.id) return null;

  const sidHash = gateToken.hashSid(payload.sid);
  const session = await gateSessions.load(sql, sidHash);
  if (!gateSessions.isUsable(session, user.id, now)) return null;
  if (!renew) return { payload, session, sidHash, idleExp: session.idleExp, renewed: null };

  const idleExp = await gateSessions.touch(sql, session, now);
  const renewed = gateToken.issue(
    { userId: user.id, sid: payload.sid, now, idleMs: gateSessions.IDLE_MS, absoluteExp: session.absoluteExp },
    cfg.secret
  );
  return { payload, session, sidHash, idleExp, renewed };
}

/* ─── المدخل الموحَّد لما بعد البوابة ──────────────────────────────────
   evaluate تجيب «هل هذا هو المستخدم؟». وهذه تجيب السؤالين معًا: هو
   المستخدم، **وبوابته مفتوحة الآن**. وتُرجع معهما `run` — وهو ما يفتح سياق
   البوابة، فلا يبلغ files.js إلا من مرّ من هنا.

   `base` يُمرَّر حين يكون المُنادي قد قيّم الهويّة سلفًا، فلا تتكرّر رحلة
   القاعدة على كل طلب. */
async function requireDrouaAccess(sql, req, { needGate = false, base = null, renew = true } = {}) {
  const identity = base || await evaluate(req);
  if (!identity.ok) return identity;
  if (!needGate) return { ...identity, gate: null, run: null };

  const live = await liveGate(sql, req, identity.user, identity.cfg, Date.now(), { renew });
  /* البوابة مقفلة ليست حالة إخفاء: صاحبها معروف ومصرَّح له، وإنما انتهت
     جلسته. والمُنادي يترجمها إلى طلب كلمة المرور من جديد. */
  if (!live) return { ok: false, kind: "locked" };

  return {
    ok: true,
    user: identity.user,
    cfg: identity.cfg,
    gate: live,
    run: (fn) => gateContext.runWithGate({ userId: identity.user.id, sidHash: live.sidHash }, fn),
  };
}

module.exports = { evaluate, requireDrouaAccess, liveGate, readCookie, GATE_COOKIE_NAME };
