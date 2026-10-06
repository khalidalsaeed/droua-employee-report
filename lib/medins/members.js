/* ─── عضويّة الوحدة: طبقةٌ مستقلّة عن الحساب الأساسيّ ──────────────────
   =========================================================================
   الفصل الذي تقوم عليه الوحدة:

     الحساب الأساسيّ (users + PROTECTED_USER_IDS)  ← هويّة المنصّة، كما هي
     العضويّة (medins_members)                      ← من يدخل الوحدة وبأيّ دور

   فمنحُ الوحدة لشخصٍ، أو تغيير دوره، أو تعطيله، أو إعادة ضبط كلمة مرور
   بوابته — كلّها تمسّ صفًّا هنا وحده. لا تُعدَّل متغيّرات Vercel، ولا
   يُعاد النشر، ولا يُلمس حسابه في المنصّة ولا كلمة مروره فيها.

   والحساب المحميّ يبقى شرطًا **إضافيًا** لا بديلًا: عضوٌ نُزعت حمايته
   يُخفى عنه القسم ولو بقي صفّه نشطًا.

   ── الإدارة اليوم والغد ──
   Phase 1: سكربت سطر أوامر (scripts/medins-members.js) يكتب الصفوف ويُدقّقها.
   لاحقًا: شاشة داخل الوحدة لمن يحمل حاجة «manage_members» — يضيفها جدول
   الأدوار في routes.js دون أي تغيير في هذا المخطّط. */

const ROLES = Object.freeze(["editor", "viewer"]);

const normEmail = (e) => String(e || "").trim().toLowerCase();

/* العضو الصالح الآن: صفٌّ نشط غير معطَّل، بريده يطابق بريد الحساب (شرطٌ
   ثانٍ للهويّة: حسابٌ تغيّر بريده لا يرث العضويّة صامتًا)، ودوره معروف. */
async function resolve(sql, user) {
  const rows = await sql`
    SELECT user_id, email, role, gate_password_hash
    FROM medins_members
    WHERE user_id = ${String(user.id)} AND active = true AND disabled_at IS NULL`;
  const row = rows && rows[0];
  if (!row) return null;
  if (!ROLES.includes(row.role)) return null;
  if (normEmail(row.email) !== normEmail(user.email)) return null;
  return { role: row.role, email: row.email, gatePasswordHash: row.gate_password_hash || null };
}

module.exports = { resolve, ROLES, normEmail };
