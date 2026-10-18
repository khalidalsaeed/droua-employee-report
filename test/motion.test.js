const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/* ملفات الأنماط التي تستعمل نظام الحركة — الموجود منها فقط */
const MOTION_CSS = ["motion.css", "dashboard-fx.css", "doc-expiry.css", "org-chart.css"].filter((f) => fs.existsSync(path.join(ROOT, f)));

/* نظام الحركة: رموز موحّدة، عدّاد لا يكذب، وتقليل الحركة يعني القيمة
   النهائية فورًا بلا أي إخفاء. */

/* يُحمَّل motion.js من جديد مع window مصنوع — matchMedia يحدّد التفضيل. */
function loadMotion({ reduce = false, raf = true } = {}) {
  const saved = { window: global.window, raf: global.requestAnimationFrame };
  global.window = { matchMedia: (q) => ({ matches: reduce && /reduce/.test(q) }) };
  if (raf) global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 1);
  else delete global.requestAnimationFrame;
  delete require.cache[require.resolve("../motion.js")];
  const M = require("../motion.js");
  return { M, restore() { global.window = saved.window; global.requestAnimationFrame = saved.raf; } };
}
const fakeEl = () => ({ textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });

test("countFrames: يبدأ من 0 وينتهي بالهدف بالضبط ولا يتراجع", () => {
  const { M, restore } = loadMotion();
  try {
    for (const target of [1, 2, 12, 100, 1234]) {
      const f = M.countFrames(target, 30);
      assert.equal(f[0], 0);
      assert.equal(f[f.length - 1], target);
      for (let i = 1; i < f.length; i++) assert.ok(f[i] >= f[i - 1] && f[i] <= target);
    }
    assert.deepEqual(M.countFrames(0, 10).filter((x) => x !== 0), []);
  } finally { restore(); }
});

test("countUp مع تقليل الحركة: القيمة النهائية فورًا بلا إطارات", async () => {
  const { M, restore } = loadMotion({ reduce: true });
  try {
    const el = fakeEl();
    const p = M.countUp(el, 12);
    assert.equal(el.textContent, "12", "تُكتب قبل أي إطار");
    assert.equal(await p, 12);
  } finally { restore(); }
});

test("countUp بلا requestAnimationFrame: القيمة النهائية فورًا", async () => {
  const { M, restore } = loadMotion({ raf: false });
  try {
    const el = fakeEl();
    await M.countUp(el, 7);
    assert.equal(el.textContent, "7");
  } finally { restore(); }
});

test("countUp بالحركة: ينتهي بالقيمة النهائية", async () => {
  const { M, restore } = loadMotion();
  try {
    const el = fakeEl();
    await M.countUp(el, 12, { duration: 20 });
    assert.equal(el.textContent, "12");
  } finally { restore(); }
});

test("arm لا يُخفي شيئًا مع تقليل الحركة", () => {
  const { M, restore } = loadMotion({ reduce: true });
  try {
    const classes = new Set();
    const doc = { documentElement: { classList: { add: (c) => classes.add(c) } } };
    assert.equal(M.arm(doc), false);
    assert.equal(classes.size, 0);
  } finally { restore(); }
});

test("onVisible مع تقليل الحركة: يُستدعى فورًا", () => {
  const { M, restore } = loadMotion({ reduce: true });
  try {
    let called = false;
    M.onVisible({}, () => { called = true; });
    assert.ok(called);
  } finally { restore(); }
});

test("رموز الحركة موجودة وضمن النطاقات المطلوبة", () => {
  const css = read("motion.css");
  const ms = (name) => Number((new RegExp(`--${name}:(\\d+)ms`).exec(css) || [])[1]);
  assert.ok(ms("duration-fast") >= 120 && ms("duration-fast") <= 180, "تفاعل دقيق 120–180ms");
  assert.ok(ms("duration-normal") >= 200 && ms("duration-normal") <= 300, "بطاقات وتوسيع 200–300ms");
  assert.ok(ms("duration-slow") >= 300 && ms("duration-slow") <= 450, "دخول الأقسام 300–450ms");
  assert.match(css, /--easing-standard:/);
  for (const k of ["m-fade-in", "m-fade-up", "m-card-enter"]) assert.match(css, new RegExp(`@keyframes ${k}`));
});

test("الإخفاء قبل الدخول مشروطٌ بالتسليح وحده", () => {
  /* كل قاعدة تُخفي عنصرًا (opacity:0) يجب أن تكون مشروطة بصنف تسليح —
     إلا إطارات الحركة نفسها، والتلميح والعرض المنبثق المخفيّان حتى .show. */
  const EXEMPT = /^(from|to|\d+%(,\d+%)*|\.fx-tip|\.oc-overlay)$/;
  for (const file of MOTION_CSS) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/opacity:\s*0(?![.\d])/.test(m[2])) continue;
      const selectors = m[1].trim().split(",").map((x) => x.trim());
      for (const sel of selectors) {
        if (EXEMPT.test(sel)) continue;
        assert.match(sel, /m-armed|dx-armed|oc-armed/, `${file}: إخفاء غير مشروط بالتسليح: ${sel}`);
      }
    }
  }
});

test("كل ملف حركة يحمل كتلة prefers-reduced-motion", () => {
  for (const file of MOTION_CSS) {
    assert.match(read(file), /@media\s*\(prefers-reduced-motion:\s*reduce\)/, file);
  }
  assert.match(read("app-shell.html"), /@media\(prefers-reduced-motion:reduce\)\{\*\{animation:none !important;transition:none !important/,
    "القاعدة الشاملة في الصفحة باقية");
});

test("الحركة على transform و opacity لا على خصائص التخطيط", () => {
  for (const file of MOTION_CSS) {
    const frames = read(file).match(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})+\s*\}/g) || [];
    for (const f of frames) assert.doesNotMatch(f, /\b(width|height|top|left|margin|padding)\s*:/, `${file}: ${f.slice(0, 40)}`);
  }
});
