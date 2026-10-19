/* org-chart.js — واجهة الهيكل التنظيمي.
   =========================================================================
   قسمٌ مختصر في التقرير الرئيسي (مؤشّرات + نتائج الفحص + أوّل مستويين)،
   وعرضٌ كامل منبثق داخل الصفحة نفسها: بحث، ومرشّحات مشتقّة من البيانات،
   ووضعان (الهيكل / حسب المواقع)، ولوحة تفاصيل، وقائمة متدرّجة للجوال.

   كل منطق البيانات في org-core.js؛ هنا الرسم والتفاعل وحدهما. والحركة من
   motion.css / motion.js — لا مدّة تُكتب هنا إلا عبر رموزها.

   لا تُعرض قيمة ليست في المصدر: مدير بلا سجلّ يظهر باسمه كما ورد فقط،
   و«مواقع الفريق» تُشتقّ من تابعيه وتُسمّى كذلك صراحةً لا موقعًا له. */
(function (root) {
  "use strict";

  const ROOT_LABEL = "ذروة الصعود للتجارة";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const icon = (n, s) => DashFx.icon(n, s);
  const reduced = () => Motion.prefersReduced();
  const isNarrow = () => window.matchMedia && window.matchMedia("(max-width: 639px)").matches;

  const S = {
    tree: null, rows: [], link: null, stats: null, opts: null,
    mode: "tree", q: "", dept: "", loc: "",
    expanded: new Set(), selected: null, hits: [], hitIdx: 0, visible: null,
    overlay: null, lastFocus: null, played: false, zoom: 1,
  };
  const ZOOM_MIN = 0.5, ZOOM_MAX = 1.6, ZOOM_STEP = 0.1;
  const canHover = () => window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  /* ── صياغات ── */
  function reportsPhrase(n) {
    if (!n) return "لا تابعين";
    if (n === 1) return "تابع واحد";
    if (n === 2) return "تابعان";
    if (n <= 10) return `${n} تابعين`;
    return `${n} تابعًا`;
  }
  function node(id) { return S.tree.nodes.get(id); }
  /* مواقع وأقسام فريق المدير — مشتقّة من تابعيه، لا صفةٌ للمدير نفسه */
  function teamFacet(n, key) {
    const vals = new Set();
    OrgCore.descendants(S.tree, n.id).forEach((d) => { const v = node(d)[key]; if (v) vals.add(v); });
    return [...vals];
  }

  /* ── التركيب ── */
  async function mount(opts) {
    S.opts = opts;
    const box = opts.preview;
    let rows;
    try {
      const j = await AdminUI.api("GET", "/api/data/org-structure");
      rows = j.items || [];
    } catch (err) {
      box.innerHTML = `<div class="oc-empty">تعذّر تحميل الهيكل التنظيمي.</div>`;
      return;
    }
    S.rows = rows;
    S.tree = OrgCore.buildHierarchy(rows, { rootLabel: ROOT_LABEL });
    S.link = OrgCore.linkPlatform(S.tree, opts.platform || [], opts.emailKey);
    S.stats = OrgCore.stats(S.tree);
    S.source = rows[0] && rows[0].source;
    renderPreview();
    if (location.hash === "#org-chart") open();
  }

  /* اسم الملف بلا الامتداد: «.xlsx» اللاتيني بعد قوسين في سطر عربي يقلب
     ترتيب العرض. */
  function srcLabel() { return String(S.source || "—").replace(/\.xlsx?$/i, ""); }

  /* ── المؤشّرات ── */
  function kpiItems() {
    const st = S.stats;
    const items = [
      { ic: "people", l: "إجمالي الموظفين", v: st.employees },
      { ic: "layers", l: "الأقسام", v: st.departments },
      { ic: "pin", l: "المواقع", v: st.locations },
      { ic: "user", l: "المدراء المباشرون", v: st.managers },
    ];
    if (st.largestTeam) items.push({ ic: "team", l: "أكبر فريق", v: st.largestTeam.size,
      cap: st.largestTeam.names.join(" · ") });
    return items;
  }
  function kpiRow() {
    return `<div class="oc-kpis">${kpiItems().map((k, i) => `
      <div class="oc-kpi m-card-enter" style="--i:${i}">
        <span class="oc-kpi-ico" aria-hidden="true">${icon(k.ic, 16)}</span>
        <span class="oc-kpi-l">${esc(k.l)}</span>
        <span class="oc-kpi-v num" data-count="${k.v}">${k.v}</span>
        ${k.cap ? `<span class="oc-kpi-c">${esc(k.cap)}</span>` : ""}
      </div>`).join("")}</div>`;
  }

  /* ── نتائج الفحص ── */
  const SEV_LABEL = { error: "خطأ", warning: "تنبيه", info: "ملاحظة" };
  function issuesBlock(interactive) {
    const list = S.tree.issues;
    const errs = list.filter((i) => i.severity === "error").length;
    const warns = list.filter((i) => i.severity === "warning").length;
    const headline = list.find((i) => i.code === "unlinked_manager");
    const linked = S.link.links.size, total = S.stats.employees;
    const summary = errs ? `${errs} خطأ في الهيكل يحتاج تصحيحًا` : headline ? headline.message : warns ? `${warns} تنبيه` : "لا مشاكل في الهيكل";
    const tone = errs ? "bad" : warns ? "warn" : "ok";
    return `<details class="oc-issues ${tone}">
      <summary>
        <span class="oc-iss-ico" aria-hidden="true">${icon(errs || warns ? "alert" : "shield", 16)}</span>
        <span class="oc-iss-t">${esc(summary)}</span>
        <span class="oc-iss-n">نتائج الفحص (${list.length})</span>
      </summary>
      <ul>${list.map((it, k) => `<li class="${it.severity}">
          <span class="oc-sev">${SEV_LABEL[it.severity]}</span>
          ${interactive && it.nodes.length ? `<button type="button" class="oc-iss-go" data-issue="${k}">${esc(it.message)}</button>` : `<span>${esc(it.message)}</span>`}
        </li>`).join("")}
        <li class="info"><span class="oc-sev">ربط</span><span>${linked} من ${total} مربوطون بسجلّات المنصّة عبر البريد الإلكتروني${S.link.ambiguous.length ? ` · ${S.link.ambiguous.length} بريد ملتبس لم يُربط` : ""}${S.link.platformOnly.length ? ` · ${S.link.platformOnly.length} سجلّ في المنصّة غير موجود في المصدر` : ""}</span></li>
      </ul>
    </details>`;
  }

  /* ── المعاينة في التقرير ── */
  function renderPreview() {
    const box = S.opts.preview;
    const tops = node(S.tree.rootId).children;
    if (S.opts.idx) S.opts.idx.textContent = `${S.stats.employees} موظفًا · ${S.stats.locations} مواقع`;
    box.innerHTML = `
      ${kpiRow()}
      ${issuesBlock(false)}
      <div class="oc-mini" aria-label="معاينة أوّل مستويين من الهيكل">
        <div class="oc-mini-root m-fade-up"><span aria-hidden="true">${icon("org", 18)}</span>${esc(ROOT_LABEL)}</div>
        <div class="oc-mini-cols" style="--n:${tops.length}">${tops.map((id, i) => {
          const n = node(id);
          const locs = n.kind === "reference" ? teamFacet(n, "location") : [n.location].filter(Boolean);
          return `<button type="button" class="oc-mini-node m-card-enter" style="--i:${i}" data-open="${esc(id)}">
            <b>${esc(n.nameAr)}</b>
            <span>${esc(reportsPhrase(n.children.length))}${locs.length ? ` · ${esc(locs.join("، "))}` : ""}</span>
            ${n.kind === "reference" ? `<em>عقدة مدير مرجعية</em>` : ""}
          </button>`;
        }).join("")}</div>
      </div>
      <div class="oc-cta-row">
        <button type="button" class="oc-cta" id="ocOpen">${icon("org", 16)} عرض الهيكل التنظيمي كاملًا</button>
        <span class="oc-src">المصدر: <bdi>${esc(srcLabel())}</bdi> (Excel) · لقطة للقراءة فقط</span>
      </div>`;
    box.querySelector("#ocOpen").addEventListener("click", () => open());
    box.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => open(b.dataset.open)));
    Motion.stagger(box, ".m-card-enter,.m-fade-up");
    Motion.onVisible(box, () => box.querySelectorAll(".oc-kpi-v[data-count]").forEach((el) => Motion.countUp(el, Number(el.dataset.count))));
  }

  /* ── العرض الكامل ── */
  function open(focusId) {
    S.lastFocus = document.activeElement;
    if (!S.overlay) buildOverlay();
    S.overlay.hidden = false;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => S.overlay.classList.add("show"));
    if (history.replaceState) history.replaceState(null, "", "#org-chart");
    S.played = false;
    S.expanded = new Set(node(S.tree.rootId).children); // أوّل مستويين مفتوحان افتراضيًا
    S.selected = null;
    renderBody();
    if (focusId) select(focusId, { reveal: true });
    else S.overlay.querySelector("#ocQ").focus({ preventScroll: true });
  }
  function close() {
    if (!S.overlay) return;
    S.overlay.classList.remove("show");
    const done = () => { S.overlay.hidden = true; };
    if (reduced()) done(); else setTimeout(done, 260);
    document.body.style.overflow = "";
    DashFx.hideTip();
    hidePop();
    if (location.hash === "#org-chart" && history.replaceState) history.replaceState(null, "", location.pathname + location.search);
    if (S.lastFocus && S.lastFocus.focus) S.lastFocus.focus({ preventScroll: true });
  }

  function buildOverlay() {
    const f = OrgCore.facets(S.tree);
    const opt = (list) => list.map((x) => `<option value="${esc(x.key)}">${esc(x.label)} (${x.count})</option>`).join("");
    const el = document.createElement("div");
    el.className = "oc-overlay";
    el.hidden = true;
    el.innerHTML = `
      <div class="oc-shell" role="dialog" aria-modal="true" aria-labelledby="ocTitle">
        <header class="oc-head">
          <div>
            <span class="eyebrow">الموارد البشرية · <bdi>${esc(srcLabel())}</bdi></span>
            <h2 id="ocTitle">الهيكل التنظيمي</h2>
          </div>
          <button type="button" class="oc-x" id="ocClose" aria-label="إغلاق">✕</button>
        </header>
        <div class="oc-bar">
          <div class="oc-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input id="ocQ" type="search" placeholder="ابحث عن موظف، قسم، موقع…" autocomplete="off" aria-label="بحث في الهيكل" enterkeyhint="search">
            <span class="oc-hits" id="ocHits" aria-live="polite"></span>
          </div>
          <select id="ocDept" aria-label="القسم"><option value="">كل الأقسام</option>${opt(f.departments)}</select>
          <select id="ocLoc" aria-label="الموقع"><option value="">كل المواقع</option>${opt(f.locations)}</select>
          <div class="oc-seg" role="group" aria-label="طريقة العرض">
            <button type="button" data-mode="tree" aria-pressed="true">الهيكل الكامل</button>
            <button type="button" data-mode="loc" aria-pressed="false">حسب المواقع</button>
          </div>
          <button type="button" class="oc-ghost" id="ocToggleAll">توسيع الكل</button>
        </div>
        <div class="oc-issues-wrap" id="ocIssues"></div>
        <div class="oc-main">
          <div class="oc-canvas" id="ocCanvas" tabindex="0" aria-label="لوحة الهيكل — اسحب للتحريك، و Ctrl مع العجلة أو + و − للتكبير"></div>
          <div class="oc-zoom" role="toolbar" aria-label="التكبير والتصغير">
            <button type="button" data-z="in" aria-label="تكبير">${icon("plus", 16)}</button>
            <output class="oc-zoom-v" id="ocZoomV" aria-live="polite">100%</output>
            <button type="button" data-z="out" aria-label="تصغير">${icon("minus", 16)}</button>
            <span class="oc-zoom-sep" aria-hidden="true"></span>
            <button type="button" data-z="fit" aria-label="ملاءمة الهيكل للشاشة">${icon("fit", 16)}</button>
            <button type="button" data-z="reset" aria-label="الحجم الأصلي 100%">${icon("reset", 16)}</button>
          </div>
          <div class="oc-pop" id="ocPop" role="tooltip" hidden></div>
          <aside class="oc-panel" id="ocPanel" aria-label="تفاصيل" hidden></aside>
        </div>
      </div>`;
    document.body.appendChild(el);
    S.overlay = el;
    el.querySelector("#ocIssues").innerHTML = issuesBlock(true);
    el.querySelector("#ocClose").addEventListener("click", close);
    el.addEventListener("click", (ev) => { if (ev.target === el) close(); });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (S.selected && !el.querySelector("#ocPanel").hidden) closePanel(); else close(); }
      if (ev.key === "Tab") trapFocus(ev);
    });
    const q = el.querySelector("#ocQ");
    let t;
    q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { S.q = q.value; runSearch(true); }, 150); });
    q.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); nextHit(); } });
    el.querySelector("#ocDept").addEventListener("change", (ev) => { S.dept = ev.target.value; renderBody(true); });
    el.querySelector("#ocLoc").addEventListener("change", (ev) => { S.loc = ev.target.value; renderBody(true); });
    el.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    el.querySelector("#ocToggleAll").addEventListener("click", toggleAll);
    el.querySelectorAll(".oc-iss-go").forEach((b) => b.addEventListener("click", () => {
      const it = S.tree.issues[Number(b.dataset.issue)];
      const target = it.nodes.find((id) => S.tree.nodes.has(id) && node(id).parent);
      if (target) select(target, { reveal: true });
    }));
    const mq = window.matchMedia && window.matchMedia("(max-width: 639px)");
    if (mq && mq.addEventListener) mq.addEventListener("change", () => { if (!el.hidden) renderBody(); });
    enablePan(el.querySelector("#ocCanvas"));
  }

  function trapFocus(ev) {
    const items = [...S.overlay.querySelectorAll('button:not([disabled]),input,select,[tabindex="0"],summary')]
      .filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  /* ── التحريك والتكبير ────────────────────────────────────────────────
     التحريك: سحب الفأرة في أيّ موضع من اللوحة (حتى فوق البطاقات — نقرةٌ لا
     يتجاوز فيها المؤشّر 5px تبقى نقرة)، واللمس يمرّر طبيعيًا لأن اللوحة
     overflow:auto. التكبير: أزرار، Ctrl/⌘ مع العجلة، + و − و 0 من لوحة
     المفاتيح، وقرصة إصبعين على اللمس. يُثبَّت تحت المؤشّر/منتصف القرصة
     النقطةُ نفسها من الهيكل فلا «يقفز» العرض.
     CSS zoom لا transform: يعيد التخطيط بالمقاس الجديد فيبقى التمرير
     وأشرطته وscrollIntoView صحيحة بلا حساب إضافي. */
  function enablePan(c) {
    let down = null, dragged = false;
    c.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "mouse" || ev.button !== 0 || ev.target.closest(".oc-tog") || isNarrow()) return;
      down = { x: ev.clientX, y: ev.clientY, l: c.scrollLeft, t: c.scrollTop };
      dragged = false;
    });
    window.addEventListener("pointermove", (ev) => {
      if (!down) return;
      const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      if (!dragged) { dragged = true; c.classList.add("panning"); hidePop(); }
      c.scrollLeft = down.l - dx;
      c.scrollTop = down.t - dy;
    });
    window.addEventListener("pointerup", () => { down = null; c.classList.remove("panning"); });
    c.addEventListener("scroll", hidePop, { passive: true });
    /* سحبٌ انتهى فوق بطاقة لا يفتحها */
    c.addEventListener("click", (ev) => { if (dragged) { ev.stopPropagation(); ev.preventDefault(); dragged = false; } }, true);

    c.addEventListener("wheel", (ev) => {
      if (isNarrow() || !(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      setZoom(S.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), { x: ev.clientX, y: ev.clientY });
    }, { passive: false });
    c.addEventListener("keydown", (ev) => {
      if (isNarrow() || ev.target.closest("input,select")) return;
      if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); setZoom(S.zoom + ZOOM_STEP); }
      else if (ev.key === "-") { ev.preventDefault(); setZoom(S.zoom - ZOOM_STEP); }
      else if (ev.key === "0") { ev.preventDefault(); setZoom(1); }
    });

    /* قرصة الإصبعين. touch-action: pan-x pan-y في الأنماط يُبقي التمرير
       بإصبع واحد للمتصفّح ويمنعه من تكبير الصفحة كلها بالقرصة. */
    const touches = new Map();
    let pinch = null;
    c.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "touch" || isNarrow()) return;
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.zoom };
      }
    });
    c.addEventListener("pointermove", (ev) => {
      if (!touches.has(ev.pointerId)) return;
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (!pinch || touches.size !== 2) return;
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(pinch.z * (d / pinch.d), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    });
    const lift = (ev) => { touches.delete(ev.pointerId); if (touches.size < 2) pinch = null; };
    c.addEventListener("pointerup", lift);
    c.addEventListener("pointercancel", lift);

    S.overlay.querySelectorAll("[data-z]").forEach((b) => b.addEventListener("click", () => {
      const z = b.dataset.z;
      if (z === "in") setZoom(S.zoom + ZOOM_STEP);
      else if (z === "out") setZoom(S.zoom - ZOOM_STEP);
      else if (z === "reset") setZoom(1);
      else fitZoom();
    }));
  }

  function chartEl() { return S.overlay && S.overlay.querySelector("#ocCanvas .oc-chart"); }

  /* يغيّر المقاس مع تثبيت النقطة تحت anchor (إحداثيات الشاشة)، أو منتصف
     اللوحة بلا anchor. scrollLeft في RTL يبدأ من 0 وينزل سالبًا، فيُحسب
     الموضع نسبةً إلى أصغر قيمة ممكنة له. */
  function setZoom(z, anchor) {
    const c = S.overlay.querySelector("#ocCanvas"), ch = chartEl();
    const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
    if (!ch) { S.zoom = next; return; }
    if (next === S.zoom && ch.style.zoom) return;
    const r = c.getBoundingClientRect();
    const ax = anchor ? anchor.x - r.left : c.clientWidth / 2;
    const ay = anchor ? anchor.y - r.top : c.clientHeight / 2;
    const rtl = getComputedStyle(c).direction === "rtl";
    const minL = () => (rtl ? -(c.scrollWidth - c.clientWidth) : 0);
    const fx = (c.scrollLeft - minL() + ax) / c.scrollWidth;
    const fy = (c.scrollTop + ay) / c.scrollHeight;
    S.zoom = next;
    ch.style.zoom = String(next);
    c.scrollLeft = minL() + fx * c.scrollWidth - ax;
    c.scrollTop = fy * c.scrollHeight - ay;
    hidePop();
    syncZoomUi();
  }
  function fitZoom() {
    const c = S.overlay.querySelector("#ocCanvas"), ch = chartEl();
    if (!ch) return;
    const w = ch.scrollWidth / S.zoom, h = ch.scrollHeight / S.zoom;
    const z = Math.min(1, (c.clientWidth - 48) / w, (c.clientHeight - 60) / h);
    setZoom(z);
    const rtl = getComputedStyle(c).direction === "rtl";
    const mid = Math.max(0, (c.scrollWidth - c.clientWidth) / 2);
    c.scrollLeft = rtl ? -mid : mid;
    c.scrollTop = 0;
  }
  function syncZoomUi() {
    if (!S.overlay) return;
    S.overlay.querySelector("#ocZoomV").textContent = `${Math.round(S.zoom * 100)}%`;
    S.overlay.querySelector('[data-z="in"]').disabled = S.zoom >= ZOOM_MAX;
    S.overlay.querySelector('[data-z="out"]').disabled = S.zoom <= ZOOM_MIN;
    S.overlay.querySelector(".oc-zoom").hidden = isNarrow();
  }

  /* ── تفاصيل الحوم (سطح المكتب وحده) ──────────────────────────────────
     معاينة سريعة بعد توقّفٍ قصير فوق البطاقة؛ لا تحمل إلا ما في لوحة
     التفاصيل التي يفتحها النقر — النقر يبقى الطريق الأساسي، والحوم اختصار. */
  let popTimer = null;
  function showPop(id, anchorEl) {
    clearTimeout(popTimer);
    popTimer = setTimeout(() => {
      const n = node(id), pop = S.overlay.querySelector("#ocPop");
      const isRef = n.kind === "reference";
      const parent = n.parent && n.parent !== S.tree.rootId ? node(n.parent) : null;
      const line = (k, v) => (v ? `<div class="oc-pop-r"><span>${esc(k)}</span><b>${esc(v)}</b></div>` : "");
      pop.innerHTML = `
        <div class="oc-pop-h"><b>${esc(n.nameAr)}</b><span class="oc-badge ${isRef ? "ref" : "emp"}">${isRef ? "عقدة مدير مرجعية" : esc(n.status || "موظف")}</span></div>
        ${isRef
          ? `${line("مواقع فريقه", teamFacet(n, "location").join("، "))}${line("التابعون", reportsPhrase(n.children.length))}
             <div class="oc-pop-note">سجل المدير غير مربوط بموظف حالي</div>`
          : `${line("المسمّى الوظيفي", n.jobTitle)}${line("القسم", n.department)}${line("الموقع", n.location)}
             ${line("المدير المباشر", parent ? parent.nameAr : n.managerName)}${n.children.length ? line("التابعون", reportsPhrase(n.children.length)) : ""}`}
        <div class="oc-pop-hint">اضغط لعرض التفاصيل كاملة</div>`;
      pop.hidden = false;
      const main = S.overlay.querySelector(".oc-main").getBoundingClientRect();
      const r = anchorEl.getBoundingClientRect();
      const w = pop.offsetWidth, h = pop.offsetHeight;
      let left = r.left + r.width / 2 - w / 2 - main.left;
      left = Math.max(8, Math.min(left, main.width - w - 8));
      let top = r.bottom - main.top + 8;
      if (top + h > main.height - 8) top = r.top - main.top - h - 8;
      pop.style.transform = `translate(${Math.round(left)}px,${Math.round(Math.max(8, top))}px)`;
      requestAnimationFrame(() => pop.classList.add("show"));
    }, 320);
  }
  function hidePop() {
    clearTimeout(popTimer);
    const pop = S.overlay && S.overlay.querySelector("#ocPop");
    if (!pop) return;
    pop.classList.remove("show");
    pop.hidden = true;
  }

  function setMode(mode) {
    if (mode === S.mode) return;
    S.mode = mode;
    /* المواقع مفتوحة عند الدخول إلى الوضع — هي المستوى الذي جاء المستخدم لأجله */
    if (mode === "loc") OrgCore.groupByLocation(S.tree, null).forEach((g) => {
      S.expanded.add(`g:${g.key}`);
      g.managers.forEach((m) => S.expanded.add(`g:${g.key}|${m.id}`));
    });
    S.overlay.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    const c = S.overlay.querySelector("#ocCanvas");
    if (reduced() || !c.animate) { renderBody(); return; }
    c.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(4px)" }], { duration: 140, easing: "ease-in" })
      .finished.then(() => { renderBody(); c.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "cubic-bezier(.16,.8,.3,1)" }); });
  }

  function toggleAll() {
    const allIds = [...S.tree.nodes.values()].filter((n) => n.children.length).map((n) => n.id);
    const anyClosed = allIds.some((id) => id !== S.tree.rootId && !S.expanded.has(id));
    S.expanded = anyClosed ? new Set(allIds) : new Set();
    renderBody();
  }

  /* ── شجرة العرض: بنية واحدة للوضعين يرسمها راسمٌ واحد ──
     عنصر: { key, id (عقدة حقيقية) أو group {label,count}, kids:[...] } */
  function viewTree() {
    const vis = S.visible;
    const show = (id) => !vis || vis.has(id);
    if (S.mode === "loc") {
      return OrgCore.groupByLocation(S.tree, vis).map((g) => ({
        key: `g:${g.key}`, group: { label: g.label, count: g.count },
        kids: [
          ...g.managers.map((m) => ({ key: `g:${g.key}|${m.id}`, id: m.id, kids: m.members.map((e) => ({ key: `g:${g.key}|${e}`, id: e, kids: [] })) })),
          ...g.direct.map((e) => ({ key: `g:${g.key}|${e}`, id: e, kids: [] })),
        ],
      }));
    }
    const build = (id) => ({ key: id, id, kids: node(id).children.filter(show).map(build) });
    return node(S.tree.rootId).children.filter(show).map(build);
  }

  function renderBody(fromFilter) {
    S.visible = OrgCore.filter(S.tree, { department: S.dept, location: S.loc });
    if (fromFilter && S.visible) node(S.tree.rootId).children.forEach((id) => S.expanded.add(id));
    const c = S.overlay.querySelector("#ocCanvas");
    c.classList.toggle("oc-list-mode", isNarrow());
    const vt = viewTree();
    if (!vt.length) { c.innerHTML = `<div class="oc-empty">لا يوجد موظفون مطابقون للمرشّحات</div>`; return; }
    c.innerHTML = isNarrow() ? renderList(vt) : renderChart(vt);
    hidePop();
    const ch = chartEl();
    if (ch && S.zoom !== 1) ch.style.zoom = String(S.zoom);
    syncZoomUi();
    wireCanvas(c);
    /* شجرة أعرض من السطح: يبدأ العرض من منتصفها لا من طرفها. scrollLeft في
       RTL سالب نحو اليسار، فالإشارة تتبع اتجاه الصفحة. */
    if (!isNarrow() && c.scrollWidth > c.clientWidth) {
      const mid = (c.scrollWidth - c.clientWidth) / 2;
      c.scrollLeft = getComputedStyle(c).direction === "rtl" ? -mid : mid;
    }
    if (S.q) runSearch(false);
    markSelection();
    const first = !S.played && !reduced();
    S.played = true;
    if (first) { c.classList.remove("oc-in"); void c.offsetWidth; c.classList.add("oc-armed"); requestAnimationFrame(() => c.classList.add("oc-in")); }
    else { c.classList.remove("oc-armed"); c.classList.add("oc-in"); }
    const btn = S.overlay.querySelector("#ocToggleAll");
    const closed = [...S.tree.nodes.values()].some((n) => n.children.length && n.id !== S.tree.rootId && !S.expanded.has(n.id));
    btn.textContent = closed ? "توسيع الكل" : "طيّ الكل";
  }

  /* ── الرسم: سطح المكتب واللوحي ── */
  function card(v, depth) {
    if (v.group) {
      return `<div class="oc-card oc-group" role="group"><span class="oc-ico" aria-hidden="true">${icon("pin", 15)}</span>
        <b>${esc(v.group.label)}</b><span class="oc-meta">${esc(OrgCore.countPhrase(v.group.count, "موظف واحد", "موظفان", "موظفين", "موظفًا"))}</span></div>`;
    }
    const n = node(v.id);
    const kids = v.kids.length;
    const isRef = n.kind === "reference";
    const sub = isRef
      ? `<span class="oc-badge ref">عقدة مدير مرجعية</span>`
      : `${n.jobTitle ? `<span class="oc-meta">${esc(n.jobTitle)}</span>` : ""}
         ${n.department ? `<span class="oc-meta oc-dept">${esc(n.department)}</span>` : ""}
         ${n.location ? `<span class="oc-meta oc-loc">${icon("pin", 12)} ${esc(n.location)}</span>` : ""}`;
    const exp = kids ? isOpen(v) : false;
    return `<div class="oc-card${isRef ? " oc-ref" : ""}${n.active === false ? " oc-inactive" : ""}" data-id="${esc(n.id)}" style="--i:${Math.min(depth, 8)}">
      <button type="button" class="oc-hit" data-select="${esc(n.id)}" aria-label="${esc(n.nameAr)}${isRef ? " — عقدة مدير مرجعية" : ""}">
        <span class="oc-av" aria-hidden="true">${esc(initials(n.nameAr))}${photo(n)}</span>
        <span class="oc-txt"><b>${esc(n.nameAr)}</b>${sub}</span>
      </button>
      ${kids ? `<button type="button" class="oc-tog" data-toggle="${esc(v.key)}" aria-expanded="${exp}" aria-label="${exp ? "طيّ" : "فتح"} فريق ${esc(n.nameAr)}">
        <span class="oc-cnt num">${kids}</span>${icon("team", 13)}<svg class="oc-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>` : ""}
    </div>`;
  }
  /* مفتاح الفتح مفتاح العرض لا معرّف العقدة: في وضع المواقع قد يظهر المدير
     تحت أكثر من موقع، ولكلّ ظهور فتحه. المجموعة نفسها مفتوحة دائمًا في الرسم. */
  function isOpen(v) { return !!v.group || S.expanded.has(v.key); }
  function initials(name) { const p = String(name || "").trim().split(/\s+/); return (p[0] || "").slice(0, 1) + ((p[1] || "").slice(0, 1) || ""); }
  /* صورة الموظف فوق أحرفه الأولى، يقدّمها المُضيف (opts.photoImg) — هذا
     الملف لا يجلب شيئًا بنفسه. عقدة المدير المرجعية لا سجلّ لها فلا صورة:
     تبقى أحرفها الأولى مهما أعاد المُضيف. */
  function photo(n) {
    if (!n || n.kind !== "employee" || !S.opts || typeof S.opts.photoImg !== "function") return "";
    return S.opts.photoImg(n) || "";
  }

  function stack(v, depth) {
    if (!v.kids.length) return "";
    const exp = isOpen(v);
    return `<div class="oc-kids" data-kids="${esc(v.key)}"${exp ? "" : " hidden"}>${v.kids.map((k, i) =>
      `<div class="oc-branch" data-branch="${esc(k.id || k.key)}" style="--j:${Math.min(i, 10)}">${card(k, depth + 1)}${stack(k, depth + 1)}</div>`).join("")}</div>`;
  }

  function renderChart(vt) {
    const rootCard = S.mode === "loc"
      ? `<div class="oc-card oc-root"><span class="oc-ico" aria-hidden="true">${icon("pin", 16)}</span><b>${esc(ROOT_LABEL)}</b><span class="oc-meta">حسب المواقع</span></div>`
      : `<div class="oc-card oc-root"><span class="oc-ico" aria-hidden="true">${icon("org", 16)}</span><b>${esc(ROOT_LABEL)}</b><span class="oc-meta">${esc(OrgCore.countPhrase(S.stats.employees, "موظف واحد", "موظفان", "موظفين", "موظفًا"))}</span></div>`;
    return `<div class="oc-chart">
      <div class="oc-root-wrap">${rootCard}</div>
      <div class="oc-cols">${vt.map((v, i) => `<div class="oc-col oc-branch" data-branch="${esc(v.id || v.key)}" style="--c:${i}">${card(v, 1)}${stack(v, 1)}</div>`).join("")}</div>
    </div>`;
  }

  /* ── الرسم: الجوال — قائمة متدرّجة من flattenForList ── */
  function renderList(vt) {
    /* الوضع الهرمي يمرّ بـ flattenForList مباشرة؛ وضع المواقع يُسطَّح من
       شجرة العرض بالقاعدة نفسها (أبناء المفتوح وحده). */
    let rows;
    if (S.mode === "tree") {
      rows = OrgCore.flattenForList(S.tree, S.expanded, S.visible).map((r) => ({ ...r, key: r.id }));
    } else {
      rows = [];
      const walk = (v, depth) => {
        const open = S.expanded.has(v.key);
        rows.push({ key: v.key, id: v.id, group: v.group, depth, hasChildren: v.kids.length > 0, expanded: open, size: v.kids.length });
        if (open) v.kids.forEach((k) => walk(k, depth + 1));
      };
      vt.forEach((v) => walk(v, 0));
    }
    return `<ul class="oc-list" role="tree" aria-label="الهيكل التنظيمي">${rows.map((r, i) => {
      const n = r.id ? node(r.id) : null;
      const title = r.group ? r.group.label : n.nameAr;
      const meta = r.group ? OrgCore.countPhrase(r.group.count, "موظف واحد", "موظفان", "موظفين", "موظفًا")
        : n.kind === "reference" ? "عقدة مدير مرجعية" : [n.department, n.location].filter(Boolean).join(" · ");
      return `<li role="treeitem" aria-level="${r.depth + 1}" ${r.hasChildren ? `aria-expanded="${r.expanded}"` : ""} class="oc-row${r.group ? " oc-row-group" : ""}${n && n.kind === "reference" ? " oc-ref" : ""}" data-id="${esc(r.id || "")}" style="--d:${r.depth};--i:${Math.min(i, 12)}">
        ${r.hasChildren ? `<button type="button" class="oc-tog" data-toggle="${esc(r.key)}" aria-label="${r.expanded ? "طيّ" : "فتح"} ${esc(title)}"><svg class="oc-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>` : `<span class="oc-tog-sp" aria-hidden="true"></span>`}
        ${n ? `<span class="oc-av ep-av oc-row-av" aria-hidden="true">${esc(initials(title))}${photo(n)}</span>` : ""}
        ${r.id ? `<button type="button" class="oc-row-hit" data-select="${esc(r.id)}"><b>${esc(title)}</b><span>${esc(meta)}</span></button>`
          : `<span class="oc-row-hit"><b>${esc(title)}</b><span>${esc(meta)}</span></span>`}
        ${r.hasChildren ? `<span class="oc-cnt num">${r.size}</span>` : ""}
      </li>`;
    }).join("")}</ul>`;
  }

  /* ── الربط ── */
  function wireCanvas(c) {
    c.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", (ev) => { ev.stopPropagation(); toggle(b.dataset.toggle, b); }));
    c.querySelectorAll("[data-select]").forEach((b) => {
      b.addEventListener("click", () => { hidePop(); select(b.dataset.select); });
      if (!isNarrow()) {
        b.addEventListener("pointerenter", (ev) => {
          hoverPath(b.dataset.select, true);
          if (ev.pointerType === "mouse" && canHover() && !c.classList.contains("panning")) showPop(b.dataset.select, b.closest(".oc-card"));
        });
        b.addEventListener("pointerleave", () => { hoverPath(b.dataset.select, false); hidePop(); });
        b.addEventListener("focus", () => hoverPath(b.dataset.select, true));
        b.addEventListener("blur", () => hoverPath(b.dataset.select, false));
      }
    });
  }

  /* توسيع/طيّ بحركة ارتفاع عبر Web Animations API. */
  function toggle(key, btn) {
    const opening = !S.expanded.has(key);
    if (opening) S.expanded.add(key); else S.expanded.delete(key);
    const c = S.overlay.querySelector("#ocCanvas");
    if (isNarrow()) { renderBody(); const b = c.querySelector(`[data-toggle="${CSS.escape(key)}"]`); if (b) b.focus({ preventScroll: true }); return; }
    const kids = c.querySelector(`[data-kids="${CSS.escape(key)}"]`);
    btn.setAttribute("aria-expanded", String(opening));
    if (!kids) return;
    if (reduced() || !kids.animate) { kids.hidden = !opening; return; }
    /* القصّ أثناء حركة الارتفاع وحدها — بعدها يعود مرئيًا كي لا تُقصّ بدايات الخطوط */
    kids.style.overflow = "hidden";
    const unclip = () => { kids.style.overflow = ""; };
    if (opening) {
      kids.hidden = false;
      const h = kids.scrollHeight;
      kids.animate([{ height: "0px" }, { height: `${h}px` }], { duration: 300, easing: "cubic-bezier(.22,.8,.26,1)" }).finished.then(unclip, unclip);
      kids.querySelectorAll(":scope > .oc-branch").forEach((b, i) =>
        b.animate([{ opacity: 0, transform: "translateY(-8px) scale(.98)" }, { opacity: 1, transform: "none" }],
          { duration: 260, delay: 70 + i * 40, easing: "cubic-bezier(.16,.8,.3,1)", fill: "backwards" }));
    } else {
      /* الطيّ عكس الفتح: يخفت الأبناء من الأسفل أوّلًا ثم ينطوي الارتفاع */
      const branches = [...kids.querySelectorAll(":scope > .oc-branch")].reverse();
      branches.forEach((b, i) => b.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-4px)" }],
        { duration: 140, delay: i * 25, easing: "ease-in", fill: "forwards" }));
      const h = kids.scrollHeight;
      kids.animate([{ height: `${h}px` }, { height: "0px" }], { duration: 240, delay: 60 + branches.length * 15, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" })
        .finished.then(() => {
          unclip();
          if (!S.expanded.has(key)) kids.hidden = true;
          kids.getAnimations().forEach((a) => a.cancel());
          branches.forEach((b) => b.getAnimations().forEach((a) => a.cancel()));
        }, unclip);
    }
  }

  function hoverPath(id, on) {
    const c = S.overlay.querySelector("#ocCanvas");
    const path = new Set(OrgCore.ancestors(S.tree, id));
    const reports = new Set(node(id).children);
    c.querySelectorAll(".oc-card[data-id]").forEach((el) => {
      const nid = el.dataset.id;
      el.classList.toggle("oc-hl-path", on && path.has(nid));
      el.classList.toggle("oc-hl-report", on && reports.has(nid));
      el.classList.toggle("oc-hl-self", on && nid === id);
    });
    c.querySelectorAll(".oc-branch[data-branch]").forEach((el) => {
      const bid = el.dataset.branch;
      el.classList.toggle("oc-hl-line", on && (bid === id || path.has(bid)));
    });
  }

  /* ── البحث ── */
  function runSearch(scroll) {
    const res = OrgCore.search(S.tree, S.q);
    const hitsEl = S.overlay.querySelector("#ocHits");
    const c = S.overlay.querySelector("#ocCanvas");
    const visibleHits = res.matches.filter((id) => !S.visible || S.visible.has(id));
    S.hits = visibleHits;
    S.hitIdx = 0;
    hitsEl.textContent = S.q ? (visibleHits.length ? `${visibleHits.length} نتيجة` : "لا نتائج") : "";
    if (!S.q) { c.querySelectorAll(".oc-match,.oc-on-path").forEach((e) => e.classList.remove("oc-match", "oc-on-path")); return; }
    /* افتح الفروع اللازمة: في الوضع الهرمي مفاتيح العرض هي معرّفات العقد؛
       وفي وضع المواقع تُفتح المجموعة والمدير الحاملان للنتيجة. */
    let need = false;
    if (S.mode === "tree") res.expand.forEach((id) => { if (!S.expanded.has(id)) { S.expanded.add(id); need = true; } });
    else visibleHits.forEach((id) => {
      const n = node(id), g = `g:${n.locKey || "—"}`;
      [g, `${g}|${n.parent}`].forEach((k) => { if (!S.expanded.has(k)) { S.expanded.add(k); need = true; } });
    });
    if (need) { renderBody(); return; }
    c.querySelectorAll("[data-id]").forEach((el) => {
      el.classList.toggle("oc-match", visibleHits.includes(el.dataset.id));
      el.classList.toggle("oc-on-path", !visibleHits.includes(el.dataset.id) && res.paths.has(el.dataset.id));
    });
    c.querySelectorAll(".oc-branch[data-branch]").forEach((el) => el.classList.toggle("oc-hl-line", res.paths.has(el.dataset.branch)));
    if (scroll && visibleHits.length) focusHit(0);
  }
  function focusHit(k) {
    const id = S.hits[k];
    const el = S.overlay.querySelector(`#ocCanvas [data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center", inline: "center" });
  }
  function nextHit() { if (!S.hits.length) return; S.hitIdx = (S.hitIdx + 1) % S.hits.length; focusHit(S.hitIdx); }

  /* ── التحديد ولوحة التفاصيل ── */
  function select(id, opts) {
    if (!S.tree.nodes.has(id)) return;
    S.selected = id;
    if (opts && opts.reveal) {
      let changed = false;
      if (S.mode === "tree") OrgCore.ancestors(S.tree, id).forEach((a) => { if (!S.expanded.has(a)) { S.expanded.add(a); changed = true; } });
      else { const n = node(id); const g = `g:${n.locKey || "—"}`; [g, `${g}|${n.parent}`].forEach((k) => { if (!S.expanded.has(k)) { S.expanded.add(k); changed = true; } }); }
      if (S.visible && !S.visible.has(id)) { S.dept = ""; S.loc = ""; S.overlay.querySelector("#ocDept").value = ""; S.overlay.querySelector("#ocLoc").value = ""; changed = true; }
      if (changed) renderBody();
      const el = S.overlay.querySelector(`#ocCanvas [data-id="${CSS.escape(id)}"]`);
      if (el) el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center", inline: "center" });
    }
    markSelection();
    renderPanel(id);
  }
  function markSelection() {
    if (!S.overlay) return;
    S.overlay.querySelectorAll("#ocCanvas [data-id]").forEach((el) => el.classList.toggle("oc-selected", el.dataset.id === S.selected));
  }
  function closePanel() {
    const p = S.overlay.querySelector("#ocPanel");
    p.classList.remove("show");
    const done = () => { p.hidden = true; };
    if (reduced()) done(); else setTimeout(done, 220);
    const prev = S.selected;
    S.selected = null;
    markSelection();
    const btn = prev && S.overlay.querySelector(`#ocCanvas [data-select="${CSS.escape(prev)}"]`);
    if (btn) btn.focus({ preventScroll: true });
  }

  function row(k, v) { return v == null || v === "" ? "" : `<div class="oc-dr"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`; }
  function personLink(id) {
    const n = node(id);
    return `<button type="button" class="oc-plink" data-goto="${esc(id)}">${esc(n.nameAr)}${n.kind === "reference" ? ' <em>مرجعية</em>' : ""}</button>`;
  }

  function renderPanel(id) {
    const n = node(id);
    const p = S.overlay.querySelector("#ocPanel");
    const isRef = n.kind === "reference";
    const parent = n.parent && n.parent !== S.tree.rootId ? n.parent : null;
    const path = OrgCore.pathOf(S.tree, id).map((pid) => esc(node(pid).nameAr)).join(' <span class="oc-sep">←</span> ');
    const linkIdx = S.link.links.get(id);
    const ambiguous = S.link.ambiguous.includes(id);
    const reports = n.children;
    let body;
    if (isRef) {
      const locs = teamFacet(n, "location"), depts = teamFacet(n, "department");
      body = `
        <div class="oc-note warn">${icon("link", 15)} سجل المدير غير مربوط بموظف حالي. الاسم كما ورد في عمود «المدير المباشر» فقط — لا بريد ولا مسمّى ولا موقع له في المصدر.</div>
        <div class="oc-dl">
          ${row("الاسم في المصدر", esc(n.nameAr))}
          ${row("عدد التابعين المباشرين", esc(reportsPhrase(reports.length)))}
          ${row("مواقع فريقه", esc(locs.join("، ")))}
          ${row("أقسام فريقه", esc(depts.join("، ")))}
        </div>`;
    } else {
      body = `
        <div class="oc-dl">
          ${row("الحالة", n.status ? `<span class="oc-status ${n.active ? "ok" : "na"}">${esc(n.status)}</span>` : null)}
          ${row("الاسم بالإنجليزية", n.nameEn ? `<span dir="ltr">${esc(n.nameEn)}</span>` : null)}
          ${row("المسمّى الوظيفي", n.jobTitle ? esc(n.jobTitle) : null)}
          ${row("القسم", n.department ? esc(n.department) : null)}
          ${row("الموقع", n.location ? esc(n.location) : null)}
          ${row("المدير المباشر", parent ? personLink(parent) : n.managerName ? esc(n.managerName) : "غير محدّد في المصدر")}
          ${row("عدد التابعين المباشرين", esc(reportsPhrase(reports.length)))}
          ${row("البريد الإلكتروني", n.email ? `<span dir="ltr">${esc(n.email)}</span>` : null)}
          ${row("المرجع في المصدر", n.row ? `الصفّ ${n.row}` : null)}
        </div>
        ${linkIdx != null
          ? `<button type="button" class="oc-cta oc-open-emp" data-emp="${linkIdx}">${icon("user", 15)} فتح ملف الموظف في المنصّة</button>`
          : `<div class="oc-note">${ambiguous ? "البريد يطابق أكثر من سجلّ في المنصّة — لم يُربط تلقائيًا." : "لا يوجد سجلّ في المنصّة بالبريد نفسه."}</div>`}`;
    }
    p.innerHTML = `
      <div class="oc-p-head">
        <button type="button" class="oc-x" data-close aria-label="إغلاق التفاصيل">✕</button>
        <span class="oc-badge ${isRef ? "ref" : "emp"}">${isRef ? "عقدة مدير مرجعية" : "موظف"}</span>
        <div class="oc-p-who${isRef ? " oc-ref" : ""}">
          <span class="oc-av ep-av oc-p-av" aria-hidden="true">${esc(initials(n.nameAr))}${photo(n)}</span>
          <h3>${esc(n.nameAr)}</h3>
        </div>
        <div class="oc-path">${path}</div>
      </div>
      <div class="oc-p-body">
        ${body}
        ${reports.length ? `<div class="oc-p-sec"><div class="gt">التابعون المباشرون</div><div class="oc-plist">${reports.map(personLink).join("")}</div></div>` : ""}
      </div>`;
    p.hidden = false;
    requestAnimationFrame(() => p.classList.add("show"));
    p.querySelector("[data-close]").addEventListener("click", closePanel);
    p.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => select(b.dataset.goto, { reveal: true })));
    const openEmp = p.querySelector(".oc-open-emp");
    if (openEmp) openEmp.addEventListener("click", () => { close(); S.opts.openEmployee(Number(openEmp.dataset.emp)); });
    p.querySelector("[data-close]").focus({ preventScroll: true });
  }

  const OrgChart = { mount, open, close };
  root.OrgChart = OrgChart;
})(window);
