/* staff-travel.js — صفحة «متابعة موظفي ذروة» (/staff-travel.html).
   =========================================================================
   لا يحسب هذا الملف حالة واحدة بنفسه: كل حالة وشارة وتنبيه وعدّاد من
   StaffTravel (staff-travel-status.js) — المصدر نفسه الذي تختبره
   test/staff-travel.test.js.

   البيانات من GET /api/data/staff-travel في طلب واحد: الرحلات، ودليل
   الموظفين المختصر، والعتبات. الكتابة POST/PUT/DELETE على المسار نفسه،
   والخادم يعيد فحص staff_travel:* في كل طلب — إخفاء الأزرار هنا راحة لا أمان.

   «وضع العرض التجريبي» (?demo=1، أو الزرّ حين لم يُنشأ الجدول بعد): بيانات
   مُختلَقة بأسماء وهمية تعيش في الذاكرة وحدها، ليُراجَع التصميم والتدفّق
   كاملًا قبل اعتماد الهجرة. لا يصل منه طلب كتابة واحد إلى الخادم. */
(function () {
  const T = StaffTravel;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const svg = (p, s) => `<svg width="${s || 18}" height="${s || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const IC = {
    plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
    cal: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    back: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
    chev: '<path d="m15 18-6-6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    visa: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M15 9.5a1.5 1.5 0 1 1 0 .01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    travel: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/><path d="M8 14h3M8 17h6"/>',
  };
  const CHIP_ICON = { traveling: IC.plane, soon: IC.clock, returned: IC.back, scheduled: IC.cal };

  const state = {
    trips: [], employees: [], th: T.thresholds(), setupRequired: false, demo: false,
    filter: "all", q: "", groups: [], showAllAlerts: false,
  };
  const canDo = (a) => state.demo || AdminUI.can("staff_travel", a);

  /* ---------------- البيانات ---------------- */
  async function load() {
    if (state.demo) return render();
    const j = await AdminUI.api("GET", "/api/data/staff-travel");
    state.trips = j.items || [];
    state.employees = j.employees || [];
    state.th = T.thresholds(j.thresholds);
    state.setupRequired = !!j.setupRequired;
    render();
  }

  async function save(method, body) {
    if (state.demo) return demoWrite(method, body);
    const j = await AdminUI.api(method, "/api/data/staff-travel", body);
    await load();
    return j;
  }

  /* ---------------- العرض التجريبي (ذاكرة فقط) ---------------- */
  function shift(n) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n);
    return T.todayIso(d);
  }
  function enterDemo() {
    state.demo = true;
    const E = (eid, name, job) => ({ eid, name, job, iqama: "", passport: "" });
    state.employees = [
      E("1001", "أحمد محمد علي", "عامل"), E("1002", "سعود عبدالله محمد", "سائق"),
      E("1003", "محمد إبراهيم حسن", "عامل"), E("1004", "خالد علي أحمد", "فني"),
      E("1005", "عمر فيصل عبدالله", "عامل"), E("1006", "ياسر سالم ناصر", "محاسب"),
      E("1007", "فهد ماجد صالح", "مشرف"),
    ];
    let id = 0;
    const R = (eid, s, e, v, extra) => ({ id: String(++id), employeeEid: eid, startDate: shift(s), endDate: shift(e), visaExpiryDate: shift(v),
      visaNumber: "", visaType: "خروج وعودة", destination: "", notes: "", returnConfirmedAt: null, createdByName: "عرض تجريبي", ...extra });
    state.trips = [
      R("1001", -20, 25, 46, { destination: "القاهرة", visaNumber: "DEMO-0001" }),
      R("1002", 5, 30, 61, { destination: "إسلام آباد" }),
      R("1003", -60, -12, 5, { returnConfirmedAt: new Date().toISOString(), destination: "عمّان" }),
      R("1003", -400, -370, -340, { returnConfirmedAt: new Date().toISOString(), destination: "عمّان" }),
      R("1004", -10, 40, 30, { destination: "مانيلا" }),
      R("1005", -50, -3, -1, { destination: "دكا" }),
      R("1006", 45, 75, 120, { destination: "بيروت" }),
      R("1007", -15, 4, -2, { destination: "الخرطوم" }),
    ];
    state.setupRequired = false;
    render();
  }
  function demoWrite(method, body) {
    const err = method !== "DELETE" && body.action !== "confirm_return" ? T.validateTrip(method === "PUT" ? { ...state.trips.find((t) => t.id === body.id), ...body } : body) : null;
    if (err) throw new Error(err);
    if (method === "POST" && body.action === "confirm_return") {
      const t = state.trips.find((x) => x.id === body.id); if (t) t.returnConfirmedAt = new Date().toISOString();
    } else if (method === "POST") {
      if (state.trips.some((t) => T.overlaps(t, body))) throw new Error("للموظف رحلة أخرى مسجّلة تتداخل مع هذه التواريخ");
      const id = String(Date.now());
      state.trips.push({ ...body, id, returnConfirmedAt: body.endDate < T.todayIso() ? new Date().toISOString() : null, createdByName: "عرض تجريبي" });
    } else if (method === "PUT") {
      const t = state.trips.find((x) => x.id === body.id);
      const next = { ...t, ...body };
      if (state.trips.some((x) => x.id !== t.id && T.overlaps(x, next))) throw new Error("للموظف رحلة أخرى مسجّلة تتداخل مع هذه التواريخ");
      if (next.endDate >= T.todayIso()) next.returnConfirmedAt = null;
      Object.assign(t, next);
    } else if (method === "DELETE") {
      state.trips = state.trips.filter((x) => x.id !== body.id);
    }
    render();
    return { ok: true };
  }

  /* ---------------- الرسم ---------------- */
  function render() {
    const today = T.todayIso();
    state.groups = T.groupByEmployee(state.trips, state.employees, today, state.th);
    renderHead();
    renderSummary(today);
    renderAlerts(today);
    renderTabs();
    renderList(today);
  }

  function renderHead() {
    const add = document.getElementById("tvAdd");
    add.hidden = !canDo("create");
    add.disabled = state.setupRequired && !state.demo;
    const note = document.getElementById("tvNote");
    if (state.demo) {
      note.innerHTML = `<div class="tv-demo"><span><b>عرض تجريبي</b> — أسماء وبيانات وهمية في المتصفّح فقط، لا يُحفظ منها شيء.</span>
        <button class="tv-link" type="button" data-exit-demo>الخروج من العرض التجريبي</button></div>`;
    } else if (state.setupRequired) {
      note.innerHTML = `<div class="tv-setup"><b>القسم جاهز، وجدول الرحلات لم يُنشأ بعد.</b><br>
        إنشاء الجدول (employee_travel) بانتظار اعتماد تصميم قاعدة البيانات — لا تُحفظ أي رحلة قبله.<br>
        <button class="tv-link" type="button" data-demo>عرض بيانات تجريبية لمراجعة التصميم</button></div>`;
    } else note.innerHTML = "";
  }

  function renderSummary(today) {
    const s = T.summary(state.groups, today, state.th);
    const card = (cls, icon, n, l) => `<div class="tv-stat ${cls}"><span class="dot">${svg(icon, 17)}</span><span><span class="n num">${n}</span><span class="l" style="display:block">${l}</span></span></div>`;
    document.getElementById("tvSummary").innerHTML =
      card("go", IC.plane, s.traveling, "مسافرون حاليًا") +
      card("soon", IC.clock, s.soon, `رحلات قريبة (خلال ${state.th.SOON_DAYS} أيام)`) +
      card("visa", IC.visa, s.visaSoon, `تأشيرات تنتهي خلال ${state.th.VISA_SOON_DAYS} يوم`) +
      card("sch", IC.cal, s.scheduled, "رحلات مجدولة");
  }

  function renderAlerts(today) {
    const list = T.alerts(state.groups, today, state.th);
    const host = document.getElementById("tvAlerts");
    if (!list.length) { host.innerHTML = ""; return; }
    const LIMIT = 4;
    const shown = state.showAllAlerts ? list : list.slice(0, LIMIT);
    host.innerHTML = `<section class="tv-alerts" aria-label="التنبيهات">
      <div class="tv-alerts-h"><span>التنبيهات</span><span class="cnt num">${list.length}</span></div>
      ${shown.map((a) => `<button type="button" class="tv-alert ${a.level}" data-open="${esc(a.eid)}" data-trip="${esc(a.tripId)}">
        <span class="b"></span><span><span class="who">${esc(a.name)}</span> — <span class="what">${esc(a.text)}</span></span></button>`).join("")}
      ${list.length > LIMIT ? `<div class="tv-alerts-more"><button class="tv-link" type="button" data-alerts-toggle>${state.showAllAlerts ? "عرض أقل" : `عرض كل التنبيهات (${list.length})`}</button></div>` : ""}
    </section>`;
  }

  const TABS = [
    { key: "all", label: "الكل" }, { key: "traveling", label: "مسافر" }, { key: "soon", label: "قريب السفر" },
    { key: "returned", label: "عاد" }, { key: "scheduled", label: "مجدولة" },
  ];
  function renderTabs() {
    const count = (k) => (k === "all" ? state.groups.length : state.groups.filter((g) => g.status.key === k).length);
    document.getElementById("tvTabs").innerHTML = TABS.map((t) =>
      `<button type="button" role="tab" class="tv-tab" data-filter="${t.key}" aria-selected="${state.filter === t.key}">${t.label}<span class="c num">${count(t.key)}</span></button>`).join("");
  }

  function timeline(trip, st) {
    let pos, lbl, dashed = false, hollow = false, fill;
    if (st.key === "traveling") { pos = 0.1 + st.progress * 0.8; fill = pos; lbl = "في السفر"; }
    else if (st.key === "soon") { pos = 0.18; fill = 0.18; dashed = true; hollow = true; lbl = st.daysToStart === 0 ? "يبدأ اليوم" : `بعد ${T.days(st.daysToStart)}`; }
    else if (st.key === "scheduled") { pos = 0.12; fill = 0.12; dashed = true; hollow = true; lbl = `بعد ${T.days(st.daysToStart)}`; }
    else { pos = 0.5; fill = 1; lbl = "تم العودة"; }
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    return `<div class="tv-line">
      <div class="tv-line-lbl"><span>بداية الرحلة</span><span>نهاية الرحلة</span></div>
      <div class="tv-track ${st.key}${dashed ? " dashed" : ""}${hollow ? " hollow" : ""}">
        <span class="tv-rail"></span><span class="tv-fill" style="width:${pct(fill)}"></span>
        <span class="tv-end s"></span><span class="tv-end e${st.key === "returned" ? " done" : ""}"></span>
        <span class="tv-plane" style="inset-inline-start:${pct(pos)}">${svg(IC.plane, 18)}<span>${esc(lbl)}</span></span>
      </div>
      <div class="tv-line-dates"><span class="num">${T.fmt(trip.startDate)}</span><span class="num">${T.fmt(trip.endDate)}</span></div>
    </div>`;
  }

  /* لرحلة انتهت: التأشيرة لم تعد تعني شيئًا تشغيليًا، فشارتها محايدة
     بدل أحمر يُنذر بلا سبب. */
  function visaRow(trip, today) {
    const vs = T.visaStatus(trip.visaExpiryDate, today, state.th);
    if (T.tripStatus(trip, today, state.th).key === "returned") vs.key = "na";
    return `<div class="tv-visa">${svg(IC.cal, 18)}
      <div class="grow"><div class="k">انتهاء التأشيرة</div><div class="v num">${T.fmt(trip.visaExpiryDate)}</div></div>
      <span class="vchip ${vs.key}">${vs.key === "expired" || vs.key === "urgent" || vs.key === "today" ? svg(IC.alert, 13) : ""}${esc(vs.label)}</span></div>`;
  }

  function warnings(g, trip, st) {
    let out = "";
    if (st.key !== "returned" && T.visaBeforeReturn(trip)) {
      out += `<div class="tv-warn">${svg(IC.alert, 15)}<span>تنبيه: التأشيرة تنتهي قبل موعد العودة</span></div>`;
    }
    if (st.key === "returned" && g.trips[0] && g.trips[0].id === trip.id && !trip.returnConfirmedAt) {
      out += `<div class="tv-warn">${svg(IC.alert, 15)}<span>تجاوز تاريخ العودة بـ${esc(T.days(st.daysSinceEnd))} ولم يُؤكَّد رجوعه</span>
        ${canDo("edit") ? `<button type="button" class="admin-mini-btn act" style="white-space:nowrap" data-confirm-return="${esc(trip.id)}">تأكيد العودة</button>` : ""}</div>`;
    }
    return out;
  }

  function chip(st) {
    return `<span class="tv-chip ${st.key}">${svg(CHIP_ICON[st.key], 14)}${esc(st.label)}</span>`;
  }
  function metaLine(e) {
    return `رقم الموظف: <span class="num">${esc(e.eid)}</span>${e.job ? ` | ${esc(e.job)}` : ""}`;
  }

  function renderList(today) {
    const host = document.getElementById("tvList");
    const rows = state.groups.filter((g) => (state.filter === "all" || g.status.key === state.filter) && T.matches(g, state.q));
    if (!state.groups.length) {
      host.innerHTML = `<div class="tv-empty"><span class="big">لا توجد رحلات مسجّلة</span>
        ${canDo("create") && !(state.setupRequired && !state.demo) ? "ابدأ بزرّ «إضافة رحلة» واختر الموظف من سجلّ الموظفين." : "ستظهر هنا رحلات موظفي ذروة فور تسجيلها."}</div>`;
      return;
    }
    if (!rows.length) {
      host.innerHTML = `<div class="tv-empty"><span class="big">لا نتائج</span>لا يوجد موظف يطابق البحث أو الفلتر الحالي.</div>`;
      return;
    }
    host.innerHTML = rows.map((g) => {
      const trip = g.primary, st = g.status;
      const others = g.trips.length - 1;
      return `<article class="tv-card ${st.key}" tabindex="0" role="button" data-open="${esc(g.eid)}" aria-label="تفاصيل ${esc(g.employee.name)}">
        <div class="tv-top">
          <div class="tv-who"><div class="tv-name">${esc(g.employee.name)}</div><div class="tv-meta">${metaLine(g.employee)}</div></div>
          ${chip(st)}<span class="tv-chev">${svg(IC.chev, 18)}</span>
        </div>
        ${timeline(trip, st)}
        ${visaRow(trip, today)}
        ${warnings(g, trip, st)}
        ${others > 0 ? `<div class="tv-more">${others === 1 ? "رحلة سابقة واحدة" : `${others} رحلات أخرى`} في سجلّ الرحلات</div>` : ""}
      </article>`;
    }).join("");
  }

  /* ---------------- التفاصيل ---------------- */
  function openDetails(eid, tripId) {
    const g = state.groups.find((x) => x.eid === String(eid));
    if (!g) return;
    let sel = (tripId && g.trips.find((t) => t.id === String(tripId))) || g.primary;
    const today = T.todayIso();
    const draw = () => {
      const st = T.tripStatus(sel, today, state.th);
      const vs = T.visaStatus(sel.visaExpiryDate, today, state.th);
      const field = (k, v) => `<div><div class="k">${k}</div><div class="v">${v || "—"}</div></div>`;
      const html = `
        <div class="admin-mhead"><button class="admin-mclose" data-admin-close aria-label="إغلاق">✕</button>
          <h3>${esc(g.employee.name)}</h3></div>
        <div class="admin-mbody">
          <div class="admin-error-msg" data-admin-error></div>
          <div class="tv-meta" style="margin-bottom:10px">${metaLine(g.employee)}</div>
          <div class="tv-d-box tv-card ${st.key}" style="cursor:default;box-shadow:none">
            <div class="tv-top"><div class="tv-who"><div class="tv-name" style="font-size:14px">${sel.id === (g.primary && g.primary.id) ? "الرحلة الحالية" : "رحلة من السجلّ"}</div></div>${chip(st)}</div>
            ${timeline(sel, st)}
            ${visaRow(sel, today)}
            ${warnings(g, sel, st)}
            <div class="tv-d-grid" style="margin-top:12px">
              ${field("وجهة السفر", esc(sel.destination))}
              ${field("نوع التأشيرة", esc(sel.visaType))}
              ${field("رقم التأشيرة", sel.visaNumber ? `<span class="num">${esc(sel.visaNumber)}</span>` : "")}
              ${field("حالة التأشيرة", esc(vs.label))}
              ${field("تأكيد العودة", sel.returnConfirmedAt ? "مؤكَّدة" : st.key === "returned" ? "غير مؤكَّدة" : "—")}
              ${field("أُضيفت بواسطة", esc(sel.createdByName))}
            </div>
            ${sel.notes ? `<div class="tv-d-grid" style="grid-template-columns:1fr;margin:0">${field("ملاحظات", esc(sel.notes).replace(/\n/g, "<br>"))}</div>` : ""}
            <div class="tv-d-actions">
              ${canDo("edit") ? `<button type="button" class="admin-mini-btn" data-edit>تعديل الرحلة</button>` : ""}
              ${canDo("delete") ? `<button type="button" class="admin-mini-btn danger" data-del>حذف الرحلة</button>` : ""}
            </div>
          </div>
          <div class="tv-sec-t"><span>سجل الرحلات <span class="tv-opt num">(${g.trips.length})</span></span>
            ${canDo("create") ? `<button type="button" class="admin-mini-btn" data-add-for>${svg(IC.plus, 14)} رحلة جديدة</button>` : ""}</div>
          <div class="tv-hist">${g.trips.map((t) => {
            const s = T.tripStatus(t, today, state.th);
            return `<button type="button" class="tv-h${t.id === sel.id ? " sel" : ""}" data-pick="${esc(t.id)}">
              <span class="dates num">${T.fmt(t.startDate)} ← ${T.fmt(t.endDate)}</span>
              <span>${chip(s)}</span>
              <span class="sub"><span>انتهاء التأشيرة: <b class="num">${T.fmt(t.visaExpiryDate)}</b></span><span>الوجهة: <b>${esc(t.destination || "—")}</b></span></span>
            </button>`;
          }).join("")}</div>
        </div>
        <div class="admin-mfoot"><button class="admin-btn-ghost" data-admin-close>إغلاق</button></div>`;
      /* التنقّل في السجلّ يعيد رسم النافذة نفسها في مكانها — لا نافذة فوق نافذة. */
      if (m) {
        m.innerHTML = html;
        m.querySelectorAll("[data-admin-close]").forEach((b) => b.addEventListener("click", AdminUI.closeModal));
      } else m = AdminUI.openModal(html, { wide: true });
      m.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { sel = g.trips.find((t) => t.id === b.dataset.pick); draw(); }));
      const ed = m.querySelector("[data-edit]"); if (ed) ed.addEventListener("click", () => afterClose(() => openForm(sel)));
      const del = m.querySelector("[data-del]"); if (del) del.addEventListener("click", () => afterClose(() => removeTrip(sel, g)));
      const add = m.querySelector("[data-add-for]"); if (add) add.addEventListener("click", () => afterClose(() => openForm(null, g.eid)));
      const cr = m.querySelector("[data-confirm-return]"); if (cr) cr.addEventListener("click", () => afterClose(() => confirmReturn(sel.id, () => openDetails(g.eid, sel.id))));
    };
    let m = null;
    draw();
  }

  /* كل طبقة في AdminUI تدفع حالة في سجلّ المتصفّح وتُغلق بـhistory.back().
     فتحُ نافذة فور إغلاق أخرى يجعل popstate المتأخّر يُغلق الجديدة. لذا
     ينتظر الانتقال بين نافذتين حتى يستقرّ السجلّ أولًا. */
  function afterClose(fn) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      window.removeEventListener("popstate", go);
      setTimeout(fn, 0);
    };
    window.addEventListener("popstate", go);
    AdminUI.closeModal();
    setTimeout(go, 450);
  }

  async function removeTrip(trip, g) {
    const ok = await AdminUI.confirmDanger(
      `حذف رحلة ${g.employee.name} (${T.fmt(trip.startDate)} ← ${T.fmt(trip.endDate)}) نهائيًا؟ لا يمكن التراجع عن الحذف.`,
      { confirmLabel: "حذف الرحلة", cancelLabel: "إلغاء" });
    /* الإلغاء يعيد المستخدم إلى التفاصيل حيث كان. */
    if (!ok) return setTimeout(() => openDetails(g.eid, trip.id), 350);
    try {
      await save("DELETE", { id: trip.id });
      AdminUI.toastOk("حُذفت الرحلة");
    } catch (err) { AdminUI.toastError(err.message || "تعذّر الحذف"); }
  }

  async function confirmReturn(id, after) {
    try {
      await save("POST", { action: "confirm_return", id });
      AdminUI.toastOk("تم تأكيد العودة");
      if (after) after();
    } catch (err) { AdminUI.toastError(err.message || "تعذّر تأكيد العودة"); }
  }

  /* ---------------- النموذج ---------------- */
  const VISA_TYPES = ["خروج وعودة", "خروج نهائي", "زيارة", "سياحة", "عمل", "عمرة"];

  function openForm(trip, presetEid) {
    const editing = !!trip;
    const t = trip || { employeeEid: presetEid || "", startDate: "", endDate: "", visaExpiryDate: "", visaNumber: "", visaType: "", destination: "", notes: "" };
    const emps = [...state.employees].sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
    const opt = (e) => `<option value="${esc(e.eid)}"${String(e.eid) === String(t.employeeEid) ? " selected" : ""}>${esc(e.name)} — ${esc(e.eid)}${e.job ? ` (${esc(e.job)})` : ""}</option>`;
    const m = AdminUI.openModal(`
      <div class="admin-mhead"><button class="admin-mclose" data-admin-close aria-label="إغلاق">✕</button>
        <h3>${editing ? "تعديل رحلة" : "إضافة رحلة"}</h3></div>
      <form class="admin-mbody" id="tvForm" novalidate>
        <div class="admin-error-msg" data-admin-error></div>
        <div class="admin-field">
          <label for="fEmp">الموظف</label>
          ${emps.length > 8 ? `<input class="in tv-emp-filter" id="fEmpQ" type="search" placeholder="ابحث بالاسم أو الرقم الوظيفي…" autocomplete="off">` : ""}
          <select class="in" id="fEmp" required><option value="">— اختر الموظف —</option>${emps.map(opt).join("")}</select>
          <div class="hint">من سجلّ الموظفين في المنصّة — لا تُكتب بيانات الموظف يدويًا.</div>
        </div>
        <div class="admin-field-row">
          <div class="admin-field"><label for="fStart">تاريخ بداية الرحلة</label><input class="in" id="fStart" type="date" required value="${esc(t.startDate)}"></div>
          <div class="admin-field"><label for="fEnd">تاريخ نهاية الرحلة</label><input class="in" id="fEnd" type="date" required value="${esc(t.endDate)}"></div>
        </div>
        <div class="admin-field"><label for="fVisa">تاريخ انتهاء التأشيرة</label><input class="in" id="fVisa" type="date" required value="${esc(t.visaExpiryDate)}"></div>
        <div class="tv-form-note" id="fPreview"></div>
        <div class="admin-field-row">
          <div class="admin-field"><label for="fVisaNo">رقم التأشيرة <span class="tv-opt">— اختياري</span></label><input class="in num" id="fVisaNo" maxlength="40" autocomplete="off" value="${esc(t.visaNumber)}"></div>
          <div class="admin-field"><label for="fVisaType">نوع التأشيرة <span class="tv-opt">— اختياري</span></label>
            <input class="in" id="fVisaType" maxlength="60" list="fVisaTypes" value="${esc(t.visaType)}">
            <datalist id="fVisaTypes">${VISA_TYPES.map((v) => `<option value="${esc(v)}">`).join("")}</datalist></div>
        </div>
        <div class="admin-field"><label for="fDest">وجهة السفر <span class="tv-opt">— اختياري</span></label><input class="in" id="fDest" maxlength="120" value="${esc(t.destination)}"></div>
        <div class="admin-field"><label for="fNotes">ملاحظات <span class="tv-opt">— اختياري</span></label><textarea class="in" id="fNotes" maxlength="1000">${esc(t.notes)}</textarea></div>
      </form>
      <div class="admin-mfoot">
        <button class="admin-btn-ghost" type="button" data-admin-close>إلغاء</button>
        <button class="admin-btn-primary" type="button" id="fSave">${editing ? "حفظ التعديلات" : "إضافة الرحلة"}</button>
      </div>`);
    const $ = (id) => m.querySelector("#" + id);
    const read = () => ({
      employeeEid: $("fEmp").value, startDate: $("fStart").value, endDate: $("fEnd").value, visaExpiryDate: $("fVisa").value,
      visaNumber: $("fVisaNo").value.trim(), visaType: $("fVisaType").value.trim(), destination: $("fDest").value.trim(), notes: $("fNotes").value.trim(),
    });
    /* معاينة حيّة: الحالة التي ستُشتقّ، وتحذير التأشيرة قبل العودة، والتداخل. */
    const preview = () => {
      const v = read(), el = $("fPreview");
      const msgs = [];
      let bad = false;
      if (T.isIso(v.startDate) && T.isIso(v.endDate) && v.endDate >= v.startDate) {
        msgs.push(`الحالة ستُحسب تلقائيًا: <b>${esc(T.tripStatus(v, T.todayIso(), state.th).label)}</b>`);
        if (T.isIso(v.visaExpiryDate) && T.visaBeforeReturn(v)) { msgs.push("تنبيه: التأشيرة تنتهي قبل موعد العودة"); bad = true; }
        if (v.employeeEid && state.trips.some((x) => (!editing || x.id !== trip.id) && T.overlaps(x, v))) { msgs.push("للموظف رحلة أخرى تتداخل مع هذه التواريخ"); bad = true; }
      } else if (T.isIso(v.startDate) && T.isIso(v.endDate)) { msgs.push("تاريخ النهاية قبل تاريخ البداية"); bad = true; }
      el.className = "tv-form-note" + (msgs.length ? " show " + (bad ? "bad" : "info") : "");
      el.innerHTML = msgs.join("<br>");
    };
    m.querySelectorAll("input,select,textarea").forEach((x) => x.addEventListener("input", preview));
    preview();
    const q = $("fEmpQ");
    if (q) q.addEventListener("input", () => {
      const n = T.norm(q.value);
      $("fEmp").querySelectorAll("option[value]").forEach((o) => { if (o.value) o.hidden = !!n && !T.norm(o.textContent).includes(n); });
    });
    $("fSave").addEventListener("click", async () => {
      const v = read();
      const err = T.validateTrip(v);
      if (err) return AdminUI.showError(m, err);
      const btn = $("fSave"); btn.disabled = true;
      try {
        await save(editing ? "PUT" : "POST", editing ? { id: trip.id, ...v } : v);
        AdminUI.toastOk(editing ? "حُفظت التعديلات" : "أُضيفت الرحلة");
        afterClose(() => openDetails(v.employeeEid));
      } catch (e) {
        AdminUI.showError(m, e.message || "تعذّر الحفظ");
        btn.disabled = false;
      }
    });
  }

  /* ---------------- الأحداث ---------------- */
  function wire() {
    document.getElementById("tvAdd").addEventListener("click", () => openForm(null));
    document.getElementById("tvTabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filter]"); if (!b) return;
      state.filter = b.dataset.filter; renderTabs(); renderList(T.todayIso());
    });
    document.getElementById("tvQ").addEventListener("input", (e) => { state.q = e.target.value; renderList(T.todayIso()); });
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-demo]")) return enterDemo();
      if (e.target.closest("[data-exit-demo]")) { state.demo = false; return load().catch(fail); }
      if (e.target.closest("[data-alerts-toggle]")) { state.showAllAlerts = !state.showAllAlerts; return renderAlerts(T.todayIso()); }
      const cr = e.target.closest("#tvList [data-confirm-return]");
      if (cr) { e.stopPropagation(); return confirmReturn(cr.dataset.confirmReturn); }
      const o = e.target.closest("#appRoot [data-open]");
      if (o) openDetails(o.dataset.open, o.dataset.trip);
    });
    document.getElementById("tvList").addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches(".tv-card")) { e.preventDefault(); openDetails(e.target.dataset.open); }
    });
  }

  function fail(err) {
    document.getElementById("tvList").innerHTML = `<div class="tv-empty">تعذّر تحميل البيانات — تحقّق من الاتصال وأعد تحميل الصفحة.</div>`;
    AdminUI.toastError((err && err.message) || "تعذّر تحميل البيانات");
  }

  async function boot() {
    try {
      const r = await fetch("/api/auth/me");
      if (!r.ok) { location.href = "/login.html"; return; }
      const j = await r.json();
      AdminUI.setUser(j.user);
      AppNav.setUser();
    } catch { location.href = "/login.html"; return; }
    if (!AdminUI.can("staff_travel", "view")) {
      document.getElementById("appRoot").innerHTML = `<main class="block wrap"><div class="access-denied">لا تملك صلاحية عرض متابعة موظفي ذروة.<br><a class="back-link" href="/">العودة إلى الرئيسية</a></div></main>`;
      return;
    }
    wire();
    if (new URLSearchParams(location.search).get("demo") === "1") return enterDemo();
    load().catch(fail);
  }

  /* للاختبارات في المتصفّح فقط. */
  window.StaffTravelPage = { state, render, enterDemo };
  boot();
})();
