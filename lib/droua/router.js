/* ─── موجّه القسم السرّي ──────────────────────────────────────────────
   =========================================================================
   يستقبل الطلب من api/app.js ويردّ عليه كاملًا. api/app.js لا تعرف عن
   القسم شيئًا سوى سطر التفويض — لا مسارًا، ولا حارسًا، ولا استجابة.

   ولا يرمي إلى الخارج أبدًا: لو تسرّب استثناء لالتقطه catch-all في
   api/app.js الذي يُرجع err.message إلى العميل — فيكشف أسماء جداول القسم
   أو وجوده. لذلك try/catch هنا يُنهي كل خطأ داخليّ بـ404، لا بـ500:
   رسالة خطأ مختلفة تكشف أن هناك ما يُعالَج. */

const crypto = require("crypto");
const { getSql } = require("../db");
const access = require("./access");
const dataApi = require("./api");
const gateToken = require("./gateToken");
const gateSessions = require("./gateSessions");
const gatePassword = require("./gatePassword");
const rateLimit = require("./rateLimit");
const audit = require("./audit");
const H = require("./headers");
const renderGate = require("./views/gate");
const renderOpen = require("./views/open");
/* بنّاء كوكي جلسة المنصّة ومُصدِر توكنها. استيرادٌ مقصود هنا — لا في
   access.js: هذه الوحدة هي التي تردّ على الطلب، وهي وحدها من يضع رؤوسًا. */
const { issueSessionToken, verify: verifyPlatformToken } = require("../auth/tokens");
const { sessionCookie } = require("../auth/cookies");

const COOKIE_NAME = access.GATE_COOKIE_NAME;
/* أضيق نطاق يعمل للصفحة والـAPI معًا — ولذلك نُقلت الـAPI تحت
   /secure-audit/api/… بدل /api/secure-audit/…: لولا ذلك لما اشتركا في
   بادئة غير "/"، فإمّا كوكي على "/" يُرسل مع كل طلب في المنصّة، أو
   كوكيان متلازمان أي تباين بينهما عطلٌ صامت.
   وبحسب RFC 6265 §5.1.4 لا يُرسل هذا الكوكي إلى /secure-auditXYZ: البادئة
   يجب أن تتبعها "/" أو تكون مطابقة تامّة. */
const COOKIE_PATH = "/secure-audit";

/* أرضية زمنية موحّدة لمسار الفتح. بلا هذا، القفل الساري يتخطّى scrypt
   فيردّ أسرع بمئات الميلي‌ثانية — فرقٌ يُقاس يكشف سبب الفشل رغم أن الجسم
   والحالة متطابقان. */
const RESPONSE_FLOOR_MS = 600;

const GENERIC_FAILURE = { ok: false, error: "تعذّر فتح القسم" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function floor(startedAt) {
  const remaining = RESPONSE_FLOOR_MS - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

function cookie(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}`;
}
const clearCookie = () => cookie("", 0);

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch (err) {
    return {};
  }
}

/* الجلسة الحيّة: توقيع صالح، وصفٌّ غير مُبطَل، وصاحبها هو صاحب الطلب،
   ولم يتجاوز الخمول ولا السقف. ثم تنزلق مهلة الخمول. */
const activeSession = (sql, req, user, cfg, now) =>
  access.liveGate(sql, req, user, cfg, now);

/* ⚠️ `setHeader("Set-Cookie", …)` **يستبدل** ولا يضيف. وهذا القسم صار
   يضع كوكيين في الطلب الواحد — كوكي البوابة وكوكي جلسة المنصّة — فكتابةُ
   الثاني بـsetHeader كانت ستمحو الأوّل بلا خطأ ولا أثر: يُفتح القسم ثمّ
   يُقفل فورًا لأن كوكي البوابة لم يصل المتصفّح أبدًا. فالإلحاق دائمًا. */
function appendCookie(res, value) {
  const current = res.getHeader("Set-Cookie");
  if (!current) return res.setHeader("Set-Cookie", value);
  return res.setHeader("Set-Cookie", (Array.isArray(current) ? current : [current]).concat(value));
}

function setRenewed(res, live) {
  const maxAge = Math.max(0, Math.floor((live.renewed.exp - Date.now()) / 1000));
  appendCookie(res, cookie(live.renewed.token, maxAge));
}

/* ─── تمديد نافذة خمول جلسة المنصّة ───────────────────────────────────
   جلسة المنصّة نافذةُ خمولٍ منزلقة، ولا يُنزلقها في المشروع كلّه إلا
   `/api/auth/me` — وصفحاتُ أجير تناديه فتنزلق. وهذا القسم لا يناديه أبدًا:
   شاشاته لا تتحدّث إلا إلى `/secure-audit/api/…`.

   فمن يدخل القسم تتوقّف ساعتُه عن الانزلاق وتمضي إلى نهايتها، فيُطرد بعد
   ثلاثين دقيقة وهو يعمل — وهو **نمط استعمال هذه الأداة بالضبط**: يرفع
   أربعة ملفّات، ويحلّل، ويقرأ عشرات الملاحظات ويكتب عليها.

   وأسوأ ما فيه أن الطرد يظهر في صفحة البوابة رسالةَ «تعذّر فتح القسم»،
   فيُقرأ «كلمة مرورك خاطئة» وهو في الحقيقة «انتهت جلستك».

   ولا تُنزلق إلا لمن اجتاز `evaluate` كاملًا — أي المصرَّح له وحده. ومن
   رُدّ بـ404 لا يخرج له رأسٌ ولا كوكي، فالإخفاء كما هو.
   والمنطق نسخةٌ من `api/app.js:authMe`: جلسة «تذكّرني» ثابتة ثلاثين يومًا
   ولا تُنزلق، فلا تُمسّ. */
function slidePlatformSession(req, res, user) {
  const raw = access.readCookie(req, "session");
  const payload = raw ? verifyPlatformToken(raw) : null;
  if (!payload || payload.remember) return;
  appendCookie(res, sessionCookie(issueSessionToken(user, false), false));
}

/* ---------------- الصفحة ---------------- */

async function handlePage(req, res, gate) {
  const sql = getSql();
  const now = Date.now();
  const nonce = crypto.randomBytes(16).toString("base64");
  const live = await activeSession(sql, req, gate.user, gate.cfg, now);

  H.securePage(res, nonce);
  if (live) {
    setRenewed(res, live);
    audit.log(sql, { event: "section_opened", userId: gate.user.id, ip: audit.clientIp(req), secret: gate.cfg.secret });
    return res.status(200).end(renderOpen(nonce));
  }
  return res.status(200).end(renderGate(nonce));
}

/* ---------------- الـAPI ---------------- */

async function gateStatus(req, res, gate) {
  if (req.method !== "GET") return H.notFoundApi(res);
  const sql = getSql();
  const live = await activeSession(sql, req, gate.user, gate.cfg, Date.now());
  H.secureApi(res);
  if (!live) return res.status(200).json({ ok: true, unlocked: false });
  setRenewed(res, live);
  res.status(200).json({
    ok: true,
    unlocked: true,
    expiresAt: live.renewed.exp,
    absoluteExpiresAt: live.session.absoluteExp,
  });
}

async function gateUnlock(req, res, gate) {
  if (req.method !== "POST") return H.notFoundApi(res);
  const startedAt = Date.now();
  const sql = getSql();
  const { user, cfg } = gate;
  const ip = audit.clientIp(req);

  const fail = async (event, meta) => {
    await audit.log(sql, { event, userId: user.id, meta, ip, secret: cfg.secret });
    await floor(startedAt);
    H.secureApi(res);
    /* ردٌّ واحد لكل أسباب الفشل: كلمة مرور خاطئة، أو قفل ساري، أو مدخل
       غير صالح. لا حالة مختلفة، ولا جسم مختلف، ولا زمن مختلف. */
    return res.status(403).json(GENERIC_FAILURE);
  };

  const now = Date.now();
  /* التسجيل قبل العدّ — انظر lib/droua/rateLimit.js. المحاولة تُثبت نفسها
     أوّلًا، فالعدّ الذي يليها يشمل كل ما تزامن معها. */
  const { attemptId, counts } = await rateLimit.recordAndCount(sql, user.id, now);
  const lock = rateLimit.evaluate(counts);
  if (lock.locked) {
    await rateLimit.forget(sql, attemptId); // مردودةٌ بالقفل لا تُحسب ولا تمدّده
    /* الاشتقاق يُنفَّذ حتى عند القفل ثم تُهمَل نتيجته.

       الأرضية الزمنية وحدها لا تكفي: لو تجاوز scrypt الأرضية على نسخة
       دالّة بطيئة (وهو وارد عند N=2^17)، لصار مسارُ كلمة المرور الخاطئة
       أبطأ من مسار القفل — ولعاد الفرق الذي أُريد إخفاؤه. تنفيذ العمل
       نفسه في الحالتين يجعل التوحيد بنيويًا لا مرهونًا بأن تكون الأرضية
       أكبر من أسوأ زمن.

       الثمن: معالجةٌ تُستهلك أثناء القفل. مقبولٌ لأن هذه النقطة لا يبلغها
       إلا الحساب المصرَّح له وحده — وكل من سواه رُدّ بـ404 قبلها. */
    gatePassword.verify(crypto.randomBytes(24).toString("hex"), cfg.passwordHash, cfg.pepper);
    return fail("gate_locked_out", { reason: "locked" });
  }

  const body = parseJsonBody(req);
  const password = typeof body.password === "string" ? body.password : "";
  if (!gatePassword.verify(password, cfg.passwordHash, cfg.pepper)) {
    /* الصفّ مُسجَّل أصلًا قبل الاشتقاق، فلا كتابة هنا — يبقى حيث هو.
       والعتبة الثالثة (15 خلال 24 ساعة) تُبلّغ ولا تُطيل القفل: أقصى قفل
       يبقى 60 دقيقة عمدًا — القسم لمستخدم واحد، وقفلُ يومٍ كامل خطرٌ
       تشغيليّ يفوق ما يضيفه فوق الطبقات القائمة. */
    return fail("gate_unlock_failed", { reason: "bad_password", critical: lock.critical });
  }

  const sid = gateToken.newSid();
  const opened = Date.now();
  const { absoluteExp } = await gateSessions.create(sql, {
    sidHash: gateToken.hashSid(sid), userId: user.id, now: opened,
  });

  /* logStrict يرمي عند الفشل — وهو مقصود هنا وحده: بوابةٌ لا تُدقَّق يجب
     ألّا تُفتح، وإلّا صار تعطيل التدقيق وسيلةَ فتحٍ صامت. الاستثناء
     يلتقطه المُغلّف فيردّ 404. */
  await audit.logStrict(sql, { event: "gate_unlock_success", userId: user.id, ip, secret: cfg.secret });

  await rateLimit.clearFailures(sql, user.id); // يشمل صفّ هذه المحاولة نفسها
  await rateLimit.prune(sql, opened);
  await gateSessions.prune(sql, opened);

  const issued = gateToken.issue(
    { userId: user.id, sid, now: opened, idleMs: gateSessions.IDLE_MS, absoluteExp }, cfg.secret
  );
  await floor(startedAt);
  H.secureApi(res);
  appendCookie(res, cookie(issued.token, Math.floor((issued.exp - opened) / 1000)));
  res.status(200).json({ ok: true, unlocked: true, expiresAt: issued.exp, absoluteExpiresAt: absoluteExp });
}

async function gateLock(req, res, gate) {
  if (req.method !== "POST") return H.notFoundApi(res);
  const sql = getSql();
  const now = Date.now();
  const raw = access.readCookie(req, COOKIE_NAME);
  const payload = raw ? gateToken.verify(raw, gate.cfg.secret, now) : null;
  if (payload && payload.sub === gate.user.id) {
    await gateSessions.revoke(sql, gateToken.hashSid(payload.sid), now);
    audit.log(sql, { event: "gate_locked", userId: gate.user.id, ip: audit.clientIp(req), secret: gate.cfg.secret });
  }
  H.secureApi(res);
  /* الكوكي يُمسح بنفس الـPath الذي وُضع به، وإلّا بقي في المتصفّح. */
  appendCookie(res, clearCookie());
  res.status(200).json({ ok: true });
}

const API_ROUTES = {
  "gate/status": gateStatus,
  "gate/unlock": gateUnlock,
  "gate/lock": gateLock,
};

/* ---------------- المدخل ---------------- */

async function route(req, res) {
  const query = req.query || {};
  const isApi = query.kind === "api";

  const gate = await access.evaluate(req);
  if (!gate.ok) {
    if (gate.kind === "unauthenticated") {
      return isApi ? H.unauthenticatedApi(res) : H.unauthenticatedPage(res);
    }
    /* الرفض يُسجَّل حين يكون مستحقًّا — لا حين يكون الإعداد غائبًا أصلًا:
       بيئةٌ بلا إعداد ليس فيها جدول تدقيق يُكتب فيه.

       ومقيَّدًا بنافذة: أي مستخدم مسجَّل يستطيع طرق المسار في حلقة، وصفٌّ
       لكل طلب يملأ الجدول ويُغرق الإشارة في ضجيج. */
    if (gate.denied) {
      try {
        await audit.logThrottled(getSql(), {
          event: "access_denied", meta: { route: isApi ? "api" : "page" },
          ip: audit.clientIp(req), secret: gate.cfg && gate.cfg.secret,
        });
      } catch (err) {
        /* غياب الإعداد أو القاعدة لا يغيّر الردّ. */
      }
    }
    return isApi ? H.notFoundApi(res) : H.notFoundPage(res);
  }

  /* بعد `gate.ok` وقبل أي معالج: كل نشاطٍ مصرَّح له داخل القسم يُنزلق
     النافذة، صفحةً كان أو نداءَ API — فتحًا وقفلًا ورفعًا وتحليلًا. */
  slidePlatformSession(req, res, gate.user);

  if (!isApi) return handlePage(req, res, gate);

  const apiPath = String(query.apiPath || "").replace(/^secure-audit\/?/, "");
  const handler = API_ROUTES[apiPath];
  if (handler) return handler(req, res, gate);

  /* المجهول يُردّ 404 **قبل** أي فحص بوابة: ردٌّ مختلف لمسارٍ غير موجود
     يرسم خريطة القسم لمن يطرقه. */
  if (!dataApi.match(req.method, apiPath)) return H.notFoundApi(res);

  /* وما عداه بياناتُ القسم: لا تُبلَغ إلا ببوابة مفتوحة، وداخل سياقها —
     `run()` هو ما يفتح الباب أمام files.js. */
  const allowed = await access.requireDrouaAccess(getSql(), req, { needGate: true, base: gate });
  if (!allowed.ok) {
    H.secureApi(res);
    return res.status(401).json({ ok: false, locked: true });
  }
  if (allowed.gate && allowed.gate.renewed) setRenewed(res, allowed.gate);
  return allowed.run(() => dataApi.handle(req, res, {
    sql: getSql(),
    apiPath,
    query,
    ctx: { actorId: allowed.user.id },
  }));
}

module.exports = async function drouaRouter(req, res) {
  try {
    return await route(req, res);
  } catch (err) {
    /* لا err.message ولا مسار ولا اسم جدول — اسم صنف الخطأ وحده يكفي
       للتشخيص ولا يحمل بيانًا. */
    console.error("[secure-audit] internal error:", (err && err.name) || "Error");
    /* 404 لا 500: حالةٌ مختلفة تكشف أن هنا ما يُعالَج. */
    return (req.query || {}).kind === "api" ? H.notFoundApi(res) : H.notFoundPage(res);
  }
};

module.exports.COOKIE_NAME = COOKIE_NAME;
module.exports.COOKIE_PATH = COOKIE_PATH;
module.exports.RESPONSE_FLOOR_MS = RESPONSE_FLOOR_MS;
