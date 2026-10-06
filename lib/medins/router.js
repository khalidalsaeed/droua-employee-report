/* ─── موجّه الوحدة: /secure-benefits ───────────────────────────────────
   =========================================================================
   يستقبل الطلب من api/app.js ويردّ عليه كاملًا. api/app.js لا تعرف عن
   الوحدة إلا سطر التفويض.

   ولا يرمي إلى الخارج أبدًا: استثناءٌ يتسرّب يلتقطه catch-all في api/app.js
   الذي يُرجع err.message — فيكشف أسماء جداول الوحدة. فكل خطأ غير متوقّع
   يُنهى هنا بـ404، لا 500.

   ── الترتيب ──
   ١ الهويّة والعضويّة (evaluate)   → 302/401 لغير المسجَّل، 404 لكل من ليس عضوًا
   ٢ انزلاق جلسة المنصّة            → للعضو وحده
   ٣ الصفحة                         → شاشة البوابة أو الوحدة
   ٤ مسارات البوابة                 → status / unlock / lock
   ٥ مسارٌ مجهول                    → 404 **قبل** أي فحص بوابة (لا خريطة للوحدة)
   ٦ CSRF على كل كتابة              → 403
   ٧ بوابة مفتوحة الآن              → وإلّا 401 { locked: true }
   ٨ الصلاحية (authz.can)           → 403 للمشاهد على مسار تعديل + تدقيق
   ٩ المعالج داخل سياق البوابة */

const crypto = require("crypto");
const { getSql } = require("../db");
const H = require("../secure-kit/http");
const security = require("./security");
const routes = require("./routes");
const V = require("./validate");
const renderGate = require("./views/gate");
const renderApp = require("./views/app");

const { gate, audit, authz, SECTION } = security;

const PG_ERRORS = {
  "23505": [409, "القيمة موجودة مسبقًا"],
  "23503": [409, "مرجعٌ غير صالح أو مستعمَل"],
  "23514": [400, "قيمة خارج الحدود المسموحة"],
  "23502": [400, "حقلٌ مطلوب ناقص"],
  "22001": [400, "نصٌّ أطول من المسموح"],
  "22003": [400, "رقمٌ خارج النطاق"],
  "22007": [400, "تاريخ غير صالح"],
  "22008": [400, "تاريخ خارج النطاق"],
  "22P02": [400, "قيمة بصيغة غير صالحة"],
};

function respondError(res, status, message, extra) {
  H.secureApi(res);
  return res.status(status).json({ ok: false, error: message, ...(extra || {}) });
}

/* كتابةٌ تأتي من صفحة الوحدة نفسها لا غير: JSON صريح، ومصدرٌ مطابق إن
   أُعلن. فوق SameSite=Strict — طبقةٌ لا تكلّف شيئًا. */
function csrfOk(req) {
  if (req.method === "GET") return true;
  const type = String((req.headers && req.headers["content-type"]) || "").toLowerCase();
  if (!type.startsWith("application/json")) return false;
  const origin = req.headers && req.headers.origin;
  if (origin) {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    if (!host || origin !== `https://${host}`) return false;
  }
  return true;
}

function logger(sql, req, who) {
  return (event, meta) => audit.log(sql, {
    event, userId: String(who.user.id), role: who.member.role, meta,
    ip: audit.clientIp(req), secret: who.cfg.secret,
  });
}

async function handlePage(req, res, who) {
  const sql = getSql();
  const nonce = crypto.randomBytes(16).toString("base64");
  const live = await gate.liveGate(sql, req, who.user, who.cfg, Date.now());
  H.securePage(res, nonce);
  if (live) {
    gate.setRenewed(res, live);
    await logger(sql, req, who)("section_opened", {});
    return res.status(200).end(renderApp(nonce, { role: who.member.role }));
  }
  return res.status(200).end(renderGate(nonce));
}

async function invoke(req, res, matched, allowed) {
  const sql = getSql();
  const log = logger(sql, req, allowed);
  const ctx = {
    sql, req, log,
    body: req.method === "GET" ? {} : H.parseJsonBody(req),
    params: matched.params,
    query: req.query || {},
    actor: { id: String(allowed.user.id), role: allowed.member.role, name: allowed.user.name },
  };
  let result;
  try {
    result = await matched.route.handler(ctx);
  } catch (err) {
    if (err instanceof V.ApiError) return respondError(res, err.status, err.message, err.extra);
    const mapped = err && PG_ERRORS[err.code];
    if (mapped) return respondError(res, mapped[0], mapped[1]);
    throw err;
  }
  H.secureApi(res);
  if (result && result.binary) {
    for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
    res.setHeader("Content-Length", String(result.binary.length));
    return res.status(200).end(result.binary);
  }
  return res.status((result && result.status) || 200).json({ ok: true, ...((result && result.body) || {}) });
}

async function route(req, res) {
  const query = req.query || {};
  const isApi = query.kind === "api";

  const who = await gate.evaluate(req);
  if (!who.ok) {
    if (who.kind === "unauthenticated") return isApi ? H.unauthenticatedApi(res) : H.unauthenticatedPage(res);
    if (who.denied) {
      try {
        await audit.logThrottled(getSql(), {
          event: "access_denied", meta: { route: isApi ? "api" : "page" },
          ip: audit.clientIp(req), secret: who.cfg && who.cfg.secret,
        });
      } catch (err) { /* لا يغيّر الردّ */ }
    }
    return isApi ? H.notFoundApi(res) : H.notFoundPage(res);
  }

  gate.slidePlatformSession(req, res, who.user);
  if (!isApi) return handlePage(req, res, who);

  const apiPath = String(query.apiPath || "").replace(new RegExp(`^${SECTION}/?`), "");
  const gateHandler = gate.handlers[apiPath];
  if (gateHandler) {
    if (req.method === "POST" && !csrfOk(req)) return respondError(res, 403, "طلبٌ مرفوض");
    return gateHandler(req, res, who);
  }

  const matched = routes.match(req.method, apiPath);
  if (!matched) return H.notFoundApi(res);
  if (!csrfOk(req)) return respondError(res, 403, "طلبٌ مرفوض");

  const sql = getSql();
  const allowed = await gate.requireAccess(sql, req, { needGate: true, base: who });
  if (!allowed.ok) {
    H.secureApi(res);
    return res.status(401).json({ ok: false, locked: true });
  }
  gate.setRenewed(res, allowed.gate);

  if (!authz.can(allowed.member.role, matched.route.need)) {
    await logger(sql, req, allowed)("forbidden_action", { route: matched.route.path, need: matched.route.need });
    return respondError(res, 403, "صلاحيات غير كافية");
  }

  return allowed.run(() => invoke(req, res, matched, allowed));
}

module.exports = async function medinsRouter(req, res) {
  try {
    return await route(req, res);
  } catch (err) {
    console.error(`[${SECTION}] internal error:`, (err && err.name) || "Error");
    return (req.query || {}).kind === "api" ? H.notFoundApi(res) : H.notFoundPage(res);
  }
};

module.exports.csrfOk = csrfOk;
module.exports.PG_ERRORS = PG_ERRORS;
