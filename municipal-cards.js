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
  const S = { items: [], opts: null, q: "", status: "", occ: "", popModal: null };

  const ICON = {
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M7 12h10"/>',
    download: '<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
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
    if (n < 0) return { key: "bad", cls: "bad", n, label: `منتهية منذ ${daysUnit(-n)}`, icon: "alert" };
    if (n === 0) return { key: "bad", cls: "bad", n, label: "تنتهي اليوم", icon: "alert" };
    if (n <= RENEW_DAYS) return { key: "warn", cls: "bad", n, label: `تنتهي خلال ${daysUnit(n)}`, icon: "alert" };
    if (n <= NOTICE_DAYS) return { key: "warn", cls: "warn", n, label: `تنتهي خلال ${daysUnit(n)}`, icon: "clock" };
    return { key: "ok", cls: "ok", n, label: "سارية", icon: "check" };
  }

  function employeeOf(item) {
    const o = S.opts;
    if (!o || !item.idNumber) return null;
    const i = (o.platform || []).findIndex((e) => String(e[o.F.iqama] || "").replace(/\D/g, "") === item.idNumber);
    return i < 0 ? null : { i, e: o.platform[i] };
  }

  const hijriText = (h) => {
    const m = String(h || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]} هـ` : "";
  };
  const initialsOf = (name) => {
    const p = String(name || "").trim().split(/\s+/);
    return (p[0] || "").slice(0, 1) + ((p[1] || "").slice(0, 1) || "");
  };
  const qrUrl = (it, dl) => `/api/files/municipal-qr?card=${encodeURIComponent(it.certNo)}${dl ? "&download=1" : ""}`;
  const photoUrl = (it) => `/api/files/municipal-photo?card=${encodeURIComponent(it.certNo)}&v=${encodeURIComponent(it.photoVersion || "")}`;

  /* ── البطاقة ── */
  function cardFace(it) {
    const rows = [
      ["رقم الهوية", it.idNumber, true],
      ["الجنسية", it.nationality],
      ["المهنة", it.occupation],
    ].filter((r) => r[1]);
    const photo = it.hasPhoto ? `<img class="mc-photo-img" src="${photoUrl(it)}" alt="" loading="lazy" decoding="async" draggable="false">` : "";
    return `
      <div class="mc-card" role="group" aria-label="الشهادة الصحية ${esc(it.certNo)}">
        <div class="mc-card-shine" aria-hidden="true"></div>
        <div class="mc-card-top">
          <div class="mc-issuer">
            <span class="mc-issuer-ar">${esc(it.issuer || "أمانة منطقة الرياض")}</span>
            <span class="mc-issuer-en">Health Certificate · شهادة صحية</span>
          </div>
          <span class="mc-chip" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="mc-card-mid">
          <div class="mc-photo" aria-hidden="true"><span>${esc(initialsOf(it.name))}</span>${photo}</div>
          <div class="mc-holder">
            ${it.name ? `<div class="mc-holder-name">${esc(it.name)}</div>` : ""}
            <dl class="mc-facts">${rows.map((r) => `<div><dt>${r[0]}</dt><dd${r[2] ? ' class="ltr"' : ""}>${esc(r[1])}</dd></div>`).join("")}</dl>
          </div>
        </div>
        <div class="mc-card-bottom">
          <div class="mc-num"><span class="mc-k">رقم الشهادة</span><span class="mc-v ltr">${esc(it.certNo)}</span></div>
          ${it.expiryDate || it.expiryHijri ? `<div class="mc-exp"><span class="mc-k">صالحة حتى</span>
            <span class="mc-v">${it.expiryDate ? esc(fmtDate(it.expiryDate)) : ""}</span>
            ${it.expiryHijri ? `<span class="mc-h">${esc(hijriText(it.expiryHijri))}</span>` : ""}</div>` : ""}
        </div>
      </div>`;
  }

  function tile(it, idx) {
    const st = statusOf(it);
    const m = employeeOf(it);
    const o = S.opts;
    const name = m ? m.e[o.F.name] : it.name;
    const role = m ? [m.e[o.F.job], m.e[o.F.damanah] ? `#${m.e[o.F.damanah]}` : ""].filter(Boolean).join(" · ") : (it.occupation || "");
    const canDelete = AdminUI.can("municipal", "delete");
    return `
      <article class="mc-tile" style="animation-delay:${Math.min(idx * 45, 360)}ms" data-card="${esc(it.certNo)}">
        <div class="mc-tile-head">
          <span class="mc-status ${st.cls}">${icon(st.icon, 14)}${esc(st.label)}</span>
          ${m ? "" : `<span class="mc-unlinked" title="رقم الهوية في الشهادة لا يطابق أي سجلّ موظف">غير مرتبطة بسجلّ</span>`}
        </div>
        ${cardFace(it)}
        <div class="mc-who">
          ${m ? `<button type="button" class="mc-name" data-open-emp="${m.i}">${esc(name)}</button>` : `<div class="mc-name is-static">${esc(name || "—")}</div>`}
          ${role ? `<div class="mc-role">${esc(role)}</div>` : ""}
        </div>
        ${it.hasQr ? `
        <button type="button" class="mc-qr-btn" data-qr="${esc(it.certNo)}" aria-label="عرض الباركود الخاص بـ${esc(name || it.certNo)} بحجم كبير">
          <span class="mc-qr-thumb"><img src="${qrUrl(it)}" alt="" loading="lazy" decoding="async"></span>
          <span class="mc-qr-txt"><b>عرض الباركود</b><small>اضغط للتكبير والمسح بالجوال</small></span>
          <span class="mc-qr-go" aria-hidden="true">${icon("scan", 18)}</span>
        </button>` : `<div class="mc-qr-btn is-empty">لا يوجد رمز QR في ملفّ هذه الشهادة</div>`}
        ${canDelete ? `<div class="mc-admin"><button type="button" class="admin-mini-btn danger" data-del="${esc(it.certNo)}">حذف البطاقة</button></div>` : ""}
      </article>`;
  }

  /* ── التصفية ── */
  function matches(it) {
    if (S.status && statusOf(it).key !== S.status) return false;
    if (S.occ && (it.occupation || "") !== S.occ) return false;
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
    const shown = all.filter(matches);
    o.idx.textContent = all.length ? `${shown.length} من ${all.length}` : "—";

    const count = (k) => all.filter((it) => statusOf(it).key === k).length;
    o.summary.innerHTML = all.length ? [
      ["ok", "سارية", count("ok")],
      ["warn", "قريبة الانتهاء", count("warn")],
      ["bad", "منتهية", count("bad")],
    ].map(([k, l, n]) => `<button type="button" class="mc-sum ${k}${S.status === k ? " on" : ""}" data-sum="${k}" aria-pressed="${S.status === k}">
        <b class="num">${n}</b><span>${l}</span></button>`).join("") : "";

    if (!all.length) {
      o.grid.innerHTML = `<div class="mc-empty">${icon("qr", 28)}<p>لا توجد بطاقات بلدية مسجّلة بعد.</p>
        ${AdminUI.can("municipal", "create") ? "<small>ارفع ملفّ الشهادة الصحية (PDF) من زرّ «إضافة بطاقة» وستُقرأ بياناتها ورمزها تلقائيًا.</small>" : ""}</div>`;
      return;
    }
    o.grid.innerHTML = shown.length ? shown.map(tile).join("") : `<div class="mc-empty"><p>لا توجد بطاقات مطابقة</p></div>`;
  }

  function fillOccupations() {
    const sel = S.opts.occ;
    const list = [...new Set(S.items.map((it) => it.occupation).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));
    sel.innerHTML = `<option value="">كل المهن</option>` + list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    sel.value = list.includes(S.occ) ? S.occ : "";
    S.occ = sel.value;
  }

  /* ── نافذة الباركود ── */
  function openQr(certNo) {
    const it = S.items.find((x) => x.certNo === certNo);
    if (!it || !it.hasQr) return;
    closeQr();
    const m = employeeOf(it);
    const name = m ? m.e[S.opts.F.name] : it.name;
    const role = m ? m.e[S.opts.F.job] : it.occupation;
    const scrim = document.createElement("div");
    scrim.className = "mc-scrim";
    scrim.innerHTML = `
      <div class="mc-modal" role="dialog" aria-modal="true" aria-labelledby="mcQrTitle">
        <div class="mc-modal-head">
          <h3 id="mcQrTitle">الباركود الخاص بالموظف</h3>
          <button type="button" class="mc-x" data-close aria-label="إغلاق">${icon("close", 18)}</button>
        </div>
        <div class="mc-modal-body">
          <div class="mc-qr-big"><img src="${qrUrl(it)}" alt="رمز QR للشهادة الصحية ${esc(it.certNo)}"></div>
          <div class="mc-modal-who">
            <b>${esc(name || "")}</b>
            ${role ? `<span>${esc(role)}</span>` : ""}
            <span class="mc-modal-num ltr">${esc(it.certNo)}</span>
          </div>
          <div class="mc-hint">${icon("scan", 22)}<span>امسح الرمز بكاميرا الجوال لعرض الشهادة الصحية من موقع أمانة منطقة الرياض.</span></div>
          <a class="mc-dl" href="${qrUrl(it, true)}" download="municipal-card-${esc(it.certNo)}-QR.png">${icon("download", 17)}تحميل الباركود</a>
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
    fillOccupations();
    render();
  }

  /* حدث error لا يصعد: صورة لم تُحمَّل تُزال فتبقى الأحرف الأولى، ورمزٌ
     لم يُحمَّل يُستبدل بشرطة — لا صورة مكسورة أبدًا. */
  function onImgError(ev) {
    const t = ev.target;
    if (!t || t.tagName !== "IMG") return;
    if (t.classList.contains("mc-photo-img")) t.remove();
    else if (t.closest(".mc-qr-thumb")) t.replaceWith(Object.assign(document.createElement("span"), { textContent: "—", className: "mc-qr-miss" }));
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
    o.summary.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-sum]");
      if (!b) return;
      S.status = S.status === b.dataset.sum ? "" : b.dataset.sum;
      o.status.value = S.status;
      render();
    });
    let t;
    o.search.addEventListener("input", (ev) => { S.q = ev.target.value; clearTimeout(t); t = setTimeout(render, 160); });
    o.status.addEventListener("change", (ev) => { S.status = ev.target.value; render(); });
    o.occ.addEventListener("change", (ev) => { S.occ = ev.target.value; render(); });
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
