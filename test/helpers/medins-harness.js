/* ─── بيئة اختبار وحدة /secure-benefits ─────────────────────────────────
   =========================================================================
   تبني كل ما يلزم لتشغيل الموجّه الحقيقيّ بلا شبكة ولا أسرار حقيقية:
     • متغيّرات بيئة اصطناعية (أسرار، مفاتيح، توكن متجر) تُستعاد بعد كل اختبار.
     • قاعدة: إمّا مُشغّل psql حقيقيّ (تكامل) أو مُزيَّف بذاكرة (وحدة).
     • متجر Blob مُزيَّف (نفس مُزيَّف Droua).
     • هويّة المنصّة: توكن جلسة حقيقيّ موقَّع بسرٍّ اصطناعيّ، و requireUser
       مُستبدَل بقاموس مستخدمين — فلا يُحتاج جدول users.
   والمغلّف async ويُنتظر جسمه (الدرس الموثّق في droua-harness). */

const Module = require("node:module");
const path = require("node:path");
const crypto = require("node:crypto");
const { makeFakeBlob } = require("./files-db");

const ROOT = path.resolve(__dirname, "..", "..");
const BLOB_ID = require.resolve("@vercel/blob");
const DB_ID = require.resolve("../../lib/db");
const REQUIRE_AUTH_ID = require.resolve("../../lib/auth/requireAuth");

const IDS = Object.freeze({
  editor: "11111111-1111-4111-8111-111111111111",
  viewer: "22222222-2222-4222-8222-222222222222",
  outsider: "33333333-3333-4333-8333-333333333333", // محميّ لكن ليس عضوًا
  plain: "44444444-4444-4444-8444-444444444444", // مسجَّل غير محميّ
});
const USERS = Object.freeze({
  [IDS.editor]: { id: IDS.editor, name: "محرّر اصطناعي", email: "editor@example.test", role: "hr", status: "active" },
  [IDS.viewer]: { id: IDS.viewer, name: "مشاهد اصطناعي", email: "viewer@example.test", role: "hr", status: "active" },
  [IDS.outsider]: { id: IDS.outsider, name: "مالك اصطناعي", email: "owner@example.test", role: "owner", status: "active" },
  [IDS.plain]: { id: IDS.plain, name: "موظف", email: "staff@example.test", role: "employee", status: "active" },
});

const ENV = Object.freeze({
  SESSION_SECRET: "synthetic-session-secret-for-tests-0000000001",
  PROTECTED_USER_IDS: [IDS.editor, IDS.viewer, IDS.outsider].join(","),
  MEDINS_GATE_SECRET: "synthetic-medins-gate-secret-000000000000002",
  MEDINS_GATE_PEPPER: "synthetic-medins-pepper-0000000000000000003",
  MEDINS_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_SYNTHETIC_MEDINS",
  MEDINS_FILE_ACTIVE_KEY_ID: "k1",
  MEDINS_FILE_KEY_K1: "c3".repeat(32),
});
const PASSWORDS = Object.freeze({ editor: "editor-gate-password-synthetic", viewer: "viewer-gate-password-synthetic" });

/* هاشات بمعامل مخفَّض (الصيغة تحمل معاملها، فالمسار هو مسار الإنتاج). */
let HASHES = null;
function hashes() {
  if (!HASHES) {
    const password = require("../../lib/secure-kit/password");
    HASHES = {
      editor: password.derive(PASSWORDS.editor, { logN: 12, pepper: ENV.MEDINS_GATE_PEPPER }),
      viewer: password.derive(PASSWORDS.viewer, { logN: 12, pepper: ENV.MEDINS_GATE_PEPPER }),
    };
  }
  return HASHES;
}

function clearProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && !key.includes("node_modules") && !key.includes(`${path.sep}test${path.sep}`)) delete require.cache[key];
  }
}

function stub(id, exports) {
  const m = new Module(id, null);
  m.filename = id;
  m.loaded = true;
  m.exports = exports;
  require.cache[id] = m;
}

/* ─── قاعدة مُزيَّفة بذاكرة: جداول البوابة والعضويّة والتدقيق فقط ─── */
function makeGateDb() {
  const members = new Map();
  const sessions = new Map();
  const attempts = [];
  const audit = [];
  const calls = [];
  const armed = { auditFail: false };
  let attemptId = 0;
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  function exec(text, v) {
    const t = norm(text);
    if (/FROM medins_members WHERE user_id/.test(t)) {
      const m = members.get(v[0]);
      return m && m.active && !m.disabled_at ? [{ ...m }] : [];
    }
    if (/^INSERT INTO medins_gate_sessions/.test(t)) {
      sessions.set(v[0], { sid_hash: v[0], user_id: v[1], idle_exp: Date.parse(v[4]), absolute_exp: Date.parse(v[5]), revoked_at: null });
      return [];
    }
    if (/FROM medins_gate_sessions WHERE sid_hash/.test(t)) {
      const s = sessions.get(v[0]);
      return s ? [{ sid_hash: s.sid_hash, user_id: s.user_id, idle_exp_ms: String(s.idle_exp), absolute_exp_ms: String(s.absolute_exp), revoked_at: s.revoked_at }] : [];
    }
    if (/^UPDATE medins_gate_sessions SET last_seen_at/.test(t)) {
      const s = sessions.get(v[2]);
      if (s && !s.revoked_at) s.idle_exp = Date.parse(v[1]);
      return [];
    }
    if (/^UPDATE medins_gate_sessions SET revoked_at .* WHERE sid_hash/.test(t)) {
      const s = sessions.get(v[1]);
      if (s && !s.revoked_at) s.revoked_at = v[0];
      return [];
    }
    if (/^UPDATE medins_gate_sessions SET revoked_at .* WHERE user_id/.test(t)) {
      for (const s of sessions.values()) if (s.user_id === v[1] && !s.revoked_at) s.revoked_at = v[0];
      return [];
    }
    if (/^DELETE FROM medins_gate_sessions/.test(t)) return [];
    if (/^WITH ins AS \( INSERT INTO medins_gate_attempts/.test(t)) {
      const [userId, ts, shortFrom, longFrom, critFrom] = v;
      const prior = attempts.filter((a) => a.user_id === userId && a.outcome === "fail");
      const count = (from) => prior.filter((a) => a.ts > Date.parse(from)).length;
      attemptId += 1;
      attempts.push({ id: attemptId, user_id: userId, outcome: "fail", ts: Date.parse(ts) });
      return [{ attempt_id: attemptId, short_count: String(count(shortFrom)), long_count: String(count(longFrom)), critical_count: String(count(critFrom)) }];
    }
    if (/^DELETE FROM medins_gate_attempts WHERE id/.test(t)) {
      const i = attempts.findIndex((a) => a.id === v[0]);
      if (i >= 0) attempts.splice(i, 1);
      return [];
    }
    if (/^DELETE FROM medins_gate_attempts WHERE user_id/.test(t)) {
      for (let i = attempts.length - 1; i >= 0; i -= 1) if (attempts[i].user_id === v[0]) attempts.splice(i, 1);
      return [];
    }
    if (/^DELETE FROM medins_gate_attempts WHERE ts/.test(t)) return [];
    if (/^INSERT INTO medins_audit/.test(t)) {
      if (armed.auditFail) throw new Error("فشل تدقيق مُسلَّح");
      if (/WHERE NOT EXISTS/.test(t)) {
        const [event, userId, meta, ipHash, , , from] = v;
        if (audit.some((a) => a.event === event && a.ip_hash === ipHash && a.ts > Date.parse(from))) return [];
        audit.push({ event, user_id: userId, meta: JSON.parse(meta), ip_hash: ipHash, ts: Date.now() });
        return [];
      }
      const withRole = /\(event, user_id, role, meta, ip_hash\)/.test(t);
      const [event, userId, a, b, c] = v;
      audit.push(withRole
        ? { event, user_id: userId, role: a, meta: JSON.parse(b), ip_hash: c, ts: Date.now() }
        : { event, user_id: userId, role: null, meta: JSON.parse(a), ip_hash: b, ts: Date.now() });
      return [];
    }
    return null; // غير معروف
  }

  const sql = (strings, ...values) => {
    let text = "";
    const params = [];
    strings.forEach((chunk, i) => {
      text += chunk;
      if (i >= values.length) return;
      const val = values[i];
      if (val && val.__unsafe !== undefined) { text += val.__unsafe; return; }
      text += "?";
      params.push(val);
    });
    calls.push({ text: norm(text), values: params });
    const q = {
      text,
      then(res, rej) {
        try {
          const out = exec(text, params);
          return Promise.resolve(out === null ? [] : out).then(res, rej);
        } catch (err) {
          return Promise.reject(err).then(res, rej);
        }
      },
    };
    return q;
  };
  sql.unsafe = (s) => ({ __unsafe: String(s) });
  sql.transaction = async (qs) => Promise.all(qs.map((q) => q));
  sql.calls = calls;

  function addMember(userId, role, { hash = null, email } = {}) {
    members.set(userId, {
      user_id: userId, email: (email || USERS[userId].email).toLowerCase(), role, active: true,
      gate_password_hash: hash, disabled_at: null,
    });
  }
  return { sql, members, sessions, attempts, audit, calls, armed, addMember };
}

/* ─── الطلب والاستجابة ─── */
function makeRes() {
  const out = { statusCode: 0, headers: {}, body: undefined, ended: false };
  const res = {
    setHeader(name, value) { out.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return out.headers[String(name).toLowerCase()]; },
    status(code) { out.statusCode = code; return res; },
    json(body) { out.body = body; out.ended = true; return res; },
    end(body) { if (body !== undefined) out.body = body; out.ended = true; return res; },
    writeHead(code, headers) {
      out.statusCode = code;
      for (const [k, v] of Object.entries(headers || {})) out.headers[k.toLowerCase()] = v;
      return res;
    },
  };
  return { res, out };
}

function cookiesFrom(out) {
  const raw = out.headers["set-cookie"];
  return raw ? (Array.isArray(raw) ? raw : [raw]) : [];
}

/* عميلٌ لكل مستخدم بجرّة كوكي. */
function client(userId) {
  const { issueSessionToken } = require("../../lib/auth/tokens");
  const jar = new Map();
  if (userId) jar.set("session", issueSessionToken(USERS[userId], false));
  const router = () => require("../../api/app");

  async function call(method, apiPath, { body, page = false, headers = {} } = {}) {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    /* كما يفعل Vercel: سلسلة الاستعلام تُدمج في req.query ولا تبقى في apiPath. */
    const [pathOnly, qs] = String(apiPath).split("?");
    const extraQuery = Object.fromEntries(new URLSearchParams(qs || ""));
    const req = {
      method,
      query: page ? { kind: "page", page: "secure-benefits" } : { ...extraQuery, kind: "api", apiPath: `secure-benefits/${pathOnly}` },
      headers: {
        cookie, host: "app.example.test",
        ...(method !== "GET" ? { "content-type": "application/json", origin: "https://app.example.test" } : {}),
        "x-forwarded-for": "198.51.100.7",
        ...headers,
      },
      body: body === undefined ? undefined : body,
    };
    const { res, out } = makeRes();
    await router()(req, res);
    for (const c of cookiesFrom(out)) {
      const [pair] = c.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/Max-Age=0/.test(c) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return out;
  }
  return { call, jar, page: () => call("GET", "", { page: true }) };
}

async function withMedins(fn, { sql = null } = {}) {
  const saved = {};
  const keys = new Set([...Object.keys(ENV), ...Object.keys(process.env).filter((k) => k.startsWith("MEDINS_") || k.startsWith("DROUA_"))]);
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, ENV);

  const previous = { blob: require.cache[BLOB_ID], db: require.cache[DB_ID], auth: require.cache[REQUIRE_AUTH_ID] };
  clearProjectCache();
  const blob = makeFakeBlob();
  const gateDb = sql ? null : makeGateDb();
  const db = sql || gateDb.sql;
  stub(BLOB_ID, blob.api);
  stub(DB_ID, { getSql: () => db });
  stub(REQUIRE_AUTH_ID, {
    async requireUser(req) {
      const { verify } = require("../../lib/auth/tokens");
      const raw = require("../../lib/secure-kit/http").readCookie(req, "session");
      const payload = raw ? verify(raw) : null;
      const user = payload && USERS[payload.sub];
      return user && user.status === "active" ? { ...user } : null;
    },
  });
  try {
    return await fn({ blob, gateDb, sql: db, client, IDS, USERS, PASSWORDS, hashes: hashes() });
  } finally {
    for (const [id, mod] of [[BLOB_ID, previous.blob], [DB_ID, previous.db], [REQUIRE_AUTH_ID, previous.auth]]) {
      if (mod) require.cache[id] = mod;
      else delete require.cache[id];
    }
    clearProjectCache();
    for (const k of Object.keys(ENV)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

module.exports = { withMedins, makeGateDb, makeRes, client, IDS, USERS, ENV, PASSWORDS, hashes, sha256, clearProjectCache };
