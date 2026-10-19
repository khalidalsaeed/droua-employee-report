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

   لا يطبع رمزًا ولا رابط تخزين ولا اسم ملفّ داخل المتجر.

   المصادقة OIDC وحدها (lib/photos/store.js) — لا توكن قراءة/كتابة دائم.
   يُشغَّل عبر Vercel CLI الذي يحقن متغيّرات البيئة في العملية وحدها بلا
   كتابة ملفّ: EMPLOYEE_PHOTOS_STORE_ID ورمز VERCEL_OIDC_TOKEN قصير العمر.

   الـCLI لا يصدر محليًا إلا رمز OIDC لبيئة development (vercel project
   token: "Get a development OIDC token"). فالرفع المحلي يحتاج أن يكون المتجر
   مربوطًا ببيئة Development أيضًا — ويُفكّ ربطها بعد الرفع إن شئت.

   المعاينة (لا كتابة):
     vercel env run -e development -- node scripts/upload-employee-photos.js "<المجلّد>"
   تفحص الملفّات، ثم — إن وُجدت بيانات الاعتماد — بيئة الرمز وصلاحيته
   بقراءة واحدة (list) لا تكتب شيئًا.
   الرفع:
     vercel env run -e development -- node scripts/upload-employee-photos.js "<المجلّد>" --apply
   يُرفض الرفع برمز production أو مجهول البيئة.

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

const UPLOAD_ENVS = ["development", "preview"];

/* حمولة رمز OIDC (JWT) — للبيئة والانتهاء فقط. الحمولة ليست سرًّا؛ الرمز
   نفسه لا يُطبع أبدًا. */
function oidcClaims(token) {
  try {
    const seg = String(token).split(".")[1] || "";
    return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch (err) {
    return null;
  }
}

/* يطبع حالة بيانات الاعتماد بلا أي قيمة سرّية، ويجرّب قراءة واحدة لا تكتب.
   الرفع مسموح برمز development أو preview فقط — لا production أبدًا. */
async function checkCredentials() {
  const store = require("../lib/photos/store");
  const out = { ok: false, oidcToken: null };
  const hasStore = store.configured();
  const token = String(process.env.VERCEL_OIDC_TOKEN || "").trim();
  console.log("\ncredentials:");
  console.log(`  ${store.ENV_STORE_ID} present: ${hasStore}`);
  console.log(`  VERCEL_OIDC_TOKEN present: ${!!token}`);
  if (!hasStore || !token) return out;
  const claims = oidcClaims(token);
  const env = claims && claims.environment;
  const expMin = claims && claims.exp ? Math.round((claims.exp * 1000 - Date.now()) / 60000) : null;
  console.log(`  token environment: ${env || "unknown"}`);
  console.log(`  token expires in (min): ${expMin == null ? "unknown" : expMin}`);
  if (!UPLOAD_ENVS.includes(env)) { console.log("  ⛔ بيئة الرمز غير مسموحة للرفع (development أو preview فقط)"); return out; }
  if (expMin != null && expMin < 5) { console.log("  ⛔ الرمز ينتهي قريبًا — أعد التشغيل"); return out; }
  try {
    const { list } = require("@vercel/blob");
    const r = await list({ limit: 1, ...store.credentials(token) });
    console.log(`  read check: OK (store objects: ${r.blobs.length}${r.hasMore ? "+" : ""})`);
  } catch (err) {
    console.log(`  read check: FAILED — ${err.message}`);
    return out;
  }
  out.ok = true;
  out.oidcToken = token;
  return out;
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

  const cred = await checkCredentials();
  if (!apply) { console.log("\nمعاينة فقط — لم يُكتب شيء. أضف --apply للرفع.\n"); return; }
  if (!cred.ok) {
    console.error("\n⛔ لا رفع: بيانات الاعتماد غير جاهزة (انظر credentials أعلاه).\n");
    process.exitCode = 1;
    return;
  }
  if (summary.matched !== summary.total) {
    console.error("\n⛔ لا رفع: كل الصور يجب أن تكون matched وسليمة.\n");
    process.exitCode = 1;
    return;
  }

  const store = require("../lib/photos/store");
  let failed = 0;
  for (const it of items) {
    try {
      const result = await store.putPhoto(it.entry, it.bytes, cred.oidcToken);
      /* الفحص الحاسم: الرابط بلا مصادقة يجب ألّا يُقدّم الصورة. */
      const r = await fetch(result.url).catch(() => null);
      if (r && r.ok) throw new Error("⚠️ الكائن يُقدَّم بلا مصادقة — المتجر ليس خاصًّا");
      const back = await store.readPhoto(it.entry, cred.oidcToken);
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

module.exports = { plan, checkCredentials };
