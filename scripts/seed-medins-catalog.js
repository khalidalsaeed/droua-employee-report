#!/usr/bin/env node
/* زرع قائمة بنود المنافع المقترحة — **لا يكتب شيئًا بلا --apply**.
   =========================================================================
   القائمة في lib/medins/catalogProposal.js مسودّة تنتظر الاعتماد. وهذا
   السكربت لا يُشغَّل قبله. والزرع إضافة بحتة: ON CONFLICT DO NOTHING — بندٌ
   موجود (أو أُضيف من الواجهة بالرمز نفسه) لا يُمسّ.

   المعاينة:  node scripts/seed-medins-catalog.js           (بلا اتّصال)
   التنفيذ:   node scripts/seed-medins-catalog.js --apply    (بعد الاعتماد فقط) */

const { PROPOSAL } = require("../lib/medins/catalogProposal");
const catalog = require("../lib/medins/data/catalog");

function validate() {
  const codes = new Set();
  for (const item of PROPOSAL) {
    if (!catalog.CODE_RE.test(item.code)) throw new Error(`رمز غير صالح: ${item.code}`);
    if (codes.has(item.code)) throw new Error(`رمز مكرّر: ${item.code}`);
    codes.add(item.code);
    if (!catalog.CATEGORIES.includes(item.category)) throw new Error(`تصنيف غير صالح: ${item.code}`);
    if (!catalog.VALUE_TYPES.includes(item.valueType)) throw new Error(`نوع غير صالح: ${item.code}`);
    if (!catalog.BETTER.includes(item.better)) throw new Error(`اتّجاه غير صالح: ${item.code}`);
    catalog.checkUnit(item.valueType, item.unit);
  }
  return PROPOSAL.length;
}

function insertQuery(sql, item) {
  return sql`
    INSERT INTO medins_benefit_catalog (code, label_ar, label_en, category, value_type, unit, better, display_order, active, created_by)
    VALUES (${item.code}, ${item.labelAr}, ${item.labelEn}, ${item.category}, ${item.valueType}, ${item.unit},
            ${item.better}, ${item.displayOrder}, true, 'seed:catalogProposal')
    ON CONFLICT (code) DO NOTHING`;
}

async function main() {
  const count = validate();
  if (!process.argv.includes("--apply")) {
    console.log(`— معاينة: ${count} بندًا مقترحًا (لا اتّصال بالقاعدة) —\n`);
    for (const i of PROPOSAL) console.log(`${String(i.displayOrder).padStart(4)}  ${i.code.padEnd(28)} ${i.valueType.padEnd(8)} ${i.better.padEnd(7)} ${i.labelAr}`);
    console.log("\nللتنفيذ بعد الاعتماد: --apply");
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ.");
    process.exitCode = 1;
    return;
  }
  const { getSql } = require("../lib/db");
  const sql = getSql();
  for (const item of PROPOSAL) await insertQuery(sql, item);
  console.log(`زُرع ما لم يكن موجودًا من ${count} بندًا. البنود القائمة لم تُمسّ.`);
}

if (require.main === module) {
  main().catch((err) => { console.error("فشل الزرع:", (err && err.message) || err); process.exitCode = 1; });
}

module.exports = { validate, insertQuery };
