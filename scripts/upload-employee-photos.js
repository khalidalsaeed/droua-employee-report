#!/usr/bin/env node
/* رفع صور الموظفين المعتمدة إلى متجرها الخاصّ — مرّة واحدة.
   =========================================================================
   ⛔ للمعاينة (Preview) وحدها حتى يُعتمد الإنتاج: التوكن المستعمل هو توكن
   متجر الصور المربوط ببيئة Preview فقط.

   المدخل مجلّد الصور المعالَجة، كل ملفّ باسم «صورة <اسم الموظف>.jpg».
   لكل ملفّ:
     ① المطابقة من اسم الملفّ وحده (lib/photos/match.js) — matched فقط يُرفع.
     ② الفحص من البايتات (lib/photos/validate.js): التوقيع، النوع الحقيقي،
        الامتداد، الحجم، الأبعاد، الاكتمال.
     ③ كشف التكرار بالبصمة.
     ④ البصمة يجب أن تطابق مدخل الـmanifest للموظف نفسه — يُرفع بالضبط ما
        اعتُمد، لا نسخة أخرى.
   ثم بعد الرفع: فحص حاسم أن الكائن **لا** يُقدَّم بلا مصادقة.

   لا يطبع توكنًا ولا رابط تخزين ولا اسم ملفّ داخل المتجر.

   المعاينة (لا كتابة):  node scripts/upload-employee-photos.js "<المجلّد>"
   الرفع:               node scripts/upload-employee-photos.js "<المجلّد>" --apply

   التوكن من البيئة EMPLOYEE_PHOTOS_READ_WRITE_TOKEN — على PowerShell:
     $s = Read-Host -AsSecureString
     $env:EMPLOYEE_PHOTOS_READ_WRITE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
       [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))

   الرجوع: حذف المتجر كله من Vercel (Storage ← المتجر ← Delete) — لا شيء
   آخر يُكتب في أي مكان. */

const fs = require("fs");
const path = require("path");
const { matchFile } = require("../lib/photos/match");
const { inspectPhoto, findDuplicates } = require("../lib/photos/validate");
const { ROWS } = require("../lib/org/source");
const manifest = require("../lib/photos/manifest");

/* الخطة بلا أي نداء شبكة — تُختبر كما هي. */
function plan(files) {
  const items = files.map(({ name, bytes }, i) => {
    const label = `image_${String(i + 1).padStart(2, "0")}`;
    const m = matchFile(name, ROWS);
    const item = { label, status: m.status, via: m.via || null, entry: null, error: null, bytes };
    if (m.status !== "matched") return item;
    try {
      item.info = inspectPhoto(bytes, { fileName: name });
    } catch (err) {
      item.status = "invalid";
      item.error = err.message;
      return item;
    }
    const email = String(m.row.email || "").toLowerCase();
    item.entry = manifest.find((e) => e.match.email === email) || null;
    if (!item.entry) { item.status = "not_in_manifest"; return item; }
    if (item.entry.sha256 !== item.info.sha256) { item.status = "hash_mismatch"; item.entry = null; }
    return item;
  });

  findDuplicates(items.filter((it) => it.info).map((it) => it.info)).forEach(([, b]) => {
    const dup = items.filter((it) => it.info)[b];
    dup.status = "duplicate";
    dup.entry = null;
  });
  /* صورتان لموظف واحد: الثانية مرفوضة — لا «آخر واحدة تفوز». */
  const owners = new Set();
  items.forEach((it) => {
    if (!it.entry) return;
    if (owners.has(it.entry.photoId)) { it.status = "duplicate_target"; it.entry = null; return; }
    owners.add(it.entry.photoId);
  });

  const count = (s) => items.filter((it) => it.status === s).length;
  return {
    items,
    summary: {
      total: items.length,
      matched: count("matched"),
      ambiguous: count("ambiguous"),
      unmatched: count("unmatched"),
      rejected: items.length - count("matched") - count("ambiguous") - count("unmatched"),
    },
  };
}

function readFolder(dir) {
  return fs.readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!dir) {
    console.error('الاستعمال: node scripts/upload-employee-photos.js "<المجلّد>" [--apply]');
    process.exitCode = 1;
    return;
  }

  const { items, summary } = plan(readFolder(dir));
  console.log(`\ntotal images: ${summary.total}\nmatched: ${summary.matched}\nambiguous: ${summary.ambiguous}\nunmatched: ${summary.unmatched}\nrejected: ${summary.rejected}\n`);
  items.forEach((it) => console.log(`${it.label} -> ${it.status}${it.error ? ` (${it.error})` : ""}`));

  if (!apply) { console.log("\nمعاينة فقط — لم يُكتب شيء. أضف --apply للرفع.\n"); return; }
  if (summary.matched !== summary.total) {
    console.error("\n⛔ لا رفع: كل الصور يجب أن تكون matched وسليمة.\n");
    process.exitCode = 1;
    return;
  }

  const store = require("../lib/photos/store");
  let failed = 0;
  for (const it of items) {
    try {
      const result = await store.putPhoto(it.entry, it.bytes);
      /* الفحص الحاسم: الرابط بلا مصادقة يجب ألّا يُقدّم الصورة. */
      const r = await fetch(result.url).catch(() => null);
      if (r && r.ok) throw new Error("⚠️ الكائن يُقدَّم بلا مصادقة — المتجر ليس خاصًّا");
      const back = await store.readPhoto(it.entry);
      if (!back) throw new Error("تعذّرت القراءة بعد الرفع");
      console.log(`  ✅ ${it.label} مرفوع وخاصّ ومُتحقَّق`);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${it.label}: ${err.message}`);
    }
  }
  console.log(`\nالنتيجة: ${items.length - failed}/${items.length}\n`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error("فشل:", (err && err.message) || err);
    process.exitCode = 1;
  });
}

module.exports = { plan };
