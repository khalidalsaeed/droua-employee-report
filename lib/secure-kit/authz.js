/* ─── صلاحيات داخل الوحدة: نقطة قرار واحدة ─────────────────────────────
   =========================================================================
   لا علاقة لها بنظام صلاحيات المنصّة (`hasPermission`): الدور هنا دورٌ
   داخل وحدة سرّية، يُقرأ من عضويّتها لا من دور المستخدم في المنصّة. فمالك
   المنصّة الذي ليس عضوًا لا يرى الوحدة أصلًا.

   الأدوار وحاجاتها تعلنها الوحدة. وحاجةٌ لا يعرفها الجدول **مرفوضة** —
   مسارٌ جديد بحاجةٍ مكتوبة خطأً يُغلق لا يُفتح. */

function createAuthz({ roles }) {
  const table = new Map();
  for (const [role, needs] of Object.entries(roles || {})) table.set(role, new Set(needs));
  const allNeeds = new Set([...table.values()].flatMap((s) => [...s]));

  function can(role, need) {
    const needs = table.get(String(role || ""));
    return Boolean(needs && needs.has(String(need || "")));
  }

  const isRole = (role) => table.has(String(role || ""));
  const isNeed = (need) => allNeeds.has(String(need || ""));

  return { can, isRole, isNeed, roles: [...table.keys()], needs: [...allNeeds] };
}

module.exports = { createAuthz };
