/* municipal-cards.js — قسم «البطاقات البلدية» في الصفحة الرئيسية.
   =========================================================================
   سكربت كلاسيكي → MunicipalCards في النطاق العام، على نمط org-chart.js:
   يجلب بياناته بنفسه بعد بيانات الموظفين، ولا يعطّل غيره إن فشل.

   البطاقة المعروضة هي وجه الشهادة الأصلي مرسومًا من ملفّ الأمانة نفسه
   (شعارها وصورتها ورمزها ونصوصها كما هي) — المنصّة تصمّم ما حولها فقط.
   والرمز في النافذة المكبّرة هو صورة QR الأصلية من الملفّ نفسه.

   الربط بالموظف بـemployeeEid (employees.eid = «الرقم الوظيفي») الذي حُسم
   عند الاستيراد برقم الإقامة — لا بالاسم.

   الصورتان تُطلبان بالمعرّف العشوائي cardId من /api/files/municipal-card-image
   و /api/files/municipal-qr، وكلاهما يعيد فحص الجلسة وmunicipal:view من متجر
   خاصّ. لا رابط تخزين ولا رابط الرمز في أي استجابة JSON. */
(function (root) {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const S = { items: [], opts: null, q: "", status: "", dept: "", showAll: false, popModal: null };
  /* صفّان على الشاشة العريضة قبل «عرض الكل»، كما في المرجع. */
  const PREVIEW_COUNT = 8;
  const ID_RE = /^[0-9a-f]{16}$/;

  const ICON = {
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M7 12h10"/>',
    download: '<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  };
  const icon = (n, s) => `<svg width="${s || 16}" height="${s || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

  /* ── الحالة — من تاريخ الانتهاء الحقيقي، محسوبة عند كل تحميل ──
     الشهادة نفسها تنصّ على تجديدها قبل انتهائها بثلاثين يومًا، فالثلاثون
     الأخيرة حمراء (وقت التجديد)، والثلاثون التي قبلها كهرمانية للتنبيه. */
  const RENEW_DAYS = 30, NOTICE_DAYS = 60;
  function daysUnit(a) { return a === 1 ? "يوم واحد" : a === 2 ? "يومين" : a <= 10 ? `${a} أيام` : `${a} يومًا`; }
  function statusOf(item) {
    const n = item.expiryDate ? daysLeft(item.expiryDate) : null;
    if (n === null) return { key: "na", cls: "na", n, label: "تاريخ الانتهاء غير متاح", icon: "clock" };
    if (n < 0) return { key: "bad", cls: "bad", n, label: "منتهية", icon: "alert" };
    if (n === 0) return { key: "bad", cls: "bad", n, label: "ينتهي اليوم", icon: "alert" };
    if (n <= RENEW_DAYS) return { key: "warn", cls: "bad", n, label: `ينتهي خلال ${daysUnit(n)}`, icon: "alert" };
    if (n <= NOTICE_DAYS) return { key: "warn", cls: "warn", n, label: `ينتهي خلال ${daysUnit(n)}`, icon: "clock" };
    return { key: "ok", cls: "ok", n, label: "سارية", icon: "check" };
  }

  function employeeOf(item) {
    const o = S.opts;
    if (!o || !item.employeeEid) return null;
    const i = (o.platform || []).findIndex((e) => String(e[o.F.damanah]) === String(item.employeeEid));
    return i < 0 ? null : { i, e: o.platform[i] };
  }

  /* الاسم والمسمّى من سجلّ المنصّة؛ ومن لا يملك عرض سجلّ الموظفين يرى ما
     طُبع على الشهادة نفسها. */
  function personOf(it) {
    const m = employeeOf(it);
    const o = S.opts;
    return { m, name: (m && m.e[o.F.name]) || it.nameOnCard || "", role: (m && m.e[o.F.job]) || it.occupation || "" };
  }

  /* «تجديد المستند» بصلاحية municipal:manage — منفصلة عن العرض. */
  const canRenew = () => !!root.DocRenewal && AdminUI.can("municipal", "manage");

  function openRenew(cardId) {
    const it = S.items.find((x) => x.cardId === cardId);
    if (!it) return;
    const p = personOf(it);
    root.DocRenewal.open({
      kind: "municipal", id: it.cardId, employeeName: p.name,
      currentNumber: it.certificateNumber, currentExpiry: it.expiryDate, history: it.history,
      statusOf: (iso) => { const st = statusOf({ expiryDate: iso }); return { label: st.label, cls: st.cls }; },
      onSuccess: (item) => applyRenewed(item),
    });
  }

  /* البطاقة تتحدّث في مكانها بلا إعادة تحميل: الحقول الجديدة، والإصدار
     الجديد يكسر ذاكرة صورتي الوجه والرمز. */
  function applyRenewed(item) {
    if (!item || !ID_RE.test(String(item.cardId || ""))) return;
    const i = S.items.findIndex((x) => x.cardId === item.cardId);
    if (i < 0) return;
    S.items[i] = item;
    fillDepartments();
    render();
    const el = S.opts.grid.querySelector(`[data-card="${item.cardId}"]`);
    if (el && root.DocRenewal) root.DocRenewal.flash(el);
  }

  const cardUrl = (it) => `/api/files/municipal-card-image?id=${it.cardId}&v=${encodeURIComponent(it.version || "")}`;
  const qrUrl = (it, dl) => `/api/files/municipal-qr?id=${it.cardId}&v=${encodeURIComponent(it.version || "")}${dl ? "&download=1" : ""}`;

  function tile(it, idx) {
    const st = statusOf(it);
    const p = personOf(it);
    return `
      <article class="mc-tile" style="animation-delay:${Math.min(idx * 40, 320)}ms" data-card="${it.cardId}">
        <div class="mc-tile-head">
          <span class="mc-status ${st.cls}">${icon(st.icon, 15)}<span>${esc(st.label)}</span></span>
        </div>
        <div class="mc-cert">
          <img class="mc-cert-img" src="${cardUrl(it)}" width="605" height="950" loading="lazy" decoding="async" draggable="false"
            alt="الشهادة الصحية رقم ${esc(it.certificateNumber)}${p.name ? ` — ${esc(p.name)}` : ""}">
        </div>
        <div class="mc-who">
          ${p.m ? `<button type="button" class="mc-name" data-open-emp="${p.m.i}" title="فتح ملف الموظف">${esc(p.name)}</button>` : `<div class="mc-name is-static">${esc(p.name || "—")}</div>`}
          ${p.role ? `<div class="mc-role">${esc(p.role)}</div>` : ""}
        </div>
        ${it.hasQr ? `<button type="button" class="mc-qr-btn" data-qr="${it.cardId}" aria-label="عرض الباركود الخاص بـ${esc(p.name || it.certificateNumber)}">
          <span>عرض الباركود</span>${icon("qr", 20)}</button>` : `<div class="mc-qr-btn is-empty">لا يوجد باركود في الملف</div>`}
        ${canRenew() ? root.DocRenewal.buttonHtml("municipal", it.cardId, p.name) : ""}
      </article>`;
  }

  /* ── التصفية ── */
  function matches(it) {
    if (S.status && statusOf(it).key !== S.status) return false;
    if (S.dept && personOf(it).role !== S.dept) return false;
    const q = S.q.trim().toLowerCase();
    if (!q) return true;
    const p = personOf(it);
    const o = S.opts;
    const hay = [p.name, it.nameOnCard, it.certificateNumber, it.occupation, it.employeeEid, p.m && p.m.e[o.F.iqama]]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }

  function render() {
    DIAG.renders++;
    DIAG.inRender = true;
    try { renderInner(); } finally {
      /* سجلّات الحذف التي أنتجها render() نفسه تُستهلك هنا، فلا يُحسب
         استبدال الشبكة الطبيعي «حذفًا بعد الرسم». */
      if (DIAG.obs) DIAG.obs.takeRecords();
      DIAG.inRender = false;
    }
    diag();
  }
  function renderInner() {
    const o = S.opts;
    const all = S.items;
    const filtered = all.filter(matches);
    const filtering = !!(S.q.trim() || S.status || S.dept);
    const shown = S.showAll || filtering ? filtered : filtered.slice(0, PREVIEW_COUNT);
    o.idx.textContent = all.length ? `${filtered.length} من ${all.length}` : "";

    /* «عرض الكل» يظهر حين يخفي المعاينة شيئًا أو حين توجد تصفية تُلغى. */
    if (o.allBtn) {
      const hidden = !filtering && !S.showAll && filtered.length > PREVIEW_COUNT;
      o.allBtn.style.display = hidden || filtering ? "" : "none";
      o.allBtn.querySelector("span").textContent = filtering ? "إلغاء التصفية" : "عرض الكل";
    }

    if (!all.length) {
      o.grid.innerHTML = `<div class="mc-empty">${icon("qr", 28)}<p>لا توجد بطاقات بلدية مسجّلة بعد.</p></div>`;
      return;
    }
    o.grid.innerHTML = shown.length ? shown.map(tile).join("") : `<div class="mc-empty"><p>لا توجد بطاقات مطابقة</p></div>`;
  }

  function fillDepartments() {
    const sel = S.opts.dept;
    const list = [...new Set(S.items.map((it) => personOf(it).role).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));
    sel.innerHTML = `<option value="">جميع الأقسام</option>` + list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    sel.value = list.includes(S.dept) ? S.dept : "";
    S.dept = sel.value;
  }

  /* ── نافذة الباركود — صورة الرمز الأصلية من الملفّ ── */
  function openQr(cardId) {
    const it = S.items.find((x) => x.cardId === cardId);
    if (!it || !it.hasQr) return;
    closeQr();
    const p = personOf(it);
    const scrim = document.createElement("div");
    scrim.className = "mc-scrim";
    scrim.innerHTML = `
      <div class="mc-modal" role="dialog" aria-modal="true" aria-labelledby="mcQrTitle">
        <div class="mc-modal-head">
          <h3 id="mcQrTitle">الباركود الخاص بالموظف</h3>
          <button type="button" class="mc-x" data-close aria-label="إغلاق">${icon("close", 20)}</button>
        </div>
        <div class="mc-modal-body">
          <div class="mc-qr-big"><img src="${qrUrl(it)}" alt="رمز QR للشهادة الصحية ${esc(it.certificateNumber)}"></div>
          <div class="mc-modal-who">
            <b>${esc(p.name)}</b>
            ${p.role ? `<span>${esc(p.role)}</span>` : ""}
          </div>
          <div class="mc-hint">${icon("scan", 26)}<span>يمكن مسح هذا الباركود باستخدام الهاتف لعرض بيانات الشهادة الصحية</span></div>
          <a class="mc-dl" href="${qrUrl(it, true)}" download="municipal-card-${esc(it.certificateNumber)}-QR.png">${icon("download", 18)}<span>تحميل الباركود</span></a>
        </div>
      </div>`;
    document.body.appendChild(scrim);
    requestAnimationFrame(() => scrim.classList.add("show"));
    const close = () => closeQr();
    scrim.addEventListener("click", (ev) => { if (ev.target === scrim || ev.target.closest("[data-close]")) close(); });
    S.modal = scrim;
    S.popModal = AdminUI.pushLayer(scrim.querySelector(".mc-modal"), close, { noAutofocus: true });
    setTimeout(() => { const b = scrim.querySelector("[data-close]"); if (b) b.focus({ preventScroll: true }); }, 60);
  }
  function closeQr() {
    const scrim = S.modal;
    if (!scrim) return;
    S.modal = null;
    const pop = S.popModal;
    S.popModal = null;
    scrim.classList.remove("show");
    setTimeout(() => scrim.remove(), 300);
    if (pop) pop();
  }

  async function reload() {
    try {
      const j = await AdminUI.api("GET", "/api/data/municipal-cards");
      S.items = (j.items || []).filter((it) => it && ID_RE.test(String(it.cardId || "")));
    } catch (err) {
      S.items = [];
      S.opts.grid.innerHTML = `<div class="mc-empty"><p>تعذّر تحميل البطاقات البلدية.</p></div>`;
      DIAG.loadError = (err && err.message) || "load failed";
      diag();
      return;
    }
    fillDepartments();
    render();
  }

  /* حدث error لا يصعد: بطاقة لم تُحمَّل تُستبدل برسالة هادئة، ورمزٌ لم
     يُحمَّل في النافذة كذلك — لا صورة مكسورة أبدًا. */
  function onImgError(ev) {
    const t = ev.target;
    if (!t || t.tagName !== "IMG") return;
    if (t.classList.contains("mc-cert-img")) t.closest(".mc-cert").innerHTML = `<p class="mc-cert-fail">تعذّر تحميل صورة البطاقة</p>`;
    else if (t.closest(".mc-qr-big")) t.closest(".mc-qr-big").innerHTML = `<p class="mc-qr-fail">تعذّر تحميل الرمز — أعد المحاولة.</p>`;
  }

  function mount(opts) {
    S.opts = opts;
    const o = opts;
    o.grid.addEventListener("click", (ev) => {
      const q = ev.target.closest("[data-qr]");
      if (q) { openQr(q.dataset.qr); return; }
      const rn = ev.target.closest("[data-renew]");
      if (rn) { openRenew(rn.dataset.renewId); return; }
      const emp = ev.target.closest("[data-open-emp]");
      if (emp && o.openEmployee) o.openEmployee(Number(emp.dataset.openEmp));
    });
    if (o.allBtn) o.allBtn.addEventListener("click", () => {
      if (S.q.trim() || S.status || S.dept) {
        S.q = S.status = S.dept = "";
        o.search.value = o.status.value = o.dept.value = "";
      } else {
        S.showAll = true;
      }
      render();
    });
    let t;
    o.search.addEventListener("input", (ev) => { S.q = ev.target.value; clearTimeout(t); t = setTimeout(render, 160); });
    o.status.addEventListener("change", (ev) => { S.status = ev.target.value; render(); });
    o.dept.addEventListener("change", (ev) => { S.dept = ev.target.value; render(); });
    document.addEventListener("error", onImgError, true);
    watchDiag();
    diag();
    return reload();
  }

  /* ⚠️ مؤقّت — شارة تشخيص «تجديد المستند»، تظهر فقط حين يختم الخادم الصفحة
     بـ<meta name="renewal-diag"> (Preview، لا Production). تُزال قبل الدمج.
     تعرض الحالة الحيّة: الـcommit، municipal:manage، تحميل DocRenewal، عدد
     الكروت وأزرار التجديد — وتراقب الشبكة: إن حُذف زرّ بعد الرسم تقول ذلك. */
  const BUILD = "renew-diag-2";
  const DIAG = { removed: 0, renders: 0, lastRenderButtons: 0 };
  function diagMeta() {
    const m = document.querySelector('meta[name="renewal-diag"]');
    return m ? String(m.content || "").split("|") : null;
  }
  function diag() {
    const meta = diagMeta();
    if (!meta) return;
    const sec = document.getElementById("municipalSec");
    if (!sec) return;
    let box = document.getElementById("renewDiag");
    if (!box) {
      box = document.createElement("div");
      box.id = "renewDiag";
      box.setAttribute("dir", "ltr");
      box.style.cssText = "margin:0 0 14px;padding:10px 14px;border:2px dashed #A98544;border-radius:10px;background:#FFF8E8;font:600 13px/1.7 ui-monospace,Menlo,monospace;color:#3a2c0f;overflow-wrap:anywhere";
      sec.insertBefore(box, sec.firstChild);
    }
    const u = AdminUI.getUser && AdminUI.getUser();
    const grid = S.opts && S.opts.grid;
    const tiles = grid ? grid.querySelectorAll(".mc-tile").length : 0;
    const btns = grid ? grid.querySelectorAll("[data-renew]").length : 0;
    box.innerHTML = [
      `<b>Renewal Preview — commit: ${esc(meta[0])}</b> (${esc(meta[1])}) · script: ${BUILD}`,
      `user role: ${esc(u ? u.role : "—")} · municipal:view = ${AdminUI.can("municipal", "view")} · municipal:manage = ${AdminUI.can("municipal", "manage")} · ajeer:manage = ${AdminUI.can("ajeer", "manage")}`,
      `DocRenewal loaded: ${!!root.DocRenewal} · municipal cards: ${tiles} · [data-renew] buttons: ${btns} (items: ${S.items.length}, renders: ${DIAG.renders})`,
      DIAG.loadError ? `<span style="color:#A6382C">⚠ /api/data/municipal-cards: ${esc(DIAG.loadError)}</span>` : "",
      DIAG.removed ? `<span style="color:#A6382C">⚠ renew buttons removed after render: ${DIAG.removed}</span>` : `buttons removed after render: 0`,
    ].filter(Boolean).map((l) => `<div>${l}</div>`).join("");
  }
  function watchDiag() {
    if (!diagMeta() || !S.opts || !S.opts.grid || typeof MutationObserver === "undefined") return;
    DIAG.obs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.removedNodes) {
        if (n.nodeType === 1 && (n.matches("[data-renew]") || (n.querySelector && n.querySelector("[data-renew]")))) {
          /* إزالة خارج render() نفسه = كود آخر يحذف الزرّ. */
          if (!DIAG.inRender) DIAG.removed++;
        }
      }
      clearTimeout(DIAG.t);
      DIAG.t = setTimeout(diag, 60);
    });
    DIAG.obs.observe(S.opts.grid, { childList: true, subtree: true });
  }

  root.MunicipalCards = { mount, statusOf, applyRenewed, _state: S, _diag: DIAG };
})(window);
