const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cfg = require("../lib/droua/config");
const gatePassword = require("../lib/droua/gatePassword");

/* ─── عقد سكربت توليد هاش البوابة ──────────────────────────────────────
   =========================================================================
   السكربت يُشغَّل مرّة واحدة في عمر النظام، وبيدٍ تمسك كلمة المرور الحقيقية.
   فخطؤه لا يُكتشف عند التشغيل بل بعد أسابيع حين ترفض البوابة كلمة مرور
   صحيحة — والشكّ وقتها يقع على الكلمة لا على السكربت. لذلك يُختبر عقده:

     • stdout يحمل سطر الهاش وحده. المطالبات ورموز الطرفية على stderr،
       وإلّا خرج من «... > hash.txt» سطرٌ مشوَّه لا يلاحظه أحد.
     • كل فشل صريح برمز خروج 1 — لا خروج صامت بـ0 بلا مخرَج.
     • الناتج يجتاز parseHash ويتحقّق منه verify بالفلفل نفسه. */

const SCRIPT = path.resolve(__dirname, "..", "scripts", "hash-gate-password.js");
const PEPPER = "throwaway-test-pepper-not-a-real-value";
const PASSWORD = "throwaway-test-password-123";
const ESC = String.fromCharCode(27);

function run(input, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: "utf8",
    env: { ...process.env, DROUA_AUDIT_GATE_PEPPER: PEPPER, ...env },
  });
}

test("السكربت: stdout يحمل سطر الهاش وحده، والمطالبات على stderr", () => {
  const r = run(`${PASSWORD}\n${PASSWORD}\n`);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "سطر واحد لا غير على stdout");
  assert.match(lines[0], /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  /* لا رموز طرفية ولا نصّ مطالبة يتسرّب إلى stdout. */
  assert.ok(!r.stdout.includes(ESC), "ممنوع رموز ANSI في stdout");
  assert.ok(!/كلمة مرور البوابة/.test(r.stdout), "المطالبة مكانها stderr");
  assert.match(r.stderr, /كلمة مرور البوابة/, "المطالبة يجب أن تظهر للمستخدم");
});

test("السكربت: الناتج يجتاز parseHash ويتحقّق بالفلفل نفسه", () => {
  const hash = run(`${PASSWORD}\n${PASSWORD}\n`).stdout.trim();
  const parsed = cfg.parseHash(hash);
  assert.ok(parsed, "الخادم يجب أن يقبل صيغة ما يولّده السكربت");
  assert.equal(parsed.logN, 17, "معاملات الإنتاج");
  assert.equal(gatePassword.verify(PASSWORD, parsed, PEPPER), true);
  assert.equal(gatePassword.verify("wrong-password", parsed, PEPPER), false);
  /* فلفل مختلف = هاش لا يُفتح. هذا ما يجعل تسريب الهاش وحده عديم الفائدة،
     وهو أيضًا سبب أشهر عطل تشغيليّ: توليدٌ بفلفل غير الذي في Vercel. */
  assert.equal(gatePassword.verify(PASSWORD, parsed, "different-pepper"), false);
});

test("السكربت: كل فشل صريح برمز 1 وبلا أي مخرَج على stdout", () => {
  const cases = [
    ["الكلمتان غير متطابقتين", "aaaaaaaaaaaa\nbbbbbbbbbbbb\n", /غير متطابقتين/],
    ["أقصر من الحدّ", "short\nshort\n", /12 محرفًا/],
    /* الحالة التي كانت تخرج بصمت برمز 0 بلا هاش. */
    ["مدخل ناقص", "onlyoneline1\n", /انتهى المدخل/],
    ["مدخل فارغ", "", /انتهى المدخل/],
  ];
  for (const [label, input, message] of cases) {
    const r = run(input);
    assert.equal(r.status, 1, `${label}: يجب أن يفشل برمز 1 لا أن يخرج بنجاح`);
    assert.equal(r.stdout.trim(), "", `${label}: لا شيء على stdout عند الفشل`);
    assert.match(r.stderr, message, `${label}: رسالة واضحة على stderr`);
  }
});

test("السكربت: --pepper يطبع سرّين مختلفين ولا يولّد هاشًا في النداء نفسه", () => {
  const p = spawnSync(process.execPath, [SCRIPT, "--pepper"], { encoding: "utf8", env: process.env });
  assert.equal(p.status, 0);
  const out = p.stdout.trim().split("\n");
  assert.equal(out.length, 2, "سطران: الفلفل والسرّ");
  const pepper = out[0].replace("DROUA_AUDIT_GATE_PEPPER=", "");
  const secret = out[1].replace("DROUA_GATE_SECRET=", "");
  assert.match(pepper, /^[0-9a-f]{64}$/);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.notEqual(pepper, secret, "قيمتان مختلفتان — خلطهما يُبطل التحقّق");
  /* الطول يتجاوز الحدّ الأدنى الذي يفرضه config على سرّ التوقيع. */
  assert.ok(secret.length >= cfg.MIN_SECRET_LENGTH);
  assert.ok(!p.stdout.includes("scrypt$"), "لا يولّد هاشًا في نداء الأسرار");
});

test("السكربت: تحذير مرئيّ حين لا يكون الفلفل مضبوطًا", () => {
  /* أشهر عطل تشغيليّ: توليد الهاش قبل تصدير الفلفل. التحذير على stderr
     فلا يلوّث المخرَج، لكنه يظهر للمستخدم. */
  const r = run(`${PASSWORD}\n${PASSWORD}\n`, { DROUA_AUDIT_GATE_PEPPER: "" });
  assert.equal(r.status, 0, "يعمل بلا فلفل — لكن بتحذير");
  assert.match(r.stderr, /DROUA_AUDIT_GATE_PEPPER غير مضبوط/);
});
