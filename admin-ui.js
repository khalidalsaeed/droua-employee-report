/* Shared admin components (modal, confirm, form errors, file upload) used
   by every page's management UI (employees, ajeer, payroll...) so each page
   doesn't reimplement the same modal/upload plumbing. Depends only on
   admin-ui.css + ui.css for styling — no build step, plain <script src> include.

   طبقة الجوال المضافة هنا (وتعتمد عليها app-nav.js أيضًا):
     - overlay: حبس تمرير الجسم + حبس التركيز + إغلاق بزر رجوع أندرويد.
       كان openModal يفتح حوارًا دون حبس التمرير إطلاقًا، فتُمرَّر الصفحة
       خلفه ويتسرّب التمرير من نهاية الحوار إلى المستند.
     - visualViewport: يرفع الورقة فوق لوحة المفاتيح ويُبقي الحقل المركَّز
       مرئيًا. الحوار المتمركز كان يختفي خلف لوحة المفاتيح على iOS.
     - toast/confirmDanger: بدائل داخل الصفحة لـ alert()/confirm() الأصليين،
       اللذين يمكن كتمهما في أندرويد كروم فيفشل الحذف صامتًا.
     - uploadFileDetailed: XHR بدل fetch للحصول على تقدّم الرفع. */
const AdminUI = (function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /* ======================================================================
     منظومة الطبقات — يشترك فيها الحوار والدرج وأوراق المرشّحات.
     ====================================================================== */

  /* مكدّس الطبقات المفتوحة. كل عنصر: {close, el, restoreFocus}.
     المكدّس هو ما يجعل فتح ورقة تأكيد فوق حوار مفتوح يعمل بشكل صحيح:
     الإغلاق يطوي الأعلى فقط، وحبس التمرير يُرفع عند إفراغ المكدّس. */
  const stack = [];
  let scrollY = 0;

  function lockScroll() {
    if (stack.length > 1) return; // مقفول أصلًا بفعل طبقة أدنى
    scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.insetInline = "0";
    document.body.style.width = "100%";
  }
  function unlockScroll() {
    if (stack.length) return; // ما زالت هناك طبقة مفتوحة
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.insetInline = "";
    document.body.style.width = "";
    window.scrollTo(0, scrollY);
  }

  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function focusablesIn(el) {
    return [...el.querySelectorAll(FOCUSABLE)].filter(
      (n) => n.offsetWidth || n.offsetHeight || n.getClientRects().length
    );
  }

  /* حبس التركيز داخل الطبقة العليا فقط. بدونه يخرج قارئ الشاشة على iOS
     من الحوار إلى الصفحة خلفه رغم aria-modal="true". */
  function onKeydown(e) {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      e.preventDefault();
      top.close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusablesIn(top.el);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !top.el.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
  document.addEventListener("keydown", onKeydown);

  /* زر الرجوع في أندرويد يجب أن يغلق الطبقة لا أن يغادر الصفحة.
     كل فتح يدفع حالة في السجل، وكل إغلاق يزيلها. علامة `navigating`
     تمنع الحلقة عندما يأتي الإغلاق من popstate نفسه. */
  let navigating = false;
  window.addEventListener("popstate", () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    navigating = true;
    top.close();
    navigating = false;
  });

  /* يرفع الطبقة فوق لوحة المفاتيح. iOS يقلّص المنفذ المرئي دون تحريك
     العناصر الثابتة، فالحقل المركَّز ينتهي خلف اللوحة. */
  function bindViewport(el) {
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const apply = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.style.setProperty("--kb", `${overlap}px`);
      const active = document.activeElement;
      if (overlap > 0 && active && el.contains(active) && typeof active.scrollIntoView === "function") {
        active.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    apply();
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      el.style.removeProperty("--kb");
    };
  }

  /* كل ما هو طبقة عائمة — لا يُعطَّل حين تُفتح طبقة فوق الصفحة.
     يشمل طبقات app-shell.html الخاصة (الدرج القديم، حوار الوثائق، رمز QR). */
  const LAYER_SELECTOR =
    ".u-scrim,.u-sheet,.u-drawer,.u-toast-wrap,.admin-scrim,.admin-modal," +
    ".scrim,.drawer,.mscrim,.navscrim,.sidenav,.hovercard";

  /* يعطّل خلفية الصفحة لقارئات الشاشة ولوحة المفاتيح. بدونه يخرج VoiceOver
     من الحوار إلى المحتوى خلفه رغم aria-modal="true". */
  function setBackgroundInert(layerEl, on) {
    [...document.body.children].forEach((n) => {
      if (n === layerEl || n.contains(layerEl)) return;
      if (/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(n.tagName)) return;
      if (n.matches(LAYER_SELECTOR)) return;
      if (on) n.setAttribute("inert", "");
      else n.removeAttribute("inert");
    });
  }

  /* تُستدعى من فاتح الطبقة. ترجع دالة إنهاء تُستدعى عند الإغلاق. */
  function pushLayer(el, close, opts) {
    const entry = { el, close, restoreFocus: document.activeElement };
    stack.push(entry);
    lockScroll();
    if (!navigating) {
      history.pushState({ adminOverlay: stack.length }, "");
      entry.pushedState = true;
    }
    const unbindVv = bindViewport(el);
    setBackgroundInert(el, true);

    // التركيز الأولي: أول حقل قابل للكتابة، وإلا أول عنصر تفاعلي.
    if (!(opts && opts.noAutofocus)) {
      setTimeout(() => {
        const items = focusablesIn(el);
        const field = items.find((n) => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName));
        (field || items[0] || el).focus({ preventScroll: true });
      }, 60);
    }

    return function popLayer() {
      const i = stack.indexOf(entry);
      if (i === -1) return;
      stack.splice(i, 1);
      unbindVv();
      if (!stack.length) setBackgroundInert(el, false);
      unlockScroll();
      if (entry.pushedState && !navigating) history.back();
      if (entry.restoreFocus && document.contains(entry.restoreFocus)) {
        entry.restoreFocus.focus({ preventScroll: true });
      }
    };
  }

  /* ======================================================================
     الحوار / الورقة السفلية
     ====================================================================== */

  let scrimEl, modalEl, popModal = null, modalDirty = false;

  function ensureDom() {
    if (scrimEl) return;
    scrimEl = document.createElement("div");
    scrimEl.className = "admin-scrim";
    modalEl = document.createElement("div");
    modalEl.className = "admin-modal";
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    document.body.appendChild(scrimEl);
    document.body.appendChild(modalEl);
    scrimEl.addEventListener("click", requestCloseModal);
    /* أي تعديل على النموذج يجعل لمسة الحجاب تطلب تأكيدًا بدل الإسقاط
       الصامت — نموذج التذكرة وحده تسعة حقول. */
    modalEl.addEventListener("input", () => { modalDirty = true; });
  }

  /* html: the modal's inner markup. Include an element with
     [data-admin-close] (e.g. the ✕ button) to wire the close click.
     opts.wide widens it for grid-ish content (the permissions manager). */
  function openModal(html, opts) {
    ensureDom();
    if (popModal) popModal();           // استبدال حوار مفتوح
    modalEl.className = "admin-modal" + (opts && opts.wide ? " wide" : "");
    modalEl.innerHTML = html;
    modalDirty = false;
    scrimEl.classList.add("show");
    modalEl.classList.add("show");
    modalEl.querySelectorAll("[data-admin-close]").forEach((b) => b.addEventListener("click", closeModal));
    popModal = pushLayer(modalEl, closeModal);
    return modalEl;
  }

  function closeModal() {
    if (!scrimEl) return;
    scrimEl.classList.remove("show");
    modalEl.classList.remove("show");
    modalDirty = false;
    if (popModal) { popModal(); popModal = null; }
  }

  async function requestCloseModal() {
    if (!modalDirty) { closeModal(); return; }
    const ok = await confirmDanger("إغلاق النموذج وإسقاط ما أدخلته؟", {
      confirmLabel: "إغلاق وإسقاط",
      cancelLabel: "متابعة التعبئة",
    });
    if (ok) closeModal();
  }

  /* ======================================================================
     التنبيهات والتأكيد
     ====================================================================== */

  let toastWrap;
  /* type: "ok" | "bad" | "warn" | "" */
  function toast(message, type, ms) {
    if (!toastWrap) {
      toastWrap = document.createElement("div");
      toastWrap.className = "u-toast-wrap";
      toastWrap.setAttribute("role", "status");
      toastWrap.setAttribute("aria-live", "polite");
      document.body.appendChild(toastWrap);
    }
    const el = document.createElement("div");
    el.className = "u-toast" + (type ? " " + type : "");
    el.textContent = String(message == null ? "" : message);
    toastWrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const life = ms || (type === "bad" ? 6000 : 3600);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, life);
    return el;
  }
  const toastError = (m, ms) => toast(m, "bad", ms);
  const toastOk = (m, ms) => toast(m, "ok", ms);

  /* تأكيد الإجراءات المدمّرة. كان window.confirm — وهو قابل للكتم عبر
     "منع هذه الصفحة من إنشاء حوارات إضافية" في أندرويد كروم، فيرجع false
     ويفشل الحذف دون أي أثر مرئي. يرجع Promise<boolean>. */
  function confirmDanger(message, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const scrim = document.createElement("div");
      scrim.className = "u-scrim";
      const sheet = document.createElement("div");
      sheet.className = "u-sheet u-confirm";
      sheet.setAttribute("role", "alertdialog");
      sheet.setAttribute("aria-modal", "true");
      sheet.innerHTML = `
        <div class="u-sheet-grip"></div>
        <div class="u-sheet-body">
          <p class="u-confirm-msg">${esc(message)}</p>
        </div>
        <div class="u-sheet-foot">
          <button type="button" class="u-btn ${o.danger === false ? "u-btn-primary" : "u-btn-danger"}" data-yes>${esc(o.confirmLabel || "تأكيد")}</button>
          <button type="button" class="u-btn u-btn-ghost" data-no>${esc(o.cancelLabel || "إلغاء")}</button>
        </div>`;
      document.body.appendChild(scrim);
      document.body.appendChild(sheet);
      requestAnimationFrame(() => { scrim.classList.add("show"); sheet.classList.add("show"); });

      let pop;
      const done = (val) => {
        scrim.classList.remove("show");
        sheet.classList.remove("show");
        if (pop) pop();
        setTimeout(() => { scrim.remove(); sheet.remove(); }, 320);
        resolve(val);
      };
      sheet.querySelector("[data-yes]").addEventListener("click", () => done(true));
      sheet.querySelector("[data-no]").addEventListener("click", () => done(false));
      scrim.addEventListener("click", () => done(false));
      /* التركيز يبدأ على "إلغاء" لا على الزر المدمّر. */
      pop = pushLayer(sheet, () => done(false), { noAutofocus: true });
      setTimeout(() => sheet.querySelector("[data-no]").focus({ preventScroll: true }), 60);
    });
  }

  function showError(scopeEl, message) {
    const err = scopeEl.querySelector("[data-admin-error]");
    if (!err) { toastError(message); return; }
    err.textContent = message;
    err.classList.add("show");
    err.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function clearError(scopeEl) {
    const err = scopeEl.querySelector("[data-admin-error]");
    if (err) {
      err.textContent = "";
      err.classList.remove("show");
    }
  }

  /* Non-fatal notice — the operation succeeded but something partial happened
     (e.g. the permit uploaded but its QR couldn't be read). Styled distinctly
     from showError so a success-with-caveat doesn't read as a failure. */
  function showNotice(scopeEl, message) {
    const el = scopeEl.querySelector("[data-admin-notice]");
    if (!el) { toast(message, "warn"); return; }
    el.textContent = message;
    el.classList.add("show");
  }

  /* Generic authenticated JSON call against /api/data/* (or anything else
     returning {ok, error}). Throws with the server's Arabic error message
     on failure so callers can just try/catch and show it. */
  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let j;
    try {
      j = await r.json();
    } catch {
      throw new Error("استجابة غير صالحة من الخادم");
    }
    if (!r.ok || !j.ok) throw new Error(j.error || "حدث خطأ غير متوقع");
    return j;
  }

  /* ---- current user + permissions ----
     Every page calls setUser() with what /api/auth/me returned, then gates UI
     with can(). The resolved permission list comes from the server (role
     defaults or the user's custom set, Owner always full), so no page
     reimplements the resolution rules. Hiding a control with can() is a
     convenience only — the API re-checks the same permission on every
     request, so a user who forges a call still gets a 403. */
  let currentUser = null;
  function setUser(user) {
    currentUser = user || null;
    return currentUser;
  }
  function getUser() {
    return currentUser;
  }
  function can(section, action) {
    if (!currentUser) return false;
    if (currentUser.role === "owner") return true;
    return (currentUser.permissions || []).includes(`${section}:${action}`);
  }
  /* True if the user holds any of the section's listed actions — for deciding
     whether to render a whole action row at all. */
  function canAny(section, actions) {
    return actions.some((a) => can(section, a));
  }

  /* ======================================================================
     رفع الملفات
     ====================================================================== */

  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  const UPLOAD_TIMEOUT_MS = 120000;

  /* Uploads a File via the server-proxy endpoint (no client Blob SDK
     needed); prefix groups files in the store (e.g. "ajeer-permits") and
     section names the permission the server checks (<section>:upload_files).
     Returns the whole server response, not just the URL — permit PDFs come back
     with {qrText, qrExtracted} from the server-side QR decode.
     extra: additional query params the server needs to act on the upload — e.g.
     {docType, eid} so an employee document's expiry can be extracted and applied.

     XHR بدل fetch لأن fetch لا يعطي أحداث تقدّم للرفع: كان رفع ملف بحجم
     ميغابايتات على بيانات الجوال صامتًا تمامًا من اللمس حتى إعادة الرسم.
     onProgress(percent|null) — null حين لا يكون الحجم معلومًا. */
  function uploadFileDetailed(file, prefix, section, extra, onProgress) {
    if (!file) return Promise.reject(new Error("لم يتم اختيار ملف"));
    if (file.size > MAX_UPLOAD_BYTES) {
      return Promise.reject(new Error(`حجم الملف ${(file.size / 1048576).toFixed(1)}MB يتجاوز الحد المسموح (20MB)`));
    }
    const qs = new URLSearchParams({ prefix, section, ...(extra || {}) }).toString();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/files/upload?${qs}`);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      if (typeof onProgress === "function") {
        onProgress(0);
        xhr.upload.addEventListener("progress", (e) => {
          onProgress(e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : null);
        });
      }
      xhr.addEventListener("load", () => {
        let j;
        try {
          j = JSON.parse(xhr.responseText);
        } catch {
          reject(new Error("فشل رفع الملف"));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300 || !j.ok) {
          reject(new Error(j.error || "فشل رفع الملف"));
          return;
        }
        resolve(j);
      });
      xhr.addEventListener("error", () => reject(new Error("تعذّر الاتصال بالخادم أثناء الرفع")));
      xhr.addEventListener("timeout", () => reject(new Error("انتهت مهلة الرفع — تحقّق من الاتصال وأعد المحاولة")));
      xhr.addEventListener("abort", () => reject(new Error("أُلغي الرفع")));
      xhr.send(file);
    });
  }
  async function uploadFile(file, prefix, section, onProgress) {
    return (await uploadFileDetailed(file, prefix, section, undefined, onProgress)).url;
  }
  async function deleteFile(url, section) {
    await api("POST", `/api/files/delete?section=${encodeURIComponent(section)}`, { url });
  }

  /* يربط <input type=file> بدورة رفع كاملة: تعطيل الزر، شريط تقدّم، تنبيه
     خطأ، وتصفير قيمة الحقل. التصفير ضروري: بدونه لا يُطلق اختيار الملف
     نفسه مجددًا حدث change، فتفشل إعادة المحاولة بعد انقطاع الشبكة. */
  function wireUpload(input, trigger, run) {
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const bar = document.createElement("div");
      bar.className = "u-progress";
      bar.innerHTML = "<span></span>";
      const fill = bar.firstChild;
      if (trigger) {
        trigger.setAttribute("aria-busy", "true");
        trigger.classList.add("is-busy");
        trigger.insertAdjacentElement("afterend", bar);
      }
      try {
        await run(file, (pct) => { fill.style.width = (pct == null ? 100 : pct) + "%"; });
      } catch (err) {
        toastError(err.message);
      } finally {
        input.value = "";
        bar.remove();
        if (trigger) {
          trigger.removeAttribute("aria-busy");
          trigger.classList.remove("is-busy");
        }
      }
    });
  }

  /* Small helper for tabbed modal forms (عام / الإقامة / الرخصة ...). Wires
     .admin-tab buttons to toggle matching [data-tab-panel] sections. */
  function wireTabs(scopeEl) {
    const tabs = scopeEl.querySelectorAll(".admin-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        scopeEl.querySelectorAll("[data-tab-panel]").forEach((p) => {
          p.style.display = p.dataset.tabPanel === tab.dataset.tab ? "" : "none";
        });
      });
    });
  }

  return {
    esc, openModal, closeModal, confirmDanger, showError, clearError, showNotice,
    api, setUser, getUser, can, canAny, uploadFile, uploadFileDetailed, deleteFile,
    wireTabs, wireUpload, toast, toastOk, toastError, pushLayer,
  };
})();
