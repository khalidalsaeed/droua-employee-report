/* doc-expiry.js — قسم «الوثائق القادمة على انتهاء الصلاحية».
   =========================================================================
   تنفيذٌ للتصميم المعتمد: جدول «أكثر الوثائق إلحاحًا» يمينًا، وحلقة كبيرة
   بأربع فئات وبطاقاتها يسارًا، وتبديل «حسب المدة / حسب الموظف» أعلى القسم،
   و«عرض جميع الوثائق» و«آخر تحديث» أسفله.

   لا يحسب هذا الملف حالة وثيقة من عنده: كل وثيقة تأتي من DocStatus.empDocs
   — المصدر نفسه الذي تُحسب منه بطاقات المؤشّرات وقائمة /expiring.html —
   وهنا تُوزَّع فقط على فئات المدة. قراءةٌ محضة: لا كتابة ولا نداء شبكة.

   سكربت كلاسيكي → DocExpiry في النطاق العام؛ والدوالّ النقيّة تُختبر عبر
   require. */
(function (root) {
  "use strict";

  const WINDOW = 90;
  const TOP = 5; // صفوف «الأكثر إلحاحًا» قبل «عرض جميع الوثائق»

  /* الفئات الأربع بترتيب الإلحاح. pill نصّ شارة الحالة كما في التصميم. */
  const BUCKETS = [
    { key: "expired", label: "منتهية", pill: "منتهية" },
    { key: "d10", label: "0 – 10 أيام", pill: "10 أيام" },
    { key: "d30", label: "11 – 30 يومًا", pill: "30 يومًا" },
    { key: "d90", label: "31 – 90 يومًا", pill: "90 يومًا" },
  ];
  const BUCKET = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));

  function bucketOf(n) {
    if (n == null) return null;
    if (n < 0) return "expired";
    if (n <= 10) return "d10";
    if (n <= 30) return "d30";
    if (n <= WINDOW) return "d90";
    return null;
  }

  /* نقيّة: كل وثيقة لها تاريخ، موزّعة على الفئات.
     رخصة «جاري السداد» تُعدّ وتُستبعد من الفئات — إجراؤها جارٍ، وهي خارج
     قائمة المتابعة في المنصّة كلها (DocStatus.needsFollowUp). */
  function collect(data, permits, DS) {
    const D = DS || (typeof DocStatus !== "undefined" ? DocStatus : null);
    const pm = D.latestPermits(permits);
    const docs = [];
    let beyond = 0, pending = 0;
    (data || []).forEach((e, i) => D.empDocs(e, pm).forEach((dc) => {
      if (dc.st.key === "na" || dc.st.n == null) return;
      if (dc.st.key === "pending") { pending++; return; }
      const bucket = bucketOf(dc.st.n);
      if (!bucket) { beyond++; return; }
      docs.push({ i, emp: e, type: dc.type, tk: dc.tk, exp: dc.exp, n: dc.st.n, bucket });
    }));
    docs.sort((a, b) => a.n - b.n);
    const counts = { expired: 0, d10: 0, d30: 0, d90: 0 };
    docs.forEach((d) => counts[d.bucket]++);
    return { docs, counts, total: docs.length, beyond, pending };
  }

  /* نقيّة: وثائق الموظف الواحد التي تنتهي في اليوم نفسه بالضبط تُجمع في
     صفّ واحد (إقامة + رخصة عمل — باقي 7 أيام). القاعدة محافظة: الموظف نفسه
     ويوم الانتهاء نفسه (n يُحسب من تاريخ الانتهاء بدقّة اليوم)، بلا تقريب —
     فرق يوم واحد يبقى صفًّا مستقلًّا. لا تمسّ الوثائق نفسها ولا عدّها: كل
     صفّ يحمل وثائقه في docs، والحلقة والبطاقات تبقى على collect().
     الترتيب يتبع ترتيب docs (الأكثر إلحاحًا أوّلًا)، والأنواع داخل الصفّ
     بترتيب empDocs (إقامة، رخصة عمل، الجواز، تصريح أجير). */
  function groupSameDay(docs) {
    const m = new Map();
    docs.forEach((d) => {
      const k = `${d.i}|${d.n}`;
      if (!m.has(k)) m.set(k, { i: d.i, emp: d.emp, n: d.n, exp: d.exp, bucket: d.bucket, docs: [] });
      m.get(k).docs.push(d);
    });
    return [...m.values()];
  }

  /* نقيّة: «حسب الموظف» — وثائق كل موظف، مرتّبين بأقرب انتهاء لديه.
     sets: وثائقه مجموعةً بيوم الانتهاء، مجموعة لكل تاريخ. */
  function byEmployee(docs) {
    const m = new Map();
    docs.forEach((d) => {
      if (!m.has(d.i)) m.set(d.i, { i: d.i, emp: d.emp, docs: [] });
      m.get(d.i).docs.push(d);
    });
    return [...m.values()].map((g) => ({ ...g, worst: g.docs[0], sets: groupSameDay(g.docs) })).sort((a, b) => a.worst.n - b.worst.n);
  }

  /* «منذ 34 يومًا» / «تنتهي اليوم» / «باقي 3 أيام» */
  function remaining(n) {
    if (n === 0) return "تنتهي اليوم";
    const a = Math.abs(n);
    if (n < 0) return `منذ ${a === 1 ? "يوم واحد" : a === 2 ? "يومين" : a <= 10 ? `${a} أيام` : `${a} يومًا`}`;
    return `باقي ${a === 1 ? "يوم واحد" : a === 2 ? "يومان" : a <= 10 ? `${a} أيام` : `${a} يومًا`}`;
  }
  function docsPhrase(n) {
    if (n === 1) return "وثيقة واحدة";
    if (n === 2) return "وثيقتان";
    if (n <= 10) return `${n} وثائق`;
    return `${n} وثيقة`;
  }

  /* ── الرسم (المتصفّح وحده) ─────────────────────────────────────────── */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const svg = (path, size) => `<svg width="${size || 18}" height="${size || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const ICON = {
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    chev: '<path d="M15 18l-6-6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    iq: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M6 16c.8-1.6 1.8-2.3 3-2.3s2.2.7 3 2.3M14 10h4M14 13h3"/>',
    lic: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18"/>',
    pass: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="3.2"/><path d="M8.8 10h6.4M12 6.8c-1.3 1-1.3 5.4 0 6.4M12 6.8c1.3 1 1.3 5.4 0 6.4M9.5 17h5"/>',
    ajeer: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 15l2 2 4-4"/>',
  };
  const initials = (name) => { const p = String(name || "").trim().split(/\s+/); return (p[0] || "").slice(0, 1) + " " + ((p[1] || "").slice(0, 1) || ""); };
  const reduced = () => (typeof Motion !== "undefined" ? Motion.prefersReduced() : false);

  function fmtStamp(d) {
    const D = DocStatus;
    const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
    const h12 = h % 12 || 12;
    return `${d.getDate()} ${D.arMonths[d.getMonth()]} ${d.getFullYear()}، ${h12}:${m} ${h < 12 ? "ص" : "م"}`;
  }

  /* الحلقة: أقواس بفاصل صغير، تُرسم كمسحة واحدة — كل قوس يبدأ حين ينتهي
     سابقه (التأخير بحسب موضعه، والمدّة بحسب طوله). */
  const R = 84, SW = 24, C = 2 * Math.PI * R, GAP = 3;
  function ringSvg(counts, total) {
    let off = 0, arcs = "";
    const nz = BUCKETS.filter((b) => counts[b.key] > 0).length;
    BUCKETS.forEach((b) => {
      const n = counts[b.key];
      if (!n) return;
      const frac = n / total;
      const len = Math.max(frac * C - (nz > 1 ? GAP : 0), 1);
      arcs += `<circle class="dx-arc ${b.key}" data-b="${b.key}" data-len="${len.toFixed(2)}" data-off="${(off / C).toFixed(4)}" data-frac="${frac.toFixed(4)}"
        cx="100" cy="100" r="${R}" fill="none" stroke-width="${SW}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
        tabindex="0" role="button" aria-label="${esc(b.label)}: ${docsPhrase(n)} — اضغط لعرضها في الجدول"></circle>`;
      off += frac * C;
    });
    return `<svg class="dx-ring" viewBox="0 0 200 200" role="img" aria-label="توزيع ${docsPhrase(total)} على فئات المدة">
      <circle cx="100" cy="100" r="${R}" fill="none" class="dx-track" stroke-width="${SW}"></circle>
      <circle cx="100" cy="100" r="${R - SW / 2 - 9}" fill="none" class="dx-inner"></circle>
      <g transform="rotate(-90 100 100)">${arcs}</g></svg>`;
  }

  const S = { view: "dur", filter: null, expanded: false, data: null, opts: null, el: null, played: false };

  function render(el, data, permits, opts) {
    if (!el) return;
    S.el = el; S.opts = opts || {};
    S.data = collect(data, permits);
    const { counts, total, beyond, pending } = S.data;
    const exp = counts.expired;
    const sub = `المنتهية والتي تنتهي خلال ${WINDOW} يومًا. ${docsPhrase(total)} في القائمة، منها ${exp} منتهية`
      + (beyond ? ` و ${beyond} بعد ${WINDOW} يومًا خارجها` : "")
      + (pending ? ` · ${pending} رخصة «جاري السداد» مستبعدة` : "");
    el.innerHTML = `
      <header class="dx-head">
        <div class="dx-title">
          <span class="dx-ico">${svg(ICON.doc, 22)}</span>
          <div><h3>الوثائق القادمة على انتهاء الصلاحية</h3><p class="dx-sub">${esc(sub)}</p></div>
        </div>
        <div class="dx-tabs" role="tablist" aria-label="طريقة العرض">
          <span class="dx-tab-ind" aria-hidden="true"></span>
          <button type="button" role="tab" data-view="dur" aria-selected="true">${svg(ICON.clock, 17)}<span>عرض حسب المدة</span></button>
          <button type="button" role="tab" data-view="emp" aria-selected="false">${svg(ICON.user, 17)}<span>عرض حسب الموظف</span></button>
        </div>
      </header>
      <div class="dx-body">
        <section class="dx-card dx-table-card" aria-labelledby="dxTableTitle">
          <div class="dx-card-head">
            <div><h4 id="dxTableTitle">أكثر الوثائق إلحاحًا</h4><p class="dx-card-sub">أهم الوثائق التي تحتاج إلى إجراء خلال الفترة القريبة القادمة</p></div>
            <div class="dx-filter" hidden></div>
          </div>
          <div class="dx-table-wrap"></div>
        </section>
        <section class="dx-card dx-chart-card" aria-label="توزيع الوثائق حسب المدة">
          <div class="dx-chart">
            <ul class="dx-legend">${BUCKETS.map((b) => `
              <li><button type="button" class="dx-leg ${b.key}" data-b="${b.key}" aria-pressed="false">
                <i></i><b class="num" data-count="${counts[b.key]}">${counts[b.key]}</b><span>${b.label}</span></button></li>`).join("")}
            </ul>
            <div class="dx-ring-box">
              ${ringSvg(counts, total || 1)}
              <div class="dx-center"><b class="num" data-count="${total}">${total}</b><span>وثيقة</span><small>تنتهي خلال ${WINDOW} يومًا</small></div>
            </div>
          </div>
          <div class="dx-tiles">${BUCKETS.map((b, k) => `
            <button type="button" class="dx-tile ${b.key}" data-b="${b.key}" aria-pressed="false" style="--i:${k}">
              <b class="num" data-count="${counts[b.key]}">${counts[b.key]}</b><span>${b.label}</span></button>`).join("")}
          </div>
        </section>
      </div>
      <footer class="dx-foot">
        <span class="dx-updated">${svg(ICON.cal, 17)} آخر تحديث: ${esc(fmtStamp(S.opts.loadedAt || new Date()))}</span>
        <button type="button" class="dx-all"${total > TOP ? "" : " hidden"}><span></span>${svg(ICON.chev, 16)}</button>
      </footer>`;
    wire(el);
    drawTable(false);
    placeIndicator();
    const first = !S.played && !reduced() && typeof Motion !== "undefined";
    S.played = true;
    if (first) {
      el.classList.add("dx-armed");
      el.querySelectorAll(".dx-arc").forEach((a) => a.setAttribute("stroke-dasharray", `0 ${C}`));
      el.querySelectorAll("[data-count]").forEach((b) => { b.textContent = "0"; });
      Motion.onVisible(el, () => {
        el.classList.add("dx-in");
        requestAnimationFrame(() => el.querySelectorAll(".dx-arc").forEach((a) => {
          const len = Number(a.dataset.len);
          a.style.transitionDelay = `${Math.round(Number(a.dataset.off) * 900)}ms`;
          a.style.transitionDuration = `${Math.max(160, Math.round(Number(a.dataset.frac) * 900))}ms`;
          a.setAttribute("stroke-dasharray", `${len} ${C - len}`);
        }));
        el.querySelectorAll("[data-count]").forEach((b) => Motion.countUp(b, Number(b.dataset.count), { duration: 800 }));
      });
    } else el.classList.add("dx-in");
  }

  function wire(el) {
    el.querySelectorAll(".dx-tabs [data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    el.querySelector(".dx-tabs").addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      const next = S.view === "dur" ? "emp" : "dur";
      setView(next);
      el.querySelector(`.dx-tabs [data-view="${next}"]`).focus();
    });
    el.querySelectorAll("[data-b]").forEach((b) => {
      b.addEventListener("click", () => setFilter(S.filter === b.dataset.b ? null : b.dataset.b));
      if (b.tagName === "circle") b.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setFilter(S.filter === b.dataset.b ? null : b.dataset.b); }
      });
      const hot = (on) => el.querySelector(".dx-chart-card").classList.toggle(`hot-${b.dataset.b}`, on);
      b.addEventListener("pointerenter", () => hot(true));
      b.addEventListener("pointerleave", () => hot(false));
    });
    el.querySelector(".dx-all").addEventListener("click", () => { S.expanded = !S.expanded; drawTable(true); });
    window.addEventListener("resize", placeIndicator, { passive: true });
  }

  /* مؤشّر التبويب ينزلق تحت التبويب المختار */
  function placeIndicator() {
    if (!S.el) return;
    const tabs = S.el.querySelector(".dx-tabs"), on = tabs.querySelector('[aria-selected="true"]'), ind = tabs.querySelector(".dx-tab-ind");
    if (!on || !ind) return;
    const tr = tabs.getBoundingClientRect(), br = on.getBoundingClientRect();
    ind.style.width = `${br.width}px`;
    ind.style.transform = `translateX(${br.left - tr.left}px)`;
  }

  function setView(v) {
    if (v === S.view) return;
    S.view = v;
    S.el.querySelectorAll(".dx-tabs [data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    placeIndicator();
    S.el.querySelector("#dxTableTitle").textContent = v === "dur" ? "أكثر الوثائق إلحاحًا" : "الموظفون الأكثر إلحاحًا";
    S.el.querySelector(".dx-card-sub").textContent = v === "dur"
      ? "أهم الوثائق التي تحتاج إلى إجراء خلال الفترة القريبة القادمة"
      : "كل موظف بوثائقه الداخلة في النطاق، مرتّبين بأقرب انتهاء";
    drawTable(true);
  }

  function setFilter(key) {
    S.filter = key;
    const card = S.el.querySelector(".dx-chart-card");
    card.classList.toggle("has-pick", !!key);
    S.el.querySelectorAll("[data-b]").forEach((b) => {
      b.classList.toggle("picked", b.dataset.b === key);
      if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", String(b.dataset.b === key));
    });
    const f = S.el.querySelector(".dx-filter");
    f.hidden = !key;
    if (key) {
      f.innerHTML = `<button type="button" class="dx-chip ${key}" aria-label="إلغاء ترشيح ${esc(BUCKET[key].label)}"><i></i>${esc(BUCKET[key].label)} ${svg(ICON.x, 13)}</button>`;
      f.querySelector("button").addEventListener("click", () => setFilter(null));
    }
    S.expanded = false;
    drawTable(true);
  }

  /* أنواع الوثائق شارات صغيرة متجاورة تلتفّ عند الضيق: [ إقامة ] [ رخصة عمل ] */
  function tags(docs) {
    return docs.map((d) => `<span class="dx-tag">${svg(ICON[d.tk] || ICON.doc, 14)}${esc(d.type)}</span>`).join("");
  }

  function pill(bucket) {
    return `<span class="dx-pill ${bucket}"><i></i>${esc(BUCKET[bucket].pill)}</span>`;
  }

  /* صورة الموظف فوق أحرفه الأولى، يقدّمها المُضيف (opts.photoImg) — هذا
     الملف يبقى بلا نداء شبكة. لا صورة = الأحرف الأولى كما كانت. */
  function photo(emp) {
    return S.opts && typeof S.opts.photoImg === "function" ? S.opts.photoImg(emp) || "" : "";
  }

  function drawTable(animate) {
    const wrap = S.el.querySelector(".dx-table-wrap");
    const docs = S.filter ? S.data.docs.filter((d) => d.bucket === S.filter) : S.data.docs;
    const F = DocStatus.F;
    const clickable = !!S.opts.onPick;
    let head, rows, count;
    if (S.view === "dur") {
      const sets = groupSameDay(docs);
      count = sets.length;
      const list = S.expanded ? sets : sets.slice(0, TOP);
      head = "<th>#</th><th>الموظف</th><th>نوع الوثيقة</th><th>المدة المتبقية</th><th>الحالة</th>";
      rows = list.map((d, k) => `
        <tr class="dx-row" data-i="${d.i}" style="--i:${Math.min(k, 10)}"${clickable ? ` tabindex="0" aria-label="فتح ملف ${esc(d.emp[F.name])}"` : ""}>
          <td class="dx-n"><span class="num">${k + 1}</span></td>
          <td class="dx-emp"><div class="dx-emp-in"><span class="dx-av">${esc(initials(d.emp[F.name]))}${photo(d.emp)}</span><span><b>${esc(d.emp[F.name] || "—")}</b>${d.emp[F.job] ? `<small>${esc(d.emp[F.job])}</small>` : ""}</span></div></td>
          <td class="dx-type"><span class="dx-tags">${tags(d.docs)}</span></td>
          <td class="dx-rem ${d.bucket}" title="${esc(DocStatus.fmtDate(d.exp))}">${esc(remaining(d.n))}</td>
          <td class="dx-st">${pill(d.bucket)}</td>
        </tr>`).join("");
    } else {
      const groups = byEmployee(docs);
      count = groups.length;
      const list = S.expanded ? groups : groups.slice(0, TOP);
      /* كل مجموعة تحمل مدّتها، وأوّلها أقرب انتهاء — فلا عمود مكرّر له */
      head = "<th>#</th><th>الموظف</th><th>الوثائق</th><th>الحالة</th>";
      rows = list.map((g, k) => `
        <tr class="dx-row" data-i="${g.i}" style="--i:${Math.min(k, 10)}"${clickable ? ` tabindex="0" aria-label="فتح ملف ${esc(g.emp[F.name])}"` : ""}>
          <td class="dx-n"><span class="num">${k + 1}</span></td>
          <td class="dx-emp"><div class="dx-emp-in"><span class="dx-av">${esc(initials(g.emp[F.name]))}${photo(g.emp)}</span><span><b>${esc(g.emp[F.name] || "—")}</b>${g.emp[F.job] ? `<small>${esc(g.emp[F.job])}</small>` : ""}</span></div></td>
          <td class="dx-type dx-types">${g.sets.map((d) => `<span class="dx-set"><span class="dx-tags">${tags(d.docs)}</span><span class="dx-set-rem ${d.bucket}" title="${esc(DocStatus.fmtDate(d.exp))}">${esc(remaining(d.n))}</span></span>`).join("")}</td>
          <td class="dx-st">${pill(g.worst.bucket)}</td>
        </tr>`).join("");
    }
    const empty = `<div class="dx-empty">${S.filter ? `لا توجد وثائق في فئة «${esc(BUCKET[S.filter].label)}»` : `لا توجد وثائق منتهية أو تنتهي خلال ${WINDOW} يومًا`}</div>`;
    const html = count ? `<table class="dx-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` : empty;

    const all = S.el.querySelector(".dx-all");
    /* «عرض جميع الوثائق (N)» يعدّ الوثائق لا الصفوف: صفّ «إقامة + رخصة عمل»
       وثيقتان. أمّا «حسب الموظف» فيعدّ الموظفين كما كان. */
    const totalShown = S.view === "dur" ? docs.length : count;
    all.hidden = count <= TOP;
    all.querySelector("span").textContent = S.expanded ? "عرض الأكثر إلحاحًا فقط" : (S.view === "dur" ? `عرض جميع الوثائق (${totalShown})` : `عرض جميع الموظفين (${totalShown})`);
    all.classList.toggle("open", S.expanded);

    const swap = () => {
      wrap.innerHTML = html;
      if (clickable) wrap.querySelectorAll(".dx-row").forEach((r) => {
        const go = () => S.opts.onPick(Number(r.dataset.i));
        r.addEventListener("click", go);
        r.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
      });
      else wrap.classList.add("dx-static");
    };
    if (!animate || reduced() || !wrap.animate) { swap(); return; }
    wrap.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(4px)" }], { duration: 120, easing: "ease-in" })
      .finished.then(() => {
        swap();
        wrap.classList.add("dx-reflow");
        wrap.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "cubic-bezier(.16,.8,.3,1)" });
      });
  }

  const DocExpiry = { WINDOW, TOP, BUCKETS, bucketOf, collect, groupSameDay, byEmployee, remaining, docsPhrase, render };
  if (typeof module !== "undefined" && module.exports) module.exports = DocExpiry;
  else root.DocExpiry = DocExpiry;
})(typeof window !== "undefined" ? window : globalThis);
