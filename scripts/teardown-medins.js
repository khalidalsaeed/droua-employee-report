#!/usr/bin/env node
/* ─── التراجع الكامل لقاعدة وحدة /secure-benefits ───────────────────────
   =========================================================================
   ⚠️ **يتلف بيانات الوحدة كلّها بلا استرجاع** (العروض، والقيم، وصفوف الملفّات،
   والأعضاء، والتدقيق). لا يُشغَّل إلا بأمرٍ صريح من صاحب القرار.

   • بلا وسائط: يطبع ما سيُنفَّذ ولا يتّصل بالقاعدة.
   • التنفيذ يتطلّب العلامة الطويلة حرفيًا: --confirm-drop-all-medins-data
   • لا يمسّ إلا جداول medins_* — مسمّاةً واحدًا واحدًا، لا بنمط.
   • لا يحذف كائنات المتجر الخاصّ: المتجر مستقلّ ويُحذف من لوحة Vercel إن
     أُريد. وبلا صفوف القاعدة فالكائنات مشفَّرة بلا مرجع.

   التراجع الأخفّ أوّلًا (انظر docs/medical-insurance/03-production-runbook.md):
   إخفاء الوحدة بحذف MEDINS_GATE_SECRET، أو git revert لسطر التفويض —
   وكلاهما يُبقي البيانات. */

const { run } = require("./lib/medins-migrate");

/* بترتيب الاعتماد: الأبناء قبل الآباء. بلا CASCADE: إن وُجد اعتمادٌ لم
   نتوقّعه فالأسلم أن يفشل الحذف لا أن يمتدّ. */
const TABLES = Object.freeze([
  "medins_class_benefits",
  "medins_offer_terms",
  "medins_file_parts",
  "medins_files",
  "medins_offer_classes",
  "medins_offers",
  "medins_insurers",
  "medins_benefit_catalog",
  "medins_company_locations",
  "medins_gate_sessions",
  "medins_gate_attempts",
  "medins_members",
  "medins_audit",
]);

const STATEMENTS = TABLES.map((t) => ({ label: `حذف ${t}`, sql: `DROP TABLE IF EXISTS ${t}` }));
const CONFIRM = "--confirm-drop-all-medins-data";

async function main() {
  if (!process.argv.includes(CONFIRM)) {
    console.log("— معاينة فقط، بلا اتّصال —\n");
    for (const s of STATEMENTS) console.log(`${s.sql};`);
    console.log(`\nللتنفيذ (يتلف البيانات): ${CONFIRM}`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  await run(getSql(), STATEMENTS, { onProgress: (s) => console.log(`${s.label} ... تم`) });
}

if (require.main === module) {
  main().catch((err) => { console.error("فشل:", (err && err.message) || err); process.exitCode = 1; });
}

module.exports = { STATEMENTS, TABLES, CONFIRM };
