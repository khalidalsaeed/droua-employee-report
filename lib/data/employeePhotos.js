const manifest = require("../photos/manifest");
const store = require("../photos/store");

/* صور الموظفين — فهرس للقراءة فقط.
   =========================================================================
   يُخدَم عبر /api/data/employee-photos بصلاحية سجلّ الموظفين نفسها
   (employees:view). لا يُرجع صورًا ولا روابط تخزين: فقط من يملك صورة
   (eid و/أو البريد) ومعرّفها العشوائي. البايتات تُطلب بعدها من
   /api/files/employee-photo?id=… الذي يعيد فحص الصلاحية نفسها.

   متجر غير مُهيّأ (الإنتاج قبل الاعتماد) = فهرس فارغ = Placeholder في كل
   مكان، بلا روابط مكسورة.

   رفع/استبدال/حذف غير مدعوم في هذه النسخة: الصور الاثنتا عشرة المعتمدة
   تُدار بالـmanifest. حين يُبنى الرفع يُسجَّل في audit_log
   (employee_eid، الإجراء، الفاعل، الوقت — بلا بايتات). */
const section = "employees";

const READ_ONLY = "صور الموظفين للقراءة فقط في هذه النسخة";

async function list() {
  if (!store.configured()) return [];
  return manifest.map((e) => ({ photoId: e.photoId, eid: e.match.eid || null, email: e.match.email || null }));
}

async function get(id) {
  if (!store.configured()) return null;
  const e = store.entryById(id);
  return e ? { photoId: e.photoId, eid: e.match.eid || null, email: e.match.email || null } : null;
}

async function create() { throw new Error(READ_ONLY); }
async function update() { throw new Error(READ_ONLY); }
async function remove() { throw new Error(READ_ONLY); }

module.exports = { section, list, get, create, update, remove };
