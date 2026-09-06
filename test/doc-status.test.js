const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DocStatus = require("../doc-status.js");
const { F, SOON } = DocStatus;

const ROOT = path.join(__dirname, "..");

/* اختبارات عتبة المتابعة ومصدرها الوحيد.
   =========================================================================
   العطل الذي تحرسه هذه الاختبارات: الصفحة كانت تعرض وثيقة باقٍ عليها 86
   يومًا ضمن «قريبة الانتهاء» لأن العتبة كانت 90. المتابعة التشغيلية تبدأ
   في آخر عشرة أيام لا قبلها، والمنتهية تبقى مطروحة حتى يُحدَّث تاريخها.

   كل التواريخ هنا نسبية لليوم لا مثبَّتة: doc-status.js يشتقّ NOW من ساعة
   الجهاز عند التحميل، فتاريخٌ مثبَّت يجعل الاختبار يسقط بمرور الوقت. */

/* صيغة M/D/YYYY محلّية — هي إحدى الصيغتين اللتين يقرأهما parseDate،
   واختيارها هنا مقصود: تُبنى بالتقويم المحلّي تمامًا كـNOW، فلا يتسرّب
   إلى الحساب فارقُ منطقة زمنية. */
function inDays(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

/* موظف بالحد الأدنى من الحقول: كل تاريخ غير ممرَّر يبقى غير مسجَّل، وهي
   حالة na التي يجب أن تُستبعد من كل عدّ. */
function emp({ eid = "1", name = "موظف", iqama = "2000000001", iq, lic, pass, pending } = {}) {
  const e = { [F.eid]: eid, [F.name]: name, [F.iqama]: iqama };
  if (iq !== undefined) e[F.iqExp] = iq;
  if (lic !== undefined) e[F.licExp] = lic;
  if (pass !== undefined) e[F.passExp] = pass;
  if (pending) e._licPending = true;
  return e;
}

function permit({ permit: no = "P-1", iqama = "2000000001", issue = inDays(-20), expiry } = {}) {
  return { permit: no, iqama, nameOnPermit: "موظف", issueDate: issue, expiryDate: expiry };
}

const types = (rows) => rows.map((r) => r.tk).sort();

/* ── العتبة نفسها ───────────────────────────────────────────────────── */

test("العتبة عشرة أيام", () => {
  assert.equal(SOON, 10, "عتبة المتابعة التشغيلية داخل المنصّة عشرة أيام");
});

/* ── حدود نافذة المتابعة، وثيقةً وثيقة ─────────────────────────────── */

test("11 يومًا فأكثر خارج القائمة والعدّاد", () => {
  for (const n of [11, 20, 50, 70, 86, 90, 365]) {
    const rows = DocStatus.collectFollowUpDocs([emp({ iq: inDays(n) })]);
    assert.equal(rows.length, 0, `وثيقة باقٍ عليها ${n} يومًا لا تدخل المتابعة`);
  }
});

test("من 10 أيام إلى يوم واحد داخل القائمة", () => {
  for (const n of [10, 9, 5, 2, 1]) {
    const rows = DocStatus.collectFollowUpDocs([emp({ iq: inDays(n) })]);
    assert.equal(rows.length, 1, `وثيقة باقٍ عليها ${n} يومًا تدخل المتابعة`);
    assert.equal(rows[0].st.key, "warn");
    assert.equal(rows[0].st.n, n);
  }
});

test("اليوم 0 يظهر كمنتهٍ اليوم", () => {
  const rows = DocStatus.collectFollowUpDocs([emp({ iq: inDays(0) })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].st.key, "today");
  assert.equal(rows[0].st.n, 0);
});

test("المنتهية فعلًا تبقى ظاهرة", () => {
  for (const n of [-1, -3, -40, -400]) {
    const rows = DocStatus.collectFollowUpDocs([emp({ iq: inDays(n) })]);
    assert.equal(rows.length, 1, `وثيقة منتهية منذ ${Math.abs(n)} يومًا تبقى في المتابعة`);
    assert.equal(rows[0].st.key, "bad");
  }
});

test("الوثيقة بلا تاريخ مسجَّل لا تُحتسب", () => {
  assert.equal(DocStatus.collectFollowUpDocs([emp({})]).length, 0);
  assert.equal(DocStatus.collectFollowUpDocs([emp({ iq: null })]).length, 0);
  assert.equal(DocStatus.collectFollowUpDocs([emp({ iq: "" })]).length, 0);
});

/* الحالة التي ظهرت في لقطات الشاشة: باقٍ 86 يومًا وكانت تُعرض. */
test("انحدار: 86 يومًا لا تظهر بينما 8 أيام تظهر", () => {
  const rows = DocStatus.collectFollowUpDocs([
    emp({ eid: "1", iqama: "1", iq: inDays(86) }),
    emp({ eid: "2", iqama: "2", iq: inDays(8) }),
  ]);
  assert.deepEqual(rows.map((r) => r.emp[F.eid]), ["2"]);
});

/* ── كل نوع وثيقة يخضع للعتبة نفسها ────────────────────────────────── */

test("الإقامة والرخصة والجواز وتصريح أجير كلها تحت العتبة نفسها", () => {
  const e = emp({ iq: inDays(4), lic: inDays(6), pass: inDays(9) });
  const rows = DocStatus.collectFollowUpDocs([e], [permit({ expiry: inDays(3) })]);
  assert.deepEqual(types(rows), ["ajeer", "iq", "lic", "pass"]);
});

test("كل نوع وثيقة يخرج عند 11 يومًا", () => {
  const e = emp({ iq: inDays(11), lic: inDays(11), pass: inDays(11) });
  const rows = DocStatus.collectFollowUpDocs([e], [permit({ expiry: inDays(11) })]);
  assert.equal(rows.length, 0);
});

/* ── رخصة «جاري السداد» ────────────────────────────────────────────── */

test("رخصة جاري السداد مستبعدة من المتابعة حتى لو انتهت", () => {
  const near = DocStatus.collectFollowUpDocs([emp({ lic: inDays(3), pending: true })]);
  assert.equal(near.length, 0, "إجراؤها جارٍ فعلًا فلا تُطالِب بمتابعة");
  const past = DocStatus.collectFollowUpDocs([emp({ lic: inDays(-3), pending: true })]);
  assert.equal(past.length, 0, "التجاوز يبقى ساريًا بعد الانتهاء أيضًا");
});

/* ── تصاريح أجير ───────────────────────────────────────────────────── */

test("تصريح أجير باقٍ 4 أيام يدخل القائمة بنوعه", () => {
  const rows = DocStatus.collectFollowUpDocs([emp({ iqama: "5" })], [permit({ iqama: "5", expiry: inDays(4) })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tk, "ajeer");
  assert.equal(rows[0].type, "تصريح أجير");
  assert.equal(rows[0].st.n, 4);
});

test("تصريح أجير باقٍ 25 يومًا لا يدخل القائمة", () => {
  const rows = DocStatus.collectFollowUpDocs([emp({ iqama: "5" })], [permit({ iqama: "5", expiry: inDays(25) })]);
  assert.equal(rows.length, 0);
});

test("تصريح أجير منتهٍ يبقى في القائمة", () => {
  const rows = DocStatus.collectFollowUpDocs([emp({ iqama: "5" })], [permit({ iqama: "5", expiry: inDays(-2) })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tk, "ajeer");
  assert.equal(rows[0].st.key, "bad");
});

test("تصريحان لنفس الإقامة: الأحدث إصدارًا وحده يُحتسب", () => {
  const rows = DocStatus.collectFollowUpDocs(
    [emp({ iqama: "5" })],
    [
      permit({ permit: "OLD", iqama: "5", issue: inDays(-60), expiry: inDays(3) }),
      permit({ permit: "NEW", iqama: "5", issue: inDays(-5), expiry: inDays(300) }),
    ]
  );
  assert.equal(rows.length, 0, "التصريح الجديد يَجُبّ القديم، فلا شيء يحتاج متابعة");
});

test("تصريح بلا موظف مطابق لا يُحتسب", () => {
  const rows = DocStatus.collectFollowUpDocs([emp({ iqama: "5" })], [permit({ iqama: "999", expiry: inDays(1) })]);
  assert.equal(rows.length, 0);
});

test("غياب التصاريح لا يكسر الاحتساب", () => {
  const e = [emp({ iq: inDays(2) })];
  assert.equal(DocStatus.collectFollowUpDocs(e).length, 1);
  assert.equal(DocStatus.collectFollowUpDocs(e, null).length, 1);
  assert.equal(DocStatus.collectFollowUpDocs(e, []).length, 1);
});

/* ── التحديث اللحظي: الاشتقاق من التاريخ لا من حالة محفوظة ─────────── */

test("تجديد الرخصة يُخرج الموظف من القائمة ويُنقص العدّاد", () => {
  const e = emp({ lic: inDays(5) });
  const before = DocStatus.collectFollowUpDocs([e]);
  assert.equal(before.length, 1, "باقٍ 5 أيام → في القائمة والعدّاد");

  e[F.licExp] = inDays(400); /* جُدّدت في المنصّة */
  const after = DocStatus.collectFollowUpDocs([e]);
  assert.equal(after.length, 0, "التاريخ الجديد يُخرجها فورًا بلا إدخال إضافي");
});

test("تجديد تصريح أجير يُنقص العدّاد", () => {
  const e = [emp({ iqama: "7" })];
  const p = permit({ iqama: "7", expiry: inDays(2) });
  assert.equal(DocStatus.collectFollowUpDocs(e, [p]).length, 1);
  p.expiryDate = inDays(30);
  assert.equal(DocStatus.collectFollowUpDocs(e, [p]).length, 0);
});

test("تجديد وثيقة منتهية يُخرجها من القائمة", () => {
  const e = emp({ iq: inDays(-12) });
  assert.equal(DocStatus.collectFollowUpDocs([e]).length, 1);
  e[F.iqExp] = inDays(365);
  assert.equal(DocStatus.collectFollowUpDocs([e]).length, 0);
});

/* ── الترتيب ───────────────────────────────────────────────────────── */

test("المنتهية أولًا (الأقدم في الصدارة) ثم الأقرب انتهاءً", () => {
  const rows = DocStatus.collectFollowUpDocs([
    emp({ eid: "a", iqama: "a", iq: inDays(9) }),
    emp({ eid: "b", iqama: "b", iq: inDays(-30) }),
    emp({ eid: "c", iqama: "c", iq: inDays(0) }),
    emp({ eid: "d", iqama: "d", iq: inDays(-2) }),
    emp({ eid: "e", iqama: "e", iq: inDays(3) }),
  ]);
  assert.deepEqual(rows.map((r) => r.emp[F.eid]), ["b", "d", "c", "e", "a"]);
});

/* ── العدّاد والقائمة من مصدر واحد ─────────────────────────────────── */

test("المنتهية مجموعة جزئية من قائمة المتابعة لا قائمة موازية", () => {
  const list = [
    emp({ eid: "1", iqama: "1", iq: inDays(-5) }),
    emp({ eid: "2", iqama: "2", iq: inDays(4) }),
    emp({ eid: "3", iqama: "3", iq: inDays(40) }),
  ];
  const followUp = DocStatus.collectFollowUpDocs(list);
  const expired = DocStatus.collectExpiredDocs(list);
  assert.equal(followUp.length, 2);
  assert.equal(expired.length, 1);
  const ids = new Set(followUp.map((r) => `${r.emp[F.eid]}:${r.tk}`));
  for (const x of expired) {
    assert.ok(ids.has(`${x.emp[F.eid]}:${x.tk}`), "كل وثيقة منتهية موجودة في قائمة المتابعة");
  }
});

test("قائمة المتابعة = المنتهية + قريبة الانتهاء، بلا تداخل", () => {
  const list = [
    emp({ eid: "1", iqama: "1", iq: inDays(-5) }),
    emp({ eid: "2", iqama: "2", iq: inDays(0) }),
    emp({ eid: "3", iqama: "3", iq: inDays(7) }),
    emp({ eid: "4", iqama: "4", iq: inDays(99) }),
  ];
  const followUp = DocStatus.collectFollowUpDocs(list).length;
  const soon = DocStatus.collectSoonDocs(list).length;
  const expired = DocStatus.collectExpiredDocs(list).length;
  assert.equal(followUp, soon + expired);
});

test("needsFollowUp يغطّي bad و today و warn وحدها", () => {
  const key = (n) => DocStatus.statusOf(inDays(n));
  assert.ok(DocStatus.needsFollowUp(key(-1)));
  assert.ok(DocStatus.needsFollowUp(key(0)));
  assert.ok(DocStatus.needsFollowUp(key(SOON)));
  assert.ok(!DocStatus.needsFollowUp(key(SOON + 1)));
  assert.ok(!DocStatus.needsFollowUp({ key: "na", cls: "na", n: null }));
  assert.ok(!DocStatus.needsFollowUp({ key: "pending", cls: "pending", n: 3 }));
});

/* ── الملخّص النصّي ────────────────────────────────────────────────── */

test("الملخّص يذكر تصاريح أجير ويحذف الأنواع الصفرية", () => {
  const rows = DocStatus.collectFollowUpDocs(
    [emp({ iqama: "9", iq: inDays(1), lic: inDays(2) })],
    [permit({ iqama: "9", expiry: inDays(3) })]
  );
  const s = DocStatus.summarizeDocs(rows);
  assert.match(s, /إقامات 1/);
  assert.match(s, /رخص عمل 1/);
  assert.match(s, /تصاريح أجير 1/);
  assert.doesNotMatch(s, /جوازات/, "النوع الصفري يُحذف بدل أن يُطبع صفرًا");
});

/* ── حارس: العتبة معرَّفة مرّة واحدة في المنصّة ────────────────────── */

test("لا ملف واجهة يعرّف عتبة متابعة خاصة به", () => {
  const files = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".js") || f.endsWith(".html"));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const m = src.match(/\b(?:const|let|var)\s+SOON\w*\s*=\s*\d+/g);
    if (m && f !== "doc-status.js") offenders.push(`${f} → ${m.join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "عتبة ثانية تعني أن يخالف الرقمُ القائمةَ يومًا ما:\n  " + offenders.join("\n  ")
  );
});

test("عتبة «الحالة الآن» في التقارير تساوي عتبة اللوحة", () => {
  const { SOON_DAYS } = require("../lib/reports/reportData.js");
  assert.equal(SOON_DAYS, SOON, "التقرير لا يجوز أن يذكر نافذة متابعة تخالف ما تعرضه اللوحة");
});

test("فئات التخطيط 30/60/90 في التقارير لم تُمسّ", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/reports/reportData.js"), "utf8");
  assert.match(src, /const BANDS = \[30, 60, 90\]/, "الاستحقاقات القادمة أداة تخطيط ربعية، لا قائمة متابعة");
});

test("سلّم التنبيهات 5/2/0 وما بعد الانتهاء لم يُمسّ", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/notifications/scan.js"), "utf8");
  assert.match(src, /const UPCOMING_TRIGGER_DAYS = \[5, 2, 0\]/);
  assert.match(src, /if \(remaining < 0\) return "overdue";/);
});
