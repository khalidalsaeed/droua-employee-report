const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { neon } = require("@neondatabase/serverless");

/* ─── سكربتات التهيئة: إضافيّة، معزولة، منفَّذة فعلًا، ومطابقة للحدود ─── */

const gate = require("../scripts/setup-medins-gate");
const core = require("../scripts/setup-medins-core");
const teardown = require("../scripts/teardown-medins");
const { run } = require("../scripts/lib/medins-migrate");
const limits = require("../lib/medins/limits");

const ALL = [...gate.STATEMENTS, ...core.STATEMENTS];
const text = ALL.map((s) => s.sql).join("\n");

test("الهجرة إضافيّة بحتة: IF NOT EXISTS، بلا DROP ولا ALTER ولا مساس بغير medins_*", () => {
  for (const s of ALL) {
    assert.match(s.sql, /^\s*CREATE (TABLE|(UNIQUE )?INDEX) IF NOT EXISTS /, s.label);
    assert.doesNotMatch(s.sql, /\b(DROP|ALTER|TRUNCATE|GRANT|INSERT INTO|DELETE FROM)\b|\bUPDATE \w+ SET\b/i, s.label);
  }
  for (const m of text.matchAll(/(?:TABLE IF NOT EXISTS|REFERENCES|INDEX IF NOT EXISTS \w+\s+ON) (\w+)/g)) {
    assert.ok(m[1].startsWith("medins_"), `يلمس ${m[1]}`);
  }
  assert.doesNotMatch(text, /\busers\b\s*\(/, "مفتاحٌ أجنبيّ إلى جدول المستخدمين");
});

test("قيود القاعدة تطابق lib/medins/limits.js — لا ينحرف أحدهما وحده", () => {
  const F = limits.FILES;
  assert.match(text, new RegExp(`size_bytes > 0 AND size_bytes <= ${F.MAX_FILE_BYTES}\\)`));
  assert.match(text, new RegExp(`size_bytes > 0 AND size_bytes <= ${F.PART_BYTES}\\)`));
  assert.match(text, new RegExp(`part_count BETWEEN 1 AND ${F.MAX_PARTS}\\)`));
  assert.match(text, new RegExp(`part_index BETWEEN 0 AND ${F.MAX_PARTS - 1}\\)`));
  assert.match(text, new RegExp(`char_length\\(file_name\\) BETWEEN 1 AND ${F.MAX_FILE_NAME}`));
  assert.match(text, new RegExp(`format IN \\(${Object.keys(F.FORMATS).map((f) => `'${f}'`).join(", ")}\\)`));
  assert.match(text, new RegExp(`kind IN \\(${F.KINDS.map((k) => `'${k}'`).join(", ")}\\)`));
  for (const [col, max] of [["title", limits.TEXT.OFFER_TITLE], ["name_ar", limits.TEXT.INSURER_NAME], ["label", limits.TEXT.LOCATION_LABEL]]) {
    assert.match(text, new RegExp(`char_length\\(btrim\\(${col}\\)\\) BETWEEN 1 AND ${max}`), col);
  }
});

test("Missing ≠ Zero مفروضة في القاعدة نصًّا", () => {
  assert.match(text, /value_status IN \('known', 'unknown', 'not_applicable'\)/);
  assert.match(text, /num_nonnulls\(amount_value, percent_value, bool_value, count_value, text_value\)\s+= CASE WHEN value_status = 'known' THEN 1 ELSE 0 END/);
  assert.match(text, /vat_status IN \('included', 'excluded', 'unknown'\)/);
});

test("الشرطة العكسية بـchr(92) لا حرفيًّا — وإلّا رُفض كل ملفّ", () => {
  assert.match(text, /strpos\(file_name, chr\(92\)\) = 0/);
  assert.doesNotMatch(text, /strpos\(file_name, '\\?'\)/);
  assert.doesNotMatch(text, /strpos\(file_name, ''\)/);
});

test("الفهارس تخدم الاستعلامات الفعلية", () => {
  for (const idx of [
    /medins_gate_attempts \(user_id, outcome, ts DESC\)/, /medins_gate_attempts \(ts\)/,
    /medins_audit \(event, ip_hash, ts DESC\)/, /medins_gate_sessions \(user_id\)/,
    /medins_files \(offer_id, plaintext_sha256\) WHERE status IN \('uploading', 'ready'\)/,
    /medins_files \(status, upload_expires_at\)/, /medins_company_locations \(is_default\) WHERE is_default/,
  ]) assert.match(text, idx);
});

function capturedNeon() {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    requests.push(JSON.parse(opts.body));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ command: "CREATE", rowCount: 0, rows: [], fields: [] }) };
  };
  return { sql: neon("postgresql://user:pass@ep-fake.us-east-2.aws.neon.tech/db"), requests, restore: () => { globalThis.fetch = original; } };
}

test("run() يُرسل كل عبارة إلى السلك فعلًا — لا وصفًا يُرمى (sql.query لا sql.unsafe)", async () => {
  for (const statements of [gate.STATEMENTS, core.STATEMENTS, teardown.STATEMENTS]) {
    const net = capturedNeon();
    try {
      assert.equal(await run(net.sql, statements), statements.length);
      assert.equal(net.requests.length, statements.length);
      net.requests.forEach((r, i) => assert.equal(r.query, statements[i].sql));
    } finally { net.restore(); }
  }
});

test("المعاينة والتراجع لا يتّصلان بلا أمرٍ صريح", () => {
  const env = { ...process.env, DATABASE_URL: "" };
  const dry = execFileSync("node", [path.join(__dirname, "..", "scripts", "setup-medins-core.js"), "--dry-run"], { env, encoding: "utf8" });
  assert.match(dry, /معاينة فقط/);
  const td = execFileSync("node", [path.join(__dirname, "..", "scripts", "teardown-medins.js")], { env, encoding: "utf8" });
  assert.match(td, /معاينة فقط/);
  assert.match(td, /--confirm-drop-all-medins-data/);
  for (const s of teardown.STATEMENTS) assert.match(s.sql, /^DROP TABLE IF EXISTS medins_\w+$/);
  const created = [...text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...teardown.TABLES].sort(), created, "التراجع لا يغطّي كل الجداول أو يتجاوزها");
});

test("زرع الكتالوج لا يكتب بلا --apply، والقائمة المقترحة صالحة", () => {
  const { validate } = require("../scripts/seed-medins-catalog");
  assert.equal(validate(), 18);
  const out = execFileSync("node", [path.join(__dirname, "..", "scripts", "seed-medins-catalog.js")], { env: { ...process.env, DATABASE_URL: "" }, encoding: "utf8" });
  assert.match(out, /معاينة/);
  assert.doesNotMatch(core.STATEMENTS.map((s) => s.sql).join(" "), /INSERT/);
});

test("سكربت الأعضاء: كل أمرٍ يكتب صفّه وتدقيقه معًا، وبلا كلمات مرور", () => {
  const { build } = require("../scripts/medins-members");
  const tag = (strings, ...values) => ({ text: strings.join("?"), values });
  const user = "11111111-1111-4111-8111-111111111111";
  const grant = build(tag, "grant", { user, email: "A@B.test", role: "viewer", by: "خالد" });
  assert.equal(grant.length, 2);
  assert.deepEqual(grant[0].values.slice(0, 3), [user, "a@b.test", "viewer"]);
  assert.match(grant[1].text, /INSERT INTO medins_audit/);
  assert.throws(() => build(tag, "grant", { user, email: "a@b.test", role: "owner", by: "خالد" }), /editor أو viewer/);
  assert.throws(() => build(tag, "grant", { user: "x;drop", email: "a@b.test", role: "viewer", by: "خالد" }), /صيغة/);
  const pw = build(tag, "set-password", { user, by: "خالد" }, { hash: "scrypt$17$8$1$aa$bb" });
  assert.ok(pw.some((q) => /UPDATE medins_gate_sessions SET revoked_at/.test(q.text)), "كلمة جديدة لا تُبطل الجلسات");
  assert.ok(!JSON.stringify(pw[2].values).includes("scrypt$"), "الهاش في التدقيق");
  const dis = build(tag, "disable", { user, by: "خالد" });
  assert.ok(dis.some((q) => /revoked_at/.test(q.text)));
});
