/* motion.js — أدوات الحركة المشتركة (عدّاد، دخول عند الظهور، تتابع).
   =========================================================================
   سكربت كلاسيكي → Motion في النطاق العام، و require في الاختبارات.
   لا مكتبة: requestAnimationFrame و IntersectionObserver فقط.

   قاعدتان لا تُكسران:
     1. المعلومة لا تنتظر الحركة. العدّ لا يتجاوز 700ms، والنصّ النهائي
        يُكتب عند آخر إطار أو فورًا حين لا يتوفّر requestAnimationFrame.
        بلا IntersectionObserver يظهر كل شيء فورًا.
     2. prefers-reduced-motion يعني: القيمة النهائية مباشرة، بلا عدّ ولا
        تتابع ولا طفو. */
(function (root) {
  "use strict";

  function prefersReduced(win) {
    const w = win || (typeof window !== "undefined" ? window : null);
    try { return !!(w && w.matchMedia && w.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (e) { return false; }
  }

  /* منحنى ease-out تكعيبي — بداية سريعة وهبوط ناعم على الرقم الأخير. */
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /* القيم الوسيطة التي يمرّ بها العدّاد، دالّةٌ نقيّة للاختبار:
     تبدأ من 0 وتنتهي بالهدف بالضبط ولا تتجاوزه ولا تتراجع. */
  function countFrames(target, steps) {
    const to = Math.max(0, Math.round(Number(target) || 0));
    const n = Math.max(1, steps || 1);
    const out = [];
    for (let k = 0; k <= n; k++) out.push(Math.round(to * easeOut(k / n)));
    out[out.length - 1] = to;
    return out;
  }

  const fmt = (v) => Number(v).toLocaleString("en-US");

  /* يعدّ النصّ داخل el من 0 إلى target. يُرجع وعدًا يُحلّ عند الانتهاء. */
  function countUp(el, target, opts) {
    const o = opts || {};
    const to = Math.max(0, Math.round(Number(target) || 0));
    const format = o.format || fmt;
    if (!el) return Promise.resolve(to);
    const raf = root.requestAnimationFrame;
    if (to === 0 || prefersReduced() || typeof raf !== "function") {
      el.textContent = format(to);
      return Promise.resolve(to);
    }
    const duration = o.duration || 700;
    return new Promise((resolve) => {
      let start = null;
      const tick = (now) => {
        if (start === null) start = now;
        const t = Math.min(1, (now - start) / duration);
        el.textContent = format(Math.round(to * easeOut(t)));
        if (t < 1) raf(tick);
        else { el.textContent = format(to); resolve(to); }
      };
      el.textContent = format(0);
      raf(tick);
    });
  }

  /* يسلّح الصفحة: الصنف .m-armed يجعل عناصر الدخول تنتظر ظهورها. لا
     يُوضع مع تقليل الحركة ولا بلا IntersectionObserver — فيبقى كل شيء
     مرئيًا. */
  function arm(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || prefersReduced() || !("IntersectionObserver" in root)) return false;
    d.documentElement.classList.add("m-armed");
    return true;
  }

  /* يستدعي fn(el) مرّة واحدة حين يدخل el نافذة العرض. بلا مراقب أو مع
     تقليل الحركة يُستدعى فورًا. */
  function onVisible(el, fn, opts) {
    if (!el) return;
    if (prefersReduced() || !("IntersectionObserver" in root)) { fn(el); return; }
    const io = new root.IntersectionObserver((entries, obs) => {
      entries.forEach((en) => { if (en.isIntersecting) { obs.unobserve(en.target); fn(en.target); } });
    }, { threshold: (opts && opts.threshold) || 0.15, rootMargin: (opts && opts.rootMargin) || "0px 0px -6% 0px" });
    io.observe(el);
  }

  /* يعطي عناصر مجموعة ترتيبها (--i) ويعلّمها .m-in عند ظهور الحاوية،
     فيتتابع دخولها بفارق --stagger. سقف للترتيب كي لا ينتظر العنصر
     العشرون ثانية كاملة. */
  function stagger(container, selector, opts) {
    if (!container) return;
    const items = [...container.querySelectorAll(selector)];
    const cap = (opts && opts.cap) || 8;
    items.forEach((el, i) => el.style.setProperty("--i", String(Math.min(i, cap))));
    onVisible(container, () => items.forEach((el) => el.classList.add("m-in")), opts);
  }

  const Motion = { prefersReduced, countFrames, countUp, arm, onVisible, stagger, easeOut };
  if (typeof module !== "undefined" && module.exports) module.exports = Motion;
  else root.Motion = Motion;
})(typeof window !== "undefined" ? window : globalThis);
