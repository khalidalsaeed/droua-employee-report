/* ─── حلقة مفاتيح تشفير ملفّات القسم ───────────────────────────────────
   =========================================================================
   مفتاحٌ واحد في متغيّر واحد ليس تدويرًا، بل عمودٌ يحمل ثابتًا. وأول تدوير
   حقيقيّ يصطدم بالسؤال: أين يعيش المفتاح القديم؟ فتصير الهجرة إجبارية على
   كل ملفّ — وهي أسوأ ما يُطلب من نظامٍ يخزّن مستندات لا تُعاد.

   ── لماذا متغيّر مستقلّ لكل مفتاح، لا كائن JSON يجمعها ──
   لأن التدوير حينها **إضافةُ متغيّر**، ولا يُعاد كتابة المتغيّر الذي يحمل
   المفتاح القديم أبدًا. أمّا حقل جامع فيوجب لصق الكائن كاملًا في كل تدوير،
   ولصقةٌ واحدة ناقصة تمحو المفتاح القديم — **وتفقد معه كل ملفّ كُتب به،
   بلا استرجاع**. فالقاعدة الحاكمة: لا يمرّ التدوير عبر تحرير القيمة التي
   تحمل المفتاح القديم.

   ── والقراءة بمفتاح الصفّ لا بالنشط ──
   ملفٌّ كُتب بـk1 يبقى مقروءًا بعد أن يصير النشط k2. ومعرّفٌ مجهول **يرمي
   ولا يسقط إلى النشط**: السقوط هنا يُنتج فشل فكٍّ يبدو فسادًا في الملفّ،
   فيُشخَّص في الاتجاه الخطأ تمامًا.

   والقراءة من البيئة عند كل نداء لا عند تحميل الوحدة — كما في config.js. */

const ENV_ACTIVE = "DROUA_FILE_ACTIVE_KEY_ID";
const ENV_PREFIX = "DROUA_FILE_KEY_";

const KEY_ID_RE = /^k[1-9][0-9]{0,2}$/;
const KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const KEY_BYTES = 32;

/* كل رسائل الخطأ هنا تذكر **أسماء** متغيّرات ومعرّفات مفاتيح فقط. ولا
   واحدة منها تلمس مادّة مفتاح: الرسالة تُطبع في اللوجّ، والمادّة لا تُطبع. */

function readRing() {
  const keys = new Map();
  const material = new Map();

  for (const [name, raw] of Object.entries(process.env)) {
    if (!name.startsWith(ENV_PREFIX)) continue;
    const value = String(raw == null ? "" : raw).trim();
    /* متغيّر فارغ = غير مضبوط. وإسقاطه ليس صمتًا: إن كان هو النشط سقط
       الشرط أدناه، وإن كان قديمًا ظهرت ملفّاته بـunknown_key في التدقيق. */
    if (!value) continue;

    const id = name.slice(ENV_PREFIX.length).toLowerCase();
    if (!KEY_ID_RE.test(id)) {
      throw new Error(`اسم متغيّر مفتاح غير صالح: ${name}`);
    }
    if (!KEY_HEX_RE.test(value)) {
      throw new Error(`قيمة ${name} ليست ${KEY_BYTES * 2} محرفًا hex`);
    }
    if (keys.has(id)) {
      throw new Error(`متغيّران يشيران إلى المعرّف نفسه: ${id}`);
    }

    const lower = value.toLowerCase();
    /* مفتاحان بمادّة واحدة تحت معرّفين = تدوير وهميّ: العمود يتغيّر
       والمادّة لا. ويمرّ بلا أثر لولا هذا الفحص. */
    if (material.has(lower)) {
      throw new Error(`مفتاحان بمادّة واحدة: ${material.get(lower)} و${id}`);
    }
    material.set(lower, id);
    keys.set(id, Buffer.from(lower, "hex"));
  }

  if (!keys.size) throw new Error("حلقة مفاتيح القسم فارغة");

  const activeKeyId = String(process.env[ENV_ACTIVE] || "").trim().toLowerCase();
  if (!KEY_ID_RE.test(activeKeyId)) {
    throw new Error(`${ENV_ACTIVE} غير مضبوط أو بصيغة غير صالحة`);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error(`${ENV_ACTIVE} يشير إلى مفتاح غير موجود في الحلقة`);
  }

  return { activeKeyId, keys };
}

/* تحقّق شامل. يُرجع الوصف دون أي مادّة مفتاح — فلا يُطبع سهوًا ما لا يُطبع. */
function load() {
  const ring = readRing();
  return { activeKeyId: ring.activeKeyId, ids: [...ring.keys.keys()].sort() };
}

function activeKeyId() {
  return readRing().activeKeyId;
}

/* هل المعرّف موجود؟ للتفريق بين «مفتاح مجهول» (حدث سلامة) و«حلقة تالفة»
   (عطل إعداد) — والاثنان يُعالجان معالجتين مختلفتين تمامًا. */
function has(keyId) {
  const id = String(keyId || "").trim().toLowerCase();
  if (!KEY_ID_RE.test(id)) return false;
  return readRing().keys.has(id);
}

function keyFor(keyId) {
  const id = String(keyId || "").trim().toLowerCase();
  if (!KEY_ID_RE.test(id)) throw new Error("معرّف مفتاح بصيغة غير صالحة");
  const ring = readRing();
  const key = ring.keys.get(id);
  /* لا سقوط إلى النشط. أبدًا. */
  if (!key) throw new Error(`معرّف مفتاح غير موجود في الحلقة: ${id}`);
  return key;
}

module.exports = {
  load, activeKeyId, keyFor, has,
  ENV_ACTIVE, ENV_PREFIX, KEY_ID_RE, KEY_BYTES,
};
