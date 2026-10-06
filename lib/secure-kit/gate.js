/* ─── البوابة: الهويّة، ثم العضويّة، ثم كلمة مرور ثانية وجلسة مستقلّة ────
   =========================================================================
   تجمع هذه الوحدة ما كان في lib/droua/access.js و router.js (مسار الفتح)
   في صورةٍ عامّة تحقن فيها كل وحدة هويّتها: إعدادها، وطريقتها في معرفة
   أعضائها، ومُرمِّزها، وجداولها، وكوكيها.

   ثلاثة مبادئ موروثة كما هي:

   ① **الرفض المبكّر بلا قاعدة.** توكن المنصّة يُتحقّق منه محلّيًا ويُقرأ منه
     sub؛ فإن لم يجتز `earlyAllow` رُدّ فورًا. شرط إخفاء لا تحسين أداء: لو
     استعلمنا القاعدة أوّلًا لصار الردّ أبطأ بجولة قاعدة من ردّ مسار غير
     موجود، وفرقٌ يُقاس دليلٌ على أن هنا ما يُحرَس.

   ② **ردٌّ واحد لكل أسباب فشل الفتح**: نفس الحالة والجسم والزمن (أرضيةٌ
     زمنية، والاشتقاق يُنفَّذ حتى عند القفل وحتى لعضوٍ بلا كلمة مرور).

   ③ **بوابةٌ لا تُدقَّق لا تُفتح**: تسجيل النجاح صارمٌ يرمي، والمُغلِّف
     يترجم الرمي إلى 404.

   والجديد هنا: الدور يأتي من **العضويّة** (`resolveMember`)، وكلمة مرور
   البوابة **لكل عضو**. */

const crypto = require("crypto");
const H = require("./http");
const password = require("./password");

const GENERIC_FAILURE = { ok: false, error: "تعذّر فتح القسم" };

function createGate({
  label, loadConfig, codec, sessionsFor, limiter, audit, cookie, floorMs, getSql, context,
  identity, platformSession,
}) {
  for (const [k, v] of Object.entries({ loadConfig, codec, sessionsFor, limiter, audit, cookie, getSql, context, identity })) {
    if (!v) throw new Error(`createGate: ${k} مطلوب`);
  }
  if (!(floorMs > 0)) throw new Error("createGate: floorMs مطلوب");

  /* يُرجع:
       { ok: true, user, member, cfg }
       { ok: false, kind: "unauthenticated" }   → 302 أو 401
       { ok: false, kind: "hidden", denied }    → 404 دائمًا */
  async function evaluate(req) {
    const cfg = loadConfig();
    if (!cfg) return { ok: false, kind: "hidden", denied: false };

    const raw = H.readCookie(req, "session");
    const payload = raw ? identity.verifyPlatformToken(raw) : null;
    if (!payload) return { ok: false, kind: "unauthenticated" };

    const denied = { ok: false, kind: "hidden", denied: true, cfg };
    if (!identity.earlyAllow(String(payload.sub), cfg)) return denied;

    const user = await identity.loadUser(req);
    if (!user || String(user.id) !== String(payload.sub)) return denied;
    if (!identity.earlyAllow(String(user.id), cfg)) return denied;

    const member = await identity.resolveMember(getSql(), user, cfg);
    if (!member || !member.role) return denied;
    return { ok: true, user, member, cfg };
  }

  /* الجلسة الحيّة — التحقّق الوحيد. `renew` يمدّد الخمول ويُصدر توكنًا جديدًا. */
  async function liveGate(sql, req, user, cfg, now, { renew = true } = {}) {
    const sessions = sessionsFor(cfg);
    const raw = H.readCookie(req, cookie.name);
    const payload = raw ? codec.verify(raw, cfg.secret, now) : null;
    if (!payload || payload.sub !== String(user.id)) return null;

    const sidHash = codec.hashSid(payload.sid);
    const session = await sessions.load(sql, sidHash);
    if (!sessions.isUsable(session, String(user.id), now)) return null;
    if (!renew) return { payload, session, sidHash, idleExp: session.idleExp, renewed: null };

    const idleExp = await sessions.touch(sql, session, now);
    const renewed = codec.issue(
      { userId: String(user.id), sid: payload.sid, now, idleMs: sessions.IDLE_MS, absoluteExp: session.absoluteExp },
      cfg.secret
    );
    return { payload, session, sidHash, idleExp, renewed };
  }

  /* الهويّة + بوابةٌ مفتوحة الآن، ومعهما `run` الذي يفتح سياق الوحدة. */
  async function requireAccess(sql, req, { needGate = false, base = null, renew = true } = {}) {
    const who = base || await evaluate(req);
    if (!who.ok) return who;
    if (!needGate) return { ...who, gate: null, run: null };

    const live = await liveGate(sql, req, who.user, who.cfg, Date.now(), { renew });
    if (!live) return { ok: false, kind: "locked" };

    return {
      ok: true,
      user: who.user,
      member: who.member,
      cfg: who.cfg,
      gate: live,
      run: (fn) => context.runWithGate({ userId: String(who.user.id), sidHash: live.sidHash, role: who.member.role }, fn),
    };
  }

  function setRenewed(res, live) {
    if (!live || !live.renewed) return;
    const maxAge = Math.max(0, Math.floor((live.renewed.exp - Date.now()) / 1000));
    H.appendCookie(res, cookie.build(live.renewed.token, maxAge));
  }

  /* جلسة المنصّة نافذةُ خمولٍ منزلقة لا يُنزلقها إلا /api/auth/me، وصفحات
     الوحدة لا تناديه — فبلا هذا يُطرد العامل بعد ثلاثين دقيقة وهو يعمل،
     ويظهر الطرد «تعذّر فتح القسم» فيُقرأ «كلمة مرورك خاطئة».
     جلسة «تذكّرني» ثابتة ولا تُمسّ. ولا تُنزلق إلا لمن اجتاز evaluate. */
  function slidePlatformSession(req, res, user) {
    if (!platformSession) return;
    const raw = H.readCookie(req, "session");
    const payload = raw ? identity.verifyPlatformToken(raw) : null;
    if (!payload || payload.remember) return;
    H.appendCookie(res, platformSession.cookie(platformSession.issue(user, false), false));
  }

  /* ─── المعالجات ─── */

  async function status(req, res, who) {
    if (req.method !== "GET") return H.notFoundApi(res);
    const sql = getSql();
    const live = await liveGate(sql, req, who.user, who.cfg, Date.now());
    H.secureApi(res);
    if (!live) return res.status(200).json({ ok: true, unlocked: false });
    setRenewed(res, live);
    res.status(200).json({
      ok: true, unlocked: true, role: who.member.role,
      expiresAt: live.renewed.exp, absoluteExpiresAt: live.session.absoluteExp,
    });
  }

  async function unlock(req, res, who) {
    if (req.method !== "POST") return H.notFoundApi(res);
    const startedAt = Date.now();
    const sql = getSql();
    const { user, member, cfg } = who;
    const userId = String(user.id);
    const role = member.role;
    const ip = audit.clientIp(req);
    const sessions = sessionsFor(cfg);
    /* هاش هذا العضو، أو هاشٌ وهميّ صالح الصيغة لا يطابق شيئًا: العمل نفسه
       في الحالتين، فلا يكشف الزمنُ أن العضو بلا كلمة مرور. */
    const parsed = password.parseHash(member.gatePasswordHash) || password.dummyHash();

    const fail = async (event, meta) => {
      await audit.log(sql, { event, userId, role, meta, ip, secret: cfg.secret });
      await H.floor(startedAt, floorMs);
      H.secureApi(res);
      return res.status(403).json(GENERIC_FAILURE);
    };

    const now = Date.now();
    const { attemptId, counts } = await limiter.recordAndCount(sql, userId, now);
    const lock = limiter.evaluate(counts);
    if (lock.locked) {
      await limiter.forget(sql, attemptId);
      password.verify(crypto.randomBytes(24).toString("hex"), parsed, cfg.pepper);
      return fail("gate_locked_out", { reason: "locked" });
    }

    const body = H.parseJsonBody(req);
    const input = typeof body.password === "string" ? body.password : "";
    const matched = password.verify(input, parsed, cfg.pepper);
    if (!matched || !member.gatePasswordHash) {
      return fail("gate_unlock_failed", { reason: member.gatePasswordHash ? "bad_password" : "no_password", critical: lock.critical });
    }

    const sid = codec.newSid();
    const opened = Date.now();
    const { absoluteExp } = await sessions.create(sql, { sidHash: codec.hashSid(sid), userId, now: opened });

    await audit.logStrict(sql, { event: "gate_unlock_success", userId, role, ip, secret: cfg.secret });

    await limiter.clearFailures(sql, userId);
    await limiter.prune(sql, opened);
    await sessions.prune(sql, opened);

    const issued = codec.issue({ userId, sid, now: opened, idleMs: sessions.IDLE_MS, absoluteExp }, cfg.secret);
    await H.floor(startedAt, floorMs);
    H.secureApi(res);
    H.appendCookie(res, cookie.build(issued.token, Math.floor((issued.exp - opened) / 1000)));
    res.status(200).json({ ok: true, unlocked: true, role, expiresAt: issued.exp, absoluteExpiresAt: absoluteExp });
  }

  async function lock(req, res, who) {
    if (req.method !== "POST") return H.notFoundApi(res);
    const sql = getSql();
    const now = Date.now();
    const raw = H.readCookie(req, cookie.name);
    const payload = raw ? codec.verify(raw, who.cfg.secret, now) : null;
    if (payload && payload.sub === String(who.user.id)) {
      await sessionsFor(who.cfg).revoke(sql, codec.hashSid(payload.sid), now);
      await audit.log(sql, {
        event: "gate_locked", userId: String(who.user.id), role: who.member.role,
        ip: audit.clientIp(req), secret: who.cfg.secret,
      });
    }
    H.secureApi(res);
    H.appendCookie(res, cookie.clear());
    res.status(200).json({ ok: true });
  }

  return {
    label, evaluate, liveGate, requireAccess, setRenewed, slidePlatformSession,
    handlers: { "gate/status": status, "gate/unlock": unlock, "gate/lock": lock },
    GENERIC_FAILURE,
  };
}

module.exports = { createGate, GENERIC_FAILURE };
