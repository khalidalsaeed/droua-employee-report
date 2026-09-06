const test = require("node:test");
const assert = require("node:assert/strict");

const { buildEmail, buildPush, dedupKey, notifyEmailAddress, DEFAULT_NOTIFY_EMAIL } = require("../lib/payroll/notify");

/* النصوص مواصفة متّفق عليها حرفًا بحرف، فالاختبار مطابقة لا تقريب:
   أي تحسين لغوي عابر على هذه الجمل يجب أن يكون قرارًا واعيًا يُرى في
   الـdiff، لا تعديلًا يمرّ. */

const RUN = { id: "2026-08", monthLabel: "أغسطس 2026" };

test("عنوان البريد ونصّه مطابقان للمواصفة", () => {
  const { subject, text } = buildEmail(RUN);
  assert.equal(subject, "تم إنشاء مسير رواتب أغسطس 2026");
  assert.equal(
    text,
    "تم إنشاء مسير رواتب أغسطس 2026 تلقائيًا وبانتظار إكمالك ومراجعة بيانات الموظفين وإرفاق إثباتات تحويل الرواتب."
  );
});

test("عنوان إشعار الدفع ونصّه مطابقان للمواصفة", () => {
  const p = buildPush(RUN);
  assert.equal(p.title, "مسير رواتب أغسطس 2026");
  assert.equal(p.body, "تم إنشاء المسير وبانتظار إكمالك له.");
});

/* الضغط يفتح المسير نفسه لا الرئيسية ولا صفحة الوثائق. المسار هو
   الـrewrite القائم في vercel.json: /payroll/:id */
test("إشعار الدفع يوجّه إلى صفحة المسير نفسه", () => {
  assert.equal(buildPush(RUN).url, "/payroll/2026-08");
  assert.equal(buildPush({ id: "2025-12", monthLabel: "ديسمبر 2025" }).url, "/payroll/2025-12");
});

/* tag يحمل الشهر: إشعار سبتمبر لا يستبدل إشعار أغسطس على الجهاز. */
test("وسم الإشعار خاصّ بكل شهر", () => {
  assert.notEqual(buildPush(RUN).tag, buildPush({ id: "2026-09", monthLabel: "سبتمبر 2026" }).tag);
});

test("مفتاح عدم التكرار بالصيغة payroll:YYYY-MM", () => {
  assert.equal(dedupKey("2026-08"), "payroll:2026-08");
});

test("وجهة التنبيه من متغيّر البيئة، وإلّا العنوان الاحتياطي", () => {
  const saved = process.env.PAYROLL_NOTIFY_EMAIL;
  try {
    delete process.env.PAYROLL_NOTIFY_EMAIL;
    assert.equal(notifyEmailAddress(), DEFAULT_NOTIFY_EMAIL);
    process.env.PAYROLL_NOTIFY_EMAIL = "  someone@example.com  ";
    assert.equal(notifyEmailAddress(), "someone@example.com");
    process.env.PAYROLL_NOTIFY_EMAIL = "   ";
    assert.equal(notifyEmailAddress(), DEFAULT_NOTIFY_EMAIL, "قيمة فارغة تعود إلى الاحتياطي لا إلى عنوان فارغ");
  } finally {
    if (saved === undefined) delete process.env.PAYROLL_NOTIFY_EMAIL;
    else process.env.PAYROLL_NOTIFY_EMAIL = saved;
  }
});
