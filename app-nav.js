/* app-nav.js — التنقّل المشترك لكل صفحات المنصّة.
   =========================================================================
   قبل هذا الملف كان الدرج موجودًا في app-shell.html وحده، وباقي الصفحات
   تحمل رابط رجوع نصيًا بارتفاع ~21px. النتيجة أن أي انتقال جانبي — من
   التذاكر إلى التقارير مثلًا — كان يمرّ إجباريًا عبر الصفحة الرئيسية،
   وهي أثقل صفحة في المستودع. وست ترويسات كانت متطابقة بايتًا عدا وجهة
   الرجوع، فكل إصلاح كان يُكرَّر ست مرات.

   هنا مصدر واحد لكل ذلك: ترويسة لاصقة مضغوطة، وشريط تبويب سفلي على
   الجوال (المعيار في iOS وأندرويد، ويضع الوجهات في متناول الإبهام)،
   ودرج للوجهات الثانوية.

   الصلاحيات: تُقرأ عبر AdminUI.can() — نفس مصدر الحقيقة الذي يستعمله
   الخادم، فلا تُكرَّر جداول الأدوار هنا. الوجهات تظهر بعد setUser() فقط.

   يعتمد على: ui.css (البدائل الأوّلية) و admin-ui.js (منظومة الطبقات).
   يُحمَّل بـ defer في <head> ليبني الهيكل قبل الرسم الأول. */
const AppNav = (function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- الأيقونات (مأخوذة من درج app-shell.html الأصلي) ---------- */
  const I = {
    home: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    finance: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    people: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M17 11c1.7 0 3-1.3 3-3s-1.3-3-3-3"/><path d="M22 21c0-3-1.7-5-4-5.7"/>',
    ajeer: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 2v4M16 2v4"/>',
    tickets: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z"/><path d="M12 7v10"/>',
    reports: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    payroll: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h4a1.5 1.5 0 0 1 0 3H9m0 0h5"/>',
    users: '<circle cx="9" cy="7" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
    contact: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  function svg(paths, size) {
    const s = size || 20;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  }

  /* ---------- الوجهات ----------
     perm: الصلاحية المطلوبة بصيغة "section:action" (فارغة = متاحة للجميع).
     tab:  ترتيب ظهورها في الشريط السفلي (غير المرقّمة تظهر في الدرج فقط).
     page: مفتاح الصفحة لتحديد الحالة النشطة. */
  const DEST = [
    { key: "home",      href: "/",              label: "الرئيسية",        icon: I.home,     perm: "kpi:view",       tab: 1, page: "home" },
    { key: "employees", href: "/#peopleSec",    label: "الموظفون",        icon: I.people,   perm: "employees:view", tab: 2, page: "home" },
    { key: "tickets",   href: "/tickets.html",  label: "التذاكر",         icon: I.tickets,  perm: "tickets:view",   tab: 3, page: "tickets" },
    { key: "reports",   href: "/reports.html",  label: "التقارير",        icon: I.reports,  perm: "reports:view",   tab: 4, page: "reports" },
    { key: "payroll",   href: "/payroll.html",  label: "مسير الرواتب",    icon: I.payroll,  perm: "payroll:view",           page: "payroll" },
    { key: "ajeer",     href: "/#ajeerSec",     label: "تصاريح أجير",     icon: I.ajeer,    perm: "ajeer:view",             page: "home" },
    { key: "finance",   href: "/#finSec",       label: "التحليل المالي",  icon: I.finance,  perm: "finance:view",           page: "home" },
    { key: "users",     href: "/users.html",    label: "إدارة المستخدمين", icon: I.users,   perm: "users:view",             page: "users" },
    { key: "contact",   href: "/#contactSec",   label: "التواصل مع الموارد البشرية", icon: I.contact, perm: "contact:view", page: "home" },
  ];

  const PAGE_TITLES = {
    home: "تقرير الموارد البشرية",
    users: "إدارة المستخدمين",
    payroll: "مسير الرواتب",
    tickets: "التذاكر والمتابعات",
    reports: "التقارير الشهرية",
  };

  /* الصفحة الحالية من المسار — vercel.json يعيد كتابة /tickets/:id و
     /payroll/:id إلى نفس القسم، فيُطابَقان بالبادئة. */
  function currentPage() {
    const p = location.pathname;
    if (p === "/" || p === "/index.html") return "home";
    if (p.startsWith("/users")) return "users";
    if (p.startsWith("/payroll")) return "payroll";
    if (p.startsWith("/tickets")) return "tickets";
    if (p.startsWith("/reports")) return "reports";
    return "";
  }

  let page = "", headerEl, tabbarEl, drawerEl, scrimEl, popDrawer = null;

  /* ---------- الترويسة ---------- */
  function buildHeader(opts) {
    const el = document.querySelector("[data-app-header]") || document.createElement("header");
    el.className = "u-hdr";
    el.setAttribute("data-app-header", "");
    const title = opts.title || PAGE_TITLES[page] || "";
    el.innerHTML = `
      <div class="u-hdr-in">
        <button class="u-hdr-btn" type="button" data-nav-open aria-label="فتح القائمة" aria-expanded="false" aria-controls="appDrawer">${svg(I.menu, 19)}</button>
        <div class="u-hdr-titles">
          <div class="u-hdr-title">${esc(title)}</div>
          <div class="u-hdr-sub">${esc(opts.subtitle || "شركة ذروة الصعود للتجارة — إدارة الموارد البشرية")}</div>
        </div>
        <div class="u-hdr-slot" data-nav-slot></div>
      </div>`;
    if (!el.parentNode) document.body.insertBefore(el, document.body.firstChild);
    el.querySelector("[data-nav-open]").addEventListener("click", openDrawer);
    return el;
  }

  /* ---------- الشريط السفلي ---------- */
  function buildTabbar() {
    const el = document.createElement("nav");
    el.className = "u-tabbar";
    el.setAttribute("aria-label", "التنقّل السريع");
    document.body.appendChild(el);
    document.body.classList.add("has-tabbar");
    return el;
  }

  function renderTabs() {
    if (!tabbarEl) return;
    const tabs = DEST.filter((d) => d.tab && allowed(d)).sort((a, b) => a.tab - b.tab).slice(0, 4);
    tabbarEl.innerHTML =
      tabs
        .map((d) => {
          const active = d.page === page && (d.key !== "employees" || location.hash === "#peopleSec");
          return `<a class="u-tab" href="${d.href}"${active ? ' aria-current="page"' : ""}>${svg(d.icon, 21)}<span class="u-tab-lbl">${esc(d.label)}</span></a>`;
        })
        .join("") +
      /* الصفحة الحالية قد تكون وجهة في الدرج لا في الشريط (المستخدمون،
         مسير الرواتب) — فيُميَّز "المزيد" ليعرف المستخدم أين هو. */
      `<button class="u-tab" type="button" data-nav-open${
        tabs.some((d) => d.page === page) ? "" : ' aria-current="page"'
      }>${svg(I.more, 21)}<span class="u-tab-lbl">المزيد</span></button>`;
    tabbarEl.querySelectorAll("[data-nav-open]").forEach((b) => b.addEventListener("click", openDrawer));
  }

  /* ---------- الدرج ---------- */
  function buildDrawer() {
    scrimEl = document.createElement("div");
    scrimEl.className = "u-scrim";
    scrimEl.addEventListener("click", closeDrawer);
    drawerEl = document.createElement("aside");
    drawerEl.className = "u-drawer";
    drawerEl.id = "appDrawer";
    drawerEl.setAttribute("role", "dialog");
    drawerEl.setAttribute("aria-modal", "true");
    drawerEl.setAttribute("aria-label", "القائمة");
    document.body.appendChild(scrimEl);
    document.body.appendChild(drawerEl);
    return drawerEl;
  }

  /* التسميات العربية للأدوار، مطابقة لـ ROLE_LABELS في lib/auth/roles.js.
     مُصدَّرة عبر AppNav.roleLabel() لأن هذا الملف يُحمَّل في كل صفحة قبل
     سكربتاتها، فهو الموضع الطبيعي لها بدل نسخة رابعة في كل مستهلك جديد. */
  const ROLE_LABELS = {
    owner: "المالك", admin: "مدير النظام", hr: "الموارد البشرية",
    finance: "المالية", viewer: "قراءة فقط",
  };
  /* بطاقة الهوية في الدرج تعرض للمالك الكلمة الإنجليزية أيضًا منذ نشأتها.
     يُحتفظ بها هنا كتجاوز عرضٍ صريح حتى لا يتغيّر نصّ الدرج تبعًا لتغيير
     لم يُطلب فيه. */
  const DRAWER_ROLE_TEXT = { owner: "Owner - المالك" };

  /* تُعيد "" لدور غير معروف — لا تُعرض القيمة البرمجية الخام للمستخدم. */
  function roleLabel(role) {
    return ROLE_LABELS[role] || "";
  }

  function renderDrawer() {
    if (!drawerEl) return;
    /* AdminUI مُعرَّف بـ const على المستوى الأعلى، و const/let لا تُنشئ
       خاصية على window — ففحص window.AdminUI يفشل دائمًا. */
    const u = (typeof AdminUI !== "undefined" && AdminUI.getUser) ? AdminUI.getUser() : null;
    /* الفصل بين الوجهات المستقلة ومراسي الصفحة الرئيسية: المرساة بلا معنى
       حين تكون في صفحة أخرى، فتُعرض عندئذ تحت عنوان مختلف. */
    const pages = DEST.filter((d) => allowed(d) && !d.href.includes("#"));
    const anchors = DEST.filter((d) => allowed(d) && d.href.includes("#"));
    const link = (d) => {
      const active = d.page === page && !d.href.includes("#");
      return `<a class="u-navlink" href="${d.href}"${active ? ' aria-current="page"' : ""}>${svg(d.icon)}${esc(d.label)}</a>`;
    };
    drawerEl.innerHTML = `
      <div class="u-drawer-head">
        <span class="eyebrow">التنقّل</span>
        <button class="u-hdr-btn" type="button" data-nav-close aria-label="إغلاق القائمة">${svg(I.close, 18)}</button>
      </div>
      <div class="u-drawer-sec">الصفحات</div>
      ${pages.map(link).join("")}
      ${anchors.length ? `<div class="u-drawer-sec">${page === "home" ? "أقسام هذه الصفحة" : "أقسام الصفحة الرئيسية"}</div>${anchors.map(link).join("")}` : ""}
      <div class="u-drawer-foot">
        <!-- إعداد خاصّ بهذا الجهاز، فموضعه الطبيعي بجوار بطاقة صاحبه.
             الدرج متاح من كل صفحة، وهو أقرب ما يصل إليه المستخدم على
             الجوال — حيث تُفعَّل الإشعارات أصلًا. -->
        <div class="u-push" data-push-row></div>
        ${u ? `<div class="u-user">
          <span class="u-user-role">${esc(DRAWER_ROLE_TEXT[u.role] || roleLabel(u.role) || u.role || "")}</span>
          <span class="u-user-name">${esc(u.name || "")}</span>
          ${u.jobTitle ? `<span class="u-user-title">${esc(u.jobTitle)}</span>` : ""}
        </div>` : ""}
        <button class="u-navlink danger" type="button" data-nav-logout>${svg(I.logout)}تسجيل الخروج</button>
      </div>`;
    drawerEl.querySelector("[data-nav-close]").addEventListener("click", closeDrawer);
    drawerEl.querySelector("[data-nav-logout]").addEventListener("click", logout);
    renderPushRow();   /* الدرج يُعاد بناؤه، فيُعاد ملء صفّ الإشعارات معه */
    /* الوجهة تُغلق الدرج؛ ومرساة داخل الصفحة نفسها لا تُعيد التحميل فيلزم
       إغلاقها يدويًا قبل القفز. */
    drawerEl.querySelectorAll("a.u-navlink").forEach((a) => a.addEventListener("click", closeDrawer));
  }

  function allowed(d) {
    if (!d.perm) return true;
    if (typeof AdminUI === "undefined" || !AdminUI.can) return false;
    const [section, action] = d.perm.split(":");
    return AdminUI.can(section, action);
  }

  function openDrawer() {
    if (!drawerEl) return;
    scrimEl.classList.add("show");
    drawerEl.classList.add("show");
    document.querySelectorAll("[data-nav-open]").forEach((b) => b.setAttribute("aria-expanded", "true"));
    popDrawer = AdminUI.pushLayer(drawerEl, closeDrawer);
  }
  function closeDrawer() {
    if (!drawerEl) return;
    scrimEl.classList.remove("show");
    drawerEl.classList.remove("show");
    document.querySelectorAll("[data-nav-open]").forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (popDrawer) { popDrawer(); popDrawer = null; }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      location.href = "/login.html";
    }
  }

  /* =====================================================================
     إشعارات الجوال (Web Push)
     ---------------------------------------------------------------------
     كل ما هنا خاصّ بالجهاز الحالي وحده: الاشتراك يُنشئه المتصفّح لهذا
     الجهاز ويُسجَّل باسم صاحب الجلسة، فالتفعيل من جوالك يسجّل جوالك لا
     غيره. الحالات المعروضة: غير مدعوم · يحتاج تثبيتًا (iOS) · غير مُهيّأة
     على الخادم · غير مفعّلة · مفعّلة · الإذن مرفوض. لكلٍّ نصّه، فلا يقف
     المستخدم أمام زرّ صامت لا يعرف لماذا لا يعمل.
     ===================================================================== */
  const PUSH = {
    supported: typeof navigator !== "undefined" && "serviceWorker" in navigator
      && typeof window !== "undefined" && "PushManager" in window && "Notification" in window,
    enabledOnServer: null,   // من /api/push/config
    publicKey: null,
    registration: null,
    subscription: null,
    busy: false,
  };

  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent || "");
  /* iOS لا يمنح Web Push إلا لتطبيق مثبَّت على الشاشة الرئيسية (16.4+):
     في تبويب Safari عادي لا وجود لـPushManager أصلًا. */
  const isStandalone = () =>
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;

  /* المفتاح العام يصل بترميز base64url ويجب أن يُسلَّم للمتصفّح بايتاتٍ. */
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function pushInit() {
    if (!PUSH.supported) { renderPushRow(); return; }
    try {
      const cfg = await (await fetch("/api/push/config")).json();
      PUSH.enabledOnServer = !!(cfg && cfg.enabled);
      PUSH.publicKey = cfg && cfg.publicKey;
    } catch { PUSH.enabledOnServer = false; }
    if (PUSH.enabledOnServer) {
      try {
        PUSH.registration = await navigator.serviceWorker.register("/sw.js");
        PUSH.subscription = await PUSH.registration.pushManager.getSubscription();
      } catch {
        /* تعذّر تسجيل عامل الخدمة — لا يُعرض زرّ لا يمكنه أن يعمل. */
        PUSH.enabledOnServer = false;
      }
    }
    renderPushRow();
  }

  function pushState() {
    if (!PUSH.supported) return isIOS() && !isStandalone() ? "needs_install" : "unsupported";
    if (PUSH.enabledOnServer === null) return "loading";
    if (PUSH.enabledOnServer === false) return "server_off";
    if (Notification.permission === "denied") return "denied";
    return PUSH.subscription ? "on" : "off";
  }

  async function pushEnable() {
    if (PUSH.busy) return;
    PUSH.busy = true; renderPushRow();
    try {
      /* الإذن يجب أن يُطلب من إيماءة مستخدم — وهذا نداء من مُعالِج نقر. */
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;          // مرفوض أو مؤجَّل: الحالة تتكفّل بالرسالة
      const sub = await PUSH.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUSH.publicKey),
      });
      await AdminUI.api("POST", "/api/push/subscribe", { subscription: sub.toJSON() });
      PUSH.subscription = sub;
      AdminUI.toastOk("تم تفعيل إشعارات هذا الجهاز");
    } catch (err) {
      AdminUI.toastError((err && err.message) || "تعذّر تفعيل الإشعارات");
    } finally {
      PUSH.busy = false; renderPushRow();
    }
  }

  async function pushDisable() {
    if (PUSH.busy || !PUSH.subscription) return;
    PUSH.busy = true; renderPushRow();
    const endpoint = PUSH.subscription.endpoint;
    try {
      await PUSH.subscription.unsubscribe();
      PUSH.subscription = null;
      /* تنظيف الخادم بعد إلغاء المتصفّح لا قبله: لو انعكس الترتيب وفشل
         الإلغاء محليًا لبقي صفّ حيّ لجهاز لم يعد مشتركًا. */
      await AdminUI.api("POST", "/api/push/unsubscribe", { endpoint });
      AdminUI.toastOk("تم إيقاف إشعارات هذا الجهاز");
    } catch (err) {
      AdminUI.toastError((err && err.message) || "تعذّر إيقاف الإشعارات");
    } finally {
      PUSH.busy = false; renderPushRow();
    }
  }

  async function pushTest() {
    if (PUSH.busy) return;
    PUSH.busy = true; renderPushRow();
    try {
      const r = await AdminUI.api("POST", "/api/push/test");
      AdminUI.toastOk(`أُرسل إشعار تجريبي إلى ${r.sent} من ${r.total} جهاز`);
    } catch (err) {
      AdminUI.toastError((err && err.message) || "تعذّر إرسال الإشعار التجريبي");
    } finally {
      PUSH.busy = false; renderPushRow();
    }
  }

  const PUSH_TEXT = {
    loading:       "جارٍ التحقّق…",
    unsupported:   "هذا المتصفّح لا يدعم إشعارات الويب",
    needs_install: "أضف التطبيق إلى الشاشة الرئيسية أولًا لتفعيل الإشعارات",
    server_off:    "غير مُهيّأة على الخادم",
    denied:        "الإذن مرفوض — فعّله من إعدادات المتصفّح لهذا الموقع",
    off:           "غير مفعّلة على هذا الجهاز",
    on:            "مفعّلة على هذا الجهاز",
  };

  function renderPushRow() {
    const hosts = document.querySelectorAll("[data-push-row]");
    if (!hosts.length) return;
    const state = pushState();
    const dot = state === "on" ? "on" : state === "denied" ? "bad" : "off";
    const actionable = state === "off" || state === "on";
    const html = `
      <div class="u-push-head">
        <span class="u-push-dot ${dot}" aria-hidden="true"></span>
        <span class="u-push-title">إشعارات الجوال</span>
      </div>
      <div class="u-push-note">${esc(PUSH_TEXT[state] || PUSH_TEXT.loading)}</div>
      ${actionable ? `
        <div class="u-push-actions">
          <button class="u-push-btn${state === "on" ? " danger" : " primary"}" type="button" data-push-toggle${PUSH.busy ? " disabled" : ""}>
            ${PUSH.busy ? "…" : state === "on" ? "إيقاف" : "تفعيل"}
          </button>
          ${state === "on" ? `<button class="u-push-btn" type="button" data-push-test${PUSH.busy ? " disabled" : ""}>إشعار تجريبي</button>` : ""}
        </div>` : ""}`;
    hosts.forEach((host) => {
      host.innerHTML = html;
      const toggle = host.querySelector("[data-push-toggle]");
      if (toggle) toggle.addEventListener("click", () => (pushState() === "on" ? pushDisable() : pushEnable()));
      const test = host.querySelector("[data-push-test]");
      if (test) test.addEventListener("click", pushTest);
    });
  }

  /* ---------- التركيب ----------
     mountChrome(): يُستدعى مبكرًا (DOMContentLoaded) فيبني الهيكل قبل الرسم.
     setUser():     يُستدعى بعد /api/auth/me فيعيد رسم الوجهات المسموحة. */
  function mountChrome(opts) {
    const o = opts || {};
    page = o.page || currentPage();
    headerEl = buildHeader(o);
    tabbarEl = buildTabbar();
    buildDrawer();
    renderTabs();
    renderDrawer();
    return { header: headerEl, slot: headerEl.querySelector("[data-nav-slot]") };
  }

  function setUser() {
    renderTabs();
    renderDrawer();
    /* بعد معرفة المستخدم لا قبلها: نقاط /api/push/* كلها تتطلّب جلسة،
       ونداؤها قبل اكتمال المصادقة يعود بـ401 بلا داعٍ. */
    pushInit();
  }

  /* يضع عنصرًا في الجهة المقابلة من الترويسة (زر إجراء خاص بالصفحة). */
  function headerSlot(html) {
    const slot = headerEl && headerEl.querySelector("[data-nav-slot]");
    if (slot) slot.innerHTML = html;
    return slot;
  }

  return { mountChrome, setUser, openDrawer, closeDrawer, headerSlot, logout, currentPage, roleLabel, svg, ICONS: I };
})();

/* تركيب تلقائي: كل صفحة تحمل <header class="u-hdr" data-app-header> فارغًا
   يحجز المساحة في HTML، فلا يقفز التخطيط حين يملؤه هذا السكربت. الوجهات
   تظهر بعد أن تستدعي الصفحة AppNav.setUser() عقب /api/auth/me. */
(function autoMount() {
  const start = () => AppNav.mountChrome({ title: document.body.dataset.pageTitle || "" });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

