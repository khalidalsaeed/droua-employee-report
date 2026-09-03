const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

/* حارس ضد الإسناد إلى ثوابت الطبقة المشتركة.
   =========================================================================
   doc-status.js سكربت كلاسيكي يُعرِّف رموزه بـ const على المستوى الأعلى،
   والصفحة التي تحمّله تشترك معه في النطاق نفسه. فإسنادٌ إلى أحد تلك
   الأسماء من سكربت الصفحة يرمي TypeError وقت التشغيل لا وقت التحميل،
   فلا يكشفه أي فحص نحوي ولا أي اختبار يقيس ما يُرسم.

   وهذا ما وقع فعلًا: app-shell.html كان يحوي `let SOON = 90` محليًّا، ثم
   استُخرج المنطق إلى doc-status.js بـ `const SOON`، وبقي سطر الإسناد في
   آخر loadAppData(). النتيجة: استثناء يبتلعه catch في boot() فيعرض
   «تعذّر تحميل البيانات» بلا فشل شبكة واحد، ويمنع loadTickets() من
   العمل أصلًا فتبقى ودجة التذاكر في الرئيسية فارغة.

   الاختبار يغطّي الصنف كلّه لا السطر الواحد: أي ثابت مشترك، وأي صفحة
   تحمّله، حاضرة ومستقبلية. */

const SHARED_FILES = ["doc-status.js"];

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* ثوابت المستوى الأعلى فقط — أي بلا مسافة بادئة. ما كان داخل دالّة لا
   يتسرّب إلى نطاق السكربت فلا شأن له بهذا الفحص. */
function topLevelConsts(source) {
  const names = [];
  const re = /^const\s+([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

/* الصفحات التي تحمّل الملف، مستنتَجة من وسم <script> نفسه — لا قائمة
   يدوية تتقادم حين تُضاف صفحة. */
function pagesLoading(file) {
  return fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => read(f).includes(`/${file}`));
}

/* إسناد في بداية عبارة: NAME = / += / ??= …، مع استثناء التعريف بـ
   const|let|var، والخاصية (.NAME)، والاسم الأطول، والمقارنات (== ===). */
function assignmentsTo(source, name) {
  const re = new RegExp(
    String.raw`(^|[^\w$.])(?<!\b(?:const|let|var)\s)` +
      name +
      String.raw`\s*(?:\+|-|\*|\/|\|\||\?\?|&&)?=(?!=)`
  );
  return source
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => !text.startsWith("//") && !text.startsWith("*") && !text.startsWith("/*"))
    .filter(({ text }) => re.test(text));
}

for (const file of SHARED_FILES) {
  const names = topLevelConsts(read(file));

  test(`${file}: يُعرِّف ثوابت على المستوى الأعلى`, () => {
    assert.ok(names.length > 0, `لم يُعثر على أي const في ${file} — تغيّرت بنية الملف والحارس صار بلا أثر`);
    assert.ok(names.includes("SOON"), "SOON هو الثابت الذي وقع فيه العطل الأصلي، فوجوده شرط لبقاء الحارس ذا معنى");
  });

  test(`${file}: لا صفحة تُسنِد إلى ثوابته`, () => {
    const pages = pagesLoading(file);
    assert.ok(pages.length > 0, `لا صفحة تحمّل ${file} — تغيّر وسم <script> والحارس لم يعد يفحص شيئًا`);

    const offences = [];
    for (const page of pages) {
      const source = read(page);
      for (const name of names) {
        for (const hit of assignmentsTo(source, name)) {
          offences.push(`${page}:${hit.line} → ${hit.text}`);
        }
      }
    }
    assert.deepEqual(
      offences,
      [],
      "إسناد إلى ثابت مشترك يرمي TypeError وقت التشغيل:\n  " + offences.join("\n  ")
    );
  });
}
