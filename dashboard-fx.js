/* dashboard-fx.js — الحركة والتفاعل فوق لوحة المؤشّرات الحالية.
   =========================================================================
   لا يحسب هذا الملف أي رقم من عنده: البطاقات والحلقات تأتيه مرسومة
   بأرقامها النهائية من app-shell.html. الدور هنا عرضيّ محض — عدّ، ورسم من
   الصفر، وتلميح، ونقر. قسم الوثائق القادمة على الانتهاء في doc-expiry.js.

   الحركة مرّة واحدة لكل عنصر: renderDashboardTop() يُعاد بعد كل تعديل
   موظف، وإعادة العدّ من الصفر عند كل حفظ ضجيج. المرّات اللاحقة تُرسم
   بالقيمة النهائية مباشرة.

   سكربت كلاسيكي → DashFx في النطاق العام؛ والدوالّ النقيّة تُختبر عبر
   require. */
(function (root) {
  "use strict";

  const Mo = (typeof Motion !== "undefined" && Motion) || (typeof require === "function" ? require("./motion.js") : null);
  const played = new Set(); // ما تحرّك مرّة — مفتاحه معرّف العنصر

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ── أيقونات البطاقات (خطّية، تتبع لون النصّ) ── */
  const ICONS = {
    people: '<path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="7.5" r="3.5"/><path d="M20 19v-1.3a3 3 0 0 0-2.2-2.9M15.5 4.3a3.5 3.5 0 0 1 0 6.4"/>',
    shield: '<path d="M12 3l7 3v5.5c0 4.3-3 7.8-7 9.5-4-1.7-7-5.2-7-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    hourglass: '<path d="M7 3h10M7 21h10"/><path d="M17 3v3.6a5 5 0 0 1-5 5 5 5 0 0 1-5-5V3"/><path d="M7 21v-3.6a5 5 0 0 1 5-5 5 5 0 0 1 5 5V21"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    org: '<rect x="9" y="3" width="6" height="5" rx="1.2"/><rect x="3" y="16" width="6" height="5" rx="1.2"/><rect x="15" y="16" width="6" height="5" rx="1.2"/><path d="M12 8v4M6 16v-2h12v2"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    team: '<circle cx="8" cy="9" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M2.5 19a5.5 5.5 0 0 1 11 0M14 19a4.5 4.5 0 0 1 7.5-3.4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  };
  function icon(name, size) {
    const s = size || 18;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
  }

  /* «موظف واحد / موظفان / ٣ موظفين / ١١ موظفًا» */
  function employeesPhrase(n) {
    if (n === 1) return "موظف واحد";
    if (n === 2) return "موظفان";
    if (n >= 3 && n <= 10) return `${n} موظفين`;
    return `${n} موظفًا`;
  }
  function daysPhrase(n) {
    const a = Math.abs(n);
    if (n === 0) return "تنتهي اليوم";
    /* «منذ» تجرّ المثنّى: «منذ يومين» لا «منذ يومان» */
    const two = n < 0 ? "يومين" : "يومان";
    const unit = a === 1 ? "يوم واحد" : a === 2 ? two : a <= 10 ? `${a} أيام` : `${a} يومًا`;
    return n < 0 ? `منتهية منذ ${unit}` : `متبقٍّ ${unit}`;
  }
  const pct = (n, total) => (total ? ((n / total) * 100).toFixed(1) : "0.0");

  /* ── التلميح المشترك ── */
  let tipEl = null;
  function tip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement("div");
    tipEl.className = "fx-tip";
    tipEl.setAttribute("role", "tooltip");
    tipEl.id = "fxTip";
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function showTip(html, anchor, evt) {
    const t = tip();
    t.innerHTML = html;
    t.classList.add("show");
    const r = anchor.getBoundingClientRect();
    const x = evt && evt.clientX ? evt.clientX : r.left + r.width / 2;
    const y = evt && evt.clientY ? evt.clientY : r.top;
    const w = t.offsetWidth, h = t.offsetHeight;
    const left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
    const top = y - h - 14 < 8 ? y + 18 : y - h - 14;
    t.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }
  function hideTip() { if (tipEl) tipEl.classList.remove("show"); }

  /* ── البطاقات: عدّ تصاعدي عند الظهور، مرّة واحدة ── */
  function kpis(row) {
    if (!row || !Mo) return;
    const first = !played.has("kpis");
    played.add("kpis");
    const cards = [...row.querySelectorAll(".kpi")];
    cards.forEach((c, i) => { c.style.setProperty("--i", String(i)); if (first) c.classList.add("m-card-enter"); });
    if (!first) return;
    Mo.onVisible(row, () => {
      cards.forEach((c) => c.classList.add("m-in"));
      row.querySelectorAll(".big[data-count]").forEach((el) => Mo.countUp(el, Number(el.dataset.count), { duration: 700 }));
    });
  }

  /* ── الحلقة: ترسم نفسها من الصفر، والرقم في المنتصف يعدّ ──
     الأقواس تأتي جاهزة بأطوالها النهائية (data-len)؛ هنا تُصفَّر ثم
     تُعاد إلى طولها فيتكفّل transition بالرسم. */
  function ring(box, opts) {
    if (!box) return;
    const o = opts || {};
    const arcs = [...box.querySelectorAll(".ring-arc")];
    const center = box.querySelector(".chart-center .n");
    const key = `ring:${box.id}`;
    const first = !played.has(key) && Mo && !Mo.prefersReduced();
    played.add(key);
    if (first) {
      /* مخفيّة حتى الرسم: قوسٌ بطول صفر بنهاية مستديرة يظهر نقطةً شاردة */
      arcs.forEach((a) => { a.setAttribute("stroke-dasharray", `0 ${o.circ}`); a.style.opacity = "0"; });
      if (center) center.textContent = "0";
      Mo.onVisible(box, () => requestAnimationFrame(() => {
        arcs.forEach((a) => { const len = Number(a.dataset.len); a.style.opacity = ""; a.setAttribute("stroke-dasharray", `${len} ${o.circ - len}`); });
        if (center) Mo.countUp(center, Number(center.dataset.count), { duration: 700 });
      }));
    }
    const subject = o.subject || "";
    arcs.forEach((a) => {
      const n = Number(a.dataset.n), label = a.dataset.label, pickable = !!(a.dataset.pick && o.onPick);
      const title = /^جاري/.test(label) ? `${subject} — ${label}` : `${subject} ${label}`;
      const html = `<b>${esc(title)}</b><span>${employeesPhrase(n)}</span><span class="fx-tip-sub">${pct(n, o.total)}% من الموظفين</span>${pickable ? '<span class="fx-tip-act">اضغط لعرضهم في سجلّ الموظفين</span>' : ""}`;
      a.setAttribute("tabindex", "0");
      a.setAttribute("role", pickable ? "button" : "img");
      a.setAttribute("aria-label", `${title}: ${employeesPhrase(n)}، ${pct(n, o.total)}% من الموظفين`);
      if (pickable) a.classList.add("pickable");
      const on = (ev) => { box.classList.add("has-hot"); a.classList.add("hot"); showTip(html, a, ev); };
      const off = () => { box.classList.remove("has-hot"); a.classList.remove("hot"); hideTip(); };
      a.addEventListener("pointerenter", on);
      a.addEventListener("pointermove", (ev) => showTip(html, a, ev));
      a.addEventListener("pointerleave", off);
      a.addEventListener("focus", () => on(null));
      a.addEventListener("blur", off);
      a.addEventListener("click", (ev) => {
        if (pickable) { off(); o.onPick(a.dataset.pick); }
        else on(ev); // اللمس: النقرة تُظهر التلميح
      });
      a.addEventListener("keydown", (ev) => {
        if (pickable && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); off(); o.onPick(a.dataset.pick); }
      });
    });
  }

  if (typeof window !== "undefined") {
    window.addEventListener("scroll", hideTip, { passive: true });
    /* التسليح عند التحميل: قبله لا يُخفى شيء، ومع تقليل الحركة لا يحدث أبدًا. */
    if (Mo && typeof document !== "undefined") Mo.arm(document);
  }

  const DashFx = { icon, kpis, ring, employeesPhrase, daysPhrase, showTip, hideTip, esc };
  if (typeof module !== "undefined" && module.exports) module.exports = DashFx;
  else root.DashFx = DashFx;
})(typeof window !== "undefined" ? window : globalThis);
