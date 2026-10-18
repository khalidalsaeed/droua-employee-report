const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/* حرّاس الانحدار لتطوير الواجهة والهيكل التنظيمي.
   =========================================================================
   البصمات أدناه أُخذت من نقطة الأساس قبل التطوير (de6a4ef). أيّ تغيير في
   هذه الأجزاء يعني أن تطويرًا بصريًا مسّ منطق البيانات — وهذا ممنوع في
   هذا التطوير. إن تغيّرت عمدًا في عمل لاحق، تُحدَّث البصمة مع ذكر السبب. */

function fnBlock(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) return null;
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  return null;
}
function between(src, a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); return i < 0 || j < 0 ? null : src.slice(i, j); }

const shell = read("app-shell.html");

const BASELINE = {
  /* حساب الإقامات ورخص العمل (countBy يغذّي الحلقتين والبطاقات) */
  countBy: [between(shell, "function countBy(getSt)", "/* الوثائق بحاجة إلى متابعة"), "c7feded910f60d0a"],
  /* التذاكر والمتابعات */
  renderTicketsWidget: [fnBlock(shell, "function renderTicketsWidget()"), "d6b7d48814cc4847"],
  loadTickets: [fnBlock(shell, "async function loadTickets()"), "0ac560f61ddf74af"],
  ticketMiniRow: [fnBlock(shell, "function ticketMiniRow(t)"), "63f6b44719d0f3fa"],
  employeeTicketsBlock: [fnBlock(shell, "function employeeTicketsBlock(eid)"), "2963436af4c7ac18"],
  ticketsSecMarkup: [between(shell, '<section class="block wrap" id="ticketsSec">', "</section>"), "8318cb97211bcdbd"],
  /* التواصل مع الموارد البشرية */
  contactSecMarkup: [between(shell, '<section class="block wrap" id="contactSec">', "</section>"), "d2ed0e5ac1fa4748"],
};

for (const [name, [text, expected]] of Object.entries(BASELINE)) {
  test(`لم يتغيّر: ${name}`, () => {
    assert.ok(text, `${name} غير موجود في app-shell.html`);
    assert.equal(sha(text), expected);
  });
}

const FILES = {
  "doc-status.js": "97f323ca6819925d",        // حالة الوثائق وعتبة المتابعة
  "tickets-ui.js": "7ccd3769af3efd84",        // شارات التذاكر وقاعدة التأخّر
  "lib/data/employees.js": "3fc10ba5bc06cd1f", // سجلّ الموظفين ومسارات الكتابة
  "lib/data/tickets.js": "a519bc5a0f7e64e2",
  "lib/notifications/scan.js": "07b96287d694996f", // سلّم تنبيهات الانتهاء
};
for (const [file, expected] of Object.entries(FILES)) {
  test(`لم يتغيّر: ${file}`, () => assert.equal(sha(read(file)), expected));
}

test("الهيكل التنظيمي بعد التذاكر مباشرة وقبل التواصل", () => {
  const ids = [...shell.matchAll(/<section class="block wrap" id="(\w+)"/g)].map((m) => m[1]);
  const at = ids.indexOf("orgSec");
  assert.ok(at > 0);
  assert.equal(ids[at - 1], "ticketsSec");
  assert.equal(ids[at + 1], "contactSec");
});

test("ترتيب الأقسام الأخرى كما كان", () => {
  const ids = [...shell.matchAll(/<section class="block wrap" id="(\w+)"/g)].map((m) => m[1]).filter((x) => x !== "orgSec");
  assert.deepEqual(ids, ["kpiSec", "finSec", "peopleSec", "ajeerSec", "ticketsSec", "contactSec"]);
});

test("قسم الهيكل محروس بصلاحية سجلّ الموظفين في الواجهة", () => {
  assert.match(shell, /orgSec:"employees"/);
});

test("البطاقات الأربع بأرقامها من المصادر نفسها", () => {
  assert.match(shell, /lbl:"إجمالي الموظفين",big:DATA\.length/);
  assert.match(shell, /lbl:"إقامات سارية",big:validIq/);
  assert.match(shell, /lbl:"وثائق بحاجة إلى متابعة",big:followUpDocs\.length/);
  assert.match(shell, /lbl:"منها وثائق منتهية",big:expiredDocs\.length/);
});

test("الحلقتان: البيانات نفسها، والنقر على ما يطابق مرشّحًا حرفيًا فقط", () => {
  assert.match(shell, /donut\("chartIqama",\[\["سارية",validIq,C\.ok\],\["منتهية",expiredIq,C\.bad,"bad"\]\]/);
  assert.match(shell, /\["جاري السداد",pendingLic,C\.pending,"pending"\]/);
  assert.match(shell, /\["منتهية",expiredLic,C\.bad,"bad"\]/);
  // «سارية» بلا مرشّح: تجمع ok و warn و today ولا مرشّح يطابقها
  assert.doesNotMatch(shell, /\["سارية",valid(Iq|Lic),C\.ok,"/);
});

test("الدوال الخادمة لم تزد: اثنتان فقط", () => {
  const apiFiles = [];
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|mjs|ts)$/.test(e.name)) apiFiles.push(p);
  });
  walk("api");
  assert.deepEqual(apiFiles.sort(), ["api/app.js", "api/cron/check-expirations.js"]);
  const vercel = JSON.parse(read("vercel.json"));
  assert.deepEqual(Object.keys(vercel.functions), ["api/app.js"]);
  assert.ok(!vercel.rewrites.some((r) => /org/.test(r.source)), "لا مسار جديد");
});

test("لا اعتمادية جديدة", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(),
    ["@neondatabase/serverless", "@vercel/blob", "jsqr", "nodemailer", "pdfjs-dist", "pdfmake", "qrcode", "web-push"]);
  assert.equal(pkg.devDependencies, undefined);
});

test("ملفات الواجهة الجديدة محمّلة في الصفحة", () => {
  for (const f of ["motion.css", "dashboard-fx.css", "doc-expiry.css", "org-chart.css"]) assert.match(shell, new RegExp(`href="/${f.replace(".", "\\.")}\\?v=\\d+"`));
  for (const f of ["motion.js", "dashboard-fx.js", "doc-expiry.js", "org-core.js", "org-chart.js"]) assert.match(shell, new RegExp(`src="/${f.replace(".", "\\.")}\\?v=\\d+"`));
  // الترتيب: الحركة قبل مستهلكيها، والمنطق قبل الواجهة، وكلها قبل سكربت الصفحة
  const pos = (f) => shell.indexOf(`src="/${f}`);
  assert.ok(pos("doc-status.js") < pos("motion.js") && pos("motion.js") < pos("dashboard-fx.js"));
  assert.ok(pos("org-core.js") < pos("org-chart.js"));
});

test("الملفات الجديدة سكربتات كلاسيكية لا تُعرِّف ثوابت في النطاق العام", () => {
  for (const f of ["motion.js", "dashboard-fx.js", "doc-expiry.js", "org-core.js", "org-chart.js"]) {
    assert.doesNotMatch(read(f), /^(const|let|var)\s/m, `${f}: تعريف على المستوى الأعلى يصطدم بسكربت الصفحة`);
  }
});
