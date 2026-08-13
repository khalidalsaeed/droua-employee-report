/* Shared admin components (modal, confirm, form errors, file upload) used
   by every page's management UI (employees, ajeer, payroll...) so each page
   doesn't reimplement the same modal/upload plumbing. Depends only on
   admin-ui.css for styling — no build step, plain <script src> include. */
const AdminUI = (function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  let scrimEl, modalEl;
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
    scrimEl.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });
  }

  /* html: the modal's inner markup. Include an element with
     [data-admin-close] (e.g. the ✕ button) to wire the close click. */
  function openModal(html) {
    ensureDom();
    modalEl.innerHTML = html;
    scrimEl.classList.add("show");
    modalEl.classList.add("show");
    modalEl.querySelectorAll("[data-admin-close]").forEach((b) => b.addEventListener("click", closeModal));
    return modalEl;
  }
  function closeModal() {
    if (!scrimEl) return;
    scrimEl.classList.remove("show");
    modalEl.classList.remove("show");
  }

  /* Native confirm() for destructive actions — matches the pattern already
     proven in users-shell.html's delete flow; kept deliberately simple. */
  function confirmDanger(message) {
    return window.confirm(message);
  }

  function showError(scopeEl, message) {
    const err = scopeEl.querySelector("[data-admin-error]");
    if (!err) return;
    err.textContent = message;
    err.classList.add("show");
  }
  function clearError(scopeEl) {
    const err = scopeEl.querySelector("[data-admin-error]");
    if (err) {
      err.textContent = "";
      err.classList.remove("show");
    }
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

  /* Uploads a File via the server-proxy endpoint (no client Blob SDK
     needed); prefix groups files in the store (e.g. "ajeer-permits"). */
  async function uploadFile(file, prefix) {
    const r = await fetch(`/api/files/upload?prefix=${encodeURIComponent(prefix)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    let j;
    try {
      j = await r.json();
    } catch {
      throw new Error("فشل رفع الملف");
    }
    if (!r.ok || !j.ok) throw new Error(j.error || "فشل رفع الملف");
    return j.url;
  }
  async function deleteFile(url) {
    await api("POST", "/api/files/delete", { url });
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

  return { esc, openModal, closeModal, confirmDanger, showError, clearError, api, uploadFile, deleteFile, wireTabs };
})();
