/* ─── معرّفات ومسمّيات: ما يُتحقَّق منه مرّة عند الإنشاء ─────────────────
   =========================================================================
   الطبقة تُحقن فيها أسماء الجداول عبر `sql.unsafe()` — وهي الطريقة
   الوحيدة لتسمية جدولٍ في قالب neon. وذلك آمن بشرطٍ واحد: ألّا يبلغ الاسمُ
   من الطلب أبدًا، وأن يُفحص بتعبيرٍ مغلق **عند إنشاء النسخة** لا عند كل
   استعلام. فاسمٌ خاطئ يرمي في سطر الإعداد، لا في منتصف طلب. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TABLE_RE = /^[a-z][a-z0-9_]{2,40}$/;

function assertTable(name) {
  const value = String(name || "");
  if (!TABLE_RE.test(value)) throw new Error(`اسم جدول غير صالح: ${value}`);
  return value;
}

const isUuid = (value) => typeof value === "string" && UUID_RE.test(value);

module.exports = { UUID_RE, TABLE_RE, assertTable, isUuid };
