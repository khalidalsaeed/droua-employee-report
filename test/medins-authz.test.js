const test = require("node:test");
const assert = require("node:assert/strict");

const { withMedins } = require("./helpers/medins-harness");

/* ─── الصلاحيات: يمرّ على جدول المسارات كلّه آليًا ───────────────────────
   لا قائمة يدوية تنسى مسارًا: كل صفٍّ في lib/medins/routes.js يُختبر بدوري
   المحرّر والمشاهد عبر api/app.js الحقيقيّ. مسارٌ جديد يدخل الاختبار وحده. */

const SAMPLE = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", n: "0", code: "sample_code" };
const concrete = (path) => path.replace(/:(id|n|code)/g, (m, name) => SAMPLE[name]);

test("كل مسار يعلن حاجةً يعرفها جدول الأدوار، ولا مسارين متطابقين", () => {
  const { ROUTES } = require("../lib/medins/routes");
  const { authz } = require("../lib/medins/security");
  const seen = new Set();
  assert.ok(ROUTES.length >= 30);
  for (const r of ROUTES) {
    assert.ok(authz.isNeed(r.need), `${r.method} ${r.path} بلا حاجة معروفة`);
    assert.equal(typeof r.handler, "function", `${r.method} ${r.path} بلا معالج`);
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `مكرّر: ${key}`);
    seen.add(key);
  }
  /* كل تعديل يحتاج edit — لا POST/PUT/DELETE بحاجة view. */
  for (const r of ROUTES) if (r.method !== "GET") assert.equal(r.need, "edit", `${r.method} ${r.path} كتابةٌ بحاجة ${r.need}`);
  assert.deepEqual(authz.roles.sort(), ["editor", "viewer"]);
  assert.equal(authz.can("viewer", "edit"), false);
  assert.equal(authz.can("viewer", "view"), true);
  assert.equal(authz.can("editor", "edit"), true);
  assert.equal(authz.can("owner", "view"), false, "دور المنصّة يُستشار");
  assert.equal(authz.can("editor", "manage_members"), false);
});

test("المشاهد يُرفض 403 على **كل** مسار تعديل، ويُدقَّق كل رفض", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.viewer, "viewer", { hash: hashes.viewer });
    const c = client(IDS.viewer);
    await c.call("POST", "gate/unlock", { body: { password: PASSWORDS.viewer } });
    const { ROUTES } = require("../lib/medins/routes");
    const edits = ROUTES.filter((r) => r.need === "edit");
    for (const r of edits) {
      const out = await c.call(r.method, concrete(r.path), { body: r.method === "GET" ? undefined : {} });
      assert.equal(out.statusCode, 403, `${r.method} ${r.path} → ${out.statusCode}`);
      assert.deepEqual(out.body, { ok: false, error: "صلاحيات غير كافية" });
    }
    const denied = gateDb.audit.filter((a) => a.event === "forbidden_action");
    assert.equal(denied.length, edits.length);
    assert.ok(denied.every((a) => a.role === "viewer" && a.meta.need === "edit"));
  });
});

test("المشاهد يبلغ كل مسار عرض (لا 403)، والمحرّر يبلغ كل المسارات", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.viewer, "viewer", { hash: hashes.viewer });
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    const v = client(IDS.viewer);
    const e = client(IDS.editor);
    await v.call("POST", "gate/unlock", { body: { password: PASSWORDS.viewer } });
    await e.call("POST", "gate/unlock", { body: { password: PASSWORDS.editor } });
    const { ROUTES } = require("../lib/medins/routes");
    for (const r of ROUTES) {
      const body = r.method === "GET" ? undefined : {};
      if (r.need === "view") {
        const out = await v.call(r.method, concrete(r.path), { body });
        assert.notEqual(out.statusCode, 403, `المشاهد مُنع من ${r.method} ${r.path}`);
        assert.notEqual(out.statusCode, 401);
      }
      const out = await e.call(r.method, concrete(r.path), { body });
      assert.notEqual(out.statusCode, 403, `المحرّر مُنع من ${r.method} ${r.path}`);
      assert.notEqual(out.statusCode, 401);
    }
  });
});
