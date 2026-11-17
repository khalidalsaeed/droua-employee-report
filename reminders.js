/* reminders.js — قسم «التذكيرات» في الصفحة الرئيسية.
   =========================================================================
   جدول تذكيرات موحّد: كل وثيقة لها تاريخ انتهاء صفٌّ مستقلّ، مهما كان
   مصدرها. حلّ محلّ قسم «الوثائق القادمة على انتهاء الصلاحية» (الحلقة،
   «أكثر الوثائق إلحاحًا»، «حسب المدة / حسب الموظف»).

   طبقة تجميع (Aggregation) فوق المصادر القائمة — لا جدول جديد ولا هجرة
   ولا نداء شبكة من هذا الملف. المُضيف (app-shell.html) يمرّر ما جلبه أصلًا:

     النوع            المصدر                                   صلاحية العرض
     ───────────────  ───────────────────────────────────────  ────────────────
     الإقامة          employees.data["تاريخ انتهاء الإقامة"]     employees:view
     رخصة العمل       employees.data["تاريخ انتهاء رخصة العمل"]  employees:view
     جواز السفر       employees.data["تاريخ انتهاء الجواز"]      employees:view
     تصريح أجير       ajeer_permits.expiry_date (الأحدث لكل إقامة) ajeer:view
     البطاقة البلدية  municipal-cards/index.json (متجر خاصّ)      municipal:view
     تأشيرة السفر     employee_travel.visa_expiry_date (رحلة قائمة) staff_travel:view

   الصلاحيات تُفرض مرّتين: الخادم لا يعيد بيانات قسم لا يملك المستخدم عرضه
   (403 ⇒ مصفوفة فارغة)، وهذا الملف يُسقط مصدر النوع كاملًا إن لم يملك
   صلاحية عرضه — فلا يظهر صفّه ولا عدّه في الفلتر، لا زرّه وحده.

   التواريخ: يوم الانتهاء يوم تقويمي (dayKey) واليوم بتوقيت الرياض
   (todayKey)، والفرق بينهما بالأيام التقويمية — فلا ينزلق يوم في متصفّح
   خارج المملكة. الحالات بعتبات القسم السابق نفسها: منتهي، 0–10، 11–30،
   31–90.

   سكربت كلاسيكي → Reminders في النطاق العام؛ والدوالّ النقيّة تُختبر عبر
   require. */
(function (root) {
  "use strict";

  /* DocStatus مُعرَّف بـconst في doc-status.js — في النطاق العام لا على window. */
  const DS = typeof DocStatus !== "undefined" ? DocStatus : require("./doc-status.js");

  const WINDOW = 90;   // «جميع الحالات»: المنتهية وما ينتهي خلال 90 يومًا
  const PREVIEW = 8;   // الصفوف في الصفحة الرئيسية قبل «عرض جميع التذكيرات»
  const PAGE = 20;     // صفوف الصفحة الواحدة بعد التوسيع
  const PLATFORM_TZ = "Asia/Riyadh";

  /* أنواع الوثائق التي لها مصدر بيانات فعلي في المنصّة — لا غيرها.
     perm صلاحية العرض التي تُظهر النوع وبياناته. */
  const TYPES = [
    { key: "iqama", label: "الإقامة", perm: ["employees", "view"] },
    { key: "work_license", label: "رخصة العمل", perm: ["employees", "view"] },
    { key: "passport", label: "جواز السفر", perm: ["employees", "view"] },
    { key: "ajeer", label: "تصريح أجير", perm: ["ajeer", "view"] },
    { key: "municipal", label: "البطاقة البلدية", perm: ["municipal", "view"] },
    { key: "visa", label: "تأشيرة السفر", perm: ["staff_travel", "view"] },
  ];
  const TYPE = Object.fromEntries(TYPES.map((t, i) => [t.key, { ...t, order: i }]));

  /* الحالات بترتيب الخطورة. */
  const STATUSES = [
    { key: "expired", label: "منتهي" },
    { key: "urgent", label: "عاجل" },          // 0–10
    { key: "soon", label: "قريب الانتهاء" },   // 11–30
    { key: "watch", label: "تحت المتابعة" },   // 31–90
    { key: "ok", label: "ساري" },              // أبعد من 90 (مدة محددة فقط)
  ];
  const STATUS = Object.fromEntries(STATUSES.map((s) => [s.key, s]));

  const PERIODS = [
    { key: "all", label: "جميع الحالات" },
    { key: "week", label: "هذا الأسبوع" },
    { key: "month", label: "هذا الشهر" },
    { key: "next_month", label: "الشهر القادم" },
    { key: "custom", label: "مدة محددة" },
  ];

  /* ── التواريخ ─────────────────────────────────────────────────────────
     dayKey: يوم الانتهاء الفعلي بصيغة YYYY-MM-DD.
       • تاريخ بلا وقت (YYYY-MM-DD أو M/D/YYYY) يوم تقويمي كما كُتب.
       • وقت بلا منطقة يُؤخذ يومه المكتوب.
       • لحظة مطلقة (Z أو ‎+03:00 أو Date) تُقرأ بتوقيت الرياض.
     ما لا يُفهم يُعاد null. (نُقلت كما هي من doc-expiry.js مع اختباراتها.) */
  const pad2 = (n) => String(n).padStart(2, "0");
  function ymd(y, m, d) {
    if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  function zonedYmd(date, tz) {
    if (!(date instanceof Date) || isNaN(date)) return null;
    try {
      const p = {};
      new Intl.DateTimeFormat("en-CA", { timeZone: tz || PLATFORM_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
      return ymd(Number(p.year), Number(p.month), Number(p.day));
    } catch (e) {
      const t = new Date(date.getTime() + 3 * 3600000); // الرياض +03:00 بلا توقيت صيفي
      return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
  }
  const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;
  const RE_MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?$/i;
  function dayKey(s, tz) {
    if (s == null || s === "") return null;
    if (s instanceof Date) return zonedYmd(s, tz);
    const v = String(s).trim();
    let m = RE_ISO.exec(v);
    if (m) return m[4] ? zonedYmd(new Date(v.replace(" ", "T")), tz) : ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    m = RE_MDY.exec(v);
    if (m) return ymd(Number(m[3]), Number(m[1]), Number(m[2])); // M/D/YYYY كما يقرؤها DocStatus.parseDate
    return null;
  }
  /* «اليوم» بتوقيت الرياض، لا بتوقيت الجهاز. */
  function todayKey(now) { return zonedYmd(now instanceof Date ? now : new Date(), PLATFORM_TZ); }
  const dayNum = (k) => { const [y, m, d] = k.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
  const keyOf = (num) => { const t = new Date(num * 86400000); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
  function daysBetween(fromKey, toKey) { return dayNum(toKey) - dayNum(fromKey); }

  /* ── الحالة ونصّها ── */
  function statusKey(n) {
    if (n < 0) return "expired";
    if (n <= 10) return "urgent";
    if (n <= 30) return "soon";
    if (n <= WINDOW) return "watch";
    return "ok";
  }
  /* العدد مع معدوده: يوم واحد، يومين/يومان، 3–10 أيام، 11+ يومًا */
  function daysPhrase(a, nominative) {
    if (a === 1) return "يوم واحد";
    if (a === 2) return nominative ? "يومان" : "يومين";
    if (a >= 3 && a <= 10) return `${a} أيام`;
    return `${a} يومًا`;
  }
  /* المدة الحقيقية دائمًا ظاهرة — لا «عاجل» وحدها. */
  function statusDetail(n) {
    const a = Math.abs(n);
    if (n < 0) return `منذ ${daysPhrase(a)}`;
    if (n === 0) return "ينتهي اليوم";
    if (n <= 10) return `ينتهي خلال ${daysPhrase(a)}`;
    if (n <= 30) return `ينتهي بعد ${daysPhrase(a)}`;
    return `باقي ${daysPhrase(a, true)}`;
  }

  const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  const AR_DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  /* «الخميس 19 نوفمبر»، ومع السنة إن لم تكن السنة الحالية. */
  function fmtDay(key, today) {
    if (!key) return "—";
    const [y, m, d] = key.split("-").map(Number);
    const wd = AR_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const sameYear = today && Number(today.slice(0, 4)) === y;
    return `${wd} ${d} ${AR_MONTHS[m - 1]}${sameYear ? "" : ` ${y}`}`;
  }

  /* ── فلتر المدة: مدى أيام [from, to] شاملًا، أو null = بلا حدّ ──
     الأسبوع من الأحد إلى السبت (أسبوع العمل في المملكة). «جميع الحالات»
     = المنتهية كلها وما ينتهي خلال 90 يومًا. */
  function periodRange(period, today, custom) {
    const t = dayNum(today);
    const [y, m] = today.split("-").map(Number);
    if (period === "week") {
      const wd = new Date(t * 86400000).getUTCDay();
      return { from: keyOf(t - wd), to: keyOf(t - wd + 6) };
    }
    if (period === "month") return { from: ymd(y, m, 1), to: keyOf(dayNum(m === 12 ? ymd(y + 1, 1, 1) : ymd(y, m + 1, 1)) - 1) };
    if (period === "next_month") {
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      return { from: ymd(ny, nm, 1), to: keyOf(dayNum(nm === 12 ? ymd(ny + 1, 1, 1) : ymd(ny, nm + 1, 1)) - 1) };
    }
    if (period === "custom") {
      const from = dayKey(custom && custom.from), to = dayKey(custom && custom.to);
      if (from && to && from > to) return { from: to, to: from };
      return { from: from || null, to: to || null };
    }
    return { from: null, to: keyOf(t + WINDOW) }; // all
  }
  function inRange(day, r) {
    if (!r) return true;
    if (r.from && day < r.from) return false;
    if (r.to && day > r.to) return false;
    return true;
  }

  /* بحث مُطبَّع: الأرقام الهندية، وصور الألف والتاء المربوطة والياء والتشكيل. */
  function norm(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
      .replace(/[ً-ْـ]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
      .replace(/\s+/g, " ").trim();
  }

  /* ── بناء التذكيرات من المصادر ─────────────────────────────────────────
     input: { employees, permits, municipal, travel:{items, people} }
     ctx:   { can(section, action), today: "YYYY-MM-DD" }
     يُعيد كل وثيقة لها تاريخ انتهاء مفهوم من الأنواع المسموح بعرضها، صفًّا
     لكل وثيقة — لا تجميع حسب الموظف. الترتيب: الأخطر أوّلًا. */
  function build(input, ctx) {
    const src = input || {};
    const can = (ctx && ctx.can) || (() => false);
    const today = (ctx && ctx.today) || todayKey();
    const F = DS.F;
    const allowed = (type) => { const p = TYPE[type].perm; return !!can(p[0], p[1]); };
    const employees = Array.isArray(src.employees) ? src.employees : [];
    const byIqama = new Map(), byEid = new Map();
    employees.forEach((e, i) => {
      if (!e) return;
      if (e[F.iqama] != null && e[F.iqama] !== "") byIqama.set(String(e[F.iqama]), i);
      if (e[F.damanah] != null && e[F.damanah] !== "") byEid.set(String(e[F.damanah]), i);
    });
    /* بيانات الموظف المعروضة: من سجلّه إن كان المستخدم يراه، وإلّا ما طُبع
       على المستند نفسه. */
    const person = (i, fallback) => {
      const e = i != null && i >= 0 ? employees[i] : null;
      return {
        empIndex: e ? i : -1,
        name: (e && e[F.name]) || (fallback && fallback.name) || "",
        job: (e && e[F.job]) || (fallback && fallback.job) || "",
        number: e ? String(e[F.damanah] == null ? "" : e[F.damanah]) : String((fallback && fallback.number) || ""),
        iqama: e ? String(e[F.iqama] == null ? "" : e[F.iqama]) : String((fallback && fallback.iqama) || ""),
        photo: e ? { eid: e[F.damanah], email: e[F.email] } : (fallback && fallback.photo) || null,
      };
    };
    const out = [];
    const push = (type, id, raw, who, extra) => {
      const day = dayKey(raw);
      if (!day) return; // وثيقة بلا تاريخ مسجَّل أو بصيغة غير مفهومة
      const n = daysBetween(today, day);
      const st = statusKey(n);
      const item = { key: `${type}:${id}`, type, typeLabel: TYPE[type].label, day, n, status: st, ...who, ...(extra || {}) };
      item.hay = norm([item.name, item.altName, item.number, item.iqama, item.job, item.docNo].filter(Boolean).join(" "));
      out.push(item);
    };

    if (allowed("iqama") || allowed("work_license") || allowed("passport")) {
      employees.forEach((e, i) => {
        if (!e) return;
        const id = e[F.damanah] != null ? e[F.damanah] : `i${i}`;
        const who = person(i);
        if (allowed("iqama")) push("iqama", id, e[F.iqExp], who);
        /* «جاري السداد»: إجراؤها جارٍ فعلًا — خارج المتابعة في المنصّة كلها. */
        if (allowed("work_license") && !e._licPending) push("work_license", id, e[F.licExp], who);
        if (allowed("passport")) push("passport", id, e[F.passExp], who);
      });
    }

    if (allowed("ajeer")) {
      /* الأحدث لكل إقامة — القاعدة نفسها التي يرسم بها قسم أجير. */
      DS.latestPermits(src.permits).forEach((p) => {
        const i = byIqama.has(String(p.iqama)) ? byIqama.get(String(p.iqama)) : -1;
        const who = person(i, { name: p.nameOnPermit, iqama: p.iqama });
        push("ajeer", p.permit, p.expiryDate, who, {
          altName: p.nameOnPermit, docNo: p.permit,
          ref: { permit: p.permit, hasFile: !!p.file },
        });
      });
    }

    if (allowed("municipal")) {
      (Array.isArray(src.municipal) ? src.municipal : []).forEach((c) => {
        if (!c || !c.cardId) return;
        const i = c.employeeEid != null && byEid.has(String(c.employeeEid)) ? byEid.get(String(c.employeeEid)) : -1;
        const who = person(i, { name: c.nameOnCard, job: c.occupation, number: c.employeeEid });
        push("municipal", c.cardId, c.expiryDate, who, {
          altName: c.nameOnCard, docNo: c.certificateNumber,
          ref: { cardId: c.cardId, hasQr: !!c.hasQr },
        });
      });
    }

    if (allowed("visa")) {
      const travel = src.travel || {};
      const people = new Map((Array.isArray(travel.people) ? travel.people : []).filter((p) => p && p.staffId).map((p) => [String(p.staffId), p]));
      const trips = Array.isArray(travel.items) ? travel.items : [];
      /* رحلة عاد صاحبها لا تُذكَّر بتأشيرتها: أكّد عودته، أو بدأت له رحلة
         لاحقة فعلًا (القاعدة الضمنية في staff-travel-status.js). */
      const laterStart = new Map();
      trips.forEach((t) => { if (t && t.staffId && t.startDate && t.startDate <= today) {
        const k = String(t.staffId); if (!laterStart.has(k) || t.startDate > laterStart.get(k)) laterStart.set(k, t.startDate); } });
      trips.forEach((t) => {
        if (!t || !t.staffId || t.returnConfirmedAt) return;
        const latest = laterStart.get(String(t.staffId));
        if (latest && t.startDate && latest > t.startDate) return;
        const p = people.get(String(t.staffId));
        const i = p && p.source === "ajeer" && byEid.has(String(p.number)) ? byEid.get(String(p.number)) : -1;
        const who = person(i, p ? { name: p.name, job: p.job, number: p.number } : { name: "" });
        push("visa", t.id, t.visaExpiryDate, who, { visaType: t.visaType || "", ref: { tripId: t.id } });
      });
    }

    return out.sort(compare);
  }

  /* الأخطر أوّلًا: الأقدم انتهاءً، ثم المنتهي حديثًا، ثم الأقلّ أيامًا
     متبقّية فالأبعد. التعادل: ترتيب الأنواع ثم الاسم. */
  function compare(a, b) {
    return a.n - b.n || TYPE[a.type].order - TYPE[b.type].order || String(a.name).localeCompare(String(b.name), "ar");
  }

  /* ── التصفية والعدّ ──
     state: { q, types:Set|Array, period, custom:{from,to} }
     العدّ بجانب كل نوع يتبع البحث والمدة الحاليين (وما يسمح به الدور)،
     لا فلتر النوع نفسه — فيبقى كل خيار يقول كم سيُظهر لو اختير. */
  function filter(items, state, today) {
    const s = state || {};
    const t = today || todayKey();
    const r = periodRange(s.period || "all", t, s.custom);
    const q = norm(s.q);
    const types = new Set(s.types || []);
    const base = items.filter((it) => inRange(it.day, r) && (!q || it.hay.includes(q)));
    const counts = Object.fromEntries(TYPES.map((x) => [x.key, 0]));
    base.forEach((it) => { counts[it.type]++; });
    const rows = types.size ? base.filter((it) => types.has(it.type)) : base;
    return { rows, counts, total: base.length, range: r };
  }

  /* الأنواع التي تظهر في الفلتر: ما يسمح به الدور ويوجد له سجلّ واحد
     على الأقل بتاريخ انتهاء — نوع بلا أي بيانات لا يُعرض خيارًا فارغًا. */
  function availableTypes(items) {
    const seen = new Set(items.map((it) => it.type));
    return TYPES.filter((t) => seen.has(t.key));
  }

  /* ── الإجراءات الفعلية لكل صفّ — لا زرّ بلا وظيفة حقيقية ──
     h: المعالجات التي يوفّرها المُضيف. غياب المعالج = لا زرّ. */
  function actionsFor(it, can, h) {
    const H = h || {};
    const a = [];
    const emp = it.empIndex >= 0 && can("employees", "view") && H.openEmployee;
    if (it.type === "ajeer") {
      if (can("ajeer", "manage") && H.renewAjeer) a.push({ act: "renew", label: "تجديد المستند", icon: "renew", primary: true });
      if (it.ref.hasFile && H.ajeerDoc) a.push({ act: "doc", label: "عرض التصريح", icon: "doc" });
      if (it.ref.hasFile && H.ajeerQr) a.push({ act: "qr", label: "عرض الباركود", icon: "qr" });
    } else if (it.type === "municipal") {
      if (can("municipal", "manage") && H.renewMunicipal) a.push({ act: "renew", label: "تجديد المستند", icon: "renew", primary: true });
      if (it.ref.hasQr && H.municipalQr) a.push({ act: "qr", label: "عرض الباركود", icon: "qr" });
    } else if (it.type === "visa") {
      a.push({ act: "travel", label: "متابعة السفر", icon: "travel", href: "/staff-travel.html", primary: true });
    } else if (emp && can("employees", "edit") && H.editEmployee) {
      /* نموذج التعديل القائم: رفع المستند يستخرج تاريخ الانتهاء الجديد. */
      a.push({ act: "edit", label: "تحديث البيانات", icon: "edit", primary: true });
    }
    if (emp) a.push({ act: "emp", label: "عرض الموظف", icon: "user" });
    if (a.length && !a.some((x) => x.primary)) a[0].primary = true;
    return a;
  }

  /* ── الرسم (المتصفّح وحده) ─────────────────────────────────────────── */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ICON = {
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    filter: '<path d="M4 5h16l-6 8v5l-4 2v-7z"/>',
    renew: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    travel: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const svg = (k, s) => `<svg width="${s || 16}" height="${s || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const initials = (name) => { const p = String(name || "").trim().split(/\s+/); return (p[0] || "").slice(0, 1) + ((p[1] || "").slice(0, 1) || ""); };
  function remindersPhrase(n) {
    if (n === 0) return "لا تذكيرات";
    if (n === 1) return "تذكير واحد";
    if (n === 2) return "تذكيران";
    if (n <= 10) return `${n} تذكيرات`;
    return `${n} تذكيرًا`;
  }

  const S = {
    el: null, opts: null, sources: { employees: [], permits: [], municipal: [], travel: null },
    items: [], q: "", types: new Set(), period: "all", custom: { from: "", to: "" }, expanded: false, page: 0, typesOpen: false,
  };
  const can = (sec, act) => !!(S.opts && S.opts.can && S.opts.can(sec, act));

  function mount(el, opts) {
    if (!el) return;
    S.el = el; S.opts = opts || {};
    el.innerHTML = `
      <div class="rm-tools">
        <label class="rm-search">${svg("search", 18)}
          <input type="search" id="rmQ" placeholder="ابحث باسم الموظف، رقم الموظف، رقم الهوية..." aria-label="ابحث في التذكيرات" autocomplete="off">
        </label>
        <div class="rm-types">
          <button type="button" class="rm-select" id="rmTypesBtn" aria-haspopup="true" aria-expanded="false" aria-controls="rmTypesPop">
            ${svg("filter", 16)}<span class="rm-select-t" id="rmTypesLbl">كل الأنواع</span>${svg("chev", 16)}
          </button>
          <div class="rm-pop" id="rmTypesPop" role="group" aria-label="نوع الوثيقة" hidden></div>
        </div>
        <label class="rm-period">${svg("cal", 16)}
          <select id="rmPeriod" aria-label="المدة">${PERIODS.map((p) => `<option value="${p.key}">${p.label}</option>`).join("")}</select>
          ${svg("chev", 16)}
        </label>
        <div class="rm-custom" id="rmCustom" hidden>
          <label><span>من</span><input type="date" id="rmFrom"></label>
          <label><span>إلى</span><input type="date" id="rmTo"></label>
        </div>
      </div>
      <p class="rm-meta" id="rmMeta" aria-live="polite"></p>
      <div class="rm-list" id="rmList"></div>
      <div class="rm-foot" id="rmFoot"></div>`;
    wire();
    refresh();
  }

  function wire() {
    const $ = (id) => S.el.querySelector(`#${id}`);
    let t;
    $("rmQ").addEventListener("input", (ev) => { S.q = ev.target.value; clearTimeout(t); t = setTimeout(() => { S.page = 0; draw(); }, 140); });
    $("rmPeriod").addEventListener("change", (ev) => {
      S.period = ev.target.value; S.page = 0;
      $("rmCustom").hidden = S.period !== "custom";
      draw();
    });
    ["rmFrom", "rmTo"].forEach((id) => $(id).addEventListener("change", () => {
      S.custom = { from: $("rmFrom").value, to: $("rmTo").value }; S.page = 0; draw();
    }));
    $("rmTypesBtn").addEventListener("click", () => toggleTypes(!S.typesOpen));
    $("rmTypesPop").addEventListener("change", (ev) => {
      const cb = ev.target.closest("input[type=checkbox]");
      if (!cb) return;
      if (cb.value === "") S.types.clear();
      else if (cb.checked) S.types.add(cb.value); else S.types.delete(cb.value);
      S.page = 0; draw();
    });
    document.addEventListener("click", (ev) => { if (S.typesOpen && !ev.target.closest(".rm-types")) toggleTypes(false); });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && S.typesOpen) { toggleTypes(false); $("rmTypesBtn").focus({ preventScroll: true }); }
    });
    S.el.addEventListener("click", onAction);
  }

  function toggleTypes(open) {
    S.typesOpen = open;
    const pop = S.el.querySelector("#rmTypesPop"), btn = S.el.querySelector("#rmTypesBtn");
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) { const f = pop.querySelector("input"); if (f) f.focus({ preventScroll: true }); }
  }

  function onAction(ev) {
    const b = ev.target.closest("[data-rm-act]");
    if (b) {
      const it = S.items.find((x) => x.key === b.dataset.rmKey);
      if (!it) return;
      const H = S.opts.handlers || {};
      const act = b.dataset.rmAct;
      if (act === "emp") H.openEmployee(it.empIndex);
      else if (act === "edit") H.editEmployee(it.empIndex, it.type);
      else if (act === "renew" && it.type === "ajeer" && can("ajeer", "manage")) H.renewAjeer(it.ref.permit);
      else if (act === "renew" && it.type === "municipal" && can("municipal", "manage")) H.renewMunicipal(it.ref.cardId);
      else if (act === "doc") H.ajeerDoc(it.ref.permit);
      else if (act === "qr" && it.type === "ajeer") H.ajeerQr(it.ref.permit);
      else if (act === "qr" && it.type === "municipal") H.municipalQr(it.ref.cardId);
      return;
    }
    const nav = ev.target.closest("[data-rm-nav]");
    if (!nav) return;
    const v = nav.dataset.rmNav;
    if (v === "all") { S.expanded = true; S.page = 0; }
    else if (v === "less") { S.expanded = false; S.page = 0; scrollTop(); }
    else if (v === "reset") { resetFilters(); }
    else { S.page = Math.max(0, S.page + (v === "next" ? 1 : -1)); scrollTop(); }
    draw();
  }

  function resetFilters() {
    S.q = ""; S.types.clear(); S.period = "all"; S.custom = { from: "", to: "" }; S.page = 0;
    const $ = (id) => S.el.querySelector(`#${id}`);
    $("rmQ").value = ""; $("rmPeriod").value = "all"; $("rmFrom").value = ""; $("rmTo").value = ""; $("rmCustom").hidden = true;
  }

  function scrollTop() {
    const sec = S.el.closest("section") || S.el;
    const r = sec.getBoundingClientRect();
    if (r.top < 0) sec.scrollIntoView({ block: "start", behavior: "auto" });
  }

  /* يُستدعى بعد كل تحميل أو تعديل لمصدر (تجديد، تعديل تاريخ…) — يُعيد بناء
     التذكيرات من البيانات الحالية ويحتفظ بالبحث والفلاتر والصفحة. */
  function update(partial) {
    Object.assign(S.sources, partial || {});
    refresh();
  }

  function refresh() {
    if (!S.el) return;
    S.today = todayKey();
    S.items = build(S.sources, { can, today: S.today });
    /* نوع اختير ثم اختفى (لا بيانات له الآن) لا يبقى فلترًا خفيًّا. */
    const avail = new Set(availableTypes(S.items).map((t) => t.key));
    [...S.types].forEach((k) => { if (!avail.has(k)) S.types.delete(k); });
    draw();
  }

  function drawTypes(counts) {
    const pop = S.el.querySelector("#rmTypesPop");
    const types = availableTypes(S.items);
    /* إعادة الرسم تستبدل الخيارات — يبقى التركيز على الخيار نفسه. */
    const focused = pop.contains(document.activeElement) ? document.activeElement.value : null;
    const total = types.reduce((s, t) => s + counts[t.key], 0);
    pop.innerHTML = `
      <label class="rm-opt rm-opt-all"><input type="checkbox" value=""${S.types.size ? "" : " checked"}><span>كل الأنواع</span> <b class="num">${total}</b></label>
      ${types.map((t) => `<label class="rm-opt"><input type="checkbox" value="${t.key}"${S.types.has(t.key) ? " checked" : ""}><span>${esc(t.label)}</span> <b class="num">${counts[t.key]}</b></label>`).join("")}`;
    if (focused != null) { const f = pop.querySelector(`input[value="${focused}"]`); if (f) f.focus({ preventScroll: true }); }
    const lbl = S.el.querySelector("#rmTypesLbl");
    const picked = types.filter((t) => S.types.has(t.key));
    lbl.textContent = !picked.length ? "كل الأنواع" : picked.length === 1 ? picked[0].label : `${picked.length} أنواع`;
    S.el.querySelector("#rmTypesBtn").classList.toggle("on", picked.length > 0);
  }

  function avatar(it) {
    const img = it.photo && S.opts.photoImg ? S.opts.photoImg(it.photo) || "" : "";
    return `<span class="rm-av ep-av" aria-hidden="true">${esc(initials(it.name))}${img}</span>`;
  }

  function actionsHtml(it) {
    const list = actionsFor(it, can, S.opts.handlers);
    if (!list.length) return `<span class="rm-none">عرض فقط</span>`;
    return list.map((a) => {
      const cls = `rm-act${a.primary ? " primary" : ""}`;
      const aria = `${a.label} — ${it.typeLabel}${it.name ? ` — ${it.name}` : ""}`;
      if (a.href) return `<a class="${cls}" href="${a.href}" aria-label="${esc(aria)}">${svg(a.icon, 15)}<span>${esc(a.label)}</span></a>`;
      return `<button type="button" class="${cls}" data-rm-act="${a.act}" data-rm-key="${esc(it.key)}" aria-label="${esc(aria)}" title="${esc(a.label)}">${svg(a.icon, 15)}<span>${esc(a.label)}</span></button>`;
    }).join("");
  }

  function rowHtml(it) {
    const st = STATUS[it.status];
    const sub = [it.job, it.number ? `#${it.number}` : ""].filter(Boolean);
    return `
      <tr class="rm-row" data-key="${esc(it.key)}">
        <td class="rm-c-emp"><div class="rm-emp">${avatar(it)}<span class="rm-who"><b>${esc(it.name || "—")}</b>${sub.length ? `<small>${sub.map((s, k) => k && s.startsWith("#") ? `<span class="num">${esc(s)}</span>` : esc(s)).join(" · ")}</small>` : ""}</span></div></td>
        <td class="rm-c-type"><span class="rm-type t-${it.type}">${esc(it.typeLabel)}</span>${it.visaType ? `<small class="rm-type-sub">${esc(it.visaType)}</small>` : ""}</td>
        <td class="rm-c-st"><span class="rm-st ${it.status}"><i></i><b>${esc(st.label)}</b> <span>${esc(statusDetail(it.n))}</span></span></td>
        <td class="rm-c-date"><span class="rm-date" title="${esc(it.day)}">${esc(fmtDay(it.day, S.today))}</span></td>
        <td class="rm-c-act"><div class="rm-acts">${actionsHtml(it)}</div></td>
      </tr>`;
  }

  function draw() {
    if (!S.el) return;
    const res = filter(S.items, { q: S.q, types: S.types, period: S.period, custom: S.custom }, S.today);
    drawTypes(res.counts);
    const rows = res.rows;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (S.page >= pages) S.page = pages - 1;
    const shown = S.expanded ? rows.slice(S.page * PAGE, S.page * PAGE + PAGE) : rows.slice(0, PREVIEW);

    const expired = rows.filter((r) => r.status === "expired").length;
    const urgent = rows.filter((r) => r.status === "urgent").length;
    S.el.querySelector("#rmMeta").innerHTML = S.items.length
      ? esc(remindersPhrase(rows.length))
        + (expired ? ` · <span class="rm-m-exp">منتهية <b class="num">${expired}</b></span>` : "")
        + (urgent ? ` · <span class="rm-m-urg">عاجلة <b class="num">${urgent}</b></span>` : "")
      : "";
    if (S.opts.idx) S.opts.idx.textContent = S.items.length ? remindersPhrase(res.total) : "";

    const list = S.el.querySelector("#rmList");
    if (!S.items.length) {
      list.innerHTML = `<div class="rm-empty">${svg("bell", 26)}<p>لا توجد وثائق منتهية أو تنتهي خلال ${WINDOW} يومًا.</p></div>`;
    } else if (!rows.length) {
      list.innerHTML = `<div class="rm-empty"><p>لا توجد تذكيرات مطابقة للبحث أو الفلاتر الحالية.</p><button type="button" class="rm-link" data-rm-nav="reset">إلغاء الفلاتر</button></div>`;
    } else {
      list.innerHTML = `<table class="rm-table">
        <thead><tr><th scope="col">اسم الموظف</th><th scope="col">نوع الوثيقة</th><th scope="col">الحالة</th><th scope="col">تاريخ الانتهاء</th><th scope="col">الإجراءات</th></tr></thead>
        <tbody>${shown.map(rowHtml).join("")}</tbody></table>`;
    }

    const foot = S.el.querySelector("#rmFoot");
    if (!rows.length) { foot.innerHTML = ""; return; }
    if (!S.expanded) {
      foot.innerHTML = rows.length > PREVIEW
        ? `<button type="button" class="rm-all" data-rm-nav="all"><span>عرض جميع التذكيرات (<span class="num">${rows.length}</span>)</span>${svg("chev", 16)}</button>`
        : "";
      return;
    }
    const from = S.page * PAGE + 1, to = Math.min(rows.length, from + PAGE - 1);
    foot.innerHTML = `
      ${pages > 1 ? `<nav class="rm-pager" aria-label="صفحات التذكيرات">
        <button type="button" class="rm-pg" data-rm-nav="prev"${S.page === 0 ? " disabled" : ""} aria-label="الصفحة السابقة">${svg("right", 16)}<span>السابق</span></button>
        <span class="rm-pg-info"><span class="num">${from}–${to}</span> من <span class="num">${rows.length}</span></span>
        <button type="button" class="rm-pg" data-rm-nav="next"${S.page >= pages - 1 ? " disabled" : ""} aria-label="الصفحة التالية"><span>التالي</span>${svg("left", 16)}</button>
      </nav>` : ""}
      ${rows.length > PREVIEW ? `<button type="button" class="rm-link" data-rm-nav="less">عرض الأكثر خطورة فقط</button>` : ""}`;
  }

  /* وميض الصفّ بعد تجديد ناجح، إن بقي ظاهرًا. */
  function flash(key) {
    if (!S.el) return;
    const row = S.el.querySelector(`.rm-row[data-key="${(root.CSS && CSS.escape) ? CSS.escape(key) : key}"]`);
    if (row) { row.classList.remove("rm-flash"); void row.offsetWidth; row.classList.add("rm-flash"); }
  }

  const Reminders = {
    WINDOW, PREVIEW, PAGE, TYPES, STATUSES, PERIODS,
    dayKey, todayKey, daysBetween, statusKey, statusDetail, daysPhrase, fmtDay, periodRange, norm,
    build, compare, filter, availableTypes, actionsFor, remindersPhrase,
    mount, update, flash, _state: S,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Reminders;
  else root.Reminders = Reminders;
})(typeof window !== "undefined" ? window : globalThis);
