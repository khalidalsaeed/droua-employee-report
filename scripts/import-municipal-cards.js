#!/usr/bin/env node
/* استيراد ملفّات البطاقات البلدية (PDF) دفعةً واحدة.
   =========================================================================
   البديل السطري لزرّ «إضافة بطاقة» في الواجهة، بالمستخرِج نفسه
   (lib/municipal/extractCard.js) والكتابة نفسها (upsertExtracted).

   الملفّات لا تدخل المستودع ولا أي متجر: تُقرأ من مجلّد محلّي ثم تُترك.

   المعاينة (افتراضية، بلا قاعدة):
     node scripts/import-municipal-cards.js "<المجلّد>"
   الكتابة:
     vercel env run -e preview -- node scripts/import-municipal-cards.js "<المجلّد>" --apply

   المعاينة تطبع آخر 4 أرقام من الهوية فقط، ولا تطبع رابط الرمز. */
const fs = require("fs");
const path = require("path");
const { extractMunicipalCard } = require("../lib/municipal/extractCard");

const mask = (id) => (id ? `••••••${String(id).slice(-4)}` : "—");

function plan(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).sort();
  const rows = files.map((file) => {
    const r = extractMunicipalCard(fs.readFileSync(path.join(dir, file)));
    return { file, ok: r.ok, reason: r.reason || null, card: r.card || {} };
  });
  const byId = new Map();
  for (const row of rows.filter((r) => r.ok)) {
    const prev = byId.get(row.card.idNumber);
    /* الهوية نفسها في ملفّين: الأبعد انتهاءً يفوز (شهادة مجدَّدة). */
    if (!prev || String(row.card.expiryDate || "") > String(prev.card.expiryDate || "")) byId.set(row.card.idNumber, row);
  }
  for (const row of rows) row.superseded = row.ok && byId.get(row.card.idNumber) !== row;
  return rows;
}

async function main() {
  const dir = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!dir || !fs.existsSync(dir)) {
    console.error("الاستعمال: node scripts/import-municipal-cards.js <مجلّد الملفّات> [--apply]");
    process.exitCode = 1;
    return;
  }
  const rows = plan(dir);
  for (const r of rows) {
    const c = r.card;
    const fields = ["name", "expiryDate", "nationality", "occupation"].filter((k) => c[k]).length;
    console.log(r.ok ? (r.superseded ? "↷" : "✔") : "✖", r.file, r.ok
      ? `${c.certNo} · هوية ${mask(c.idNumber)} · ينتهي ${c.expiryDate || "—"} · QR ${c.qrText ? "نعم" : "لا"} · صورة ${c.photo ? "نعم" : "لا"} · حقول ${fields}/4${r.superseded ? " · أقدم من ملفّ آخر للهوية نفسها" : ""}`
      : r.reason);
  }
  const todo = rows.filter((r) => r.ok && !r.superseded);
  console.log(`\n${todo.length} بطاقة جاهزة من ${rows.length} ملفّ.`);
  if (!apply) { console.log("معاينة فقط — أضف --apply للكتابة."); return; }

  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL غير مُهيّأ."); process.exitCode = 1; return; }
  const cards = require("../lib/data/municipalCards");
  const actor = { email: "import-script" };
  for (const r of todo) {
    const { replaced } = await cards.upsertExtracted(r.card, actor);
    console.log("⇡", r.card.certNo, replaced && replaced !== r.card.certNo ? `(استبدل ${replaced})` : "");
  }
}

if (require.main === module) {
  main().catch((err) => { console.error("فشل الاستيراد:", (err && err.message) || err); process.exitCode = 1; });
}

module.exports = { plan, mask };
