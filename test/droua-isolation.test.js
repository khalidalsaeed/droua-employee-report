const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* ─── العزل مفروضًا في CI لا موثوقًا به في المراجعة ────────────────────
   الفصل عن مسير أجير وعن نظام الصلاحيات ليس نيّةً تُراجَع بالعين بل شرطٌ
   يفشل البناءُ عند خرقه. هذه الاختبارات تقرأ الملفّات نصًّا. */

const ROOT = path.resolve(__dirname, "..");
const DROUA_DIR = path.join(ROOT, "lib", "droua");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
const drouaFiles = () => walk(DROUA_DIR);

/* التعليقات تُجرَّد قبل الفحص. الفحص على **الشيفرة** لا على النثر: وحدات
   القسم تشرح في تعليقاتها لماذا لا تستعمل audit_log ولا hasPermission،
   فمسحُ النصّ الخام كان سيعدّ الشرح مخالفةً — ويدفع إلى حذف التوثيق
   لإرضاء الاختبار، وهو أسوأ ما يمكن أن يفعله اختبارٌ بمشروع. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
const readAll = (files) =>
  files.map((f) => ({ file: path.relative(ROOT, f), text: stripComments(fs.readFileSync(f, "utf8")) }));

/* ما لا يجوز أن تلمسه وحدات القسم إطلاقًا. */
const FORBIDDEN = [
  "payroll_runs", "payroll_transfer_proofs", "payroll_attachments",
  "audit_log", "data/registry", "auth/permissions",
  "lib/blob", "../blob", "lib/push", "../push", "lib/notifications", "../notifications",
];

test("العزل: وحدات القسم لا تذكر أي جدول أو وحدة تخصّ أجير", () => {
  for (const { file, text } of readAll(drouaFiles())) {
    for (const needle of FORBIDDEN) {
      assert.ok(!text.includes(needle), `${file} يذكر «${needle}» — ممنوع`);
    }
  }
});

test("العزل: القسم لا يستدعي hasPermission — الحماية مستقلّة عن الدور", () => {
  for (const { file, text } of readAll(drouaFiles())) {
    assert.ok(!/hasPermission/.test(text), `${file} يستدعي hasPermission`);
    assert.ok(!/resolvePermissions|ROLE_DEFAULTS|isAdminLike/.test(text), `${file} يمسّ نظام الأدوار`);
  }
});

test("العزل: ملفّات المنصّة المشتركة لا تذكر القسم", () => {
  /* العلامة الكاشفة هي "secure-audit" ومسار وحدات القسم — لا كلمة
     "droua" وحدها: فهي اسم الشركة (ذروة الصعود) وتظهر مشروعةً في وسم
     إشعارات sw.js وفي نطاق بريد المنصّة وفي وسوم مسير أجير. الخلط بينهما
     يجعل الاختبار يمنع ما لا علاقة له بالقسم ويعمى عمّا يكشفه فعلًا. */
  const shared = [
    "lib/auth/permissions.js", "lib/auth/roles.js", "lib/data/registry.js",
    "app-nav.js", "manifest.webmanifest", "sw.js", "middleware.mjs",
  ];
  for (const rel of shared) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!/secure-audit/i.test(text), `${rel} يذكر مسار القسم`);
    assert.ok(!/lib\/droua|droua\/router|require\(".*droua/i.test(text), `${rel} يستورد وحدات القسم`);
  }
});

test("العزل: صفحات المنصّة لا تشير إلى القسم", () => {
  for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith(".html") || n.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/secure-audit/i.test(text), `${f} يذكر مسار القسم — لا رابط ولا زرّ ولا إشارة`);
  }
});

test("العزل: لا ملفّ .html للقسم في المستودع", () => {
  /* R-2: ملفّات الجذر تُقدَّم أصولًا ثابتة لأي مستخدم مسجَّل، فملفٌّ باسم
     يخصّ القسم يكشف وجوده لكل من في المنصّة. */
  const roots = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  for (const f of roots) {
    assert.ok(!/droua|secure|audit/i.test(f), `${f} اسم ملفّ ثابت يكشف القسم`);
  }
  const insideDroua = fs.existsSync(DROUA_DIR)
    ? walk(DROUA_DIR).concat(fs.readdirSync(path.join(DROUA_DIR, "views")).map((f) => path.join(DROUA_DIR, "views", f)))
    : [];
  for (const f of insideDroua) assert.ok(!f.endsWith(".html"), `${f} ملفّ HTML — يجب أن يكون قالبًا في JS`);
});

test("العزل: لا كلمة كاشفة في أي رابط عام", () => {
  const vercel = fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8");
  const sources = [...vercel.matchAll(/"source":\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const src of sources) {
    assert.ok(!/droua|payroll-audit|salary|rawatb/i.test(src), `الرابط ${src} يكشف القسم`);
  }
  /* /payroll القائم يخصّ أجير لا ذروة — يبقى كما هو. */
  assert.ok(sources.includes("/secure-audit"), "مسار الصفحة يجب أن يكون /secure-audit");
  assert.ok(sources.includes("/secure-audit/api/:path*"), "مسار الـAPI يجب أن يكون تحت /secure-audit/api");
});

test("العزل: ترتيب الـrewrites — مسار الـAPI قبل مسار الصفحة", () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const sources = vercel.rewrites.map((r) => r.source);
  const api = sources.indexOf("/secure-audit/api/:path*");
  const page = sources.indexOf("/secure-audit");
  assert.ok(api >= 0 && page >= 0);
  assert.ok(api < page, "مسار الـAPI يجب أن يسبق، وإلّا التقطه أي /secure-audit/:x يُضاف لاحقًا");
});

test("العزل: عدد الدوالّ الخادمة يبقى 2", () => {
  const count = walk(path.join(ROOT, "api")).length;
  assert.equal(count, 2, `عدد الدوالّ ${count} — القيد أن يبقى 2 بلا دالّة ثالثة`);
});

test("العزل: سكربت التهيئة لا يُنشئ إلا جداول البوابة", () => {
  const { STATEMENTS } = require("../scripts/setup-droua-gate");
  const created = STATEMENTS.map((s) => s.sql)
    .join("\n")
    .match(/CREATE TABLE IF NOT EXISTS (\w+)/g)
    .map((m) => m.split(" ").pop());
  assert.deepEqual(created.sort(), ["droua_gate_attempts", "droua_gate_audit", "droua_gate_sessions"]);
  for (const t of created) {
    assert.ok(!/runs|employees|files|notes/.test(t), `${t} ليس جدول بوابة — ممنوع في هذه المرحلة`);
  }
});

test("المخطّط: قيد CHECK على outcome في القاعدة لا في التطبيق وحده", () => {
  const { STATEMENTS } = require("../scripts/setup-droua-gate");
  const attempts = STATEMENTS.find((x) => /CREATE TABLE IF NOT EXISTS droua_gate_attempts/.test(x.sql));
  assert.ok(attempts, "جدول المحاولات يجب أن يوجد");
  assert.match(attempts.sql, /CHECK\s*\(outcome IN \('fail', 'success'\)\)/,
    "سلامةُ الحقل الذي يُبنى عليه القفل يجب ألّا تعتمد على ذاكرة كل كاتب مستقبليّ");
});

test("المخطّط: فهارس المحاولات تطابق شكل الاستعلامات الفعلية", () => {
  const { STATEMENTS } = require("../scripts/setup-droua-gate");
  const all = STATEMENTS.map((x) => x.sql.replace(/\s+/g, " ")).join("\n");
  /* شكل failureCounts و clearFailures: user_id ثم outcome ثم نوافذ ts. */
  assert.match(all, /ON droua_gate_attempts \(user_id, outcome, ts DESC\)/);
  /* شكل prune: ts وحده، ولا يخدمه فهرس ts فيه عمود تالٍ. */
  assert.match(all, /ON droua_gate_attempts \(ts\)/);
  /* والقديم أُسقط: مقدّمته نفسها، فوجوده كلفةُ كتابةٍ ومساحةٍ بلا مقابل. */
  assert.ok(!/ON droua_gate_attempts \(user_id, ts DESC\)/.test(all),
    "الفهرس القديم (user_id, ts DESC) صار زائدًا بعد المركّب");
});

test("المخطّط: كل مسند يُستعمل في الشيفرة له فهرس يخدمه", () => {
  /* الربط بين الاستعلام والفهرس مفحوصٌ آليًا: مسندٌ يُضاف بلا فهرس يظهر
     هنا لا بعد أن يثقل الجدول في الإنتاج. */
  const { STATEMENTS } = require("../scripts/setup-droua-gate");
  const indexes = STATEMENTS.map((x) => x.sql.replace(/\s+/g, " ")).join("\n");
  const rateLimit = fs.readFileSync(path.join(DROUA_DIR, "rateLimit.js"), "utf8");
  const sessions = fs.readFileSync(path.join(DROUA_DIR, "gateSessions.js"), "utf8");
  const audit = fs.readFileSync(path.join(DROUA_DIR, "audit.js"), "utf8");

  if (/WHERE ts < /.test(rateLimit)) assert.match(indexes, /droua_gate_attempts \(ts\)/);
  if (/WHERE user_id = \$\{userId\} AND outcome/.test(rateLimit)) {
    assert.match(indexes, /droua_gate_attempts \(user_id, outcome/);
  }
  /* sid_hash مفتاحٌ أساسيّ فلا يحتاج فهرسًا إضافيًا. */
  assert.match(sessions, /sid_hash/);
  assert.match(indexes, /sid_hash text PRIMARY KEY/);
  if (/WHERE user_id = \$\{userId\} AND revoked_at IS NULL/.test(sessions)) {
    assert.match(indexes, /droua_gate_sessions \(user_id\)/);
  }
  if (/NOT EXISTS/.test(audit)) assert.match(indexes, /droua_gate_audit \(event, ip_hash, ts DESC\)/);
});

test("العزل: لا طباعة لجسم الطلب في وحدات القسم", () => {
  for (const { file, text } of readAll(drouaFiles())) {
    assert.ok(!/console\.log\s*\(\s*(req\.)?body/.test(text), `${file} قد يطبع جسم الطلب`);
    assert.ok(!/console\.(log|error)[^\n]*password/i.test(text), `${file} قد يطبع كلمة المرور`);
  }
});

test("العزل: المقارنة النهائية لكلمة المرور ثابتة الزمن", () => {
  const text = fs.readFileSync(path.join(DROUA_DIR, "gatePassword.js"), "utf8");
  assert.ok(text.includes("timingSafeEqual"), "يجب استعمال crypto.timingSafeEqual");
  assert.ok(!/candidate\s*===|===\s*expected/.test(text), "ممنوع === على الهاش");
});

test("العزل: معاملات الإنتاج للاشتقاق هي 2^17", () => {
  const { PRODUCTION_PARAMS } = require("../scripts/hash-gate-password");
  assert.equal(PRODUCTION_PARAMS.logN, 17);
  assert.equal(PRODUCTION_PARAMS.r, 8);
  assert.equal(PRODUCTION_PARAMS.p, 1);
});

/* ─── تخزين القسم: ما لا يجوز أن يُذكر في وحداته ───────────────────────
   هذان الفحصان يحرسان مستقبل المجلّد كلّه، لا الملفّين الحاليَّين: أي وحدة
   تُضاف غدًا وتنسى `token` أو تعود إلى الاسم المجرَّد تُوقِف البناء. */

test("العزل: لا وحدة تعتمد على توكن متجر أجير العامّ", () => {
  /* `@vercel/blob` يقرأ التوكن العامّ تلقائيًا حين لا يُمرَّر `token`.
     فالاستثناء الوحيد المسموح هو **فحص التساوي** الذي يمسك خطأ اللصق. */
  for (const { file, text } of readAll(drouaFiles())) {
    const hits = text.match(/(?<![A-Z_])BLOB_READ_WRITE_TOKEN/g) || [];
    if (!hits.length) continue;
    assert.equal(path.basename(file), "storage.js",
      `${file} يذكر توكن المتجر العامّ — والذكر الوحيد المسموح في storage.js`);
    assert.equal(hits.length, 1, `${file}: ذكر واحد لا غير`);
    assert.match(text, /token === process\.env\.BLOB_READ_WRITE_TOKEN/,
      "الذكر الوحيد يجب أن يكون فحص التساوي");
  }
});

test("العزل: لا اسم مفتاح مجرَّد بلا معرّف", () => {
  /* اسمٌ بلا معرّف يدعو إلى سقوطٍ ضمنيّ إلى «المفتاح» — وهو صنف العطل
     نفسه الذي يجعل نسيان `token` يكتب في متجر عامّ. */
  for (const { file, text } of readAll(drouaFiles())) {
    assert.ok(!/DROUA_FILE_KEY(?!_)/.test(text),
      `${file} يذكر DROUA_FILE_KEY المجرَّد — المفاتيح تُعرَّف بمعرّف`);
  }
});

test("العزل: لا مسار يبلغ التخزين بعدُ — حتى يُكتب فحص الحارس", () => {
  /* الحارس نفسه لا يمكن اختباره اليوم: لا موجّه يستدعي التخزين أصلًا. وبدل
     ترك الفراغ بلا حارس، يُقفل الباب: أول ملفّ يستورد `storage` يُسقط هذا
     الاختبار — فيُكتب حينها فحص `requireDrouaAccess(needGate)` بدلًا منه،
     لا بعد أسابيع من وصول المسار إلى الإنتاج بلا حراسة. */
  for (const { file, text } of readAll(drouaFiles())) {
    if (path.basename(file) === "storage.js") continue;
    assert.ok(!/require\(["']\.\/storage["']\)/.test(text),
      `${file} يستورد storage — استبدل هذا الاختبار بفحص الحارس الآن`);
  }
});
