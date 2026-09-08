const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* حاجز السياسة: لا بيانات موظفين حقيقية في المستودع.
   =========================================================================
   القاعدة المعتمدة: لا مستند أصلي ولا بيان هوية حقيقي داخل Git — لا رقم
   إقامة، ولا IBAN، ولا رقم حساب بنكي، ولا مبلغ يربط براتب شخص معيّن.
   والسبب أن Git لا ينسى: ملفٌّ يُودَع اليوم يبقى في التاريخ ولكل من
   يستنسخ المستودع، وحذفه من HEAD وحده لا يمحوه.

   وسياسةٌ يحرسها الانضباط وحده تُنتَقض عند أول عجلة. فهذا الاختبار
   يحرسها بالكود: يمسح كل ملفّ نصّي في المستودع بحثًا عن أنماط الهوية،
   ويفشل إن ظهر أيٌّ منها. تُضاف عيّنةٌ فيها رقم إقامة يومًا فيسقط
   البناء قبل الـcommit لا بعد سنة.

   وما لا يستطيع هذا الاختبار حراسته: الأسماء. لا نمط يميّز اسم شخص
   حقيقي من اسم مُختلَق، فالأسماء تبقى مسؤولية المراجعة البشرية —
   والعيّنات القائمة موسومة صراحةً بأنها مُعقَّمة. */

const ROOT = path.join(__dirname, "..");

/* ما لا يُمسح: ليس من صنعنا أو ليس نصًّا. */
const SKIP_DIRS = new Set([".git", "node_modules", "assets"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md", ".txt", ".webmanifest", ".yml", ".yaml"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const ALL_FILES = walk(ROOT);
const TEXT_FILES = ALL_FILES.filter((f) => TEXT_EXT.has(path.extname(f)));
const rel = (f) => path.relative(ROOT, f);

/* package-lock.json يحوي تجزئات طويلة تصطدم بنمط الحساب البنكي بلا أي
   صلة بموظف — يُستثنى من فحص الأرقام الطويلة وحده لا من فحص الإقامة. */
const LOCKFILES = new Set(["package-lock.json"]);

/* أرقام مُختلَقة تشبه الإقامة شكلًا وتُستعمل في الاختبارات. مُعلَنة
   واحدًا واحدًا لا بنمطٍ متسامح: قائمةٌ صريحة تُراجَع، أمّا استثناء
   «كل ما فيه أصفار» فيمرّر رقمًا حقيقيًا فيه صفران. */
const FAKE_IQAMAS = new Set([
  "2000000001", // test/doc-status.test.js — الموظف الافتراضي
  "2000000501", // test/jisr-number.test.js
]);

test("لا رقم إقامة سعودية في أي ملفّ نصّي", () => {
  /* عشرة أرقام تبدأ بـ2 وليست جزءًا من رقم أطول. */
  const IQAMA = /(?<!\d)2\d{9}(?!\d)/g;
  const hits = [];
  for (const f of TEXT_FILES) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(IQAMA)) {
      if (FAKE_IQAMAS.has(m[0])) continue;
      hits.push(`${rel(f)} → ${m[0].slice(0, 4)}…`);
    }
  }
  assert.deepEqual(hits, [], `ما يشبه رقم إقامة:\n  ${hits.join("\n  ")}`);
});

test("لا IBAN سعودي في أي ملفّ نصّي", () => {
  const IBAN = /SA\d{22}/;
  const hits = [];
  for (const f of TEXT_FILES) {
    const m = fs.readFileSync(f, "utf8").match(IBAN);
    if (m) hits.push(`${rel(f)} → ${m[0].slice(0, 4)}…`);
  }
  assert.deepEqual(hits, [], `ما يشبه IBAN:\n  ${hits.join("\n  ")}`);
});

test("لا رقم حساب بنكي طويل في شيفرتنا", () => {
  /* من 14 إلى 20 رقمًا متّصلة. الحدّ الأدنى 14 لا 12 عن قصد: رقم الهاتف
     السعودي بصيغته الدولية اثنتا عشرة خانة (966 ثم تسع) وهو بيان شركة
     ظاهر في الواجهة لا بيان موظف — وأرقام الحسابات في هذه المنصّة ثماني
     عشرة خانة، فالحدّ يفصل بينهما. */
  const ACCOUNT = /(?<!\d)\d{14,20}(?!\d)/;
  const hits = [];
  for (const f of TEXT_FILES) {
    if (LOCKFILES.has(path.basename(f))) continue;
    const m = fs.readFileSync(f, "utf8").match(ACCOUNT);
    if (m) hits.push(`${rel(f)} → ${m[0].length} رقمًا`);
  }
  assert.deepEqual(hits, [], `ما يشبه رقم حساب:\n  ${hits.join("\n  ")}`);
});

/* العيّنات الثنائية: كشوف الرواتب والفواتير والإيصالات تُبنى بالكود في
   test/fixtures ولا تُنسخ من مستند حقيقي. أي PDF آخر يظهر في المستودع
   يجب أن يكون قرارًا واعيًا لا سهوًا. */
test("كل PDF في المستودع معروف ومُبرَّر", () => {
  const KNOWN = new Set([
    /* عيّنة مُعقَّمة يبنيها test/fixtures/payroll-sheet.js */
    "test/fixtures/payroll-sheet-sanitized.pdf",
    /* ⚠️ دَينٌ قائم قبل هذه السياسة — مُعلَن هنا كي لا يُنسى، لا كي
       يُقبَل. لا يعتمد على أيٍّ منها اختبار بعد نقل
       payroll-backfill.test.js إلى العيّنة المُعقَّمة.

       كشف رواتب حقيقي مُودَع في ce720d3: أسماء ورواتب عشرة موظفين.
       حذفه معلَّق على فحص أن لا صفّ في payroll_runs يشير إليه. */
    "payroll/2026-07.pdf",
    /* وخمسة تصاريح أجير حقيقية مُودَعة معها: تحمل أسماء وأرقام إقامة.
       حذفها معلَّق على الفحص نفسه على جدول التصاريح. */
    "permits/TQ6211705.pdf",
    "permits/TQ6211709.pdf",
    "permits/TQ6211782.pdf",
    "permits/TQ6211784.pdf",
    "permits/TQ6211786.pdf",
  ]);
  const pdfs = ALL_FILES.filter((f) => path.extname(f).toLowerCase() === ".pdf").map(rel);
  const unexpected = pdfs.filter((p) => !KNOWN.has(p));
  assert.deepEqual(unexpected, [], `PDF غير مُبرَّر — إن كان عيّنة فابنِها بالكود مُعقَّمة:\n  ${unexpected.join("\n  ")}`);
});

test("العيّنة المُعقَّمة تُبنى بالكود لا تُنسخ", () => {
  const gen = path.join(ROOT, "test", "fixtures", "payroll-sheet.js");
  assert.ok(fs.existsSync(gen), "مولّد العيّنة موجود، فيمكن مراجعة كل رقم فيها");
  const { ROSTER, buildSanitizedSheet } = require("./fixtures/payroll-sheet.js");
  /* والمُودَع يطابق ما يُنتجه المولّد: لا انحراف صامت بين الاثنين. */
  const onDisk = fs.readFileSync(path.join(ROOT, "test", "fixtures", "payroll-sheet-sanitized.pdf"));
  assert.deepEqual(buildSanitizedSheet(), onDisk, "أعد التوليد: node test/fixtures/payroll-sheet.js --write");
  /* وأرقام ضمان فيها 9xx فلا تشير إلى موظف حقيقي في المدى 5xx. */
  for (const r of ROSTER) assert.match(r.eid, /^9\d\d$/);
});
