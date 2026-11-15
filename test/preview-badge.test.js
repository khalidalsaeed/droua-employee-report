const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const badge = require("../lib/previewBadge");

/* ⚠️ مؤقّت مع lib/previewBadge.js — يُحذف معه قبل الدمج. */

const PAGE = fs.readFileSync(path.join(__dirname, "..", "payroll-detail-shell.html"), "utf8");

test("العلامة تظهر في المعاينة فقط، مع commit", () => {
  const out = badge.inject(PAGE, { env: "preview", commit: "56e50cf11e0db6a3" });
  assert.match(out, /<body[^>]*>\s*<div id="previewBadge"/);
  assert.ok(out.includes("نسخة مطابقة التحويلات"));
  assert.ok(out.includes("56e50cf"));
});

test("لا علامة في الإنتاج ولا محليًا — الصفحة كما هي حرفيًا", () => {
  for (const env of ["production", "development", undefined, ""]) {
    assert.equal(badge.inject(PAGE, { env, commit: "abc1234" }), PAGE, String(env));
  }
});

test("commit يُنقّى: لا حقن HTML عبر متغيّر البيئة", () => {
  const out = badge.badgeHtml('<script>x</script>');
  assert.ok(!out.includes("<script>"));
});
