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

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    /* كتم الصدى: _writeToOutput يُستبدل فلا يُطبع المدخل ولا نجوم بعدده. */
    const onWrite = rl._writeToOutput;
    rl._writeToOutput = function (s) {
      if (s.includes(prompt)) onWrite.call(rl, s);
    };
    rl.question(prompt, (answer) => {
      rl._writeToOutput = onWrite;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const wantPepper = process.argv.includes("--pepper");
  if (wantPepper) {
    console.log("DROUA_AUDIT_GATE_PEPPER=" + crypto.randomBytes(32).toString("hex"));
    console.log("DROUA_GATE_SECRET=" + crypto.randomBytes(32).toString("hex"));
    console.log("\n⚠️ الفلفل جزء من التحقّق: فقدانه أو تغييره يُبطل الهاش القائم");
    console.log("   ولو كانت كلمة المرور صحيحة. احفظه كما تحفظ كلمة المرور.\n");
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
}

if (require.main === module) {
  main().catch((err) => {
    console.error("فشل التوليد:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { PRODUCTION_PARAMS, MIN_LENGTH };
