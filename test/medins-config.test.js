const test = require("node:test");
const assert = require("node:assert/strict");

/* ─── إعداد الوحدة: كل شرطٍ فاشل يُخفيها ─────────────────────────────── */

const BASE = {
  PROTECTED_USER_IDS: "11111111-1111-4111-8111-111111111111",
  SESSION_SECRET: "s".repeat(40),
  MEDINS_GATE_SECRET: "g".repeat(40),
  MEDINS_GATE_PEPPER: "p".repeat(40),
};
const KEYS = [...Object.keys(BASE), "DROUA_GATE_SECRET", "CRON_SECRET", "MEDINS_GATE_IDLE_MINUTES", "MEDINS_GATE_ABSOLUTE_MINUTES"];

function withEnv(env, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { return fn(require("../lib/medins/config")); } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("الإعداد السليم يُحمَّل بالمدد الافتراضية 15/60", () => {
  withEnv(BASE, (config) => {
    const cfg = config.load();
    assert.equal(cfg.idleMs, 15 * 60 * 1000);
    assert.equal(cfg.absoluteMs, 60 * 60 * 1000);
  });
});

test("المدّتان قابلتان للضبط ضمن حدود، والقيمة الخارجة عنها تُخفي لا تسقط بصمت", () => {
  withEnv({ ...BASE, MEDINS_GATE_IDLE_MINUTES: "20", MEDINS_GATE_ABSOLUTE_MINUTES: "120" }, (config) => {
    const cfg = config.load();
    assert.equal(cfg.idleMs, 20 * 60 * 1000);
    assert.equal(cfg.absoluteMs, 120 * 60 * 1000);
  });
  for (const bad of [{ MEDINS_GATE_IDLE_MINUTES: "600" }, { MEDINS_GATE_IDLE_MINUTES: "abc" }, { MEDINS_GATE_ABSOLUTE_MINUTES: "10" },
    { MEDINS_GATE_IDLE_MINUTES: "50", MEDINS_GATE_ABSOLUTE_MINUTES: "30" }]) {
    withEnv({ ...BASE, ...bad }, (config) => assert.equal(config.load(), null, JSON.stringify(bad)));
  }
});

test("كل شرطٍ فاشل يُرجع null", () => {
  const cases = [
    { MEDINS_GATE_SECRET: undefined },
    { MEDINS_GATE_SECRET: "short" },
    { MEDINS_GATE_SECRET: BASE.SESSION_SECRET },
    { DROUA_GATE_SECRET: BASE.MEDINS_GATE_SECRET },
    { CRON_SECRET: BASE.MEDINS_GATE_SECRET },
    { MEDINS_GATE_PEPPER: undefined },
    { MEDINS_GATE_PEPPER: BASE.MEDINS_GATE_SECRET },
    { PROTECTED_USER_IDS: undefined },
  ];
  for (const c of cases) {
    const env = { ...BASE, ...c };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    withEnv(env, (config) => {
      assert.equal(config.load(), null, JSON.stringify(c));
      assert.ok(config.checks().results.some(([, ok]) => !ok));
    });
  }
});

test("فحص الإعداد المحلّي يطبع الأسماء لا القيم", () => {
  withEnv(BASE, (config) => {
    const names = config.checks().results.map(([n]) => n).join(" ");
    for (const v of Object.values(BASE)) assert.ok(!names.includes(v));
  });
});
