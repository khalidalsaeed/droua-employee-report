const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/* ─── العزل مفروضًا في CI ──────────────────────────────────────────────
   الوحدة مستقلّة عن أجير وعن Droua وعن نظام صلاحيات المنصّة — شرطٌ يفشل
   البناءُ عند خرقه، لا نيّةٌ تُراجَع بالعين. الفحص على الشيفرة مجرّدةً من
   التعليقات (التعليقات تشرح لماذا لا تُستعمل هذه الأشياء). */

const ROOT = path.resolve(__dirname, "..");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : e.name.endsWith(".js") ? [full] : [];
});
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const read = (files) => files.map((f) => ({ file: path.relative(ROOT, f), text: strip(fs.readFileSync(f, "utf8")) }));

const MEDINS = () => read(walk(path.join(ROOT, "lib", "medins")));
const KIT = () => read(walk(path.join(ROOT, "lib", "secure-kit")));

test("العزل: الوحدة والطبقة لا تستوردان Droua ولا أجير ولا صلاحيات المنصّة ولا متجرها العامّ", () => {
  const forbidden = [
    /require\(["'][^"']*droua/i, /lib\/blob|\.\.\/blob["']/, /lib\/push|\.\.\/push["']/, /notifications/,
    /data\/registry/, /auth\/permissions/, /hasPermission|resolvePermissions|ROLE_DEFAULTS/,
    /(?<![a-z_])(audit_log|payroll_runs|payroll_transfer_proofs|payroll_attachments|ajeer_permits|droua_[a-z_]+)(?![a-z_])/,
  ];
  for (const { file, text } of [...MEDINS(), ...KIT()]) {
    for (const re of forbidden) assert.ok(!re.test(text), `${file} يخالف ${re}`);
  }
});

test("العزل: الطبقة المشتركة عامّة — لا اسم وحدة ولا متغيّر بيئة مسمّى", () => {
  for (const { file, text } of KIT()) {
    assert.ok(!/medins|secure-benefits|secure-audit|droua/i.test(text), `${file} يعرف وحدة بعينها`);
    assert.ok(!/process\.env\.[A-Z]/.test(text), `${file} يقرأ متغيّرًا مسمّى — الأسماء تُحقن`);
    assert.ok(!/require\(["']\.\.\/(auth|db|data)/.test(text), `${file} يستورد من المنصّة — التبعيّات تُحقن`);
  }
});

test("العزل: Droua لا يعرف الوحدة ولا الطبقة (Phase 1 لا يمسّه)", () => {
  for (const { file, text } of read(walk(path.join(ROOT, "lib", "droua")))) {
    assert.ok(!/medins|secure-kit|secure-benefits/i.test(text), `${file} يذكر الوحدة`);
  }
});

test("العزل: ملفّات المنصّة العامّة وصفحاتها لا تشير إلى الوحدة", () => {
  const shared = ["lib/auth/permissions.js", "lib/auth/roles.js", "lib/data/registry.js", "app-nav.js",
    "manifest.webmanifest", "sw.js", "middleware.mjs"];
  const roots = fs.readdirSync(ROOT).filter((n) => n.endsWith(".html") || n.endsWith(".js"));
  for (const rel of [...shared, ...roots]) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!/secure-benefits|lib\/medins/i.test(text), `${rel} يشير إلى الوحدة — لا رابط ولا زرّ`);
  }
  for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith(".html"))) {
    assert.ok(!/medins|benefit|insur|تأمين/i.test(f), `${f} اسم ملفّ ثابت يكشف الوحدة`);
  }
  for (const f of walk(path.join(ROOT, "lib", "medins"))) assert.ok(!f.endsWith(".html"));
  assert.ok(!fs.readdirSync(path.join(ROOT, "lib", "medins", "views")).some((f) => f.endsWith(".html")));
});

test("العزل: توكن متجر أجير العامّ وتوكن Droua لا يُذكران إلا في قائمة «الممنوع مساواته»", () => {
  for (const { file, text } of MEDINS()) {
    const hits = text.match(/(?<![A-Z_])(BLOB_READ_WRITE_TOKEN|DROUA_BLOB_READ_WRITE_TOKEN)/g) || [];
    if (!hits.length) continue;
    assert.equal(path.basename(file), "config.js", `${file} يذكر توكن متجرٍ آخر`);
    assert.match(text, /FOREIGN_BLOB_TOKENS = Object\.freeze\(\["BLOB_READ_WRITE_TOKEN", "DROUA_BLOB_READ_WRITE_TOKEN"\]\)/);
  }
  /* والطبقة تمرّر التوكن صراحةً في كل نداء متجر. */
  const store = KIT().find((f) => f.file.endsWith("store.js")).text;
  for (const call of store.match(/blobApi\(\)\.(put|get|del)\([^;]*/g)) assert.match(call, /token/, call);
});

test("العزل: الموجّه في الوحدة لا يُحمَّل إلا بطلبٍ يخصّها، وسطر التفويض مطابقة بادئة كاملة", () => {
  const app = fs.readFileSync(path.join(ROOT, "api", "app.js"), "utf8");
  assert.match(app, /return p === BENEFITS_SECTION \|\| p\.startsWith\(BENEFITS_SECTION \+ "\/"\)/);
  assert.match(app, /if \(isBenefitsSectionRequest\(req\.query \|\| \{\}\)\) return await require\("\.\.\/lib\/medins\/router"\)/);
  assert.ok(!/^const .*require\(["']\.\.\/lib\/medins/m.test(app), "استيراد في رأس الملفّ يحمّل الوحدة مع كل طلب");
});

test("العزل: الـrewrites — الـAPI قبل الصفحة، وبلا كلمة كاشفة", () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const sources = vercel.rewrites.map((r) => r.source);
  const api = sources.indexOf("/secure-benefits/api/:path*");
  const page = sources.indexOf("/secure-benefits");
  assert.ok(api >= 0 && page >= 0 && api < page);
  for (const s of sources) assert.ok(!/insur|medical|tameen|تأمين|medins/i.test(s), s);
  assert.equal(Object.keys(vercel.functions).length, 1, "إعداد دالّة جديدة في vercel.json");
});

test("العزل: عدد الدوالّ الخادمة يبقى 2", () => {
  const count = walk(path.join(ROOT, "api")).length;
  assert.equal(count, 2);
});

test("العزل: لا اعتماد جديد في Phase 1", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "@neondatabase/serverless", "@vercel/blob", "jsqr", "nodemailer", "pdfjs-dist", "pdfmake", "qrcode", "web-push",
  ]);
  assert.equal(pkg.devDependencies, undefined);
  for (const { file, text } of [...MEDINS(), ...KIT()]) {
    for (const m of text.matchAll(/require\(["']([^"'.][^"']*)["']\)/g)) {
      const mod = m[1];
      assert.ok(mod.startsWith("node:") || ["crypto", "@vercel/blob"].includes(mod), `${file} يستورد ${mod}`);
    }
  }
});

test("العزل: كل دالّة مُصدَّرة في files.js تبدأ بالحارس", () => {
  const files = require("../lib/medins/files");
  const src = MEDINS().find((f) => f.file.endsWith(path.join("medins", "files.js"))).text;
  const exported = Object.keys(files).filter((k) => typeof files[k] === "function" && k !== "publicView");
  const guards = (src.match(/^\s+requireGate\(\);$/gm) || []).length;
  assert.equal(guards, exported.length, `حرّاس ${guards} ≠ دوالّ ${exported.length}`);
  /* ولا وحدة تلمس المتجر إلا files.js و security.js */
  for (const { file, text } of MEDINS()) {
    if (/files\.js$|security\.js$/.test(file)) continue;
    assert.ok(!/store\.(putEncrypted|getDecrypted|remove)/.test(text), `${file} يلمس المتجر مباشرة`);
  }
});

test("العزل: لا طباعة لجسم الطلب ولا لكلمات المرور", () => {
  for (const { file, text } of [...MEDINS(), ...KIT()]) {
    assert.ok(!/console\.(log|error)[^\n]*(body|password|hash)/i.test(text), `${file} قد يطبع ما لا يُطبع`);
  }
});

test("العزل: هذا الفرع لا يمسّ ملفّات Droua ولا أجير", () => {
  let base;
  try {
    base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (err) {
    return; // لا مرجع main في هذه البيئة
  }
  const changed = execFileSync("git", ["diff", "--name-only", base], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const touched = changed.filter((f) =>
    /^lib\/droua\//.test(f) || /^test\/droua-/.test(f) || /droua/.test(path.basename(f)) && f.startsWith("scripts/") ||
    /^lib\/(data|payroll|notifications|push|reports|pdf)\//.test(f) || /^(app-nav\.js|middleware\.mjs|sw\.js|lib\/blob\.js)$/.test(f));
  assert.deepEqual(touched, [], `ملفّات خارج النطاق تغيّرت: ${touched.join(", ")}`);
});
