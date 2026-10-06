/* ─── حلقة مفاتيح التشفير ───────────────────────────────────────────────
   =========================================================================
   متغيّرٌ مستقلّ لكل مفتاح (`<PREFIX>K1`، `<PREFIX>K2`…) ومتغيّر يسمّي النشط.
   فالتدوير **إضافةُ متغيّر**، ولا يُعاد كتابة المتغيّر الذي يحمل المفتاح
   القديم أبدًا — لصقةٌ ناقصة في حقلٍ جامع كانت ستفقد كل ملفّ كُتب به.

   والقراءة بمفتاح الصفّ لا بالنشط، والمعرّف المجهول يرمي ولا يسقط إلى
   النشط. والسلوك مطابق لـlib/droua/keyring.js مع البادئة معاملًا. */

const KEY_ID_RE = /^k[1-9][0-9]{0,2}$/;
const KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const KEY_BYTES = 32;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,48}$/;

function createKeyring({ envPrefix, activeEnv }) {
  if (!ENV_NAME_RE.test(String(envPrefix || "")) || !String(envPrefix).endsWith("_")) {
    throw new Error("بادئة مفاتيح غير صالحة");
  }
  if (!ENV_NAME_RE.test(String(activeEnv || ""))) throw new Error("اسم متغيّر المفتاح النشط غير صالح");

  /* رسائل الخطأ تذكر **أسماء** المتغيّرات والمعرّفات فقط — لا مادّة مفتاح. */
  function readRing() {
    const keys = new Map();
    const material = new Map();

    for (const [name, raw] of Object.entries(process.env)) {
      if (!name.startsWith(envPrefix)) continue;
      const value = String(raw == null ? "" : raw).trim();
      if (!value) continue;

      const id = name.slice(envPrefix.length).toLowerCase();
      if (!KEY_ID_RE.test(id)) throw new Error(`اسم متغيّر مفتاح غير صالح: ${name}`);
      if (!KEY_HEX_RE.test(value)) throw new Error(`قيمة ${name} ليست ${KEY_BYTES * 2} محرفًا hex`);
      if (keys.has(id)) throw new Error(`متغيّران يشيران إلى المعرّف نفسه: ${id}`);

      const lower = value.toLowerCase();
      if (material.has(lower)) throw new Error(`مفتاحان بمادّة واحدة: ${material.get(lower)} و${id}`);
      material.set(lower, id);
      keys.set(id, Buffer.from(lower, "hex"));
    }

    if (!keys.size) throw new Error("حلقة المفاتيح فارغة");

    const activeKeyId = String(process.env[activeEnv] || "").trim().toLowerCase();
    if (!KEY_ID_RE.test(activeKeyId)) throw new Error(`${activeEnv} غير مضبوط أو بصيغة غير صالحة`);
    if (!keys.has(activeKeyId)) throw new Error(`${activeEnv} يشير إلى مفتاح غير موجود في الحلقة`);

    return { activeKeyId, keys, material };
  }

  function load() {
    const ring = readRing();
    return { activeKeyId: ring.activeKeyId, ids: [...ring.keys.keys()].sort() };
  }

  const activeKeyId = () => readRing().activeKeyId;

  function has(keyId) {
    const id = String(keyId || "").trim().toLowerCase();
    if (!KEY_ID_RE.test(id)) return false;
    return readRing().keys.has(id);
  }

  function keyFor(keyId) {
    const id = String(keyId || "").trim().toLowerCase();
    if (!KEY_ID_RE.test(id)) throw new Error("معرّف مفتاح بصيغة غير صالحة");
    const key = readRing().keys.get(id);
    if (!key) throw new Error(`معرّف مفتاح غير موجود في الحلقة: ${id}`);
    return key;
  }

  /* هل تشترك هذه الحلقة في مادّة مفتاحٍ مع حلقةٍ أخرى؟ مفتاحٌ واحد لوحدتين
     يُبطل فصل التسريب بينهما. يُرجع صحيحًا/خطأً فقط — لا مادّة. */
  function sharesMaterialWith(otherPrefix) {
    const mine = readRing().material;
    for (const [name, raw] of Object.entries(process.env)) {
      if (!name.startsWith(otherPrefix)) continue;
      const value = String(raw == null ? "" : raw).trim().toLowerCase();
      if (value && mine.has(value)) return true;
    }
    return false;
  }

  return { load, activeKeyId, keyFor, has, sharesMaterialWith, ENV_ACTIVE: activeEnv, ENV_PREFIX: envPrefix };
}

module.exports = { createKeyring, KEY_ID_RE, KEY_BYTES };
