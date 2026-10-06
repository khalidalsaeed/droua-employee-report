/* ─── أدوات الإعداد: تقرأ ولا تقرّر ──────────────────────────────────────
   =========================================================================
   كل وحدة تحمّل إعدادها بنفسها وتقرّر ما الإلزاميّ فيه. وهذه الأدوات تجعل
   القرار متّسقًا: قيمةٌ خارج حدودها تُرجع null (الوحدة تترجمه إلى إخفاء)،
   ولا سقوط صامت إلى افتراضيٍّ حين تكون القيمة **موجودة وتالفة**. */

/* الحدّ الأدنى لطول سرّ التوقيع. 32 محرفًا = 128 بت على الأقلّ بترميز hex. */
const MIN_SECRET_LENGTH = 32;

function splitList(raw) {
  return String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/* عددٌ صحيح ضمن حدّين. الغياب يعطي الافتراضيّ؛ أمّا القيمة الموجودة الخارجة
   عن الحدّين فتعطي null — من كتب «600» يقصد شيئًا، وتجاهلُه بصمت أسوأ من
   رفضه. */
function boundedInt(raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/* سرٌّ صالح: طويلٌ كفاية ولا يساوي أيًّا من الأسرار الممنوع مساواتها. */
function distinctSecret(value, others = []) {
  const v = String(value || "");
  if (v.length < MIN_SECRET_LENGTH) return null;
  for (const other of others) if (other && v === String(other)) return null;
  return v;
}

module.exports = { MIN_SECRET_LENGTH, splitList, boundedInt, distinctSecret };
