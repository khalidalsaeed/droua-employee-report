/* staff-travel-status.js — المصدر الوحيد لحالات سفر موظفي ذروة.
   =========================================================================
   الحالة لا تُدخَل يدويًا ولا تُخزَّن: تُشتقّ من التواريخ عند كل عرض،
   فلا يمكن أن تتقادم — تمامًا كحالة الوثائق في doc-status.js.

     مجدولة      الرحلة مستقبلية وبدايتها أبعد من SOON_DAYS
     قريب السفر  بقي على البداية SOON_DAYS يومًا أو أقلّ
     مسافر       اليوم بين البداية والنهاية (شاملًا الطرفين)
     بانتظار تأكيد العودة  مضى تاريخ النهاية ولم تُؤكَّد العودة
     عاد         أُكِّدت العودة (من يوم النهاية فصاعدًا)

   قاعدة «عاد»: مرور تاريخ النهاية وحده لا يكفي. تصير الرحلة «عاد» بأحد ثلاثة:
     1. ضغط «تأكيد العودة» (return_confirmed_at)؛
     2. رحلة تُسجَّل بعد انتهائها — سجلّ تاريخي، يؤكّدها الخادم عند الإضافة؛
     3. بدأت للموظف رحلة لاحقة فعلًا — لا يسافر من جديد من لم يعد (ضمنيّ،
        يُحسب في groupByEmployee ولا يُكتب في القاعدة).

   العتبات في DEFAULTS أدناه، ويمكن تجاوزها من الإعدادات (المفتاح
   staff_travel_thresholds في جدول settings) — الخادم يمرّرها مع البيانات.

   سكربت كلاسيكي بلا وحدات، يُعرِّف اسمًا عامًّا واحدًا فقط (StaffTravel)
   فلا يصطدم بأي صفحة. ويُستورد في الاختبارات عبر require. */
const StaffTravel = (function () {
  const DEFAULTS = {
    SOON_DAYS: 7,         // قريب السفر: الأيام قبل بداية الرحلة
    RETURN_SOON_DAYS: 7,  // تنبيه «موعد العودة قريب»
    VISA_SOON_DAYS: 30,   // تنبيه «التأشيرة تنتهي خلال …»
    VISA_URGENT_DAYS: 7,  // لون أحمر لشارة التأشيرة
  };

  const STATUS = {
    scheduled: { key: "scheduled", label: "مجدولة" },
    soon:      { key: "soon",      label: "قريب السفر" },
    traveling: { key: "traveling", label: "مسافر" },
    overdue:   { key: "overdue",   label: "بانتظار تأكيد العودة" },
    returned:  { key: "returned",  label: "عاد" },
  };

  function thresholds(over) {
    const out = { ...DEFAULTS };
    if (over && typeof over === "object") {
      for (const k of Object.keys(DEFAULTS)) {
        const v = Number(over[k]);
        if (Number.isInteger(v) && v >= 0 && v <= 365) out[k] = v;
      }
    }
    return out;
  }

  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  function isIso(s) {
    const m = ISO.exec(String(s || ""));
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  /* رقم اليوم بتوقيت UTC — يلغي فارق المنطقة الزمنية والتوقيت الصيفي من
     كل طرح بين تاريخين. */
  function dayNum(iso) {
    if (!isIso(iso)) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  function todayIso(now) {
    const d = now ? new Date(now) : new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmt(iso) { return isIso(iso) ? iso.replace(/-/g, "/") : "—"; }

  /* «يوم/يومان/أيام» بقاعدة العدد العربية المبسّطة المستعملة في المنصّة. */
  function days(n) {
    n = Math.abs(n);
    if (n === 1) return "يوم واحد";
    if (n === 2) return "يومين";
    if (n >= 3 && n <= 10) return `${n} أيام`;
    return `${n} يوم`;
  }

  /* حالة رحلة واحدة في يوم معيّن. returnConfirmedAt من القاعدة، و
     implicitReturn من groupByEmployee (رحلة لاحقة بدأت). */
  function tripStatus(trip, today, th) {
    const t = thresholds(th);
    const now = dayNum(today || todayIso());
    const s = dayNum(trip && trip.startDate), e = dayNum(trip && trip.endDate);
    if (s === null || e === null) return { ...STATUS.scheduled, valid: false };
    const span = Math.max(1, e - s);
    if (now < s) {
      const n = s - now;
      return { ...(n <= t.SOON_DAYS ? STATUS.soon : STATUS.scheduled), daysToStart: n, progress: 0, valid: true };
    }
    const confirmed = !!(trip.returnConfirmedAt || trip.implicitReturn);
    if (now < e || (now === e && !confirmed)) {
      return { ...STATUS.traveling, daysToEnd: e - now, daysSinceStart: now - s, progress: Math.min(1, (now - s) / span), valid: true };
    }
    if (!confirmed) return { ...STATUS.overdue, daysSinceEnd: now - e, progress: 1, valid: true };
    return { ...STATUS.returned, daysSinceEnd: now - e, progress: 1, valid: true, implicit: !trip.returnConfirmedAt };
  }

  /* شارة التأشيرة: ok · soon · urgent · today · expired · na */
  function visaStatus(visaIso, today, th) {
    const t = thresholds(th);
    const v = dayNum(visaIso);
    if (v === null) return { key: "na", n: null, label: "غير مسجّلة" };
    const n = v - dayNum(today || todayIso());
    if (n < 0) return { key: "expired", n, label: `منتهية منذ ${days(n)}` };
    if (n === 0) return { key: "today", n, label: "تنتهي اليوم" };
    if (n <= t.VISA_URGENT_DAYS) return { key: "urgent", n, label: `تنتهي بعد ${days(n)}` };
    if (n <= t.VISA_SOON_DAYS) return { key: "soon", n, label: `تنتهي بعد ${days(n)}` };
    return { key: "ok", n, label: `متبقي ${days(n)}` };
  }

  /* التأشيرة تنتهي قبل يوم العودة المقرّر. */
  function visaBeforeReturn(trip) {
    const v = dayNum(trip && trip.visaExpiryDate), e = dayNum(trip && trip.endDate);
    return v !== null && e !== null && v < e;
  }

  const isActive = (st) => st.key !== "returned";

  /* الرحلة التي تمثّل الموظف في بطاقته: الجارية، وإلا المنتظرة تأكيد
     العودة، وإلا الأقرب قدومًا، وإلا آخر رحلة انتهت. */
  function primaryTrip(trips, today, th) {
    const list = (trips || []).map((trip) => ({ trip, st: tripStatus(trip, today, th) }));
    const cur = list.filter((x) => x.st.key === "traveling").sort((a, b) => cmp(b.trip.startDate, a.trip.startDate))[0];
    if (cur) return cur;
    const late = list.filter((x) => x.st.key === "overdue").sort((a, b) => cmp(b.trip.endDate, a.trip.endDate))[0];
    if (late) return late;
    const next = list.filter((x) => x.st.key === "soon" || x.st.key === "scheduled").sort((a, b) => cmp(a.trip.startDate, b.trip.startDate))[0];
    if (next) return next;
    return list.sort((a, b) => cmp(b.trip.endDate, a.trip.endDate))[0] || null;
  }
  function cmp(a, b) { return String(a || "").localeCompare(String(b || "")); }

  /* الرحلات الأحدث أولًا (بتاريخ البداية) — ترتيب «سجل الرحلات». */
  function sortHistory(trips) {
    return [...(trips || [])].sort((a, b) => cmp(b.startDate, a.startDate) || (Number(b.id) || 0) - (Number(a.id) || 0));
  }

  /* موظف واحد = مجموعة رحلاته + الرحلة الممثِّلة. employees: [{eid,name,job,...}] */
  function groupByEmployee(trips, employees, today, th) {
    const byEid = new Map();
    for (const e of employees || []) byEid.set(String(e.eid), e);
    const groups = new Map();
    for (const trip of trips || []) {
      const k = String(trip.employeeEid);
      if (!groups.has(k)) groups.set(k, { eid: k, employee: byEid.get(k) || { eid: k, name: trip.employeeName || `موظف ${k}` }, trips: [] });
      groups.get(k).trips.push(trip);
    }
    const out = [];
    const now = today || todayIso();
    for (const g of groups.values()) {
      /* نُسخ لا الأصل: implicitReturn حسبةُ عرض لا تُكتب في البيانات. */
      g.trips = sortHistory(g.trips).map((t) => ({ ...t }));
      for (const t of g.trips) {
        t.implicitReturn = !t.returnConfirmedAt && g.trips.some((o) => o !== t && o.startDate > t.endDate && o.startDate <= now);
      }
      const p = primaryTrip(g.trips, today, th);
      g.primary = p ? p.trip : null;
      g.status = p ? p.st : null;
      out.push(g);
    }
    /* ما يحتاج إجراءً أولًا (بانتظار تأكيد العودة)، ثم المسافرون، ثم
       القريب، ثم المجدول، ثم العائدون — وداخل كل فئة الأقرب تاريخًا. */
    const RANK = { overdue: 0, traveling: 1, soon: 2, scheduled: 3, returned: 4 };
    return out.sort((a, b) => {
      const r = RANK[a.status.key] - RANK[b.status.key];
      if (r) return r;
      if (a.status.key === "returned" || a.status.key === "overdue") return cmp(b.primary.endDate, a.primary.endDate);
      return cmp(a.primary.startDate, b.primary.startDate);
    });
  }

  /* التنبيهات الآلية لكل رحلة لم تُؤكَّد عودتها: قرب السفر، قرب العودة،
     التأشيرة المنتهية أو القريبة، والتأشيرة التي تنتهي قبل العودة،
     و«تجاوز تاريخ العودة» لما انتهت ولم تُؤكَّد. */
  function alerts(groups, today, th) {
    const t = thresholds(th);
    const out = [];
    for (const g of groups || []) {
      const name = g.employee.name;
      for (const trip of g.trips) {
        const st = tripStatus(trip, today, t);
        const base = { eid: g.eid, tripId: trip.id, name };
        if (st.key === "returned") continue;
        if (st.key === "soon") {
          out.push({ ...base, kind: "departure_soon", level: "warn",
            text: st.daysToStart === 0 ? "يبدأ سفره اليوم" : `يسافر بعد ${days(st.daysToStart)}` });
        }
        if (st.key === "traveling" && st.daysToEnd <= t.RETURN_SOON_DAYS) {
          out.push({ ...base, kind: "return_soon", level: "info",
            text: st.daysToEnd === 0 ? "موعد عودته اليوم" : `موعد عودته بعد ${days(st.daysToEnd)}` });
        }
        const vs = visaStatus(trip.visaExpiryDate, today, t);
        if (vs.key === "expired") out.push({ ...base, kind: "visa_expired", level: "bad", text: `التأشيرة ${vs.label}` });
        else if (vs.n !== null && vs.n <= t.VISA_SOON_DAYS) out.push({ ...base, kind: "visa_soon", level: vs.n <= t.VISA_URGENT_DAYS ? "bad" : "warn", text: `التأشيرة ${vs.label}` });
        if (visaBeforeReturn(trip)) out.push({ ...base, kind: "visa_before_return", level: "bad", text: "التأشيرة تنتهي قبل موعد العودة" });
        if (st.key === "overdue") {
          out.push({ ...base, kind: "overdue_return", level: "bad", text: `تجاوز تاريخ العودة بـ${days(st.daysSinceEnd)} ولم يُؤكَّد رجوعه` });
        }
      }
    }
    const ORDER = { bad: 0, warn: 1, info: 2 };
    return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  }

  /* بطاقات الملخص: كل رقم يعدّ الموظفين/الرحلات من التواريخ نفسها. */
  function summary(groups, today, th) {
    const t = thresholds(th);
    let traveling = 0, soon = 0, scheduled = 0, visaSoon = 0, overdue = 0;
    for (const g of groups || []) {
      for (const trip of g.trips) {
        const st = tripStatus(trip, today, t);
        if (st.key === "traveling") traveling++;
        else if (st.key === "soon") soon++;
        else if (st.key === "scheduled") scheduled++;
        else if (st.key === "overdue") overdue++;
        if (isActive(st)) {
          const vs = visaStatus(trip.visaExpiryDate, today, t);
          if (vs.n !== null && vs.n <= t.VISA_SOON_DAYS) visaSoon++;
        }
      }
    }
    return { traveling, soon, scheduled, visaSoon, overdue };
  }

  /* بحث مُطبَّع: الأرقام الهندية، وصور الألف والهاء/التاء المربوطة والياء. */
  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
      .replace(/[ً-ْـ]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
      .toLowerCase().trim();
  }
  function matches(group, q) {
    const n = norm(q);
    if (!n) return true;
    const e = group.employee || {};
    return [e.name, e.eid, e.iqama, e.passport].some((v) => v && norm(v).includes(n));
  }

  /* التحقّق من حقول النموذج — نفسه في المتصفّح والخادم. يرجع رسالة أو null. */
  function validateTrip(t) {
    if (!t || !String(t.employeeEid || "").trim()) return "اختر الموظف";
    if (!isIso(t.startDate)) return "تاريخ بداية الرحلة غير صالح";
    if (!isIso(t.endDate)) return "تاريخ نهاية الرحلة غير صالح";
    if (t.endDate < t.startDate) return "تاريخ النهاية يجب أن يكون في يوم البداية أو بعده";
    if (!isIso(t.visaExpiryDate)) return "تاريخ انتهاء التأشيرة غير صالح";
    const LIM = { visaNumber: 40, visaType: 60, destination: 120, notes: 1000 };
    const LBL = { visaNumber: "رقم التأشيرة", visaType: "نوع التأشيرة", destination: "وجهة السفر", notes: "الملاحظات" };
    for (const k of Object.keys(LIM)) {
      if (t[k] != null && String(t[k]).length > LIM[k]) return `${LBL[k]} أطول من ${LIM[k]} حرفًا`;
    }
    return null;
  }

  /* رحلتان للموظف نفسه تتداخل أيامهما. */
  function overlaps(a, b) {
    return String(a.employeeEid) === String(b.employeeEid) && a.startDate <= b.endDate && b.startDate <= a.endDate;
  }

  /* إخفاء جزئي للعرض المختصر: آخر أربعة محارف فقط. */
  function mask(v) {
    const s = String(v || "");
    if (!s) return "";
    return s.length <= 4 ? s : "•".repeat(Math.min(6, s.length - 4)) + s.slice(-4);
  }

  return {
    DEFAULTS, STATUS, thresholds, isIso, dayNum, todayIso, fmt, days,
    tripStatus, visaStatus, visaBeforeReturn, primaryTrip, sortHistory,
    groupByEmployee, alerts, summary, norm, matches, validateTrip, overlaps, mask,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = StaffTravel;
