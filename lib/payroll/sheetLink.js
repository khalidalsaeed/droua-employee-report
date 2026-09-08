/* ربط صفوف كشف الرواتب بسجلّ الموظفين — بمفتاح قاطع وحده.
   =========================================================================
   لماذا وحدة مستقلّة: هذا الربط تحتاجه الآن عمليتان — بذر صفوف الإثبات
   (scripts/backfill-payroll-proofs-2026-08.js) وتخزين راتب المسير
   (lib/payroll/sheetAmounts.js) — وستحتاجه مطابقة الإيصالات بعدهما.
   ونسختان من قاعدة ربطٍ تتباعدان بمرور الوقت، والقاعدة هنا ليست تفصيلًا
   قابلًا للتباعد: هي حجر الأساس الذي منع إرفاق إيصال بالشخص الخطأ.

   ── القاعدة ──
   أرقام الكشف أرقام نظام جسر لا «الرقم الوظيفي» في المنصّة: جسر من
   مرتبتين والمنصّة في المدى 5xx. فالربط عبر حقل «رقم جسر» في سجلّ
   الموظف — مفتاح صريح أُدخل بيد إنسان — لا بمطابقة الأرقام مباشرة.

   والاسم لا يُنشئ رابطًا أبدًا. يُطبع للتشخيص وحده. «شميم» و«شميم حسين»
   يبدوان الشخص نفسه ولا يصحّ أن يقرّر ذلك برنامج، وقد جرّبنا: مطابقٌ
   مضبوط على كشف يوليو حسم ثلاثة من عشرة على كشف أغسطس. والمبلغ لا
   يُعرّف موظفًا إطلاقًا — راتبان متساويان شائعان في هذا الكشف نفسه.

   ورقمٌ في الكشف لا يحمله أحد يُرجَع في `unknown` ولا يُخمَّن له صاحب:
   ترك الصفّ بلا ربط أهون بما لا يُقاس من إسناده لغير صاحبه. */

const { F_JISR, normalizeJisr } = require("../data/employees");

/* رقم الموظف لدى شركة ضمان (500، 501 …) — معرّفه في هذه المنصّة: عمود
   employees.eid ومفتاح الربط في التذاكر والتصاريح وإثباتات التحويل.
   المفتاح المخزَّن يبقى "الرقم الوظيفي" حرفيًا — تغييره هجرةُ JSONB في
   كل صفّ ومفتاحِ ربطٍ عبر أربعة جداول بمكسب صفر. */
const F_DAMANAH = "الرقم الوظيفي";
const F_NAME = "اسم العامل";
const F_JOB = "المهنة";

const SHEET_ATTACHMENT_KEY = "payroll_sheet";

/* رابط كشف الرواتب على المسير: المرفق المخصّص أوّلًا، ثم ملفّ المسير
   الرئيسي — وهو ما ترفعه الواجهة في الحالتين. */
function sheetUrlOf(run) {
  const attachment = ((run && run.attachments) || []).find((a) => a.key === SHEET_ATTACHMENT_KEY && a.fileUrl);
  return (attachment && attachment.fileUrl) || (run && run.fileUrl) || null;
}

/* فهرس الموظفين بـ«رقم جسر» المُطبَّع. يرفض إن حمل موظفان الرقم نفسه:
   دفاعٌ مضاعف فوق الفهرس الفريد في القاعدة — لو عُطّل الفهرس أو أُدخل
   الصفّان قبل إنشائه، لا يصحّ أن يختار البرنامج أحدهما اعتباطًا. */
function indexByJisr(employees) {
  const byJisr = new Map();
  for (const e of employees || []) {
    const key = normalizeJisr(e && e[F_JISR]);
    if (!key) continue;
    if (byJisr.has(key)) {
      const first = byJisr.get(key);
      return {
        ok: false,
        reason: "duplicate_jisr_in_platform",
        jisrNo: key,
        eids: [String(first[F_DAMANAH] || ""), String(e[F_DAMANAH] || "")],
      };
    }
    byJisr.set(key, e);
  }
  return { ok: true, byJisr };
}

/* يربط صفوف الكشف المستخرجة بالموظفين.
   يُرجع { ok, linked, unknown, excluded } — و`net` يُنقل كما استُخرج من
   الكشف بلا تدوير ولا تقريب: هو المرجع الذي ستُقاس عليه بقية القيم. */
function linkStaff(staff, employees, { exclude } = {}) {
  const index = indexByJisr(employees);
  if (!index.ok) return index;

  const excludeSet = new Set((exclude || []).map(normalizeJisr).filter(Boolean));
  const linked = [];
  const unknown = [];
  const excluded = [];

  for (const row of staff || []) {
    const jisrNo = normalizeJisr(row.jisrNo);
    if (excludeSet.has(jisrNo)) {
      excluded.push(row);
      continue;
    }
    const employee = index.byJisr.get(jisrNo);
    if (!employee) {
      unknown.push(row);
      continue;
    }
    linked.push({
      /* المُخزَّن هو الرقم الوظيفي للمنصّة لا رقم جسر: جدول الإثباتات
         مفتاحه (run_id, employee_eid) وهو يعني الرقم الوظيفي. */
      eid: String(employee[F_DAMANAH] || "").trim(),
      jisrNo,
      name: String(employee[F_NAME] || "").trim(),
      jobTitle: String(employee[F_JOB] || "").trim() || null,
      net: row.net,
      /* للتشخيص وحده — لا يُخزَّن ولا يُقارن ولا يربط. */
      nameHint: row.nameHint,
    });
  }

  return { ok: true, linked, unknown, excluded };
}

/* indexByJisr و SHEET_ATTACHMENT_KEY داخليّتان: لا مستهلك لهما خارج
   هذه الوحدة، وتصديرٌ بلا مستهلك سطحٌ يُلزمنا حفظه بلا مقابل. حاجز
   تكرار رقم جسر الذي تقيمه indexByJisr مقيسٌ عبر linkStaff. */
module.exports = { sheetUrlOf, linkStaff, F_DAMANAH, F_NAME, F_JOB };
