/* ─── نُسخ طبقة الأمن الخاصّة بالوحدة ──────────────────────────────────
   =========================================================================
   كل ما يميّز هذه الوحدة أمنيًا مجموعٌ هنا: اسم التوكن، والجداول، والكوكي،
   وحلقة المفاتيح، والمتجر، والأدوار. والمنطق نفسه في lib/secure-kit.

   لا شيء هنا مشترك مع Droua إلا الشيفرة العامّة: سرٌّ مختلف، ونوع توكن
   مختلف، وكوكي بمسار مختلف، وجداول مختلفة، ومتجر وتوكن مختلفان، ومفاتيح
   لا يجوز أن تشترك في مادّة. */

const { getSql } = require("../db");
const { verify: verifyPlatformToken, issueSessionToken } = require("../auth/tokens");
const { sessionCookie } = require("../auth/cookies");
const { requireUser } = require("../auth/requireAuth");
const protectedUsers = require("../auth/protectedUsers");

const { createTokenCodec } = require("../secure-kit/token");
const { createSessionStore } = require("../secure-kit/sessions");
const { createRateLimiter } = require("../secure-kit/rateLimit");
const { createAudit } = require("../secure-kit/audit");
const { createGateContext } = require("../secure-kit/context");
const { gateCookie } = require("../secure-kit/http");
const { createKeyring } = require("../secure-kit/keyring");
const { createEncryptedStore } = require("../secure-kit/store");
const { createAuthz } = require("../secure-kit/authz");
const { createGate } = require("../secure-kit/gate");

const config = require("./config");
const limits = require("./limits");
const members = require("./members");

const SECTION = "secure-benefits";
const COOKIE = gateCookie({ name: "medins_gate", path: "/" + SECTION });
const codec = createTokenCodec({ type: "medins-gate" });
const limiter = createRateLimiter({ table: "medins_gate_attempts" });
const context = createGateContext();

/* قائمة meta المسموحة: معرّفاتٌ وتصنيفات لا غير. لا أسماء ملفّات، ولا
   مبالغ، ولا نصوص منافع، ولا أسماء شركات — فهي بيانٌ لا واصف. */
const AUDIT_META = Object.freeze([
  "reason", "route", "need", "attempts", "critical", "action", "by",
  "offerId", "classId", "insurerId", "fileId", "termId", "locationId", "code",
  "kind", "format", "partIndex", "partCount", "sizeBytes", "count",
  "fromStatus", "toStatus", "encKeyId", "pathname",
]);
const audit = createAudit({ table: "medins_audit", allowedMeta: AUDIT_META, withRole: true, label: SECTION });

/* الأدوار وحاجاتها. «manage_members» محجوزة للشاشة المستقبلية ولا يحملها
   أحد اليوم — الإدارة عبر السكربت. */
const authz = createAuthz({ roles: { editor: ["view", "edit"], viewer: ["view"] } });

/* المدّتان من الإعداد، فالمخزن يُنشأ بهما. يُخزَّن آخر مخزن بمفتاح مدّتيه. */
let sessionsCache = null;
function sessionsFor(cfg) {
  const key = `${cfg.idleMs}:${cfg.absoluteMs}`;
  if (!sessionsCache || sessionsCache.key !== key) {
    sessionsCache = { key, store: createSessionStore({ table: "medins_gate_sessions", idleMs: cfg.idleMs, absoluteMs: cfg.absoluteMs }) };
  }
  return sessionsCache.store;
}

const gate = createGate({
  label: SECTION,
  loadConfig: config.load,
  codec,
  sessionsFor,
  limiter,
  audit,
  cookie: COOKIE,
  floorMs: limits.SESSION.RESPONSE_FLOOR_MS,
  getSql,
  context,
  identity: {
    verifyPlatformToken,
    /* الحساب المحميّ شرطٌ يُفحص **بلا قاعدة** (من متغيّر المنصّة نفسه) —
       فكل من سواه يُردّ قبل أي رحلة. والعضويّة تُقرأ بعده. */
    earlyAllow: (sub) => protectedUsers.isProtected(sub),
    loadUser: requireUser,
    resolveMember: (sql, user) => members.resolve(sql, user),
  },
  platformSession: { issue: issueSessionToken, cookie: sessionCookie },
});

const keyring = createKeyring({ envPrefix: config.ENV.KEY_PREFIX, activeEnv: config.ENV.ACTIVE_KEY });

const store = createEncryptedStore({
  tokenEnv: config.ENV.BLOB_TOKEN,
  forbiddenEqualEnvs: config.FOREIGN_BLOB_TOKENS,
  keyring,
  aadPrefix: "medins-file|v1",
  /* رقم الجزء وعددها داخل الـAAD: لا إعادة ترتيب، ولا اقتطاع، ولا نقل جزءٍ
     إلى ملفٍّ آخر أو عرضٍ آخر. */
  aadFields: ["fileId", "offerId", "kind", "partIndex", "partCount"],
  groupField: "offerId",
  pathPrefix: "medins",
  maxBytes: limits.FILES.PART_BYTES,
  formats: limits.FILES.FORMATS,
});

/* التخزين جاهزٌ ومفصول: التوكن والحلقة سليمان، ولا مادّة مفتاح مشتركة مع
   حلقة وحدةٍ أخرى. */
function storageReady() {
  if (!store.ready()) return false;
  try {
    return !config.FOREIGN_KEY_PREFIXES.some((p) => keyring.sharesMaterialWith(p));
  } catch (err) {
    return false;
  }
}

module.exports = {
  SECTION, COOKIE, codec, limiter, context, audit, authz, gate, keyring, store,
  sessionsFor, storageReady, AUDIT_META,
};
