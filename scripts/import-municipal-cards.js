#!/usr/bin/env node
/* استيراد البطاقات البلدية (الشهادات الصحية) إلى متجرها الخاصّ.
   =========================================================================
   ⛔ للمعاينة (Preview) وحدها حتى يُعتمد الإنتاج. لا يكتب في القاعدة أبدًا:
   القاعدة تُقرأ (SELECT) للمطابقة فقط.

   لكل ملفّ PDF:
     ① الاستخراج (lib/municipal/extractCard.js): رقم الشهادة، مكان الإصدار،
        الانتهاء، رقم الهوية، الاسم المطبوع، المهنة، ونصّ رمز QR.
     ② المطابقة (lib/municipal/match.js): رقم الهوية = رقم الإقامة في سجلّ
        الموظف حرفيًا → employee_eid. ambiguous وunmatched لا يُرفعان.
     ③ وجه الشهادة الأصلي مرسومًا من الملفّ، وصورة الرمز الأصلية من الملفّ
        (lib/municipal/render.js). الرمز المخزَّن يجب أن يُقرأ إلى النصّ نفسه.
   ثم مع --apply: رفع خاصّ (OIDC)، وفحص أن الكائن لا يُقدَّم بلا مصادقة،
   وقراءة راجعة بالبصمة، ثم كتابة الفهرس آخرًا.

   لا يطبع رابط رمز ولا رمزًا سرّيًا ولا مسار تخزين. رقم الهوية مقنَّع.

   المعاينة (لا كتابة):
     vercel env run -e development -- node scripts/import-municipal-cards.js "<المجلّد>"
   تأكيد يدوي لحالة ambiguous (بعد مراجعتك):
     … --assign 31319-1448=503
   حفظ صور المراجعة محليًا (خارج المستودع):
     … --preview-dir "<مجلّد>"
   الرفع:
     vercel env run -e development -- node scripts/import-municipal-cards.js "<المجلّد>" --apply

   الرجوع: scripts/import-municipal-cards.js --remove-all (يحذف كائنات
   البطاقات والفهرس من المتجر)، أو حذف المتجر كله من Vercel. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { extractMunicipalCard } = require("../lib/municipal/extractCard");
const { matchCards } = require("../lib/municipal/match");

const UPLOAD_ENVS = ["development", "preview"];
const mask = (id) => (id ? `••••••${String(id).slice(-4)}` : "—");
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

function parseArgs(argv) {
  const out = { dir: null, apply: false, removeAll: false, assign: {}, previewDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--remove-all") out.removeAll = true;
    else if (a === "--assign") {
      const m = String(argv[++i] || "").match(/^(\d{3,}-\d{4})=(\d+)$/);
      if (!m) throw new Error("--assign بالصيغة <رقم الشهادة>=<eid>");
      out.assign[m[1]] = m[2];
    } else if (a === "--preview-dir") out.previewDir = argv[++i];
    else if (!a.startsWith("--")) out.dir = a;
  }
  return out;
}

/* الاستخراج بلا أي نداء شبكة — يُختبر كما هو. */
function readCards(files) {
  const rows = files.map(({ name, bytes }, i) => {
    const label = `file_${String(i + 1).padStart(2, "0")}`;
    const r = extractMunicipalCard(bytes);
    return { label, name, bytes, sourceFileHash: sha256hex(bytes), ok: r.ok, reason: r.reason || null, card: r.card || {} };
  });
  /* الملفّ نفسه مرّتين، أو شهادتان للهوية نفسها: الأبعد انتهاءً يُعتمد. */
  const seenHash = new Set();
  const best = new Map();
  for (const r of rows) {
    if (!r.ok) continue;
    if (seenHash.has(r.sourceFileHash)) { r.ok = false; r.reason = "duplicate_file"; continue; }
    seenHash.add(r.sourceFileHash);
    const prev = best.get(r.card.idNumber);
    if (!prev || String(r.card.expiryDate || "") > String(prev.card.expiryDate || "")) best.set(r.card.idNumber, r);
  }
  for (const r of rows) if (r.ok && best.get(r.card.idNumber) !== r) { r.ok = false; r.reason = "superseded_by_newer_certificate"; }
  return rows;
}

async function loadEmployees() {
  if (!process.env.DATABASE_URL) return null;
  const { getSql } = require("../lib/db");
  const sql = getSql();
  /* قراءة فقط. */
  return sql`SELECT eid, iqama, data->>'اسم العامل' AS name FROM employees`;
}

function oidcClaims(token) {
  try {
    const seg = String(token).split(".")[1] || "";
    return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch (err) {
    return null;
  }
}

async function checkCredentials() {
  const store = require("../lib/municipal/store");
  const out = { ok: false, oidcToken: null };
  const token = String(process.env.VERCEL_OIDC_TOKEN || "").trim();
  console.log("\ncredentials:");
  console.log(`  ${store.ENV_STORE_ID} present: ${store.configured()}`);
  console.log(`  VERCEL_OIDC_TOKEN present: ${!!token}`);
  console.log(`  DATABASE_URL present (read-only use): ${!!process.env.DATABASE_URL}`);
  if (!store.configured() || !token) return out;
  const claims = oidcClaims(token);
  const env = claims && claims.environment;
  const expMin = claims && claims.exp ? Math.round((claims.exp * 1000 - Date.now()) / 60000) : null;
  console.log(`  token environment: ${env || "unknown"}`);
  console.log(`  token expires in (min): ${expMin == null ? "unknown" : expMin}`);
  if (!UPLOAD_ENVS.includes(env)) { console.log("  ⛔ بيئة الرمز غير مسموحة (development أو preview فقط)"); return out; }
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

async function renderAll(items, previewDir) {
  const { renderCardFace, originalQrPng, decodeFromRgba } = require("../lib/municipal/render");
  for (const it of items) {
    const face = await renderCardFace(it.row.bytes);
    const qr = originalQrPng(it.row.bytes);
    it.face = face.png;
    const same = qr && qr.pixelsIdentical && qr.roundTrip === it.row.card.qrText;
    it.qr = same ? qr.png : null;
    it.qrCheck = !qr ? "no_qr" : same ? "same_official_url+original_pixels" : "MISMATCH";
    it.faceQrCheck = decodeFromRgba(face.rgba, face.width, face.height) === it.row.card.qrText ? "same_official_url" : "too_dense_at_card_size (modal shows the original QR)";
    if (previewDir) {
      fs.mkdirSync(previewDir, { recursive: true });
      fs.writeFileSync(path.join(previewDir, `${it.row.card.certNo}-card.png`), it.face);
      if (it.qr) fs.writeFileSync(path.join(previewDir, `${it.row.card.certNo}-qr.png`), it.qr);
    }
  }
}

async function apply(items, oidcToken) {
  const store = require("../lib/municipal/store");
  const index = await store.readIndex(oidcToken, { fresh: true });
  const now = new Date().toISOString();
  const stale = [];
  for (const it of items) {
    const c = it.row.card;
    const previous = index.cards.find((e) => e.employeeEid === it.eid || e.certificateNumber === c.certNo);
    const entry = {
      cardId: previous ? previous.cardId : store.newCardId(),
      employeeEid: it.eid,
      certificateNumber: c.certNo,
      issuePlace: c.issuer || null,
      expiryDate: c.expiryDate || null,
      expiryHijri: c.expiryHijri || null,
      nameOnCard: c.name || null,
      occupation: c.occupation || null,
      cardKey: store.newObjectKey("card"),
      cardSha256: sha256hex(it.face),
      qrKey: it.qr ? store.newObjectKey("qr") : null,
      qrSha256: it.qr ? sha256hex(it.qr) : null,
      qrTarget: it.qr ? c.qrText : null,
      sourceFileHash: it.row.sourceFileHash,
      createdAt: previous ? previous.createdAt : now,
      updatedAt: now,
    };
    const uploads = [[entry.cardKey, it.face]].concat(it.qr ? [[entry.qrKey, it.qr]] : []);
    for (const [key, bytes] of uploads) {
      const result = await store.putObject(key, bytes, oidcToken);
      /* الفحص الحاسم: الرابط بلا مصادقة يجب ألّا يُقدّم شيئًا. */
      const r = await fetch(result.url).catch(() => null);
      if (r && r.ok) throw new Error("⚠️ الكائن يُقدَّم بلا مصادقة — المتجر ليس خاصًّا. أوقف وراجع إعداد المتجر.");
    }
    const valid = store.validEntry(entry);
    if (!valid || !(await store.readObject(valid, "card", oidcToken))) throw new Error(`${c.certNo}: تعذّرت القراءة الراجعة`);
    if (valid.qrKey && !(await store.readObject(valid, "qr", oidcToken))) throw new Error(`${c.certNo}: تعذّرت قراءة الرمز الراجعة`);
    if (previous) {
      stale.push(previous.cardKey, previous.qrKey);
      index.cards = index.cards.filter((e) => e !== previous);
    }
    index.cards.push(entry);
    console.log(`  ✅ ${it.row.label} ${c.certNo} → eid ${it.eid} (خاصّ ومُتحقَّق)`);
  }
  await store.writeIndex(index, oidcToken);
  await store.deleteObjects(stale.filter(Boolean), oidcToken);
  console.log(`\nالفهرس: ${index.cards.length} بطاقة.`);
}

async function removeAll(oidcToken) {
  const store = require("../lib/municipal/store");
  const index = await store.readIndex(oidcToken, { fresh: true });
  await store.writeIndex({ version: 1, cards: [] }, oidcToken);
  await store.deleteObjects(index.cards.flatMap((e) => [e.cardKey, e.qrKey]).filter(Boolean), oidcToken);
  console.log(`حُذفت ${index.cards.length} بطاقة من المتجر، والفهرس فارغ.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.removeAll) {
    const cred = await checkCredentials();
    if (!cred.ok) { process.exitCode = 1; return; }
    return removeAll(cred.oidcToken);
  }
  if (!args.dir || !fs.existsSync(args.dir)) {
    console.error('الاستعمال: node scripts/import-municipal-cards.js "<المجلّد>" [--assign <شهادة>=<eid>] [--preview-dir <مجلّد>] [--apply]');
    process.exitCode = 1;
    return;
  }
  const files = fs.readdirSync(args.dir).filter((f) => /\.pdf$/i.test(f)).sort()
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(args.dir, name)) }));
  const rows = readCards(files);
  const usable = rows.filter((r) => r.ok);

  const employees = await loadEmployees();
  if (!employees) console.log("\n⚠️ DATABASE_URL غير متاح: المطابقة تحتاج قراءة سجلّ الموظفين (SELECT فقط).");
  const { items, summary } = matchCards(usable.map((r) => r.card), employees || [], args.assign);
  items.forEach((it, i) => { it.row = usable[i]; });

  console.log(`\ntotal files: ${rows.length}`);
  console.log(`matched: ${employees ? summary.matched : "—"}`);
  console.log(`ambiguous: ${employees ? summary.ambiguous : "—"}`);
  console.log(`unmatched: ${employees ? summary.unmatched : "—"}`);
  console.log(`rejected (not a card / duplicate / superseded): ${rows.length - usable.length}\n`);
  rows.filter((r) => !r.ok).forEach((r) => console.log(`${r.label} -> rejected (${r.reason})`));
  items.forEach((it) => {
    const c = it.card;
    const who = it.employee ? ` · platform name: ${it.employee.name || "—"}` : "";
    const cands = it.status === "ambiguous" ? ` · candidates eid: ${it.candidates.map((e) => e.eid).join(", ")}` : "";
    console.log(`${it.row.label} -> ${employees ? it.status : "pending_match"}${it.eid ? ` (eid ${it.eid}, via ${it.via})` : ""} · ${c.certNo} · id ${mask(c.idNumber)} · name on card: ${c.name || "—"}${who}${cands} · expires ${c.expiryDate || "—"}`);
  });

  await renderAll(items, args.previewDir);
  console.log("\nQR check (stored original QR → decoded text vs. text read from the PDF):");
  items.forEach((it) => console.log(`  ${it.row.label} ${it.card.certNo}: original_qr=${it.qrCheck} · card_face_qr=${it.faceQrCheck}`));

  const cred = await checkCredentials();
  if (!args.apply) { console.log("\nمعاينة فقط — لم يُكتب شيء. أضف --apply للرفع.\n"); return; }
  if (!employees) { console.error("\n⛔ لا رفع: المطابقة لم تتمّ (DATABASE_URL)."); process.exitCode = 1; return; }
  if (!cred.ok) { console.error("\n⛔ لا رفع: بيانات الاعتماد غير جاهزة."); process.exitCode = 1; return; }
  const ready = items.filter((it) => it.status === "matched" && it.qrCheck !== "MISMATCH");
  const held = items.length - ready.length;
  if (held) console.log(`\n${held} بطاقة لن تُرفع (ambiguous / unmatched / رمز غير مطابق) حتى تُراجَع.`);
  await apply(ready, cred.oidcToken);
}

if (require.main === module) {
  main().catch((err) => { console.error("فشل:", (err && err.message) || err); process.exitCode = 1; });
}

module.exports = { readCards, parseArgs, mask };
