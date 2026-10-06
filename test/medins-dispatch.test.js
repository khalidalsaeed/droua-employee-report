const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/* ─── سطر تفويض الوحدة في api/app.js ───────────────────────────────────
   جدولٌ صريح في الاتجاهين: مسارات الوحدة وحدها تُفوَّض إليها، ولا شيء
   منها يذهب إلى Droua ولا إلى المعالج العامّ، ولا شيء من غيرها يبلغها. */

const ROOT = path.resolve(__dirname, "..");
const MEDINS_ROUTER = require.resolve("../lib/medins/router");
const DROUA_ROUTER = require.resolve("../lib/droua/router");

async function withSpies(fn) {
  const originalLoad = Module._load;
  const calls = [];
  const loaded = new Set();
  const clear = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(ROOT) && !k.includes("node_modules")) delete require.cache[k]; };
  clear();
  Module._load = function (request, parent, isMain) {
    if (parent) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch (err) { /* يمرّ */ }
      if (resolved === MEDINS_ROUTER || resolved === DROUA_ROUTER) {
        const who = resolved === MEDINS_ROUTER ? "medins" : "droua";
        loaded.add(who);
        return async (req, res) => { calls.push(who); res.status(200).json({ ok: true, to: who }); };
      }
      if (resolved && resolved.startsWith(path.join(ROOT, "lib", "medins"))) loaded.add("medins-module");
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await fn(require("../api/app"), calls, loaded);
  } finally {
    Module._load = originalLoad;
    clear();
  }
}

function res() {
  const out = { statusCode: 0, body: null, headers: {} };
  const r = {
    setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; },
    getHeader: (k) => out.headers[String(k).toLowerCase()],
    status(c) { out.statusCode = c; return r; },
    json(p) { out.body = p; return r; },
    writeHead(c, h) { out.statusCode = c; Object.assign(out.headers, h || {}); return r; },
    end(p) { if (p !== undefined) out.body = p; return r; },
  };
  return { r, out };
}
async function go(handler, query) {
  const { r, out } = res();
  await handler({ method: "GET", query, headers: {} }, r);
  return out.body && out.body.to ? out.body.to : null;
}

test("التفويض: مسارات الوحدة وحدها تبلغ موجّهها", async () => {
  await withSpies(async (handler) => {
    assert.equal(await go(handler, { kind: "page", page: "secure-benefits" }), "medins");
    for (const p of ["secure-benefits", "secure-benefits/gate/unlock", "secure-benefits/offers", "secure-benefits/files/x/parts/0"]) {
      assert.equal(await go(handler, { kind: "api", apiPath: p }), "medins", p);
    }
  });
});

test("التفويض: الأسماء المخادعة لا تُفوَّض، ومسارات Droua تبقى لـDroua", async () => {
  await withSpies(async (handler) => {
    for (const q of [
      { kind: "page", page: "secure-benefitsX" }, { kind: "page", page: "secure-benefits/" },
      { kind: "api", apiPath: "secure-benefitsX/offers" }, { kind: "api", apiPath: "data/secure-benefits" },
      { kind: "api", apiPath: "/secure-benefits" }, { kind: "x", apiPath: "secure-benefits" }, { apiPath: "secure-benefits" },
    ]) assert.notEqual(await go(handler, q), "medins", JSON.stringify(q));
    assert.equal(await go(handler, { kind: "page", page: "secure-audit" }), "droua");
    assert.equal(await go(handler, { kind: "api", apiPath: "secure-audit/gate/status" }), "droua");
  });
});

test("التفويض: الطلب الذي لا يخصّ الوحدة لا يحمّل شيفرتها أصلًا", async () => {
  await withSpies(async (handler, calls, loaded) => {
    for (const q of [{ kind: "page", page: "home" }, { kind: "api", apiPath: "auth/me" }, { kind: "page", page: "secure-audit" }]) {
      await go(handler, q);
    }
    assert.ok(!loaded.has("medins"), "حُمِّل موجّه الوحدة لطلبٍ لا يخصّها");
    assert.ok(!loaded.has("medins-module"));
  });
});
