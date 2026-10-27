const store = require("../municipal/store");

/* البطاقات البلدية (الشهادات الصحية) — /api/data/municipal-cards.
   =========================================================================
   للقراءة فقط، من فهرس المتجر الخاصّ (lib/municipal/store.js) — لا Git ولا
   قاعدة. الاستجابة لا تحمل مفاتيح التخزين ولا البصمات ولا رابط الرمز:
   وجه البطاقة وصورة رمزها يُطلبان بعدها بالمعرّف العشوائي cardId من
   /api/files/municipal-card-image و /api/files/municipal-qr، وكلاهما يعيد
   فحص الجلسة وmunicipal:view.

   الربط بالموظف بـemployeeEid (employees.eid) الذي حُسم عند الاستيراد
   برقم الإقامة — لا بالاسم.

   الكتابة لسكربت الاستيراد وحده في هذه المرحلة (scripts/import-municipal-cards.js).
   متجر غير مُهيّأ (الإنتاج قبل الاعتماد) = قائمة فارغة بلا خطأ. */
const section = "municipal";
const READ_ONLY = "البطاقات البلدية تُستورد من ملفّات الشهادات بسكربت الاستيراد في هذه المرحلة";

function toItem(e) {
  return {
    cardId: e.cardId,
    employeeEid: e.employeeEid,
    certificateNumber: e.certificateNumber,
    issuePlace: e.issuePlace,
    expiryDate: e.expiryDate,
    expiryHijri: e.expiryHijri,
    nameOnCard: e.nameOnCard,
    occupation: e.occupation,
    hasQr: !!e.qrKey,
    /* بصمة قصيرة تكسر ذاكرة المتصفّح حين يُستبدل وجه البطاقة. */
    version: e.cardSha256.slice(0, 12),
  };
}

async function listFor(oidcToken) {
  if (!store.configured()) return [];
  const index = await store.readIndex(oidcToken);
  return index.cards.map(toItem).sort((a, b) => String(a.expiryDate || "9").localeCompare(String(b.expiryDate || "9")));
}

async function list() { return []; } // المسار الفعلي listFor — يحتاج رمز OIDC من الطلب
async function get() { return null; }
async function create() { throw new Error(READ_ONLY); }
async function update() { throw new Error(READ_ONLY); }
async function remove() { throw new Error(READ_ONLY); }

module.exports = { section, listFor, toItem, list, get, create, update, remove };
