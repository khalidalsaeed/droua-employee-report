/* جولة التحديثات عند فتح المنصّة.
   =========================================================================
   نافذة «قمنا بإضافة مزايا جديدة» ثم جولة بإبراز (spotlight) على كل ميزة.
   بلا مكتبة: طبقة ثابتة بظلّ واسع تُبقي المستطيل المُبرز صافيًا، وبطاقة
   شرح بجواره (أو ورقة سفلية على الجوال).

   متى تظهر: في كل تحميل للرئيسية لمستخدم مسجَّل يُسأل الخادم عن حالة
   الإصدار الحالي — لا يُشترط دخول جديد، فصاحب جلسة قائمة أو «تذكرني»
   يراها في أوّل فتح للمنصّة بعد النشر. ما أكمله أو تخطّاه لا يعود أبدًا.

   «لاحقًا» لا يُحفظ على الخادم، بل في sessionStorage لهذه الزيارة وحدها
   (التبويب إلى أن يُغلق): فلا تعود مع كل Refresh أو تنقّل، وتعود في
   الزيارة التالية.

   الحالة على الخادم (/api/auth/update-tour، انظر lib/tour/updateTour.js):
   الإصدار والخطوات يأتيان منه مُرشَّحَين بالصلاحيات، فلا معرّف إصدار
   ولا نصّ خطوة في هذا الملف. هنا فقط: ترشيح ثانٍ بما هو ظاهر فعلًا في
   الصفحة، والعرض، ولوحة المفاتيح.

     ابدأ الجولة → started، ثم completed عند «إنهاء الجولة»
     «تخطي الجولة» (الزرّ وحده) → skipped
     لاحقًا / Esc — على النافذة أو أثناء الجولة → لا شيء يُحفظ؛ تعود في
     الزيارة التالية. ضغطة Esc بالخطأ لا تُغلق الإصدار نهائيًا.

   localStorage احتياط لا مصدر: يُكتب فقط إن فشل حفظ completed/skipped،
   فلا تعود الجولة في هذا المتصفّح، ويُعاد إرسال القرار في الزيارة القادمة. */
const UpdateTour = (function () {
  const DEFER_PREFIX = "droua:update-tour:later:";
  /* ما يفعله Esc أثناء الجولة: مثل «لاحقًا»، لا «تخطي». */
  const ESC_ACTION = "later";
  const API = "/api/auth/update-tour";
  const LOCAL_PREFIX = "droua:update-tour:";
  const MOBILE_MAX = 640;
  const GAP = 14;          /* بين المستطيل المُبرز وبطاقة الشرح */
  const PAD = 8;           /* هامش المستطيل حول العنصر */
  const EDGE = 16;         /* أقرب مسافة لحافة الشاشة */
  const TARGET_WAIT_MS = 1500;
  const SCROLL_SETTLE_MS = 900;

  /* تجهيزات آمنة قبل الخطوة، بالاسم الذي يرسله الخادم في step.prepare.
     كل تجهيز لا يفعل شيئًا إن لم يجد عنصره، ولا يغيّر بيانات. */
  const PREPARE = {
    /* الدمج في صفّ واحد ظاهر في «عرض حسب المدة» (الافتراضي)؛ إن كان
       المستخدم قد بدّل إلى «حسب الموظف» نعيده إلى التبويب الذي نشرحه. */
    "doc-expiry-duration-view": function () {
      const tab = document.querySelector('#docExpiry [role="tab"][data-view="dur"]');
      if (tab && tab.getAttribute("aria-selected") !== "true") tab.click();
    },
  };

  /* ───────── منطق خالص (مُختبَر في test/update-tour.test.js) ───────── */

  /* الخطوات التي قسمها موجود وظاهر في هذه الصفحة. الصلاحية فُحصت على
     الخادم؛ هذا يحرس حالة القسم المخفي لسبب آخر (تحميل فاشل مثلًا). */
  function visibleSteps(steps, isShown) {
    return (Array.isArray(steps) ? steps : []).filter((s) => s && s.section && isShown(s.section));
  }

  /* المستطيل المُبرز: العنصر بهامشه، مقصوصًا على المساحة المرئية تحت
     الترويسة وفوق bottom (أعلى الورقة السفلية على الجوال). null إن كان
     خارجها كليًا. */
  function spotRect(rect, vp, top, bottom) {
    const t = Math.max(rect.top - PAD, top + 4);
    const l = Math.max(rect.left - PAD, 4);
    const b = Math.min(rect.bottom + PAD, (bottom == null ? vp.h : bottom) - 4);
    const r = Math.min(rect.right + PAD, vp.w - 4);
    if (b - t < 8 || r - l < 8) return null;
    return { top: t, left: l, width: r - l, height: b - t };
  }

  /* موضع بطاقة الشرح. على الجوال ورقة سفلية دائمًا (CSS يتكفّل بها).
     على الشاشات الأوسع: تحت المستطيل إن اتّسع، وإلا فوقه، وإلا بجانبه،
     وإلا داخل المشهد أسفلَه — فالبطاقة لا تخرج عن الشاشة أبدًا. */
  function placement(spot, pop, vp) {
    if (vp.w <= MOBILE_MAX) return { mode: "sheet" };
    const clampLeft = (x) => Math.min(Math.max(x, EDGE), vp.w - pop.w - EDGE);
    const center = spot ? spot.left + spot.width / 2 - pop.w / 2 : (vp.w - pop.w) / 2;
    if (spot && spot.top + spot.height + GAP + pop.h <= vp.h - EDGE) {
      return { mode: "below", top: spot.top + spot.height + GAP, left: clampLeft(center) };
    }
    if (spot && spot.top - GAP - pop.h >= EDGE) {
      return { mode: "above", top: spot.top - GAP - pop.h, left: clampLeft(center) };
    }
    /* عنصر طويل (بطاقة تصريح كاملة): بجانبه حيث الفراغ الأوسع. */
    if (spot) {
      const clampTop = (y) => Math.min(Math.max(y, EDGE), vp.h - pop.h - EDGE);
      const leftRoom = spot.left - GAP - EDGE;
      const rightRoom = vp.w - (spot.left + spot.width) - GAP - EDGE;
      if (Math.max(leftRoom, rightRoom) >= pop.w) {
        const side = leftRoom >= rightRoom
          ? { mode: "start-side", left: spot.left - GAP - pop.w }
          : { mode: "end-side", left: spot.left + spot.width + GAP };
        return { ...side, top: clampTop(spot.top) };
      }
    }
    return { mode: "inside", top: vp.h - pop.h - EDGE, left: clampLeft(center) };
  }

  /* أين يجب أن يستقرّ أعلى العنصر بعد التمرير: في المنتصف إن اتّسع له
     المشهد مع البطاقة، وإلا تحت الترويسة مباشرة. */
  function scrollTargetY(rect, scrollY, vp, top, reserve) {
    const room = vp.h - top - reserve;
    const offset = rect.height + GAP < room ? top + (room - rect.height) / 2 : top + 12;
    return Math.max(0, Math.round(scrollY + rect.top - offset));
  }

  function stepLabel(i, n) { return `${i + 1} من ${n}`; }

  /* ───────── الحالة والتخزين ───────── */

  /* «لاحقًا» لهذه الزيارة: مفتاح لكل مستخدم وإصدار، فإصدار جديد أو حساب
     آخر في التبويب نفسه لا يرث التأجيل. */
  function deferKey(userId, version) { return `${DEFER_PREFIX}${userId}:${version}`; }
  function deferred(userId, version) {
    try { return sessionStorage.getItem(deferKey(userId, version)) === "1"; } catch (e) { return false; }
  }
  function defer(userId, version) {
    try { sessionStorage.setItem(deferKey(userId, version), "1"); } catch (e) { /* وضع خاص */ }
  }
  function localKey(userId, version) { return `${LOCAL_PREFIX}${userId}:${version}`; }
  function localGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ممتلئ/خاص */ } }
  function localDel(k) { try { localStorage.removeItem(k); } catch (e) { /* — */ } }

  async function post(version, action, steps) {
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, action, steps }),
      });
      return r.ok;
    } catch (e) { return false; }
  }

  /* القرار النهائي: إن لم يُحفظ على الخادم يُحفظ محليًا ليُعاد لاحقًا. */
  async function finalize(ctx, action) {
    const k = localKey(ctx.userId, ctx.version);
    const ok = await post(ctx.version, action, ctx.steps.length);
    if (ok) localDel(k); else localSet(k, action);
  }

  /* ───────── أدوات العرض ───────── */

  /* كسول: الملف يُحمَّل في اختبارات Node بلا DOM. */
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (d, size) => `<svg width="${size || 18}" height="${size || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
    next: '<path d="M15 18l-6-6 6-6"/>',   /* RTL: الأمام يسارًا */
    prev: '<path d="M9 18l6-6-6-6"/>',
  };

  function isShown(sel) {
    const el = document.querySelector(sel);
    if (!el) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  function viewport() { return { w: window.innerWidth, h: window.innerHeight }; }

  /* أسفل الترويسة اللاصقة — حتى لا يُبرز ما تغطّيه. */
  function headerBottom() {
    const h = document.querySelector("[data-app-header]");
    if (!h) return 0;
    const r = h.getBoundingClientRect();
    return r.bottom > 0 ? r.bottom : 0;
  }

  function focusables(container) {
    return Array.prototype.filter.call(
      container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      (n) => !n.disabled && !n.hidden && n.getClientRects().length > 0
    );
  }
  function trapTab(e, container) {
    const list = focusables(container);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1];
    if (!container.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* تعطيل الخلفية عن التركيز وقارئ الشاشة، مع مراقب لما يُضاف إلى الجسم
     لاحقًا (حاوية التنبيهات مثلًا) — النمط نفسه في welcome.js. */
  let inerted = [], observer = null;
  function setBackgroundInert(keep) {
    if (keep) {
      const mark = () => Array.prototype.forEach.call(document.body.children, (n) => {
        if (n !== keep && !n.inert && n.tagName !== "SCRIPT") { n.inert = true; inerted.push(n); }
      });
      mark();
      observer = new MutationObserver(mark);
      observer.observe(document.body, { childList: true });
    } else {
      if (observer) { observer.disconnect(); observer = null; }
      inerted.forEach((n) => { n.inert = false; });
      inerted = [];
    }
  }

  function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* لا نعرض شيئًا فوق شاشة الترحيب: ننتظر رفع .welcoming عن <html>. */
  function whenWelcomeGone() {
    if (!root.classList.contains("welcoming")) return Promise.resolve();
    return new Promise((resolve) => {
      const mo = new MutationObserver(() => {
        if (!root.classList.contains("welcoming")) { mo.disconnect(); resolve(); }
      });
      mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    });
  }

  /* أوّل محدِّد ظاهر من step.target؛ ننتظر قليلًا محتوى يُحمَّل بعد
     الإقلاع (البطاقات البلدية تجلب بياناتها بنفسها)، ثم نكتفي بالقسم. */
  async function resolveTarget(step) {
    const deadline = Date.now() + TARGET_WAIT_MS;
    const preferred = (step.target || []).filter((s) => s !== step.section);
    for (;;) {
      for (const sel of preferred) {
        const el = document.querySelector(sel);
        if (el && el.getClientRects().length) return el;
      }
      if (Date.now() >= deadline) break;
      await wait(120);
    }
    return document.querySelector(step.section);
  }

  /* تمرير ناعم ثم انتظار الاستقرار: موضع العنصر ثابت عبر إطارات متتالية. */
  async function scrollToTarget(el, reserve) {
    const vp = viewport();
    const top = headerBottom();
    const rect = el.getBoundingClientRect();
    const y = scrollTargetY(rect, window.scrollY, vp, top, reserve);
    if (Math.abs(y - window.scrollY) < 4) return;
    window.scrollTo({ top: y, behavior: reduceMotion() ? "auto" : "smooth" });
    const deadline = Date.now() + SCROLL_SETTLE_MS;
    let last = null, still = 0;
    while (Date.now() < deadline) {
      await nextFrame();
      const t = el.getBoundingClientRect().top;
      still = last !== null && Math.abs(t - last) < 0.5 ? still + 1 : 0;
      last = t;
      if (still >= 3) break;
    }
  }

  /* ───────── النافذة ───────── */

  function showModal(ctx) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "ut-modal-wrap";
      wrap.innerHTML = `
        <div class="ut-modal" role="dialog" aria-modal="true" aria-labelledby="utModalTitle" aria-describedby="utModalDesc">
          <span class="ut-badge">${icon(ICON.spark, 22)}</span>
          <h2 class="ut-modal-title" id="utModalTitle">${esc(ctx.title)}</h2>
          <p class="ut-modal-desc" id="utModalDesc">${esc(ctx.intro)}</p>
          <ul class="ut-feats" aria-label="ما الجديد">
            ${ctx.steps.map((s) => `<li>${icon(ICON.check, 16)}<span>${esc(s.title)}</span></li>`).join("")}
          </ul>
          <p class="ut-modal-hint">انقر للمشاهدة</p>
          <button type="button" class="ut-btn ut-btn-primary" data-ut="start">
            <span>ابدأ الجولة</span>${icon(ICON.next, 18)}
          </button>
          <div class="ut-modal-row">
            <button type="button" class="ut-btn ut-btn-ghost" data-ut="later">لاحقًا</button>
            <button type="button" class="ut-btn ut-btn-link" data-ut="skip">تخطي الجولة</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const prevFocus = document.activeElement;
      setBackgroundInert(wrap);
      const modal = wrap.querySelector(".ut-modal");

      let done = false;
      const close = (choice) => {
        if (done) return; done = true;
        document.removeEventListener("keydown", onKey, true);
        wrap.classList.remove("is-in");
        const remove = () => {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          setBackgroundInert(null);
          if (choice !== "start" && prevFocus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* — */ } }
          resolve(choice);
        };
        if (reduceMotion()) remove(); else setTimeout(remove, 220);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close("later"); return; }
        if (e.key === "Tab") trapTab(e, modal);
      };
      document.addEventListener("keydown", onKey, true);
      wrap.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ut]");
        if (b) close(b.dataset.ut);
      });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        wrap.classList.add("is-in");
        const primary = wrap.querySelector('[data-ut="start"]');
        try { primary.focus({ preventScroll: true }); } catch (e) { primary.focus(); }
      }));
    });
  }

  /* ───────── الجولة ───────── */

  function runTour(ctx) {
    return new Promise((resolve) => {
      const n = ctx.steps.length;
      const layer = document.createElement("div");
      layer.className = "ut-tour";
      layer.innerHTML = `
        <div class="ut-shade"></div>
        <div class="ut-spot" aria-hidden="true"></div>
        <div class="ut-pop" role="dialog" aria-modal="true" aria-labelledby="utStepTitle" aria-describedby="utStepBody">
          <div class="ut-pop-head">
            <span class="ut-step" id="utStepNo"></span>
            <span class="ut-dots" aria-hidden="true">${ctx.steps.map(() => "<i></i>").join("")}</span>
          </div>
          <h3 class="ut-pop-title" id="utStepTitle" tabindex="-1"></h3>
          <p class="ut-pop-body" id="utStepBody"></p>
          <div class="ut-pop-actions">
            <button type="button" class="ut-btn ut-btn-link" data-ut="skip">تخطي الجولة</button>
            <span class="ut-pop-nav">
              <button type="button" class="ut-btn ut-btn-ghost" data-ut="prev">${icon(ICON.prev, 16)}<span>السابق</span></button>
              <button type="button" class="ut-btn ut-btn-primary" data-ut="next"><span>التالي</span>${icon(ICON.next, 16)}</button>
            </span>
          </div>
          <span class="ut-sr" aria-live="polite" id="utLive"></span>
        </div>`;
      document.body.appendChild(layer);
      setBackgroundInert(layer);

      const spot = layer.querySelector(".ut-spot");
      const pop = layer.querySelector(".ut-pop");
      const no = layer.querySelector("#utStepNo");
      const title = layer.querySelector("#utStepTitle");
      const body = layer.querySelector("#utStepBody");
      const live = layer.querySelector("#utLive");
      const prev = layer.querySelector('[data-ut="prev"]');
      const next = layer.querySelector('[data-ut="next"]');
      const dots = layer.querySelectorAll(".ut-dots i");

      let index = -1, target = null, busy = false, finished = false, raf = 0;

      function layout() {
        raf = 0;
        if (finished) return;
        const vp = viewport();
        const top = headerBottom();
        /* الورقة تُثبَّت أوّلًا ليُقاس أعلاها الحقيقي لا موضعها المؤقّت. */
        if (vp.w <= MOBILE_MAX && pop.dataset.mode !== "sheet") { pop.dataset.mode = "sheet"; pop.style.top = ""; pop.style.left = ""; }
        const sheet = vp.w <= MOBILE_MAX ? pop.getBoundingClientRect().top - 6 : null;
        const s = target ? spotRect(target.getBoundingClientRect(), vp, top, sheet) : null;
        if (s) {
          spot.style.cssText = `top:${s.top}px;left:${s.left}px;width:${s.width}px;height:${s.height}px`;
          spot.classList.remove("is-empty");
        } else {
          spot.classList.add("is-empty");
        }
        const where = placement(s, { w: pop.offsetWidth, h: pop.offsetHeight }, vp);
        pop.dataset.mode = where.mode;
        if (where.mode === "sheet") { pop.style.top = ""; pop.style.left = ""; }
        else { pop.style.top = `${Math.round(where.top)}px`; pop.style.left = `${Math.round(where.left)}px`; }
      }
      const schedule = () => { if (!raf) raf = requestAnimationFrame(layout); };

      async function go(i) {
        if (busy || finished || i < 0 || i >= n) return;
        busy = true;
        index = i;
        const step = ctx.steps[i];
        layer.classList.add("is-moving");
        no.textContent = stepLabel(i, n);
        title.textContent = step.title;
        body.textContent = step.body;
        dots.forEach((d, k) => d.classList.toggle("on", k === i));
        prev.hidden = i === 0;
        next.querySelector("span").textContent = i === n - 1 ? "إنهاء الجولة" : "التالي";
        next.dataset.last = i === n - 1 ? "1" : "";
        live.textContent = `الخطوة ${stepLabel(i, n)}: ${step.title}`;

        if (step.prepare && PREPARE[step.prepare]) { try { PREPARE[step.prepare](); } catch (e) { /* تجهيز اختياري */ } }
        target = await resolveTarget(step);
        if (finished) return;
        /* الجوال: الورقة السفلية تحجز أسفل الشاشة، فيُحسب لها حسابها. */
        const reserve = viewport().w <= MOBILE_MAX ? pop.offsetHeight + EDGE : 0;
        if (target) await scrollToTarget(target, reserve);
        if (finished) return;
        layout();
        layer.classList.remove("is-moving");
        layer.classList.add("is-in");
        busy = false;
        try { next.focus({ preventScroll: true }); } catch (e) { next.focus(); }
      }

      function end(action) {
        if (finished) return;
        finished = true;
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", schedule);
        window.removeEventListener("scroll", schedule, true);
        if (raf) cancelAnimationFrame(raf);
        layer.classList.remove("is-in");
        layer.classList.add("is-leaving");
        const remove = () => {
          if (layer.parentNode) layer.parentNode.removeChild(layer);
          setBackgroundInert(null);
          resolve(action);
        };
        if (reduceMotion()) remove(); else setTimeout(remove, 260);
      }

      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); end(ESC_ACTION); return; }
        if (e.key === "Tab") { trapTab(e, pop); return; }
        /* أسهم للتنقّل بين الخطوات، باتجاه الصفحة (RTL: اليسار للأمام).
           لا حقول إدخال داخل البطاقة، فلا سهم يُسرق من مؤشّر كتابة. */
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const forward = (e.key === "ArrowLeft") === (getComputedStyle(root).direction === "rtl");
          if (forward) { if (index < n - 1) go(index + 1); } else go(index - 1);
        }
      }

      layer.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ut]");
        if (!b) return;
        if (b.dataset.ut === "skip") { end("skipped"); return; }
        if (busy) return;
        if (b.dataset.ut === "prev") go(index - 1);
        else if (b.dataset.ut === "next") { if (next.dataset.last) end("completed"); else go(index + 1); }
      });
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", schedule);
      window.addEventListener("scroll", schedule, true);
      go(0);
    });
  }

  /* ───────── نقطة الدخول ───────── */

  let running = false;

  /* تُستدعى من app-shell.html بعد رسم الأقسام في كل تحميل. لا ترمي أبدًا:
     أي تعثّر يعني ببساطة ألّا تظهر الجولة. */
  async function maybeStart(user) {
    if (running) return false;
    running = true;
    try {
      const r = await fetch(API);
      if (!r.ok) return false;
      const j = await r.json();
      if (!j || !j.ok || !j.version) return false;
      const userId = user && user.id;
      const k = localKey(userId, j.version);
      const pending = localGet(k);
      /* قرار سابق لم يبلغ الخادم: لا نعرض، ونعيد إرساله. */
      if (pending) {
        if (!j.show) localDel(k);
        else if (await post(j.version, pending, null)) localDel(k);
        return false;
      }
      if (!j.show || !j.tour) return false;
      if (deferred(userId, j.version)) return false;   /* «لاحقًا» في هذه الزيارة */
      const steps = visibleSteps(j.tour.steps, isShown);
      if (!steps.length) return false;

      const ctx = { userId, version: j.version, title: j.tour.title, intro: j.tour.intro, steps };
      await whenWelcomeGone();
      const choice = await showModal(ctx);
      if (choice === "skip") { await finalize(ctx, "skipped"); return true; }
      if (choice !== "start") { defer(userId, ctx.version); return true; }   /* لاحقًا / Esc */
      post(ctx.version, "started", steps.length);
      const outcome = await runTour(ctx);
      if (outcome === "later") { defer(userId, ctx.version); return true; }
      await finalize(ctx, outcome);
      return true;
    } catch (e) {
      return false;
    } finally {
      running = false;
    }
  }

  return { maybeStart, ESC_ACTION, deferKey, PREPARE, visibleSteps, spotRect, placement, scrollTargetY, stepLabel, MOBILE_MAX };
})();

if (typeof module !== "undefined" && module.exports) module.exports = UpdateTour;
