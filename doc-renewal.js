/* doc-renewal.js — «تجديد المستند» للبطاقات البلدية وتصاريح أجير.
   =========================================================================
   سكربت كلاسيكي → DocRenewal في النطاق العام. نافذة واحدة للقسمين:
     ① رفع المستند المجدَّد (سحب وإفلات أو اختيار ملف)
     ② شاشة التقدّم: أربع خطوات تتتابع وتظهر علامة ✓ لكل خطوة تنتهي
     ③ النتيجة: ملخّص النجاح، أو سبب الرفض على الخطوة التي توقّف عندها
   القراءة والمطابقة والتحقّق كلها على الخادم (POST /api/files/<kind>-renew)؛
   الخطوات هنا عرضٌ لتقدّم ذلك الطلب نفسه: الخطوة الأخيرة لا تكتمل إلا
   بردّ الخادم، والرفض يُعلَّم على خطوته الحقيقية (stage). لا رابط تخزين ولا
   رابط ملفّ يصل إلى هنا.

   الصلاحية: canRenew() يعكس canRenew في lib/auth/permissions.js — إخفاء الزرّ
   راحة فقط؛ الخادم يفحص الصلاحية نفسها قبل قراءة الملفّ. */
(function (root) {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MAX_BYTES = 20 * 1024 * 1024;
  const reduced = () => root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ICON = {
    renew: '<path d="M20 11a8 8 0 0 0-14.9-3.9"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3.9"/><path d="M20 20v-4h-4"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M7 7l10 10M17 7 7 17"/>',
    warn: '<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4.5M12 17.2v.01"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  const icon = (n, s) => `<svg width="${s || 18}" height="${s || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

  const STEPS = [
    { stage: "read", label: "جاري قراءة المستند…", done: "تمت قراءة المستند" },
    { stage: "type", label: "جاري تحديد نوع المستند…", done: "تم تحديد نوع المستند" },
    { stage: "match", label: "جاري مطابقة بيانات الموظف…", done: "تمت مطابقة بيانات الموظف" },
    { stage: "verify", label: "جاري التحقق من بيانات التجديد…", done: "تم التحقق من بيانات التجديد" },
  ];
  const LABEL = { municipal: "بطاقة بلدية", ajeer: "تصريح أجير" };

  /* AdminUI مُعرَّف بـconst في admin-ui.js — في النطاق العام لا على window. */
  const adminUI = () => (typeof AdminUI !== "undefined" ? AdminUI : root.AdminUI);

  function canRenew(kind) {
    const A = adminUI();
    if (!A) return false;
    if (kind === "municipal") return A.can("municipal", "manage");
    if (kind === "ajeer") return A.can("ajeer", "manage");
    return false;
  }

  /* زرّ البطاقة. data-renew يلتقطه مستمع القسم نفسه. */
  function buttonHtml(kind, id, who) {
    return `<button type="button" class="rn-btn" data-renew="${esc(kind)}" data-renew-id="${esc(id)}" aria-label="تجديد المستند${who ? ` — ${esc(who)}` : ""}">${icon("renew", 17)}<span>تجديد المستند</span></button>`;
  }

  /* 2027-11-15 → 2027/11/15 */
  const fmtDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || "")) ? String(iso).replace(/-/g, "/") : "—");
  const fmtDays = (n) => (n == null ? "—" : n === 1 ? "يوم واحد" : n === 2 ? "يومان" : n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوم`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const S = { el: null, pop: null, busy: false, opts: null };

  function close() {
    if (!S.el || S.busy) return;
    const el = S.el, pop = S.pop;
    S.el = S.pop = null;
    el.classList.remove("show");
    setTimeout(() => el.remove(), reduced() ? 0 : 260);
    if (pop) pop();
  }

  function shell(o) {
    const scrim = document.createElement("div");
    scrim.className = "rn-scrim";
    scrim.innerHTML = `
      <div class="rn-modal" role="dialog" aria-modal="true" aria-labelledby="drTitle" aria-describedby="drSub">
        <div class="rn-head">
          <div class="rn-head-txt">
            <h3 id="drTitle">تجديد المستند</h3>
            <p id="drSub">${esc(LABEL[o.kind])}${o.employeeName ? ` — ${esc(o.employeeName)}` : ""}</p>
          </div>
          <button type="button" class="rn-x" data-dr-close aria-label="إغلاق">${icon("close", 20)}</button>
        </div>
        <div class="rn-body" aria-live="polite"></div>
      </div>`;
    scrim.addEventListener("click", (ev) => { if (ev.target === scrim || ev.target.closest("[data-dr-close]")) close(); });
    return scrim;
  }

  function body() { return S.el.querySelector(".rn-body"); }
  function setBusy(b) {
    S.busy = b;
    S.el.classList.toggle("is-busy", b);
    const x = S.el.querySelector(".rn-x");
    if (x) x.disabled = b;
  }

  /* ── ① الرفع ── */
  function renderUpload(errorText) {
    const o = S.opts;
    const hist = (o.history || []).slice(0, 5);
    body().innerHTML = `
      <div class="rn-current">
        <span>المستند الحالي${o.currentNumber ? ` <b class="ltr">${esc(o.currentNumber)}</b>` : ""}</span>
        <span>ينتهي <b class="ltr">${fmtDate(o.currentExpiry)}</b></span>
      </div>
      <label class="rn-drop" tabindex="0">
        <input type="file" accept="application/pdf,.pdf" class="rn-file" hidden>
        <span class="rn-drop-ico">${icon("upload", 26)}</span>
        <b>ارفع المستند المجدد</b>
        <span>وسيقوم النظام بمطابقته تلقائيًا مع الموظف الحالي.</span>
        <span class="rn-drop-hint">اسحب ملف PDF وأفلته هنا، أو <u>اختر ملفًا</u></span>
      </label>
      ${errorText ? `<p class="rn-inline-err" role="alert">${esc(errorText)}</p>` : ""}
      <p class="rn-note">لن يتغيّر أي شيء ما لم تنجح المطابقة كاملة.</p>
      ${hist.length ? `<details class="rn-history"><summary>${icon("history", 16)}<span>سجل التجديد (${hist.length})</span></summary><ol>
        ${hist.map((h) => `<li><span class="ltr">${esc(h.certificateNumber || h.number || "")}</span><span>كان ينتهي ${fmtDate(h.expiryDate)}</span><span>استُبدل ${fmtDate(String(h.replacedAt || "").slice(0, 10))}${h.replacedByName ? ` · ${esc(h.replacedByName)}` : ""}</span></li>`).join("")}
      </ol></details>` : ""}`;
    const drop = body().querySelector(".rn-drop");
    const input = body().querySelector(".rn-file");
    const take = (file) => {
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return renderUpload("ارفع ملف PDF للمستند المجدد.");
      if (file.size > MAX_BYTES) return renderUpload("حجم الملف يتجاوز 20MB.");
      run(file);
    };
    input.addEventListener("change", () => take(input.files[0]));
    drop.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); input.click(); } });
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove("is-over"); }));
    drop.addEventListener("drop", (ev) => take(ev.dataTransfer && ev.dataTransfer.files[0]));
  }

  /* ── ② التقدّم ── */
  function renderProgress(fileName) {
    body().innerHTML = `
      <div class="rn-file-chip">${icon("file", 18)}<span class="ltr">${esc(fileName)}</span></div>
      <div class="rn-bar" role="progressbar" aria-label="تقدّم التجديد" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"><i></i></div>
      <ol class="rn-steps">
        ${STEPS.map((s, i) => `<li class="rn-step" data-i="${i}"><span class="rn-dot"><span class="rn-ring"></span>${icon("check", 15)}${icon("x", 15)}</span><span class="rn-step-txt">${s.label}</span></li>`).join("")}
      </ol>`;
  }
  function stepEl(i) { return body().querySelector(`.rn-step[data-i="${i}"]`); }
  function setStep(i, state) {
    const li = stepEl(i);
    if (!li) return;
    li.classList.remove("is-active", "is-done", "is-fail");
    if (state) li.classList.add(`is-${state}`);
    if (state === "done") li.querySelector(".rn-step-txt").textContent = STEPS[i].done;
    const done = body().querySelectorAll(".rn-step.is-done").length;
    const bar = body().querySelector(".rn-bar");
    if (bar) {
      bar.style.setProperty("--p", `${(done + (state === "active" ? 0.45 : 0)) / STEPS.length}`);
      bar.setAttribute("aria-valuenow", String(done));
      bar.classList.toggle("is-fail", state === "fail");
    }
  }

  async function send(file) {
    const o = S.opts;
    const qs = o.kind === "municipal" ? `id=${encodeURIComponent(o.id)}` : `permit=${encodeURIComponent(o.id)}`;
    let res, j;
    try {
      res = await fetch(`/api/files/${o.kind}-renew?${qs}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file, credentials: "same-origin" });
      j = await res.json();
    } catch (err) {
      return { ok: false, stage: "read", reason: "network", error: "تعذّر الاتصال بالخادم — لم يتغيّر شيء، أعد المحاولة" };
    }
    if (res.status === 403) return { ok: false, stage: "read", reason: "forbidden", error: "ليست لديك صلاحية تجديد هذا المستند" };
    return j || { ok: false, stage: "read", error: "تعذّر إكمال العملية" };
  }

  async function run(file) {
    setBusy(true);
    renderProgress(file.name);
    const fast = reduced();
    const pace = fast ? 120 : 620;
    const request = send(file);
    /* الخطوات الثلاث الأولى تتتابع بإيقاع هادئ أثناء الطلب؛ الرابعة تنتظر الردّ. */
    let result = null;
    request.then((r) => { result = r; });
    for (let i = 0; i < STEPS.length; i++) {
      setStep(i, "active");
      const started = Date.now();
      if (i === STEPS.length - 1 || result) {
        await request;
      }
      const r = result;
      if (r && !r.ok) {
        const failAt = Math.max(0, STEPS.findIndex((s) => s.stage === r.stage));
        if (failAt <= i) {
          await sleep(Math.max(0, pace - (Date.now() - started)));
          setStep(failAt, "fail");
          await sleep(fast ? 80 : 520);
          setBusy(false);
          return renderFailure(r);
        }
      }
      await sleep(Math.max(0, pace - (Date.now() - started)));
      setStep(i, "done");
    }
    const r = await request;
    await sleep(fast ? 60 : 360);
    setBusy(false);
    if (!r.ok) return renderFailure(r);
    renderSuccess(r);
    if (typeof S.opts.onSuccess === "function") {
      try { await S.opts.onSuccess(r.item, r.summary); } catch (err) { /* البطاقة تُحدَّث عند التحميل التالي */ }
    }
  }

  /* ── ③ النتيجة ── */
  function renderSuccess(r) {
    const s = r.summary || {};
    const o = S.opts;
    const st = o.statusOf && s.newExpiry ? o.statusOf(s.newExpiry) : null;
    const isAjeer = s.kind === "ajeer";
    const rows = [
      ["الموظف", esc(s.employeeName || o.employeeName || "—")],
      ["نوع المستند", esc(s.documentLabel || LABEL[o.kind])],
      [isAjeer ? "رقم التصريح الجديد" : "رقم الشهادة الجديدة", `<span class="ltr">${esc(s.newNumber || "—")}</span>`],
      ["المستند السابق ينتهي", `<span class="ltr">${fmtDate(s.previousExpiry)}</span>`],
      ["المستند الجديد ينتهي", `<span class="ltr">${fmtDate(s.newExpiry)}</span>`],
      ["تم تمديد الصلاحية", s.extendedDays == null ? "—" : fmtDays(s.extendedDays)],
      ["متبقي", s.daysLeft == null ? "—" : fmtDays(s.daysLeft)],
    ];
    if (st) rows.push(["الحالة", `<span class="rn-status ${esc(st.cls || "")}">${esc(st.label || "")}</span>`]);
    body().innerHTML = `
      <div class="rn-result is-ok">
        <div class="rn-badge ok"><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="23"/><path d="m15.5 27 7 7 14-15"/></svg></div>
        <h4>${isAjeer ? "تم تجديد تصريح أجير بنجاح" : "تمت مطابقة المستند بنجاح"}</h4>
        <p class="rn-result-sub">${isAjeer ? "تمت مطابقة التصريح بالموظف وتحديث البطاقة." : "تم استبدال البطاقة بالمستند المجدد وحُفظ السابق في السجل."}</p>
        <dl class="rn-summary">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
        ${s.nameMatch === "partial" ? `<p class="rn-note">الاسم على المستند مختلف قليلًا عن السابق، والمطابقة تمت برقم الهوية.</p>` : ""}
        <div class="rn-actions"><button type="button" class="rn-primary" data-dr-close>تم</button></div>
      </div>`;
    const b = body().querySelector(".rn-primary");
    if (b) b.focus({ preventScroll: true });
  }

  const FAIL_TITLE = {
    duplicate: "هذا المستند مسجل مسبقًا",
    older: "المستند المرفوع أقدم من المستند الحالي",
    not_newer: "المستند لا يمدّد الصلاحية الحالية",
    forbidden: "لا تملك صلاحية التجديد",
  };
  function renderFailure(r) {
    const other = r.reason === "other_employee" && r.otherEmployee;
    const title = other ? "المستند يخص موظفًا آخر" : FAIL_TITLE[r.reason] || "تعذر مطابقة المستند مع الموظف الحالي";
    const reasonText = other
      ? `المستند المرفوع يبدو أنه يخص موظفًا آخر: ${esc(other.name || `الرقم الوظيفي ${other.eid}`)}`
      : esc(r.error || "تعذّر إكمال العملية");
    const dates = r.reason === "older" || r.reason === "not_newer"
      ? `<dl class="rn-summary compact"><div><dt>المستند الحالي ينتهي</dt><dd class="ltr">${fmtDate(r.previousExpiry)}</dd></div><div><dt>المستند المرفوع ينتهي</dt><dd class="ltr">${fmtDate(r.newExpiry)}</dd></div></dl>`
      : "";
    body().innerHTML = `
      <div class="rn-result is-fail${other ? " is-warn" : ""}">
        <div class="rn-badge ${other ? "warn" : "bad"}">${other ? icon("warn", 30) : `<svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="23"/><path d="m18 18 16 16M34 18 18 34"/></svg>`}</div>
        <h4>${esc(title)}</h4>
        ${reasonText && reasonText !== esc(title) ? `<p class="rn-reason" role="alert">${reasonText}</p>` : ""}
        ${dates}
        <p class="rn-note">لم يتم تغيير أي بيانات، والمستند الحالي باقٍ كما هو.</p>
        <div class="rn-actions">
          ${other ? "" : `<button type="button" class="rn-primary" data-dr-retry>رفع مستند آخر</button>`}
          <button type="button" class="${other ? "rn-primary" : "rn-ghost"}" data-dr-close>${other ? "ألغِ العملية" : "إلغاء"}</button>
        </div>
      </div>`;
    const retry = body().querySelector("[data-dr-retry]");
    if (retry) retry.addEventListener("click", () => renderUpload());
    const f = body().querySelector(".rn-primary");
    if (f) f.focus({ preventScroll: true });
  }

  /* opts: { kind, id, employeeName, currentNumber, currentExpiry, history, statusOf(iso)→{label,cls}, onSuccess(item, summary) } */
  function open(opts) {
    if (!opts || !canRenew(opts.kind)) return;
    if (S.el) { S.busy = false; close(); }
    S.opts = opts;
    S.el = shell(opts);
    document.body.appendChild(S.el);
    requestAnimationFrame(() => S.el && S.el.classList.add("show"));
    S.pop = adminUI() ? adminUI().pushLayer(S.el.querySelector(".rn-modal"), () => close(), { noAutofocus: true }) : null;
    renderUpload();
    setTimeout(() => { const d = S.el && S.el.querySelector(".rn-drop"); if (d) d.focus({ preventScroll: true }); }, 80);
  }

  /* بعد النجاح: وميض هادئ على البطاقة التي تحدّثت. */
  function flash(el) {
    if (!el) return;
    el.classList.remove("rn-renewed");
    void el.offsetWidth;
    el.classList.add("rn-renewed");
    setTimeout(() => el.classList.remove("rn-renewed"), 2600);
  }

  root.DocRenewal = { canRenew, buttonHtml, open, close, flash, fmtDate, fmtDays, STEPS };
})(window);
