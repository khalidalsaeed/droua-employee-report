const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { resolvePermissions, defaultPermissionsForRole, SECTION_BY_KEY } = require("../lib/auth/permissions");

/* الموجّه بجلسة مُزيَّفة؛ الخدمة نفسها حقيقية لكن دوالّها تُستبدل في
   كل اختبار — المختبَر هنا البوّابة: من يرى، ومن يرفع، وماذا يُرجَع. */
const harness = { user: null };
function stub(rel, exports) {
  const id = require.resolve(path.join(ROOT, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub("lib/auth/requireAuth.js", { requireUser: async () => harness.user });
stub("lib/db.js", { getSql: () => { throw new Error("no db in this test"); } });
const service = require("../lib/payroll/transfers/service");
const handler = require("../api/app.js");

const calls = [];
service.getState = async (runId) => { calls.push(["get", runId]); return { setup: true, current: null, matches: {}, history: [] }; };
service.reconcileUpload = async (args) => {
  calls.push(["post", args.runId, args.replace, args.fileName, args.bytes.length]);
  if (!args.replace) throw new service.ReconcileError("exists", "يوجد ملف تحويل مرفوع مسبقًا، هل تريد استبداله؟", 409);
  return { setup: true, current: { fileName: args.fileName }, matches: {}, history: [] };
};

async function call(method, { role = "finance", permissions, query = {}, body, headers = {} } = {}) {
  harness.user = { id: "u1", email: "x@example.com", role };
  harness.user.permissions = permissions || resolvePermissions(harness.user);
  const req = { method, query: { kind: "api", apiPath: "data/payroll-transfers", run: "2026-10", ...query }, headers, body };
  const res = { code: 0, json: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.json = o; return this; } };
  await handler(req, res);
  return res;
}

test("الصلاحية: payroll:reconcile موجودة ومنفصلة عن view وupload_files", () => {
  assert.ok(SECTION_BY_KEY.payroll.actions.includes("reconcile"));
  assert.ok(defaultPermissionsForRole("admin").includes("payroll:reconcile"));
  assert.ok(defaultPermissionsForRole("owner").includes("payroll:reconcile"));
  for (const role of ["finance", "hr", "viewer"]) {
    assert.ok(!defaultPermissionsForRole(role).includes("payroll:reconcile"), `${role} لا يرفع ملفّ البنك افتراضيًا`);
  }
  assert.ok(defaultPermissionsForRole("finance").includes("payroll:view"));
});

test("قبول: صلاحية view فقط — تقرأ الحالة ولا ترفع", async () => {
  calls.length = 0;
  const g = await call("GET", { role: "finance" });
  assert.equal(g.code, 200);
  assert.equal(g.json.setup, true);
  const p = await call("POST", { role: "finance", body: Buffer.from("a,b"), headers: { "x-filename": "t.csv" } });
  assert.equal(p.code, 403);
  assert.deepEqual(calls, [["get", "2026-10"]], "الرفع لا يبلغ الخدمة أصلًا");
});

test("قبول: upload_files وحدها لا تكفي لرفع ملفّ البنك", async () => {
  const p = await call("POST", { role: "custom", permissions: ["payroll:view", "payroll:upload_files"], body: Buffer.from("x") });
  assert.equal(p.code, 403);
});

test("قبول: صلاحية reconcile — الرفع يصل، والاستبدال يحتاج تأكيدًا (409 exists)", async () => {
  calls.length = 0;
  const perms = ["payroll:view", "payroll:reconcile"];
  const first = await call("POST", { role: "custom", permissions: perms, body: Buffer.from("abc"), headers: { "x-filename": encodeURIComponent("تحويل.csv") } });
  assert.equal(first.code, 409);
  assert.equal(first.json.code, "exists");
  const second = await call("POST", { role: "custom", permissions: perms, query: { replace: "1" }, body: Buffer.from("abc"), headers: { "x-filename": encodeURIComponent("تحويل.csv") } });
  assert.equal(second.code, 200);
  assert.equal(second.json.current.fileName, "تحويل.csv");
  assert.deepEqual(calls.map((c) => c[2]), [false, true]);
});

test("بلا صلاحية view لا قراءة، ومعرّف مسير فاسد يُرفض", async () => {
  assert.equal((await call("GET", { role: "custom", permissions: [] })).code, 403);
  assert.equal((await call("GET", { query: { run: "../x" } })).code, 400);
});

test("خطأ غير متوقّع لا يكشف رسالته الداخلية", async () => {
  const orig = service.getState;
  service.getState = async () => { throw new Error("SA0380000000608010167519 leaked"); };
  const r = await call("GET");
  service.getState = orig;
  assert.equal(r.code, 500);
  assert.ok(!JSON.stringify(r.json).includes("SA03"));
});

test("عدد الدوالّ الخادمة يبقى 2 — الميزة داخل api/app.js", () => {
  const fs = require("node:fs");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
  assert.equal(walk(path.join(ROOT, "api")).filter((f) => f.endsWith(".js")).length, 2);
});

test("العزل: وحدات المطابقة لا تستورد قسم المراجعة ولا Blob", () => {
  const fs = require("node:fs");
  const dir = path.join(ROOT, "lib", "payroll", "transfers");
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/require\([^)]*droua/.test(text), `${f} يستورد قسم المراجعة`);
    assert.ok(!/require\([^)]*blob/.test(text), `${f} يكتب إلى Blob`);
    assert.ok(!/console\.(log|info|debug)/.test(text), `${f} يطبع إلى السجلّ`);
  }
});
