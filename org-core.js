/* org-core.js — منطق الهيكل التنظيمي، بلا DOM.
   =========================================================================
   مصدرٌ واحد يقرؤه المتصفّح (سكربت كلاسيكي → OrgCore في النطاق العام)
   والخادم والاختبارات (require). لا يعرف شيئًا عن الرسم: يبني الشجرة،
   ويفحص سلامتها، ويبحث ويرشّح، ويسطّحها لقائمة الجوال.

   القاعدة التي يقوم عليها: لا تخمين.
     - المدير يُربط بسجلّ موظف فقط إن طابق اسمُه اسمَ موظف في المصدر
       مطابقةً تامّة بعد تطبيع الإملاء (همزات، تاء مربوطة، مسافات) — لا
       مطابقة تقريبية ولا «أقرب اسم».
     - مدير لا سجلّ له يُعرض «عقدة مدير مرجعية» تحمل الاسم كما كُتب في
       المصدر وحده: لا بريد ولا مسمّى ولا قسم ولا موقع يُستنتج له.
     - الربط بسجلّات المنصّة بالبريد الإلكتروني وحده؛ بريدٌ يحمله أكثر من
       سجلّ لا يُربط بأيّ منها.

   شكل الصفّ المُدخل (كما في lib/org/source.js):
     { row, status, department, location, managerName, email, nameEn, nameAr,
       id?, managerId?, jobTitle?, isManager? }
   managerId (اختياري) هو النموذج المستقبلي: مرجعٌ ذاتيّ إلى id موظف آخر.
   إن وُجد يتقدّم على managerName. */
(function (root) {
  "use strict";

  const ACTIVE = "نشط";
  const ROOT_ID = "root";

  /* ── التطبيع ──────────────────────────────────────────────────────── */
  /* صورة مقارنة لا صورة عرض: يُعرض النصّ كما جاء في المصدر دائمًا. */
  function norm(value) {
    return String(value == null ? "" : value)
      .replace(/[ً-ْٰـ]/g, "") // تشكيل وتطويل
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  const normEmail = (v) => String(v == null ? "" : v).trim().toLowerCase();
  const clean = (v) => {
    const s = String(v == null ? "" : v).trim();
    return s ? s : null;
  };

  /* أكثر إملاء تكرارًا لمفتاح واحد هو ما يُعرض (مثلًا «إدارة الإنتاج» مقابل
     «ادارة الإنتاج»)؛ عند التعادل يُقدَّم الأوّل ظهورًا. */
  function displayLabels(values) {
    const byKey = new Map();
    values.forEach((v) => {
      const s = clean(v);
      if (!s) return;
      const k = norm(s);
      if (!byKey.has(k)) byKey.set(k, new Map());
      const m = byKey.get(k);
      m.set(s, (m.get(s) || 0) + 1);
    });
    const out = new Map();
    byKey.forEach((m, k) => {
      let best = null, n = -1;
      m.forEach((c, s) => { if (c > n) { best = s; n = c; } });
      out.set(k, best);
    });
    return out;
  }

  /* ── بناء الهيكل ──────────────────────────────────────────────────── */
  function buildHierarchy(rows, opts) {
    const options = opts || {};
    const rootLabel = options.rootLabel || "الهيكل التنظيمي";
    const input = (rows || []).filter(Boolean);

    const deptLabels = displayLabels(input.map((r) => r.department));
    const locLabels = displayLabels(input.map((r) => r.location));

    const nodes = new Map();
    const issues = [];
    const employees = [];

    input.forEach((r, idx) => {
      const id = clean(r.id) || `e${r.row != null ? r.row : idx + 1}`;
      const status = clean(r.status);
      const deptKey = r.department ? norm(r.department) : null;
      const locKey = r.location ? norm(r.location) : null;
      const node = {
        id, kind: "employee",
        nameAr: clean(r.nameAr), nameEn: clean(r.nameEn), email: clean(r.email),
        status, active: status === ACTIVE,
        jobTitle: clean(r.jobTitle),
        department: deptKey ? deptLabels.get(deptKey) : null, deptKey,
        location: locKey ? locLabels.get(locKey) : null, locKey,
        managerName: clean(r.managerName), managerIdRef: clean(r.managerId),
        isManager: !!r.isManager,
        row: r.row != null ? r.row : null,
        parent: null, children: [], linked: true,
      };
      if (nodes.has(id)) {
        issues.push(issue("duplicate_id", "error", `المعرّف ${id} مكرّر في المصدر`, [id]));
        return;
      }
      nodes.set(id, node);
      employees.push(node);
    });

    /* فهرس الأسماء للمطابقة التامّة بعد التطبيع. اسمٌ يحمله موظفان لا
       يصلح مفتاحًا: يُعلَّم ملتبسًا ولا يُربط به أحد. */
    const byName = new Map();
    employees.forEach((e) => {
      [e.nameAr, e.nameEn].forEach((n) => {
        if (!n) return;
        const k = norm(n);
        const cur = byName.get(k);
        if (cur && cur !== e) byName.set(k, "ambiguous");
        else byName.set(k, e);
      });
    });

    const refs = new Map(); // norm(name) → reference node
    const parentOf = new Map(); // employee id → manager node id (قبل كسر الحلقات)

    employees.forEach((e) => {
      if (e.managerIdRef) {
        const m = nodes.get(e.managerIdRef);
        if (m === e) { issues.push(issue("self_manager", "error", `${label(e)} مسجَّل مديرًا لنفسه`, [e.id])); return; }
        if (m) { parentOf.set(e.id, m.id); return; }
        issues.push(issue("missing_manager_id", "error", `${label(e)} يشير إلى مدير غير موجود (${e.managerIdRef})`, [e.id]));
        return;
      }
      if (!e.managerName) return; // بلا مدير — يُفحص لاحقًا
      const k = norm(e.managerName);
      const hit = byName.get(k);
      if (hit === e) { issues.push(issue("self_manager", "error", `${label(e)} مسجَّل مديرًا لنفسه`, [e.id])); return; }
      if (hit && hit !== "ambiguous") { parentOf.set(e.id, hit.id); return; }
      if (hit === "ambiguous") {
        issues.push(issue("ambiguous_manager", "warning", `اسم المدير «${e.managerName}» يطابق أكثر من موظف — لم يُربط`, [e.id]));
      }
      let ref = refs.get(k);
      if (!ref) {
        ref = {
          id: `ref:${k}`, kind: "reference", linked: false,
          nameAr: e.managerName, nameEn: null, email: null, status: null, active: null,
          jobTitle: null, department: null, deptKey: null, location: null, locKey: null,
          parent: null, children: [], row: null,
        };
        refs.set(k, ref);
        nodes.set(ref.id, ref);
      }
      parentOf.set(e.id, ref.id);
    });

    /* الحلقات: تتبّع سلسلة المدراء من كل موظف. أي عودة إلى عقدة في
       المسار الحالي حلقة؛ تُسجَّل مرّة واحدة، وتُكسر بفصل العقدة التي
       أُغلقت عندها فتظهر جذرًا معلَّمًا بدل أن تختفي الشجرة كلها. */
    const state = new Map(); // 1 = في المسار، 2 = انتهى
    const seenCycles = new Set();
    employees.forEach((start) => {
      const path = [];
      let cur = start.id;
      while (cur && !state.has(cur)) {
        state.set(cur, 1);
        path.push(cur);
        cur = parentOf.get(cur) || null;
      }
      if (cur && state.get(cur) === 1) {
        const loop = path.slice(path.indexOf(cur));
        const key = [...loop].sort().join("|");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          const names = loop.map((id) => label(nodes.get(id))).join(" ← ");
          issues.push(issue("cycle", "error",
            loop.length === 2 ? `إدارة متبادلة: ${names}` : `تسلسل إداري دائري: ${names} ← ${label(nodes.get(loop[0]))}`,
            loop));
          parentOf.delete(cur); // كسر الحلقة عند نقطة إغلاقها
          nodes.get(cur).cycleBreak = true;
        }
      }
      path.forEach((id) => state.set(id, 2));
    });

    /* الموظفون غير النشطين لا يدخلون الشجرة — إلا إن كان أحدٌ نشط يتبعهم،
       فيبقون عقدة سياق معلَّمة كي لا يُفصل التابع عن مديره صمتًا. */
    const keep = new Set();
    employees.forEach((e) => {
      if (!e.active) return;
      let cur = e.id;
      while (cur && !keep.has(cur)) { keep.add(cur); cur = parentOf.get(cur) || null; }
    });
    refs.forEach((r) => { if (keep.has(r.id)) r.active = true; });

    const inactive = employees.filter((e) => !e.active);
    if (inactive.length) {
      const hidden = inactive.filter((e) => !keep.has(e.id));
      if (hidden.length) {
        issues.push(issue("inactive_excluded", "info",
          `${hidden.length} سجلّ بحالة غير «نشط» مستبعد من الشجرة`, hidden.map((e) => e.id)));
      }
    }

    const rootNode = {
      id: ROOT_ID, kind: "root", nameAr: rootLabel, parent: null, children: [], linked: true,
    };
    nodes.set(ROOT_ID, rootNode);
    const visible = [...nodes.values()].filter((n) => n.kind !== "root" && keep.has(n.id));
    visible.forEach((n) => {
      const p = parentOf.get(n.id);
      const parent = p && keep.has(p) ? nodes.get(p) : rootNode;
      n.parent = parent.id;
      parent.children.push(n.id);
    });
    // ترتيب ثابت: المدراء (من لهم تابعون) أوّلًا ثم بالاسم
    const byLabel = (a, b) => String(nodes.get(a).nameAr || "").localeCompare(String(nodes.get(b).nameAr || ""), "ar");
    nodes.forEach((n) => n.children.sort((a, b) => {
      const ca = nodes.get(a).children.length ? 0 : 1, cb = nodes.get(b).children.length ? 0 : 1;
      return ca - cb || byLabel(a, b);
    }));

    /* المسار والتابعون */
    nodes.forEach((n) => {
      n.depth = 0;
      let p = n.parent, d = 0;
      while (p) { d++; p = nodes.get(p).parent; }
      n.depth = d;
    });

    /* ── فحوص الصحّة المتبقية ── */
    employees.forEach((e) => {
      if (!e.active) return;
      if (!e.managerName && !e.managerIdRef) {
        issues.push(issue("no_manager", "warning", `${label(e)} بلا مدير مباشر في المصدر`, [e.id]));
      }
      const pid = parentOf.get(e.id);
      const p = pid && nodes.get(pid);
      if (p && p.kind === "employee" && !p.active) {
        issues.push(issue("inactive_manager", "warning",
          `${label(e)} يتبع مديرًا حالته «${p.status || "غير محدّدة"}»`, [e.id, p.id]));
      }
      if (e.isManager && !e.children.length) {
        issues.push(issue("manager_without_reports", "warning", `${label(e)} معرَّف مديرًا ولا تابع له`, [e.id]));
      }
    });
    const refList = [...refs.values()].filter((r) => keep.has(r.id));
    if (refList.length) {
      issues.push(issue("unlinked_manager", "warning",
        `${countPhrase(refList.length, "مدير مباشر يحتاج", "مديران مباشران يحتاجان", "مدراء مباشرين يحتاجون", "مديرًا مباشرًا يحتاجون")} ربطًا بسجلات الموظفين`,
        refList.map((r) => r.id)));
    }
    const tops = rootNode.children;
    if (tops.length > 1) {
      issues.push(issue("multiple_roots", "info",
        `${tops.length} رؤوس منفصلة — المصدر لا يحدّد من يدير المدراء المباشرين`, tops.slice()));
    }
    const byEmail = new Map();
    employees.forEach((e) => {
      const k = normEmail(e.email);
      if (!k) return;
      if (!byEmail.has(k)) byEmail.set(k, []);
      byEmail.get(k).push(e.id);
    });
    byEmail.forEach((ids, k) => {
      if (ids.length > 1) issues.push(issue("duplicate_email", "warning", `البريد ${k} مكرّر في ${ids.length} سجلّات`, ids));
    });
    employees.forEach((e) => {
      if (!e.nameAr) return;
      const words = e.nameAr.split(/\s+/);
      const half = words.length / 2;
      if (words.length >= 2 && words.length % 2 === 0 && words.slice(0, half).join(" ") === words.slice(half).join(" ")) {
        issues.push(issue("repeated_name", "info", `الاسم العربي «${e.nameAr}» مكرّر داخل الخانة نفسها`, [e.id]));
      }
    });

    return { nodes, rootId: ROOT_ID, issues: sortIssues(issues), references: refList.map((r) => r.id) };
  }

  const SEVERITY = { error: 0, warning: 1, info: 2 };
  function sortIssues(list) { return list.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]); }
  function issue(code, severity, message, nodes) { return { code, severity, message, nodes: nodes || [] }; }
  function label(n) { return n ? (n.nameAr || n.nameEn || n.id) : "؟"; }

  /* العربية تصرّف المعدود: 1 / 2 / 3-10 / 11+ */
  function countPhrase(n, one, two, few, many) {
    if (n === 1) return `${one}`;
    if (n === 2) return `${two}`;
    if (n <= 10) return `${n} ${few}`;
    return `${n} ${many}`;
  }

  /* ── الاستعلام ────────────────────────────────────────────────────── */
  function ancestors(tree, id) {
    const out = [];
    let n = tree.nodes.get(id);
    while (n && n.parent) { out.unshift(n.parent); n = tree.nodes.get(n.parent); }
    return out;
  }
  /* المسار الإداري للعرض: الجذر → … → العقدة */
  function pathOf(tree, id) { return [...ancestors(tree, id), id]; }

  function descendants(tree, id) {
    const out = [];
    const walk = (nid) => tree.nodes.get(nid).children.forEach((c) => { out.push(c); walk(c); });
    if (tree.nodes.has(id)) walk(id);
    return out;
  }

  function employeesOf(tree) { return [...tree.nodes.values()].filter((n) => n.kind === "employee" && n.parent); }

  function stats(tree) {
    const emps = employeesOf(tree).filter((n) => n.active);
    const managers = [...tree.nodes.values()].filter((n) => n.kind !== "root" && n.parent && n.children.length);
    /* أكبر فريق قد يتعادل فيه أكثر من مدير — يُذكرون جميعًا لا الأوّل وحده. */
    const top = managers.reduce((mx, m) => Math.max(mx, m.children.length), 0);
    const largest = top ? managers.filter((m) => m.children.length === top) : [];
    return {
      employees: emps.length,
      departments: new Set(emps.map((e) => e.deptKey).filter(Boolean)).size,
      locations: new Set(emps.map((e) => e.locKey).filter(Boolean)).size,
      managers: managers.length,
      references: tree.references.length,
      largestTeam: largest.length ? { size: top, ids: largest.map((m) => m.id), names: largest.map(label) } : null,
    };
  }

  /* قوائم المرشّحات تُشتقّ من البيانات — لا قائمة مثبّتة. */
  function facets(tree) {
    const emps = employeesOf(tree).filter((n) => n.active);
    const collect = (key, lbl) => {
      const m = new Map();
      emps.forEach((e) => { if (e[key]) m.set(e[key], { key: e[key], label: e[lbl], count: (m.get(e[key]) || { count: 0 }).count + 1 }); });
      return [...m.values()].sort((a, b) => a.label.localeCompare(b.label, "ar"));
    };
    return { departments: collect("deptKey", "department"), locations: collect("locKey", "location") };
  }

  /* البحث يشمل الاسم العربي والإنجليزي والقسم والموقع واسم المدير.
     يُرجع الموظفين المطابقين، والعقد التي يجب فتحها لإظهارهم، ومساراتهم. */
  function search(tree, query) {
    const q = norm(query);
    if (!q) return { matches: [], expand: new Set(), paths: new Set() };
    const matches = [];
    tree.nodes.forEach((n) => {
      if (n.kind === "root" || !n.parent) return;
      const parent = tree.nodes.get(n.parent);
      const managerLabel = parent && parent.kind !== "root" ? parent.nameAr : n.managerName;
      const hay = [n.nameAr, n.nameEn, n.department, n.location, managerLabel].map(norm).join(" | ");
      if (hay.includes(q)) matches.push(n.id);
    });
    const expand = new Set(), paths = new Set();
    matches.forEach((id) => ancestors(tree, id).forEach((a) => { expand.add(a); paths.add(a); }));
    matches.forEach((id) => paths.add(id));
    return { matches, expand, paths };
  }

  /* المرشّحات تُبقي الموظفين النشطين المطابقين وسلسلة مدرائهم سياقًا لهم.
     بلا معيار تُرجع null = الكلّ ظاهر، فيبقى المسار الافتراضي بلا كلفة. */
  function filter(tree, f) {
    const crit = f || {};
    if (!crit.department && !crit.location) return null;
    const visible = new Set([tree.rootId]);
    employeesOf(tree).forEach((e) => {
      if (!e.active) return;
      if (crit.department && e.deptKey !== crit.department) return;
      if (crit.location && e.locKey !== crit.location) return;
      visible.add(e.id);
      ancestors(tree, e.id).forEach((a) => visible.add(a));
    });
    return visible;
  }

  /* وضع «حسب المواقع»: موقع ← مدير ← موظفون. المدير يتكرّر تحت كل موقع
     يعمل فيه تابعوه؛ موظف بلا مدير يقع تحت موقعه مباشرة. */
  function groupByLocation(tree, visible) {
    const groups = new Map();
    employeesOf(tree).forEach((e) => {
      if (!e.active || (visible && !visible.has(e.id))) return;
      const key = e.locKey || "—";
      if (!groups.has(key)) groups.set(key, { key, label: e.location || "موقع غير محدّد", managers: new Map(), direct: [] });
      const g = groups.get(key);
      const parent = tree.nodes.get(e.parent);
      if (parent && parent.kind !== "root") {
        if (!g.managers.has(parent.id)) g.managers.set(parent.id, []);
        g.managers.get(parent.id).push(e.id);
      } else g.direct.push(e.id);
    });
    return [...groups.values()]
      .map((g) => ({ key: g.key, label: g.label, direct: g.direct,
        managers: [...g.managers.entries()].map(([id, members]) => ({ id, members })),
        count: g.direct.length + [...g.managers.values()].reduce((s, m) => s + m.length, 0) }))
      .sort((a, b) => a.label.localeCompare(b.label, "ar"));
  }

  /* قائمة الجوال المتدرّجة: صفوف مسطّحة بعمق، تُظهر أبناء المفتوح فقط.
     الجذر نفسه لا يظهر صفًّا — رؤوس الشجرة هي المستوى الأوّل. */
  function flattenForList(tree, expanded, visible) {
    const rows = [];
    const open = expanded instanceof Set ? expanded : new Set(expanded || []);
    const walk = (id, depth) => {
      const n = tree.nodes.get(id);
      const kids = n.children.filter((c) => !visible || visible.has(c));
      if (id !== tree.rootId) {
        rows.push({ id, depth, hasChildren: kids.length > 0, expanded: open.has(id), size: kids.length });
        if (!open.has(id)) return;
      }
      kids.forEach((c) => walk(c, id === tree.rootId ? 0 : depth + 1));
    };
    walk(tree.rootId, -1);
    return rows;
  }

  /* الربط بسجلّات المنصّة بالبريد وحده. بريد يحمله أكثر من سجلّ في المنصّة
     ملتبس فلا يُربط. يُرجع Map: id العقدة → فهرس السجلّ في platformList. */
  function linkPlatform(tree, platformList, emailKey) {
    const byEmail = new Map();
    (platformList || []).forEach((p, i) => {
      const k = normEmail(p && p[emailKey]);
      if (!k) return;
      byEmail.set(k, byEmail.has(k) ? -1 : i);
    });
    const links = new Map(), ambiguous = [], unmatched = [];
    employeesOf(tree).forEach((e) => {
      const k = normEmail(e.email);
      if (!k || !byEmail.has(k)) { unmatched.push(e.id); return; }
      const i = byEmail.get(k);
      if (i < 0) { ambiguous.push(e.id); return; }
      links.set(e.id, i);
    });
    const used = new Set(links.values());
    const platformOnly = (platformList || []).map((_, i) => i).filter((i) => !used.has(i));
    return { links, ambiguous, unmatched, platformOnly };
  }

  /* ── فحص تعيين مدير قبل الكتابة (يستعمله الخادم) ──────────────────
     edges: Map أو كائن id → managerId للحالة الحالية. يرفض: المدير
     نفسه، والمدير غير الموجود، وأي تعيين يُغلق حلقة (A↔B أو أطول). */
  function checkManagerAssignment(edges, employeeId, managerId, knownIds) {
    const get = edges instanceof Map ? (k) => edges.get(k) : (k) => edges[k];
    const emp = String(employeeId);
    if (managerId == null || managerId === "") return { ok: true };
    const mgr = String(managerId);
    if (mgr === emp) return { ok: false, code: "self_manager", message: "لا يمكن أن يكون الموظف مديرًا لنفسه" };
    if (knownIds && !knownIds.has(mgr)) return { ok: false, code: "missing_manager", message: `المدير ${mgr} غير موجود في سجلّ الموظفين` };
    let cur = mgr;
    const seen = new Set();
    while (cur != null && cur !== "") {
      if (cur === emp) return { ok: false, code: "cycle", message: "هذا التعيين يُنشئ تسلسلًا إداريًا دائريًا" };
      if (seen.has(cur)) break; // حلقة قائمة لا تمرّ بالموظف — ليست من صنع هذا التعيين
      seen.add(cur);
      const next = get(cur);
      cur = next == null ? null : String(next);
    }
    return { ok: true };
  }

  const OrgCore = {
    ACTIVE, ROOT_ID, norm, buildHierarchy, ancestors, pathOf, descendants, stats, facets,
    search, filter, groupByLocation, flattenForList, linkPlatform, checkManagerAssignment, countPhrase, label,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = OrgCore;
  else root.OrgCore = OrgCore;
})(typeof window !== "undefined" ? window : globalThis);
