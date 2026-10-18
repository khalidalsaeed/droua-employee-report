const source = require("../org/source");

/* الهيكل التنظيمي — مورد قراءة فقط.
   =========================================================================
   يُخدَم عبر /api/data/org-structure داخل الدالّة الخادمة الموجودة: لا
   دالّة جديدة ولا مسار جديد في vercel.json.

   الصلاحية صلاحية سجلّ الموظفين نفسها (employees:view): الصفوف تحمل
   أسماء الموظفين وبريدهم، وهي بيانات ذلك القسم — تمامًا كما تُحرس صفحة
   /expiring.html. لهذا لا يُقدَّم الملف ملفًّا ثابتًا: الوسيط يكتفي بجلسة
   صالحة، فيصل الملف الثابت إلى دور لا يرى سجلّ الموظفين أصلًا.

   المصدر لقطة مُولَّدة من تقرير Excel (lib/org/source.js). الكتابة مرفوضة:
   تعديل الهيكل يكون بإعادة توليد اللقطة، ولاحقًا بحقل المدير في سجلّ
   الموظف نفسه (انظر scripts/setup-org-manager.js — غير مُطبَّق). */
const section = "employees";

const READ_ONLY = "الهيكل التنظيمي للقراءة فقط في هذه النسخة";

async function list() {
  return source.ROWS.map((r) => ({ ...r, source: source.SOURCE_NAME }));
}

async function get(id) {
  return source.ROWS.find((r) => String(r.row) === String(id)) || null;
}

async function create() { throw new Error(READ_ONLY); }
async function update() { throw new Error(READ_ONLY); }
async function remove() { throw new Error(READ_ONLY); }

module.exports = { section, list, get, create, update, remove };
