#!/usr/bin/env node
/* فحصٌ للقراءة فقط: هل جداول الوحدة وفهارسها كما تتوقّعها الشيفرة؟
   =========================================================================
   يُشغَّل بعد setup-medins-gate.js و setup-medins-core.js. لا يكتب شيئًا.
   القائمة المتوقَّعة تُستخرج من نصّ سكربتَي التهيئة نفسيهما — فلا تنحرف. */

const gate = require("./setup-medins-gate");
const core = require("./setup-medins-core");

function expected() {
  const all = [...gate.STATEMENTS, ...core.STATEMENTS].map((s) => s.sql).join("\n");
  const tables = [...all.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const indexes = [...all.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  return { tables, indexes };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ.");
    process.exitCode = 1;
    return;
  }
  const sql = require("../lib/db").getSql();
  const want = expected();
  const tables = (await sql`SELECT tablename FROM pg_tables WHERE tablename LIKE 'medins\\_%'`).map((r) => r.tablename);
  const indexes = (await sql`SELECT indexname FROM pg_indexes WHERE tablename LIKE 'medins\\_%'`).map((r) => r.indexname);
  const missingT = want.tables.filter((t) => !tables.includes(t));
  const missingI = want.indexes.filter((i) => !indexes.includes(i));
  console.log(`الجداول: ${want.tables.length - missingT.length}/${want.tables.length}`);
  console.log(`الفهارس المسمّاة: ${want.indexes.length - missingI.length}/${want.indexes.length}`);
  for (const t of missingT) console.log(`  ✗ جدول ناقص: ${t}`);
  for (const i of missingI) console.log(`  ✗ فهرس ناقص: ${i}`);
  if (missingT.length || missingI.length) process.exitCode = 1;
  else console.log("✓ المخطّط مطابق.");
}

if (require.main === module) {
  main().catch((err) => { console.error("فشل الفحص:", (err && err.message) || err); process.exitCode = 1; });
}

module.exports = { expected };
