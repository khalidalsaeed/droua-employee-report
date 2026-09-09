#!/usr/bin/env node
/* توليد هاش كلمة مرور البوابة — محلّيًا، وبلا أن تغادر كلمة المرور الجهاز.
   =========================================================================
   يقرأ من stdin **بلا echo**: لا تظهر على الشاشة، ولا تدخل تاريخ الصدفة،
   ولا تظهر في قائمة العمليات. ويطلبها مرّتين فخطأٌ مطبعيّ لا يصير كلمة
   مرور لا تعرفها.

   يطبع سطرًا واحدًا لا غير — يُلصق في متغيّر البيئة
   DROUA_AUDIT_GATE_PASSWORD_HASH بخاصّية Sensitive.

   ⛔ لا شبكة · لا قاعدة بيانات · لا كتابة ملفّ · ولا تصل الكلمة إلى أحد.

   التشغيل:  node scripts/hash-gate-password.js
             node scripts/hash-gate-password.js --pepper   (يولّد فلفلًا أيضًا) */

const crypto = require("crypto");
const readline = require("readline");
const { derive } = require("../lib/droua/gatePassword");

/* معاملات الإنتاج. N = 2^17 أقوى من 2^14 المستعملة في كلمات مرور المنصّة:
   ≈300ms للمحاولة الواحدة — مقبولٌ لعمليةٍ تقع مرّة في اليوم، ومكلفٌ جدًا
   للتخمين الآلي. */
const PRODUCTION_PARAMS = { logN: 17, r: 8, p: 1 };
const MIN_LENGTH = 12;

/* المطالبات على stderr لا stdout.

   السبب أن stdout مخصَّص لمخرَجٍ واحد: سطر الهاش. لو شاركته المطالباتُ
   ورموزُ الطرفية التي يكتبها readline، لخرج من `... > hash.txt` سطرٌ
   مشوَّه لا يلاحظه أحد — ثم ترفض البوابة كلمة المرور الصحيحة، وهو أكثر
   أعراض الفشل إرباكًا لأنه يوجّه الشكّ إلى الكلمة لا إلى الملفّ.

   وبهذا الفصل يصير السكربت قابلًا للتوجيه والأنبوب بأمان على أي صدفة. */
function askHidden(prompt) {
  /* مدخلٌ غير تفاعليّ (أنبوب، أو طرفية لا تُقدَّم كـTTY في بعض المحرّرات):
     readline بوضع terminal لا تصل نداءاته أصلًا، فكان السكربت يطبع
     المطالبتين ثم يخرج **برمز 0 بلا هاش** — نجاحٌ ظاهريّ بلا مخرَج، وهو
     أسوأ فشل ممكن هنا لأنه لا يُنبّه أحدًا. فالمسار مفصول: قراءة أسطر
     عادية خارج الطرفية، وقراءة مكتومة داخلها، وفشلٌ صريح في الحالتين. */
  if (!process.stdin.isTTY) {
    process.stderr.write(prompt + "\n");
    return pipedInput().next();
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let answered = false;
    /* كتم الصدى: _writeToOutput يُستبدل فلا يُطبع المدخل ولا نجوم بعدده. */
    const onWrite = rl._writeToOutput;
    rl._writeToOutput = function (str) {
      if (str.includes(prompt)) onWrite.call(rl, str);
    };
    /* إغلاقٌ قبل الإجابة (Ctrl+C أو نهاية مدخل) يجب أن يُفشل صراحةً لا أن
       يترك الوعد معلّقًا فيخرج Node بصمت. */
    rl.on("close", () => {
      if (!answered) reject(new Error("انتهى المدخل قبل اكتمال الإجابة"));
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl._writeToOutput = onWrite;
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

/* قارئ أسطر واحد لكامل الجلسة غير التفاعلية. */
let pipedReader = null;
function pipedInput() {
  if (pipedReader) return pipedReader;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const queued = [];
  const waiting = [];
  let ended = false;
  const fail = () => new Error("انتهى المدخل قبل اكتمال الإجابات");
  rl.on("line", (line) => {
    if (waiting.length) waiting.shift().resolve(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiting.length) waiting.shift().reject(fail());
  });
  pipedReader = {
    next: () =>
      new Promise((resolve, reject) => {
        if (queued.length) return resolve(queued.shift());
        if (ended) return reject(fail());
        waiting.push({ resolve, reject });
      }),
    close: () => rl.close(),
  };
  return pipedReader;
}

async function main() {
  const wantPepper = process.argv.includes("--pepper");
  if (wantPepper) {
    /* stdout عمدًا: هذه قيمٌ تُنسخ، وقد يُوجَّه المخرَج إلى مدير أسرار.
       ويخرج السكربت بعدها بلا توليد هاش، فلا يختلط المخرَجان أبدًا. */
    process.stdout.write("DROUA_AUDIT_GATE_PEPPER=" + crypto.randomBytes(32).toString("hex") + "\n");
    process.stdout.write("DROUA_GATE_SECRET=" + crypto.randomBytes(32).toString("hex") + "\n");
    console.error("\n⚠️ الفلفل جزء من التحقّق: فقدانه أو تغييره يُبطل الهاش القائم");
    console.error("   ولو كانت كلمة المرور صحيحة. احفظه كما تحفظ كلمة المرور.");
    console.error("   والسرّان قيمتان مختلفتان — لا تخلط بينهما.\n");
    return; // لا يولّد هاشًا في النداء نفسه: مخرَجان مختلفان لا يجتمعان
  }

  const pepper = process.env.DROUA_AUDIT_GATE_PEPPER || "";
  if (!pepper) {
    console.error("⚠️ DROUA_AUDIT_GATE_PEPPER غير مضبوط في هذه الصدفة — سيُشتقّ الهاش بلا فلفل.");
    console.error("   صدّره أوّلًا ليطابق ما ستضعه في Vercel، وإلّا فشل التحقّق على الخادم.\n");
  }

  const first = await askHidden("كلمة مرور البوابة: ");
  if (first.length < MIN_LENGTH) {
    console.error(`كلمة المرور يجب ألّا تقلّ عن ${MIN_LENGTH} محرفًا.`);
    process.exitCode = 1;
    return;
  }
  const second = await askHidden("أعد إدخالها: ");
  if (first !== second) {
    console.error("الكلمتان غير متطابقتين. لم يُولَّد شيء.");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(derive(first, { ...PRODUCTION_PARAMS, pepper }) + "\n");
  if (pipedReader) pipedReader.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("فشل التوليد:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { PRODUCTION_PARAMS, MIN_LENGTH };
