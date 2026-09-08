/* ─── الحساب المحميّ (Protected User) ───────────────────────────────────
   =========================================================================
   قدرةٌ عامّة في المنصّة: حسابٌ لا تستطيع أدواتُ إدارة المستخدمين المساسَ
   به — لا بريده، ولا دوره، ولا حالته، ولا صلاحياته، ولا كلمة مروره —
   مهما كان دور من يحاول. حتى المالك.

   لماذا لا يكفي الدور: `hasPermission` في lib/auth/permissions.js يبدأ بـ
   `if (user.role === "owner") return true` قبل أي فحص. فأيّ حمايةٍ تُبنى
   على صلاحية تنفتح لكل مالك؛ وأيّ حمايةٍ تُبنى على «كن مالكًا» تبقى
   مرهونةً بأن يظل دور الحساب مالكًا وأن يبقى عدد المالكين واحدًا — وكلاهما
   يُغيَّر من إدارة المستخدمين نفسها. الحماية هنا تقوم على `users.id` وحده:
   مُعرّف يولّده الخادم بـ crypto.randomUUID() عند الإنشاء، ولا يكتبه ولا
   يغيّره أيّ مسار في التطبيق (updateUser يكتب كل عمود عداه).

   الهوية تأتي من متغيّر البيئة PROTECTED_USER_IDS — قائمة معرّفات مفصولة
   بفواصل. لا معرّف ولا بريد مضمَّن في الشيفرة إطلاقًا، وغياب المتغيّر يعني
   ألّا أحد محميّ: أي أن سلوك المنصّة يبقى كما هو حرفًا بحرف حتى يُضبط.

   ── تصنيف الحقول: قائمة مسموح لا قائمة ممنوع ──
   قائمةُ الممنوع تحمي ممّا فكّرنا فيه اليوم فقط؛ فحقلٌ جديد يُضاف إلى
   المستخدمين بعد سنة كان سينزلق عبرها بلا انتباه. لذلك الحقل غير المصنَّف
   هنا مرفوضٌ افتراضيًا (fail-closed): إضافة حقل جديد إلى users تُوقف
   تعديله على الحساب المحميّ حتى يُصنَّف صراحةً في أحد الأصناف أدناه. */

/* حقول يكتبها النظام لا الإنسان. لولا استثناؤها لانكسر تسجيل الدخول
   نفسه: touchLastLogin يمرّ من updateUser في كل دخول ناجح. */
const SYSTEM_FIELDS = new Set(["lastLogin"]);

/* بيانات عرض لا أثر أمنيّ لها — لصاحب الحساب وحده. */
const SELF_EDITABLE_FIELDS = new Set(["name", "jobTitle"]);

/* كلمة المرور: لصاحب الحساب وحده، وبشرطٍ ثانٍ فوق ذلك — أن يكون المُنادي
   قد تحقّق من كلمة المرور الحالية. المسار الحالي في api/app.js لا يطلب
   القديمة، فمن يسرق كوكي الجلسة يستطيع تغيير كلمة المرور وإقصاء صاحبها.
   الشرطُ هنا يجعل ذلك مستحيلًا حتى لو نسي مُنادٍ مستقبليٌّ الفحصَ في
   طبقته: الرفض يقع في طبقة البيانات لا في الواجهة. */
const SELF_PASSWORD_FIELDS = new Set(["passwordHash"]);

/* مجمَّدة على الجميع — ولا حتى على صاحب الحساب.

   البريد مجمَّد عمدًا وإن بدا ملكًا لصاحبه: القسم المحميّ يشترط تطابق
   البريد للدخول، فتغييره من الواجهة قفلٌ ذاتيّ فوريّ بلا استرجاع من داخل
   التطبيق. والدور والحالة والصلاحيات مجمَّدة لأن تغييرها على حسابٍ محميّ
   لا يخدم غرضًا مشروعًا ويفتح بابًا لإقصائه.

   تغيير أيٍّ من هذه قرارٌ خارج التطبيق عمدًا (انظر Runbook الاسترجاع). */
const FROZEN_FIELDS = new Set(["email", "role", "status", "permissions"]);

const MESSAGES = {
  not_self: "هذا الحساب محميّ ولا يمكن تعديله من أدوات إدارة المستخدمين",
  frozen: "هذا الحقل غير قابل للتعديل على حساب محميّ",
  password_unverified: "تغيير كلمة مرور حساب محميّ يتطلّب كلمة المرور الحالية",
  unclassified: "هذا الحساب محميّ — الحقل غير مصنَّف فيُرفض افتراضيًا",
  delete: "هذا الحساب محميّ ولا يمكن حذفه",
};

/* تُقرأ عند كل نداء لا عند تحميل الوحدة، مع ذاكرة مؤقّتة على القيمة الخام:
   بلا ذلك يتجمّد الإعداد على ما كان وقت أول require، فيعمى أي اختبار
   يضبط المتغيّر بين حالة وأخرى — والاختبار هنا هو ما يثبت أن الحماية
   تعمل أصلًا. */
let cache = { raw: null, ids: [] };

function protectedIds() {
  const raw = String(process.env.PROTECTED_USER_IDS || "");
  if (cache.raw !== raw) {
    cache = { raw, ids: raw.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  return cache.ids;
}

/* لا حساب محميّ ما لم يُضبط المتغيّر — وهذا مقصود لا تساهل: الحماية قدرةٌ
   تُفعَّل بإعداد صريح، وبيئة بلا إعداد تتصرّف كما كانت تمامًا. أمّا
   العكس — أن تُخطئ فتحمي حسابًا لم يُقصد — فيُعطّل إدارة المستخدمين كلّها
   في تلك البيئة. */
function isConfigured() {
  return protectedIds().length > 0;
}

function isProtected(id) {
  if (id === null || id === undefined || id === "") return false;
  return protectedIds().includes(String(id));
}

/* يُرجع {field, reason, message} لأول حقل مرفوض، أو null إن كانت الرقعة
   كلّها مسموحة. لا يفحص هل الحساب محميّ — ذلك عمل guardUpdate.

   opts.selfEdit                 : المُنادي هو صاحب الحساب نفسه
   opts.currentPasswordVerified  : المُنادي تحقّق من كلمة المرور الحالية */
function refusalFor(patch, opts = {}) {
  for (const field of Object.keys(patch || {})) {
    if (SYSTEM_FIELDS.has(field)) continue;
    if (FROZEN_FIELDS.has(field)) return { field, reason: "frozen", message: MESSAGES.frozen };
    if (SELF_PASSWORD_FIELDS.has(field)) {
      if (!opts.selfEdit) return { field, reason: "not_self", message: MESSAGES.not_self };
      if (!opts.currentPasswordVerified) {
        return { field, reason: "password_unverified", message: MESSAGES.password_unverified };
      }
      continue;
    }
    if (SELF_EDITABLE_FIELDS.has(field)) {
      if (!opts.selfEdit) return { field, reason: "not_self", message: MESSAGES.not_self };
      continue;
    }
    /* الحقل غير مصنَّف: يُرفض. هذا هو fail-closed الموصوف أعلاه. */
    return { field, reason: "unclassified", message: MESSAGES.unclassified };
  }
  return null;
}

/* الحارس الذي تستدعيه طبقة البيانات (lib/auth/users.js). */
function guardUpdate(id, patch, opts = {}) {
  if (!isProtected(id)) return null;
  return refusalFor(patch, opts);
}

function guardDelete(id) {
  if (!isProtected(id)) return null;
  return { field: null, reason: "delete", message: MESSAGES.delete };
}

module.exports = {
  SYSTEM_FIELDS,
  SELF_EDITABLE_FIELDS,
  SELF_PASSWORD_FIELDS,
  FROZEN_FIELDS,
  MESSAGES,
  isConfigured,
  isProtected,
  refusalFor,
  guardUpdate,
  guardDelete,
};
