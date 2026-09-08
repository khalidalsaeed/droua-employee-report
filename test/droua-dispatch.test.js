const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

/* ─── سطر التفويض في api/app.js ────────────────────────────────────────
   =========================================================================
   قيدُ «دالّتان لا ثلاث» جعل القسم يمرّ من الدالّة المشتركة. وثمنُ ذلك أن
   شرط التفويض نفسه صار نقطة حرجة: خطأ فيه — بادئةٌ غير مضبوطة، أو مطابقةُ
   احتواء بدل بادئة — يوجّه طلب قسمٍ إلى المعالج العام أو العكس.

   لذلك يُختبر بجدول صريح في الاتجاهين: كل مسار قائم يجب ألّا يُفوَّض، وكل
   اسم مخادع يجب ألّا يُفوَّض، ومسارات القسم وحدها تُفوَّض. */

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ROUTER_PATH = require.resolve("../lib/droua/router");

/* يُحمّل api/app.js مع اعتراض موجّه القسم، فيُقاس **ما إذا** فُوِّض الطلب
   لا ما يفعله الموجّه. */
/* async مع await على fn(): المغلّف المتزامن يستعيد الاعتراض فور عودة
   fn() — أي قبل أن يبلغ جسمها أول await — فيُرفع التجسّس في منتصف
   الاختبار ويُحمَّل الموجّه الحقيقي، فتبدو الحالات التالية «غير مفوَّضة»
   وهي مفوَّضة. اختبارٌ يكذب أخطرُ من اختبار ساقط. */
async function withSpyRouter(fn) {
  const originalLoad = Module._load;
  const calls = [];
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PROJECT_ROOT) && !key.includes("node_modules")) delete require.cache[key];
  }
  let routerLoaded = false;
  Module._load = function (request, parent, isMain) {
    if (parent) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch (err) { /* يمرّ */ }
      if (resolved === ROUTER_PATH) {
        routerLoaded = true;
        return async (req, res) => {
          calls.push(String((req.query || {}).apiPath || (req.query || {}).page || ""));
          res.status(200).json({ ok: true, delegated: true });
        };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const handler = require("../api/app");
    return await fn(handler, calls, () => routerLoaded);
  } finally {
    Module._load = originalLoad;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(PROJECT_ROOT) && !key.includes("node_modules")) delete require.cache[key];
    }
  }
}

function makeRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; },
    status(c) { out.statusCode = c; return res; },
    json(p) { out.body = p; return res; },
    writeHead(c, h) { out.statusCode = c; Object.assign(out.headers, h || {}); return res; },
    end(p) { if (p !== undefined) out.body = p; return res; },
  };
  return { res, out };
}

async function dispatch(handler, query) {
  const { res, out } = makeRes();
  await handler({ method: "GET", query, headers: {} }, res);
  return out;
}
const wasDelegated = (out) => !!(out.body && out.body.delegated);

test("التوزيع: كل مسار API قائم في المنصّة لا يُفوَّض", async () => {
  await withSpyRouter(async (handler, calls) => {
    const platformPaths = [
      "auth/login", "auth/logout", "auth/me", "auth/permissions-catalogue", "auth/change-password",
      "data/users", "data/employees", "data/permits", "data/payroll-runs", "data/tickets",
      "data/settings", "data/document-types", "data/recipients",
      "files/upload", "files/delete", "files/qr",
      "reports/list", "reports/pdf", "reports/summary", "reports/send",
      "push/config", "push/subscribe", "push/unsubscribe", "push/test",
    ];
    for (const p of platformPaths) {
      const out = await dispatch(handler, { kind: "api", apiPath: p });
      assert.ok(!wasDelegated(out), `${p} فُوِّض إلى القسم — خطأ فادح`);
    }
    assert.equal(calls.length, 0);
  });
});

test("التوزيع: كل صفحة قائمة لا تُفوَّض", async () => {
  await withSpyRouter(async (handler) => {
    for (const page of ["home", "users", "payroll", "payroll-detail", "tickets", "ticket-detail", "reports", "expiring"]) {
      const out = await dispatch(handler, { kind: "page", page });
      assert.ok(!wasDelegated(out), `صفحة ${page} فُوِّضت إلى القسم`);
    }
  });
});

test("التوزيع: الأسماء المخادعة لا تُفوَّض", async () => {
  await withSpyRouter(async (handler) => {
    const tricky = [
      "secure-auditX", "secure-auditx/gate", "xsecure-audit", "xsecure-audit/gate",
      "data/secure-audit", "data/secure-audit/gate", "secure_audit", "secure_audit/gate",
      "secure-audi", "Secure-Audit", "SECURE-AUDIT/gate", "/secure-audit", " secure-audit",
      "secure-audit\\gate", "..%2fsecure-audit",
    ];
    for (const p of tricky) {
      const out = await dispatch(handler, { kind: "api", apiPath: p });
      assert.ok(!wasDelegated(out), `«${p}» فُوِّض — المطابقة يجب أن تكون بادئة كاملة حسّاسة لحالة الأحرف`);
    }
    for (const page of ["secure-auditX", "Secure-Audit", "secure_audit", "xsecure-audit"]) {
      const out = await dispatch(handler, { kind: "page", page });
      assert.ok(!wasDelegated(out), `صفحة «${page}» فُوِّضت`);
    }
  });
});

test("التوزيع: مسارات القسم وحدها تُفوَّض", async () => {
  await withSpyRouter(async (handler, calls) => {
    const mine = ["secure-audit", "secure-audit/gate/status", "secure-audit/gate/unlock", "secure-audit/gate/lock"];
    for (const p of mine) {
      const out = await dispatch(handler, { kind: "api", apiPath: p });
      assert.ok(wasDelegated(out), `${p} لم يُفوَّض`);
    }
    const page = await dispatch(handler, { kind: "page", page: "secure-audit" });
    assert.ok(wasDelegated(page), "صفحة القسم لم تُفوَّض");
    assert.equal(calls.length, mine.length + 1);
  });
});

test("التوزيع: الطلب غير الذروي لا يُحمّل وحدات القسم أصلًا", async () => {
  /* الـrequire كسول: شيفرة القسم لا تدخل الذاكرة ولا مسار التنفيذ إلا
     لطلبٍ يخصّه. */
  await withSpyRouter(async (handler, calls, routerLoaded) => {
    await dispatch(handler, { kind: "api", apiPath: "data/employees" });
    await dispatch(handler, { kind: "page", page: "home" });
    assert.equal(routerLoaded(), false, "وحدة القسم حُمِّلت رغم أن الطلب لا يخصّها");
    await dispatch(handler, { kind: "api", apiPath: "secure-audit/gate/status" });
    assert.equal(routerLoaded(), true, "وحدة القسم يجب أن تُحمَّل عند طلبها");
  });
});

test("التوزيع: kind مجهول أو غائب لا يُفوَّض", async () => {
  await withSpyRouter(async (handler) => {
    for (const query of [{}, { kind: "x", apiPath: "secure-audit/gate/unlock" }, { page: "secure-audit" }, { apiPath: "secure-audit" }]) {
      const out = await dispatch(handler, query);
      assert.ok(!wasDelegated(out), `${JSON.stringify(query)} فُوِّض`);
    }
  });
});

test("التوزيع: api/app.js لا يعرف عن القسم إلا سطر التفويض", () => {
  /* حدٌّ صريح على اتّساع ما يعرفه الملفّ المشترك: لا مسار، ولا حارس، ولا
     جدول، ولا استجابة. لو نما هذا العدد فقد بدأ منطق القسم يتسرّب إليه. */
  const text = fs.readFileSync(path.join(PROJECT_ROOT, "api", "app.js"), "utf8");
  const mentions = (text.match(/secure-audit|SECURE_SECTION|droua/gi) || []).length;
  assert.ok(mentions <= 8, `api/app.js يذكر القسم ${mentions} مرّة — يجب أن يبقى سطر تفويض لا أكثر`);
  assert.ok(!/droua_gate|gate_unlock|gatePassword|gateToken/.test(text), "منطق البوابة يجب ألّا يظهر هنا");
});
