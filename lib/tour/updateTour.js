/* جولة التحديثات — إصدارات مُعرَّفة بثبات، وحالة لكل مستخدم على الخادم.
   =========================================================================
   كل إصدار معرّفه ثابت لا يتغيّر بعد النشر (release-YYYY.MM.DD). المستخدم
   يرى جولة الإصدار الحالي مرّة واحدة: حتى يُكملها أو يتخطّاها. «لاحقًا»
   لا يُحفظ أصلًا، فتعود النافذة في الدخول القادم.

   أين تُحفظ الحالة: في audit_log القائم، لا في جدول جديد ولا عمود جديد.
   الحدث نفسه هو الحالة:

     type        update_tour_started | update_tour_completed | update_tour_skipped
     actor_id    معرّف المستخدم (من الجلسة وحدها، لا من الطلب)
     target_id   معرّف الإصدار
     meta        { steps } — عدد الخطوات المعروضة، لا أكثر

   «شاهد الإصدار» = وُجد له صفّ completed أو skipped بذلك الإصدار. فحسابٌ
   على جهاز ثانٍ أو بعد مسح المتصفّح يُعرف من الخادم، وإصدارٌ جديد بمعرّف
   جديد لا يجد صفًّا فيظهر مرّة واحدة.

   لماذا لا lib/data/settings: جدول settings يُدمج كاملًا في كائن واحد
   يُعاد لكل من يملك settings:view، فمفاتيح لكل مستخدم تتسرّب إلى الجميع
   ويملك تعديلها كل من يملك settings:edit. audit_log لا يُقرأ من الواجهة
   (readLog بلا مُنادٍ)، ويكتب فيه صاحب الجلسة وحده.

   إضافة جولة جديدة: أضف إصدارًا إلى RELEASES بمعرّف جديد، واجعل
   CURRENT_VERSION يشير إليه. لا migration ولا تعديل في أي ملف آخر —
   إلا إن احتاجت خطوة تجهيزًا جديدًا (prepare) فيُضاف في update-tour.js. */

const { hasPermission } = require("../auth/permissions");

const CURRENT_VERSION = "release-2026.10.27";

/* شكل الخطوة:
     id        ثابت داخل الإصدار
     title     العنوان
     body      وصف مختصر
     requires  [[section, action], ...] — كلها لازمة. خطوة بلا صلاحية لا
               تُرسل إلى المتصفّح أصلًا.
     section   عنصر القسم في الصفحة. غيابه أو إخفاؤه يُسقط الخطوة.
     target    محدِّدات بالترتيب: أوّل عنصر ظاهر هو ما يُبرز، وإلّا القسم.
     prepare   اسم تجهيز آمن يُنفَّذ قبل الخطوة (انظر PREPARE في
               update-tour.js) — بيانات لا شيفرة. */
const RELEASES = {
  "release-2026.10.27": {
    title: "قمنا بإضافة مزايا جديدة",
    intro: "أضفنا مجموعة من التحسينات والمزايا الجديدة لتسهيل استخدام المنصة.",
    steps: [
      {
        id: "ajeer-cards",
        title: "تصاريح أجير",
        body: "تم تطوير عرض تصاريح أجير لتظهر كبطاقات أوضح، مع إمكانية عرض الباركود ومسحه مباشرة للتحقق من التصريح.",
        requires: [["ajeer", "view"]],
        section: "#ajeerSec",
        target: ["#ajeerGrid > .aj-card", "#ajeerSec"],
      },
      {
        id: "doc-expiry-grouped",
        title: "الوثائق القادمة على انتهاء الصلاحية",
        body: "تم تحسين عرض الوثائق بحيث يتم جمع الوثائق التي تنتهي في نفس التاريخ للموظف في صف واحد، مما يجعل المتابعة أسهل وأوضح.",
        /* القسم داخل المؤشرات التنفيذية، وبياناته من سجلّ الموظفين: بلا
           إحداهما يظهر فارغًا، فلا معنى لشرحه. */
        requires: [["kpi", "view"], ["employees", "view"]],
        section: "#docExpiry",
        target: ["#docExpiry .dx-table-card", "#docExpiry"],
        prepare: "doc-expiry-duration-view",
      },
      {
        id: "municipal-cards",
        title: "البطاقات البلدية",
        body: "تمت إضافة بطاقات الشهادات الصحية البلدية مع إمكانية عرض الباركود والتحقق من الشهادة بسهولة.",
        requires: [["municipal", "view"]],
        section: "#municipalSec",
        target: ["#municipalGrid > .mc-tile", "#municipalSec"],
      },
    ],
  },
};

const ACTIONS = new Set(["started", "completed", "skipped"]);
function releaseOf(version) {
  return Object.prototype.hasOwnProperty.call(RELEASES, version) ? RELEASES[version] : null;
}

/* الخطوات التي يملك المستخدم صلاحياتها كاملة، بلا requires في الناتج —
   المتصفّح لا يحتاج إلى معرفة سبب وجود الخطوة. */
function stepsFor(user, version = CURRENT_VERSION) {
  const release = releaseOf(version);
  if (!release || !user) return [];
  return release.steps
    .filter((s) => s.requires.every(([section, action]) => hasPermission(user, section, action)))
    .map(({ requires, ...rest }) => ({ ...rest, target: [...rest.target] }));
}

/* "completed" | "skipped" | null — آخر قرار نهائي للمستخدم في هذا الإصدار.
   started وحده لا يُغلقه: من بدأ ثم أغلق المتصفّح في منتصفها يراها في
   الدخول القادم. */
async function getStatus(sql, userId, version = CURRENT_VERSION) {
  const rows = await sql`
    SELECT type FROM audit_log
    WHERE actor_id = ${String(userId)} AND target_id = ${version}
      AND type IN ('update_tour_completed', 'update_tour_skipped')
    ORDER BY ts DESC
    LIMIT 1`;
  if (!rows[0]) return null;
  return rows[0].type === "update_tour_completed" ? "completed" : "skipped";
}

/* كتابة مُنتظَرة ترمي عند الفشل — بخلاف logEvent الذي يبتلع الخطأ. هنا
   الصفّ هو الحالة نفسها، فلا يُقال للمتصفّح «حُفظ» ما لم يُحفظ فعلًا. */
async function record(sql, user, version, action, meta = {}) {
  if (!ACTIONS.has(action)) throw new Error("إجراء غير معروف");
  if (!releaseOf(version)) throw new Error("إصدار غير معروف");
  const steps = Number.isInteger(meta.steps) && meta.steps >= 0 && meta.steps <= 50 ? meta.steps : null;
  await sql`
    INSERT INTO audit_log (type, actor_email, actor_id, target_id, meta)
    VALUES (${`update_tour_${action}`}, ${user.email || null}, ${String(user.id)}, ${version},
            ${JSON.stringify(steps === null ? {} : { steps })}::jsonb)`;
}

/* ما تحتاجه الواجهة لتقرّر: تُعرض النافذة أم لا، وبأي خطوات. */
async function stateFor(sql, user, version = CURRENT_VERSION) {
  const release = releaseOf(version);
  const steps = stepsFor(user, version);
  if (!release || !steps.length) return { version, show: false, status: "none", tour: null };
  const status = await getStatus(sql, user.id, version);
  if (status) return { version, show: false, status, tour: null };
  return { version, show: true, status: "pending", tour: { title: release.title, intro: release.intro, steps } };
}

module.exports = { CURRENT_VERSION, RELEASES, ACTIONS, stepsFor, getStatus, record, stateFor, releaseOf };
