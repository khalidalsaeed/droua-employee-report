/* municipal-cards.js — قسم «البطاقات البلدية» في الصفحة الرئيسية.
   =========================================================================
   سكربت كلاسيكي → MunicipalCards في النطاق العام، على نمط org-chart.js:
   يجلب بياناته بنفسه بعد بيانات الموظفين، ولا يعطّل غيره إن فشل.

   كل ما يُعرض مصدره ملفّ الشهادة نفسه (lib/municipal/extractCard.js) —
   لا قيمة مفترضة: حقلٌ لم يُقرأ من الملفّ لا يُرسم سطره أصلًا.

   الربط بسجلّ الموظف برقم الإقامة (كما في تصاريح أجير)، فالاسم تحت
   البطاقة هو اسم المنصّة حين يُطابَق، والبطاقة نفسها تحمل الاسم كما
   طُبع عليها.

   الرمز والصورة يُطلبان من /api/files/municipal-qr و municipal-photo،
   وكلاهما يعيد فحص الجلسة وmunicipal:view؛ نصّ الرمز (رابط التحقّق) لا
   يصل إلى المتصفّح إلا داخل صورة الرمز. */
(function (root) {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const S = { items: [], opts: null, q: "", status: "", dept: "", showAll: false, popModal: null };
  /* صفّان على الشاشة العريضة قبل «عرض الكل»، كما في المرجع. */
  const PREVIEW_COUNT = 8;

  const ICON = {
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M7 12h10"/>',
    download: '<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    shield: '<path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6Z"/><path d="M9 12.5c1-.9 2-1.3 3-1.3s2 .4 3 1.3M12 8v3.2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  };
  const icon = (n, s) => `<svg width="${s || 16}" height="${s || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

  /* ── الحالة ──
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
    if (!o || !item.idNumber) return null;
    const i = (o.platform || []).findIndex((e) => String(e[o.F.iqama] || "").replace(/\D/g, "") === item.idNumber);
    return i < 0 ? null : { i, e: o.platform[i] };
  }

  /* الهجري كما طُبع على الشهادة: يوم/شهر/سنة. */
  const hijriText = (h) => {
    const m = String(h || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  };
  const initialsOf = (name) => {
    const p = String(name || "").trim().split(/\s+/);
    return (p[0] || "").slice(0, 1) + ((p[1] || "").slice(0, 1) || "");
  };
  const qrUrl = (it, dl) => `/api/files/municipal-qr?card=${encodeURIComponent(it.certNo)}${dl ? "&download=1" : ""}`;
  const photoUrl = (it) => `/api/files/municipal-photo?card=${encodeURIComponent(it.certNo)}&v=${encodeURIComponent(it.photoVersion || "")}`;

  /* ── البطاقة ──
     وجه الشهادة نفسها كما تُصدرها الأمانة: الترويسة، الصورة والرمز، عنوان
     «شهادة صحية»، ثم جدول الحقول. السطر الذي لم يُقرأ من الملفّ لا يُرسم. */
  function personOf(it) {
    const m = employeeOf(it);
    const o = S.opts;
    return {
      m,
      name: m ? m.e[o.F.name] : it.name,
      role: (m && m.e[o.F.job]) || it.occupation || "",
    };
  }

  function cardFace(it) {
    const row = (k, v, ltr) => (v ? `<div class="mc-row"><dt>${k}</dt><dd${ltr ? ' class="ltr"' : ""}>${esc(v)}</dd></div>` : "");
    const top = row("رقم الشهادة", it.certNo, true) + row("مكان الاصدار", it.issuer) +
      (it.expiryHijri || it.expiryDate ? `<div class="mc-row"><dt>تاريخ الانتهاء</dt><dd class="ltr" title="${esc(it.expiryDate ? fmtDate(it.expiryDate) : "")}">${esc(hijriText(it.expiryHijri) || fmtDate(it.expiryDate))}</dd></div>` : "");
    const who = row("الاسم", it.name) + row("رقم الهوية", it.idNumber, true) + row("الجنس", it.gender) + row("الجنسية", it.nationality);
    const photo = it.hasPhoto ? `<img class="mc-photo-img" src="${photoUrl(it)}" alt="" loading="lazy" decoding="async" draggable="false">` : "";
    return `
      <div class="mc-cert">
        <div class="mc-cert-head">
          <span class="mc-emblem" aria-hidden="true">${icon("shield", 22)}</span>
          <span class="mc-org"><b>أمانة منطقة الرياض</b><small>RIYADH REGION MUNICIPALITY</small></span>
        </div>
        <div class="mc-cert-media">
          ${it.hasQr ? `<button type="button" class="mc-cert-qr" data-qr="${esc(it.certNo)}" aria-label="تكبير الباركود"><img src="${qrUrl(it)}" alt="" loading="lazy" decoding="async"></button>` : `<span class="mc-cert-qr is-empty" aria-hidden="true"></span>`}
          <span class="mc-photo" aria-hidden="true"><span>${esc(initialsOf(it.name))}</span>${photo}</span>
        </div>
        <div class="mc-cert-title">شهادة صحية</div>
        <dl class="mc-table">
          <div class="mc-group">${top}</div>
          ${who ? `<div class="mc-group">${who}</div>` : ""}
        </dl>
      </div>`;
  }

  function tile(it, idx) {
    const st = statusOf(it);
    const p = personOf(it);
    const canDelete = AdminUI.can("municipal", "delete");
    return `
      <article class="mc-tile" style="animation-delay:${Math.min(idx * 40, 320)}ms" data-card="${esc(it.certNo)}">
        <div class="mc-tile-head">
          <span class="mc-status ${st.cls}">${icon(st.icon, 15)}<span>${esc(st.label)}</span></span>
        </div>
        ${cardFace(it)}
        <div class="mc-who">
          ${p.m ? `<button type="button" class="mc-name" data-open-emp="${p.m.i}" title="فتح ملف الموظف">${esc(p.name)}</button>` : `<div class="mc-name is-static">${esc(p.name || "—")}</div>`}
          ${p.role ? `<div class="mc-role">${esc(p.role)}</div>` : ""}
          ${p.m ? "" : `<div class="mc-unlinked" title="رقم الهوية في الشهادة لا يطابق أي سجلّ موظف">غير مرتبطة بسجلّ موظف</div>`}
        </div>
        ${it.hasQr ? `<button type="button" class="mc-qr-btn" data-qr="${esc(it.certNo)}" aria-label="عرض الباركود الخاص بـ${esc(p.name || it.certNo)}">
          <span>عرض الباركود</span>${icon("qr", 20)}</button>` : `<div class="mc-qr-btn is-empty">لا يوجد باركود في الملف</div>`}
        ${canDelete ? `<button type="button" class="mc-del" data-del="${esc(it.certNo)}">حذف البطاقة</button>` : ""}
      </article>`;
  }

  /* ── التصفية ── */
  function matches(it) {
    if (S.status && statusOf(it).key !== S.status) return false;
    if (S.dept && personOf(it).role !== S.dept) return false;
    const q = S.q.trim().toLowerCase();
    if (!q) return true;
    const m = employeeOf(it);
    const hay = [it.name, it.certNo, it.idNumber, it.occupation, it.nationality, m && m.e[S.opts.F.name], m && m.e[S.opts.F.damanah]]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }

  function render() {
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
      o.grid.innerHTML = `<div class="mc-empty">${icon("qr", 28)}<p>لا توجد بطاقات بلدية مسجّلة بعد.</p>
        ${AdminUI.can("municipal", "create") ? "<small>ارفع ملفّ الشهادة الصحية (PDF) من زرّ «إضافة بطاقة» وستُقرأ بياناتها ورمزها تلقائيًا.</small>" : ""}</div>`;
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

  /* ── نافذة الباركود ── */
  function openQr(certNo) {
    const it = S.items.find((x) => x.certNo === certNo);
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
          <div class="mc-qr-big"><img src="${qrUrl(it)}" alt="رمز QR للشهادة الصحية ${esc(it.certNo)}"></div>
          <div class="mc-modal-who">
            <b>${esc(p.name || "")}</b>
            ${p.role ? `<span>${esc(p.role)}</span>` : ""}
          </div>
          <div class="mc-hint">${icon("scan", 26)}<span>يمكن مسح هذا الباركود باستخدام الهاتف لعرض بيانات الشهادة الصحية</span></div>
          <a class="mc-dl" href="${qrUrl(it, true)}" download="municipal-card-${esc(it.certNo)}-QR.png">${icon("download", 18)}<span>تحميل الباركود</span></a>
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

  /* ── الرفع والحذف ── */
  function postPdf(file) {
    return fetch("/api/files/municipal-card", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) },
      body: file,
    }).then(async (r) => {
      let j = null;
      try { j = await r.json(); } catch (e) { /* ردّ غير JSON */ }
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || "تعذّر رفع الملف");
      return j;
    });
  }

  async function uploadFiles(files, btn) {
    const list = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!list.length) { AdminUI.toastError("اختر ملفّ PDF للشهادة الصحية"); return; }
    btn.classList.add("is-busy");
    btn.setAttribute("aria-busy", "true");
    let ok = 0;
    const failed = [];
    for (const f of list) {
      try { await postPdf(f); ok++; } catch (err) { failed.push(`${f.name}: ${err.message}`); }
    }
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
    if (ok) AdminUI.toastOk(ok === 1 ? "أُضيفت البطاقة" : `أُضيفت ${ok} بطاقات`);
    failed.forEach((m) => AdminUI.toastError(m, 7000));
    if (ok) await reload();
  }

  async function removeCard(certNo) {
    const yes = await AdminUI.confirmDanger(`حذف البطاقة ${certNo} من المنصّة؟ يمكن إضافتها لاحقًا برفع ملفّها من جديد.`, { confirmLabel: "حذف" });
    if (!yes) return;
    try {
      await AdminUI.api("DELETE", `/api/data/municipal-cards?id=${encodeURIComponent(certNo)}`);
      AdminUI.toastOk("حُذفت البطاقة");
      await reload();
    } catch (err) {
      AdminUI.toastError(err.message);
    }
  }

  async function reload() {
    try {
      const j = await AdminUI.api("GET", "/api/data/municipal-cards");
      S.items = (j.items || []).filter((it) => it && it.certNo);
    } catch (err) {
      S.items = [];
      S.opts.grid.innerHTML = `<div class="mc-empty"><p>تعذّر تحميل البطاقات البلدية.</p></div>`;
      return;
    }
    fillDepartments();
    render();
  }

  /* حدث error لا يصعد: صورة لم تُحمَّل تُزال فتبقى الأحرف الأولى، ورمزٌ
     لم يُحمَّل يُستبدل بشرطة — لا صورة مكسورة أبدًا. */
  function onImgError(ev) {
    const t = ev.target;
    if (!t || t.tagName !== "IMG") return;
    if (t.classList.contains("mc-photo-img")) t.remove();
    else if (t.closest(".mc-cert-qr")) t.remove();
    else if (t.closest(".mc-qr-big")) t.closest(".mc-qr-big").innerHTML = `<p class="mc-qr-fail">تعذّر تحميل الرمز — أعد المحاولة.</p>`;
  }

  function mount(opts) {
    S.opts = opts;
    const o = opts;
    o.grid.addEventListener("click", (ev) => {
      const q = ev.target.closest("[data-qr]");
      if (q) { openQr(q.dataset.qr); return; }
      const emp = ev.target.closest("[data-open-emp]");
      if (emp && o.openEmployee) { o.openEmployee(Number(emp.dataset.openEmp)); return; }
      const del = ev.target.closest("[data-del]");
      if (del) removeCard(del.dataset.del);
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

    if (o.addBtn && o.fileInput && AdminUI.can("municipal", "create")) {
      o.addBtn.style.display = "";
      o.addBtn.addEventListener("click", () => o.fileInput.click());
      o.fileInput.addEventListener("change", async () => {
        const files = o.fileInput.files;
        if (files && files.length) await uploadFiles(files, o.addBtn);
        o.fileInput.value = "";
      });
    }
    return reload();
  }

  root.MunicipalCards = { mount, statusOf, _state: S };
})(window);
