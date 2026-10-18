const { checkManagerAssignment } = require("../../org-core");

/* فحص تعيين المدير على الخادم قبل الكتابة — المرحلة الثانية.
   =========================================================================
   يعمل بعد تطبيق scripts/setup-org-manager.js وحده (يقرأ العمود
   manager_eid)، ولذلك لا يستدعيه lib/data/employees.js بعد: ربطه بمسار
   التعديل جزءٌ من اعتماد الهجرة نفسها.

   هذا للرسالة المفهومة وللفشل المبكر؛ الحاجز الصلب مُشغّل القاعدة
   employees_reject_manager_cycle، والتعريفان واحد: الموظف نفسه، والمدير
   غير الموجود، وأي حلقة. */
async function assertManagerAssignable(sql, eid, managerEid) {
  if (managerEid == null || String(managerEid).trim() === "") return;
  const rows = await sql`SELECT eid, manager_eid FROM employees`;
  const edges = new Map(rows.map((r) => [String(r.eid), r.manager_eid == null ? null : String(r.manager_eid)]));
  const verdict = checkManagerAssignment(edges, String(eid), String(managerEid).trim(), new Set(edges.keys()));
  if (!verdict.ok) {
    const err = new Error(verdict.message);
    err.code = verdict.code;
    throw err;
  }
}

module.exports = { assertManagerAssignable };
