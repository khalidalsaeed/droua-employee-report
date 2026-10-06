/* ─── جدول مسارات الـAPI: المصدر الوحيد للصلاحية ─────────────────────────
   =========================================================================
   كل صفٍّ يعلن حاجته: `view` (المحرّر والمشاهد) أو `edit` (المحرّر وحده).
   والموجّه لا يبلغ معالجًا إلا بعد `authz.can(role, need)`. ومسارٌ بلا
   حاجة أو بحاجةٍ لا يعرفها جدول الأدوار يُسقط اختبار test/medins-authz —
   فلا يُنسى فحص الصلاحية في مسارٍ جديد.

   المعاملات تُطابَق بتعابير مغلقة قبل المعالج: `:id` معرّف UUID، و`:n` رقم
   جزء، و`:code` رمز بند كتالوج. ما عداها لا يطابق أصلًا فيُردّ 404. */

const insurers = require("./data/insurers");
const offers = require("./data/offers");
const classes = require("./data/classes");
const catalog = require("./data/catalog");
const benefits = require("./data/benefits");
const terms = require("./data/terms");
const locations = require("./data/locations");
const auditView = require("./data/auditView");
const files = require("./files");

const PARAM = {
  id: "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})",
  n: "([0-7])",
  code: "([a-z][a-z0-9_]{2,40})",
};

function me({ actor }) {
  return { body: { role: actor.role, name: actor.name || null, can: { edit: actor.role === "editor" } } };
}

/* [method, path, need, handler] */
const TABLE = [
  ["GET", "me", "view", me],

  ["GET", "insurers", "view", insurers.list],
  ["POST", "insurers", "edit", insurers.create],
  ["PUT", "insurers/:id", "edit", insurers.update],
  ["POST", "insurers/:id/archive", "edit", insurers.archive],
  ["POST", "insurers/:id/unarchive", "edit", insurers.unarchive],

  ["GET", "offers", "view", offers.list],
  ["POST", "offers", "edit", offers.create],
  ["GET", "offers/:id", "view", offers.get],
  ["PUT", "offers/:id", "edit", offers.update],
  ["POST", "offers/:id/status", "edit", offers.setStatus],
  ["DELETE", "offers/:id", "edit", offers.remove],

  ["POST", "offers/:id/classes", "edit", classes.create],
  ["PUT", "classes/:id", "edit", classes.update],
  ["DELETE", "classes/:id", "edit", classes.remove],

  ["GET", "catalog", "view", catalog.list],
  ["POST", "catalog", "edit", catalog.create],
  ["PUT", "catalog/:code", "edit", catalog.update],

  ["GET", "classes/:id/benefits", "view", benefits.listForClass],
  ["PUT", "classes/:id/benefits", "edit", benefits.save],
  ["POST", "classes/:id/benefits/verify", "edit", benefits.verify],

  ["GET", "offers/:id/terms", "view", terms.list],
  ["POST", "offers/:id/terms", "edit", terms.create],
  ["PUT", "terms/:id", "edit", terms.update],
  ["DELETE", "terms/:id", "edit", terms.remove],

  ["GET", "offers/:id/files", "view", files.listForOffer],
  ["POST", "files/init", "edit", files.init],
  ["POST", "files/:id/parts/:n", "edit", files.putPart],
  ["POST", "files/:id/complete", "edit", files.complete],
  ["GET", "files/:id", "view", files.meta],
  /* تنزيل الأصل حقٌّ للمشاهد أيضًا (قرار D3) — وكل جزءٍ يُدقَّق. */
  ["GET", "files/:id/parts/:n", "view", files.downloadPart],
  ["DELETE", "files/:id", "edit", files.remove],

  ["GET", "locations", "view", locations.list],
  ["POST", "locations", "edit", locations.create],
  ["PUT", "locations/:id", "edit", locations.update],
  ["POST", "locations/:id/default", "edit", locations.makeDefault],

  ["GET", "audit", "edit", auditView.list],
];

function compile([method, path, need, handler]) {
  const names = [];
  const pattern = path.split("/").map((seg) => {
    if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = seg.slice(1);
    if (!PARAM[name]) throw new Error(`معامل مسار غير معروف: ${name}`);
    names.push(name);
    return PARAM[name];
  }).join("/");
  return { method, path, need, handler, names, re: new RegExp(`^${pattern}$`) };
}

const ROUTES = Object.freeze(TABLE.map(compile));

function match(method, apiPath) {
  const path = String(apiPath || "");
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.names.forEach((name, i) => { params[name] = m[i + 1]; });
    return { route: r, params };
  }
  return null;
}

/* هل يوجد المسار بأيّ طريقة؟ (لا يُستعمل في التفويض — للاختبار وحده.) */
const exists = (apiPath) => ROUTES.some((r) => r.re.test(String(apiPath || "")));

module.exports = { ROUTES, match, exists, PARAM };
