const test = require("node:test");
const assert = require("node:assert/strict");

const OrgCore = require("../org-core.js");
const source = require("../lib/org/source.js");

/* اختبارات منطق الهيكل التنظيمي.
   =========================================================================
   صنفان من البيانات:
     - اللقطة الحقيقية (lib/org/source.js): للتأكّد أن ما يُعرض هو ما في
       التقرير — 12 موظفًا، 5 مدراء مرجعيين، ولا شيء مخترع.
     - صفوف مصنوعة (⛔ لا بيان حقيقي): لكل حالة شاذّة لا تقع في اللقطة —
       المدير نفسه، الحلقات، غير النشطين، تعدّد الرؤوس. */

const tree = () => OrgCore.buildHierarchy(source.ROWS, { rootLabel: "الجذر" });
const codes = (t) => t.issues.map((i) => i.code);
const byName = (t, name) => [...t.nodes.values()].find((n) => n.nameAr === name);

/* صفّ مصنوع: الاسم مفتاح المدير، كما في التقرير */
function row(nameAr, managerName, extra = {}) {
  return { row: null, status: "نشط", department: "قسم", location: "موقع", managerName, email: null, nameEn: null, nameAr, ...extra };
}

/* ── اللقطة الحقيقية ─────────────────────────────────────────────────── */

test("اللقطة: 12 موظفًا نشطًا، 3 أقسام، 5 مواقع، 5 مدراء", () => {
  const st = OrgCore.stats(tree());
  assert.equal(source.ROWS.length, 12);
  assert.equal(st.employees, 12);
  assert.equal(st.departments, 3, "«ادارة الإنتاج» و«إدارة التشغيل» قسمان لا ثلاثة بسبب الهمزة");
  assert.equal(st.locations, 5);
  assert.equal(st.managers, 5);
  assert.equal(st.references, 5);
});

test("اللقطة: المدراء الخمسة عقد مرجعية بلا أي حقل مخترع", () => {
  const t = tree();
  const refs = t.references.map((id) => t.nodes.get(id));
  assert.deepEqual(refs.map((r) => r.nameAr).sort(),
    ["ابراهيم خليل", "محمد مهيد الاسلام", "مد جهاد", "مد عبدالملك", "منير حسين فيصل"].sort());
  for (const r of refs) {
    assert.equal(r.kind, "reference");
    assert.equal(r.linked, false);
    for (const k of ["email", "jobTitle", "department", "location", "nameEn", "status"]) {
      assert.equal(r[k], null, `${r.nameAr}: الحقل ${k} يجب أن يبقى فارغًا`);
    }
  }
});

test("اللقطة: كل مجموعة تحت مديرها كما في التقرير", () => {
  const t = tree();
  const team = (mgr) => t.nodes.get(byName(t, mgr).id).children.map((id) => t.nodes.get(id).nameAr).sort();
  assert.deepEqual(team("منير حسين فيصل"), ["شكيب مياه", "مد فرهاد علي شاركير"].sort());
  assert.deepEqual(team("مد عبدالملك"), ["الأمين مولا", "محمد راسل برودان", "مد توفيق"].sort());
  assert.deepEqual(team("ابراهيم خليل"), ["راسل ديوان راسل ديوان", "شميم حسين", "مد طيف الرحمن شهاب"].sort());
  assert.deepEqual(team("محمد مهيد الاسلام"), ["مد شهيد الاسلام", "مد هلال مد الدين"].sort());
  assert.deepEqual(team("مد جهاد"), ["ساجر احمد", "عبد المنان"].sort());
});

test("اللقطة: الفاحص يعلن المدراء غير المربوطين ولا يمنع الرسم", () => {
  const t = tree();
  const unlinked = t.issues.find((i) => i.code === "unlinked_manager");
  assert.equal(unlinked.severity, "warning");
  assert.equal(unlinked.message, "5 مدراء مباشرين يحتاجون ربطًا بسجلات الموظفين");
  assert.ok(!t.issues.some((i) => i.severity === "error"), "لا خطأ في اللقطة الحالية");
  assert.equal(t.nodes.get(t.rootId).children.length, 5, "الشجرة مرسومة رغم التنبيه");
});

test("اللقطة: أكبر فريق يذكر المتعادلين جميعًا", () => {
  const st = OrgCore.stats(tree());
  assert.equal(st.largestTeam.size, 3);
  assert.deepEqual(st.largestTeam.names.sort(), ["ابراهيم خليل", "مد عبدالملك"].sort());
});

test("اللقطة: الاسم المكرّر داخل خانته ملاحظةٌ لا تصحيح", () => {
  const t = tree();
  assert.ok(t.issues.some((i) => i.code === "repeated_name" && i.message.includes("راسل ديوان راسل ديوان")));
  assert.ok(byName(t, "راسل ديوان راسل ديوان"), "الاسم يُعرض كما في المصدر");
});

/* ── بناء الهيكل ─────────────────────────────────────────────────────── */

test("المدير الموجود سجلًّا يُربط به لا بعقدة مرجعية", () => {
  const t = OrgCore.buildHierarchy([row("مدير", null), row("موظف", "مدير")]);
  const emp = byName(t, "موظف");
  assert.equal(t.nodes.get(emp.parent).nameAr, "مدير");
  assert.equal(t.references.length, 0);
});

test("المطابقة بعد تطبيع الإملاء وحده، لا مطابقة تقريبية", () => {
  const t = OrgCore.buildHierarchy([row("إبراهيم خليل", null), row("أ", "ابراهيم  خليل"), row("ب", "ابراهيم خليل محمد")]);
  assert.equal(t.nodes.get(byName(t, "أ").parent).nameAr, "إبراهيم خليل", "الهمزة والمسافة المزدوجة فرقٌ إملائي");
  assert.equal(t.nodes.get(byName(t, "ب").parent).kind, "reference", "اسمٌ أطول ليس الشخص نفسه");
});

test("اسم مدير يطابق موظفَين لا يُربط بأيّهما", () => {
  const t = OrgCore.buildHierarchy([row("سمي", null, { row: 1 }), row("سمي", null, { row: 2 }), row("تابع", "سمي")]);
  assert.ok(codes(t).includes("ambiguous_manager"));
  assert.equal(t.nodes.get(byName(t, "تابع").parent).kind, "reference");
});

test("رؤوس متعدّدة: ملاحظة لا خطأ", () => {
  const t = OrgCore.buildHierarchy([row("أ", "م1"), row("ب", "م2")]);
  const it = t.issues.find((i) => i.code === "multiple_roots");
  assert.equal(it.severity, "info");
  assert.equal(it.nodes.length, 2);
});

test("رأس واحد: لا ملاحظة تعدّد", () => {
  const t = OrgCore.buildHierarchy([row("م", null), row("أ", "م"), row("ب", "م")]);
  assert.ok(!codes(t).includes("multiple_roots"));
});

test("موظف بلا مدير: تنبيه ويظهر رأسًا", () => {
  const t = OrgCore.buildHierarchy([row("وحيد", null)]);
  assert.ok(codes(t).includes("no_manager"));
  assert.equal(byName(t, "وحيد").parent, t.rootId);
});

test("المدير نفسه بالاسم: خطأ، والموظف يبقى ظاهرًا", () => {
  const t = OrgCore.buildHierarchy([row("نرجس", "نرجس")]);
  const it = t.issues.find((i) => i.code === "self_manager");
  assert.equal(it.severity, "error");
  assert.equal(byName(t, "نرجس").parent, t.rootId);
});

test("المدير نفسه بالمعرّف (النموذج المستقبلي): خطأ", () => {
  const t = OrgCore.buildHierarchy([{ id: "500", nameAr: "أ", status: "نشط", managerId: "500" }]);
  assert.ok(codes(t).includes("self_manager"));
});

test("معرّف مدير غير موجود: خطأ", () => {
  const t = OrgCore.buildHierarchy([{ id: "500", nameAr: "أ", status: "نشط", managerId: "999" }]);
  assert.ok(codes(t).includes("missing_manager_id"));
});

test("حلقة من عقدتين: A يدير B و B يدير A", () => {
  const t = OrgCore.buildHierarchy([row("أ", "ب"), row("ب", "أ")]);
  const cyc = t.issues.filter((i) => i.code === "cycle");
  assert.equal(cyc.length, 1, "الحلقة تُسجَّل مرّة واحدة");
  assert.equal(cyc[0].severity, "error");
  assert.equal(cyc[0].nodes.length, 2);
  assert.match(cyc[0].message, /إدارة متبادلة/);
  // الشجرة لا تختفي: الحلقة تُكسر والعقدتان ظاهرتان
  assert.ok(byName(t, "أ").parent && byName(t, "ب").parent);
});

test("حلقة أطول: A ← B ← C ← A", () => {
  const t = OrgCore.buildHierarchy([row("أ", "ب"), row("ب", "ج"), row("ج", "أ"), row("د", "أ")]);
  const cyc = t.issues.filter((i) => i.code === "cycle");
  assert.equal(cyc.length, 1);
  assert.equal(cyc[0].nodes.length, 3);
  assert.match(cyc[0].message, /دائري/);
  assert.ok(byName(t, "د").parent, "التابع خارج الحلقة يبقى مرسومًا");
  // لا عقدة جدّها نفسها بعد الكسر
  for (const n of t.nodes.values()) assert.ok(!OrgCore.ancestors(t, n.id).includes(n.id));
});

test("مدير معرَّف بلا تابعين: تنبيه", () => {
  const t = OrgCore.buildHierarchy([row("م", null, { isManager: true })]);
  assert.ok(codes(t).includes("manager_without_reports"));
});

test("بريد مكرّر في المصدر: تنبيه", () => {
  const t = OrgCore.buildHierarchy([row("أ", "م", { email: "X@a.com" }), row("ب", "م", { email: "x@a.com " })]);
  assert.ok(codes(t).includes("duplicate_email"));
});

/* ── غير النشطين ─────────────────────────────────────────────────────── */

test("غير النشط يُستبعد من الشجرة والعدّ، ويُعلَن", () => {
  const t = OrgCore.buildHierarchy([row("نشط١", "م"), row("مغادر", "م", { status: "غير نشط" })]);
  assert.equal(byName(t, "مغادر").parent, null);
  assert.equal(OrgCore.stats(t).employees, 1);
  assert.ok(codes(t).includes("inactive_excluded"));
});

test("مدير غير نشط يتبعه نشطون: يبقى سياقًا معلَّمًا مع تنبيه", () => {
  const t = OrgCore.buildHierarchy([row("مدير قديم", null, { status: "منتهي الخدمة" }), row("تابع", "مدير قديم")]);
  const mgr = byName(t, "مدير قديم");
  assert.ok(mgr.parent, "المدير ظاهر كي لا يُفصل التابع عنه");
  assert.equal(mgr.active, false);
  assert.ok(codes(t).includes("inactive_manager"));
  assert.equal(OrgCore.stats(t).employees, 1, "لا يُحتسب موظفًا نشطًا");
});

/* ── البحث والمرشّحات ────────────────────────────────────────────────── */

test("البحث بالاسم العربي يفتح المسار ويحدّده", () => {
  const t = tree();
  const r = OrgCore.search(t, "شميم");
  assert.equal(r.matches.length, 1);
  const id = r.matches[0];
  assert.ok(r.expand.has(t.nodes.get(id).parent), "مديره يُفتح");
  assert.ok(r.paths.has(t.rootId) && r.paths.has(id));
});

test("البحث بالإنجليزي والقسم والموقع والمدير", () => {
  const t = tree();
  assert.equal(OrgCore.search(t, "samim").matches.length, 1);
  assert.equal(OrgCore.search(t, "إدارة الإنتاج").matches.length, 3, "بالهمزة أو بدونها");
  assert.equal(OrgCore.search(t, "فرع اليرموك").matches.length, 2);
  const byMgr = OrgCore.search(t, "مد جهاد").matches.map((id) => t.nodes.get(id).nameAr).sort();
  assert.deepEqual(byMgr, ["ساجر احمد", "عبد المنان", "مد جهاد"].sort(), "المدير نفسه وتابعاه");
});

test("بحث فارغ لا يطابق شيئًا", () => {
  assert.equal(OrgCore.search(tree(), "  ").matches.length, 0);
});

test("المرشّحات مشتقّة من البيانات لا مثبّتة", () => {
  const f = OrgCore.facets(tree());
  assert.deepEqual(f.departments.map((d) => d.label).sort(), ["ادارة الإنتاج", "إدارة التشغيل", "السائقين"].sort());
  assert.equal(f.locations.length, 5);
  assert.equal(f.locations.reduce((s, l) => s + l.count, 0), 12);
});

test("ترشيح القسم يُبقي موظفيه وسلسلة مدرائهم فقط", () => {
  const t = tree();
  const key = OrgCore.facets(t).departments.find((d) => d.label === "السائقين").key;
  const vis = OrgCore.filter(t, { department: key });
  const names = [...vis].map((id) => t.nodes.get(id).nameAr);
  assert.ok(names.includes("شكيب مياه") && names.includes("منير حسين فيصل"));
  assert.ok(!names.includes("شميم حسين"));
  assert.equal([...vis].filter((id) => t.nodes.get(id).kind === "employee").length, 2);
});

test("ترشيح الموقع، والقسم والموقع معًا", () => {
  const t = tree();
  const f = OrgCore.facets(t);
  const loc = f.locations.find((l) => l.label === "فرع حي الملك فهد").key;
  const emps = (vis) => [...vis].filter((id) => t.nodes.get(id).kind === "employee").length;
  assert.equal(emps(OrgCore.filter(t, { location: loc })), 3);
  const prod = f.departments.find((d) => d.label === "ادارة الإنتاج").key;
  assert.equal(emps(OrgCore.filter(t, { location: loc, department: prod })), 0);
});

test("بلا معيار: null = الكلّ ظاهر", () => {
  assert.equal(OrgCore.filter(tree(), {}), null);
});

test("وضع المواقع: كل موقع بمديره وموظفيه", () => {
  const g = OrgCore.groupByLocation(tree());
  assert.equal(g.length, 5);
  const kitchen = g.find((x) => x.label === "المطبخ المركزي");
  assert.equal(kitchen.count, 3);
  assert.equal(kitchen.managers.length, 1);
  assert.equal(kitchen.managers[0].members.length, 3);
});

/* ── قائمة الجوال ────────────────────────────────────────────────────── */

test("قائمة الجوال: مغلقة تُظهر الرؤوس وحدها", () => {
  const rows = OrgCore.flattenForList(tree(), new Set());
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.depth === 0 && r.hasChildren && !r.expanded));
});

test("قائمة الجوال: فتح رأس يُظهر تابعيه بعمق 1 بعده مباشرة", () => {
  const t = tree();
  const mgr = byName(t, "مد عبدالملك").id;
  const rows = OrgCore.flattenForList(t, new Set([mgr]));
  assert.equal(rows.length, 8);
  const at = rows.findIndex((r) => r.id === mgr);
  assert.ok(rows[at].expanded);
  assert.deepEqual(rows.slice(at + 1, at + 4).map((r) => r.depth), [1, 1, 1]);
  assert.ok(rows.slice(at + 1, at + 4).every((r) => !r.hasChildren));
});

test("قائمة الجوال تحترم المرشّح", () => {
  const t = tree();
  const key = OrgCore.facets(t).locations.find((l) => l.label === "السائقين").key;
  const vis = OrgCore.filter(t, { location: key });
  const all = new Set([...t.nodes.values()].filter((n) => n.children.length).map((n) => n.id));
  const rows = OrgCore.flattenForList(t, all, vis);
  assert.equal(rows.length, 3);
});

/* ── الربط بسجلّات المنصّة ───────────────────────────────────────────── */

test("الربط بالبريد وحده، والملتبس لا يُربط", () => {
  const t = OrgCore.buildHierarchy([row("أ", "م", { email: "a@x.com" }), row("ب", "م", { email: "b@x.com" }), row("ج", "م", { email: "c@x.com" })]);
  const platform = [
    { "اسم العامل": "اسم مختلف تمامًا", "البريد الإلكتروني": "A@X.com" },
    { "اسم العامل": "ب١", "البريد الإلكتروني": "b@x.com" },
    { "اسم العامل": "ب٢", "البريد الإلكتروني": "b@x.com" },
    { "اسم العامل": "ليس في المصدر", "البريد الإلكتروني": "z@x.com" },
  ];
  const r = OrgCore.linkPlatform(t, platform, "البريد الإلكتروني");
  assert.equal(r.links.get(byName(t, "أ").id), 0, "البريد يطابق رغم اختلاف الاسم وحالة الأحرف");
  assert.ok(r.ambiguous.includes(byName(t, "ب").id));
  assert.ok(r.unmatched.includes(byName(t, "ج").id));
  assert.deepEqual(r.platformOnly, [1, 2, 3]);
});

/* ── فحص التعيين قبل الكتابة (الخادم) ───────────────────────────────── */

test("التعيين: الموظف مديرًا لنفسه مرفوض", () => {
  const v = OrgCore.checkManagerAssignment(new Map(), "500", "500");
  assert.equal(v.ok, false);
  assert.equal(v.code, "self_manager");
});

test("التعيين: حلقة من عقدتين مرفوضة", () => {
  const edges = new Map([["501", "500"]]); // 500 يدير 501
  assert.equal(OrgCore.checkManagerAssignment(edges, "500", "501").code, "cycle");
});

test("التعيين: حلقة أطول مرفوضة", () => {
  const edges = { 501: "500", 502: "501", 503: "502" }; // 500 ← 501 ← 502 ← 503
  assert.equal(OrgCore.checkManagerAssignment(edges, "500", "503").code, "cycle");
});

test("التعيين: مدير غير موجود مرفوض، والسليم مقبول", () => {
  const ids = new Set(["500", "501"]);
  assert.equal(OrgCore.checkManagerAssignment(new Map(), "500", "999", ids).code, "missing_manager");
  assert.equal(OrgCore.checkManagerAssignment(new Map([["501", null]]), "500", "501", ids).ok, true);
  assert.equal(OrgCore.checkManagerAssignment(new Map(), "500", null).ok, true, "إزالة المدير مقبولة");
});

test("التعيين: حلقة قائمة لا تمرّ بالموظف لا تعلّق الفحص", () => {
  const edges = new Map([["601", "602"], ["602", "601"]]);
  assert.equal(OrgCore.checkManagerAssignment(edges, "500", "601").ok, true);
});
