#!/usr/bin/env node
/* تحقّق محلّي من صلاحية قاعدة الربط — تاسك أجير، قبل أي migration.
   =========================================================================
   ⚠️ SELECT فقط. لا INSERT ولا UPDATE ولا DELETE ولا CREATE — ولا كتابة
   ملفّ واحد. والحاجز ليس انضباطًا: كل نصّ استعلام يمرّ على selectOnly
   قبل تنفيذه، فعبارةٌ غير SELECT تُسقط السكربت ولا تصل إلى السلك.

   ── لماذا يوجد هذا السكربت ──
   قاعدة الربط الجديدة تقيّد رقم الحساب بسياق بنكه (اقرأ CLAUDE.md ·
   «قاعدة الربط»). وصلاحيتها تتوقّف على أمرين لا يمكن قياسهما من الشيفرة:
   هل يحمل سجلّ الموظفين «اسم البنك» أصلًا، وهل يُكتب فيه بالصيغة نفسها
   التي يطبعها البنك في الإيصال. فبلا قياسهما يكون تشغيل الـmigration
   رهانًا: قد تخرج الإيصالات كلّها unlinked وتبدو القاعدة «تعمل».

   ── ما لا يُطبع، أبدًا ──
   لا اسم شخص · لا رقم إقامة · لا IBAN · لا رقم حساب · لا مبلغ · ولا
   اسم بنك. المخرج **أعدادٌ وتسميات وهمية فقط** (bank_form_A …)، فيُلصق
   كما هو بلا تنقيح.

   والاستثناء الوحيد ‎--show-banks: يطبع صيغ أسماء البنوك الحقيقية —
   أسماء مؤسّسات لا أشخاص — ليتمكّن الإنسان من صياغة المرادف. مخرجه
   للعين المحلّية وحدها ولا يُلصق في محادثة.

   ── التشغيل ──
     export DATABASE_URL='postgres://…'
     node scripts/validate-receipt-linking.js --run 2026-08 \
          --receipts /مسار/خارج/المستودع/إيصالات

   الأعلام:
     --run <معرّف>       يحصر الموظفين في أصحاب صفوف إثبات ذلك المسير
                         (موظفو أجير لذلك الشهر). بلا العلم: كل الموظفين.
     --receipts <مجلّد>  مجلّد ملفّات PDF حقيقية **خارج المستودع**. بلا
                         العلم تُقاس جهة السجلّ وحدها ويُتخطّى ③ و④.
     --show-banks        يطبع صيغ أسماء البنوك الحقيقية. محلّي فقط.

   ولا يدخل هذا الملفّ بيانٌ حقيقي ولا مسارٌ محلّي: المسار عَلَمٌ، ورابط
   القاعدة من البيئة. */

const fs = require("node:fs");
const path = require("node:path");

const { parseReceiptDocument } = require("../lib/payroll/receiptDoc");
const M = require("../lib/payroll/receiptMatch");

/* ─── حاجز القراءة فقط ─── */

/* كل استعلام يمرّ من هنا. نمطٌ إيجابي (يبدأ بـSELECT) وسلبي (لا كلمة
   كتابة في أي موضع) معًا: الأول وحده يمرّره CTE كاتب، والثاني وحده
   يمرّره نصّ لا يبدأ بشيء معروف. */
const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|vacuum|refresh|call|do)\b/i;
function selectOnly(text) {
  const t = String(text).trim();
  if (!/^select\b/i.test(t)) throw new Error(`استعلام لا يبدأ بـSELECT: ${t.slice(0, 40)}`);
  if (WRITE_WORDS.test(t)) throw new Error(`استعلام يحمل كلمة كتابة: ${t.slice(0, 40)}`);
  return t;
}

/* ─── أعلام سطر الأوامر ─── */

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i < 0 || i + 1 >= argv.length ? null : argv[i + 1];
}

/* ─── تسميات وهمية ثابتة لصيغ أسماء البنوك ─── */

/* التسمية تُمنح للصيغة **المُطبَّعة** لا للنصّ الخام، فصيغتان تختلفان
   في الفراغ وحده تحملان التسمية نفسها — وهو بالضبط ما يجب ألّا يُبلَّغ
   مرادفًا مطلوبًا. */
function labeller(prefix = "bank_form_") {
  const seen = new Map();
  const letter = (n) => {
    let s = "";
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };
  return (normalized) => {
    if (!normalized) return "(none)";
    if (!seen.has(normalized)) seen.set(normalized, prefix + letter(seen.size));
    return seen.get(normalized);
  };
}

/* ─── ① و② جهة السجلّ ─── */

const Q_EMPLOYEES = "SELECT data FROM employees ORDER BY id";
const Q_RUN_EIDS = "SELECT employee_eid FROM payroll_transfer_proofs WHERE run_id = $1";

async function readEmployees(sql, runId) {
  const rows = await sql.query(selectOnly(Q_EMPLOYEES));
  let employees = rows.map((r) => r.data).filter(Boolean);
  if (!runId) return { employees, scope: "كل الموظفين" };

  const proof = await sql.query(selectOnly(Q_RUN_EIDS), [runId]);
  const eids = new Set(proof.map((r) => String(r.employee_eid)));
  employees = employees.filter((e) => eids.has(String(e[M.F_DAMANAH] || "").trim()));
  return { employees, scope: `موظفو المسير ${runId}` };
}

function coverage(employees) {
  const has = (e, f) => String(e[f] == null ? "" : e[f]).trim() !== "";
  const withIban = employees.filter((e) => has(e, M.F_IBAN));
  const withAccount = employees.filter((e) => has(e, M.F_ACCOUNT));
  const withBank = employees.filter((e) => has(e, M.F_BANK));
  return {
    employees: employees.length,
    with_iban: withIban.length,
    with_account: withAccount.length,
    with_bank: withBank.length,
    /* ما يهمّ عمليًا: حسابٌ بلا بنك لا يربط إيصالًا واحدًا. */
    account_without_bank: withAccount.filter((e) => !has(e, M.F_BANK)).length,
    /* ولا معرّف بنكيًا إطلاقًا: هؤلاء unlinked مهما صحّت القاعدة. */
    no_identifier: employees.filter((e) => !has(e, M.F_IBAN) && !has(e, M.F_ACCOUNT)).length,
  };
}

function uniqueness(index) {
  const dup = (map) => [...map.values()].filter((a) => a.length > 1);
  const dupIban = dup(index.byIban);
  const dupPair = dup(index.byAccountBank);
  const dupRaw = dup(index.byAccount);
  return {
    distinct_iban: index.byIban.size,
    iban_shared_by_more_than_one: dupIban.length,
    distinct_account_bank_pairs: index.byAccountBank.size,
    account_bank_shared_by_more_than_one: dupPair.length,
    /* المقارنة التي تُبرّر القاعدة: كم رقمًا خامًا يحمله أكثر من موظف؟
       كلٌّ منها كان تطابقًا خامًا سيربط الإيصال بأحدهم اعتباطًا. */
    distinct_raw_accounts: index.byAccount.size,
    raw_account_shared_by_more_than_one: dupRaw.length,
  };
}

/* ─── ③ و④ جهة الإيصالات ─── */

async function readReceipts(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  const receipts = [];
  const failed = [];
  for (const f of files) {
    const doc = await parseReceiptDocument(fs.readFileSync(path.join(dir, f)));
    if (!doc.ok) { failed.push(doc.reason || "unreadable"); continue; }
    for (const r of doc.receipts) {
      receipts.push({
        extIban: r.fields.iban || null,
        extAccount: r.fields.account || null,
        extBank: r.fields.bank || null,
        extBeneficiary: r.fields.beneficiary || null,
      });
    }
  }
  return { files: files.length, receipts, failed };
}

function linkReport(receipts, employees, index) {
  const byEid = new Map();
  for (const e of employees) byEid.set(String(e[M.F_DAMANAH] || "").trim(), e);

  const zero = { uniquely_linked: 0, ambiguous: 0, unlinked: 0 };
  const out = {
    iban: { receipts: 0, ...zero },
    account: { receipts: 0, ...zero },
    unreadable: 0,
    reasons: {
      receipt_bank_missing: 0, record_bank_missing: 0,
      bank_mismatch: 0, account_no_owner: 0,
      iban_no_owner: 0, iban_multiple_owners: 0,
      account_bank_multiple_owners: 0, no_identifier: 0,
    },
    aliasPairs: new Map(),
  };

  const noteAlias = (receiptBank, recordBank, source) => {
    const a = M.normBank(receiptBank, index.bankAliases);
    const b = M.normBank(recordBank, index.bankAliases);
    if (!a || !b || a === b) return;
    const key = `${a} ${b} ${source}`;
    const prev = out.aliasPairs.get(key);
    if (prev) prev.count++;
    else out.aliasPairs.set(key, { receipt: a, record: b, source, count: 1 });
  };

  for (const r of receipts) {
    const link = M.linkReceipt(r, index);
    const lane = r.extIban ? out.iban : r.extAccount ? out.account : null;
    if (!lane) { out.unreadable++; out.reasons.no_identifier++; continue; }
    lane.receipts++;

    if (link.linkStatus === "linked") lane.uniquely_linked++;
    else if (link.linkStatus === "ambiguous") lane.ambiguous++;
    else lane.unlinked++;

    if (link.linkReasonCode && out.reasons[link.linkReasonCode] !== undefined) {
      out.reasons[link.linkReasonCode]++;
    }

    /* مصدرا إشارة المرادف: تعارضٌ منع ربطًا، وتعارضٌ ظهر رغم ربط
       بالآيبان. الثاني أثمن — الموظف مؤكَّد، فالصيغتان للبنك نفسه
       يقينًا لا احتمالًا. */
    if (link.linkReasonCode === "bank_mismatch") {
      for (const e of index.byAccount.get(M.normId(r.extAccount)) || []) {
        noteAlias(r.extBank, e[M.F_BANK], "account_path");
      }
    } else if (link.linkStatus === "linked" && link.matchKey === "iban") {
      const e = byEid.get(link.employeeEid);
      if (e) noteAlias(r.extBank, e[M.F_BANK], "iban_path_confirmed");
    }
  }
  return out;
}

/* ─── الطباعة ─── */

const line = (k, v) => console.log(`${k}: ${v}`);

function print(cov, uniq, link, meta, showBanks) {
  console.log("═══ تحقّق الربط — تاسك أجير · قراءة فقط ═══");
  line("scope", meta.scope);
  console.log("");

  console.log("── ① تغطية الحقول في السجلّ ──");
  for (const [k, v] of Object.entries(cov)) line(k, v);
  console.log("");

  console.log("── ② الفردية ──");
  for (const [k, v] of Object.entries(uniq)) line(k, v);
  console.log("");

  if (!link) {
    console.log("── ③ و④ متخطّاتان: بلا ‎--receipts ──");
    return;
  }

  console.log("── ③ الإيصالات ──");
  line("files", meta.files);
  line("receipts parsed", link.iban.receipts + link.account.receipts + link.unreadable);
  if (meta.failed.length) line("files unreadable", meta.failed.length);
  console.log("");
  line("iban receipts", link.iban.receipts);
  line("iban uniquely linked", link.iban.uniquely_linked);
  line("iban ambiguous", link.iban.ambiguous);
  line("iban unlinked", link.iban.unlinked);
  console.log("");
  line("account receipts", link.account.receipts);
  line("account+bank uniquely linked", link.account.uniquely_linked);
  line("account+bank ambiguous", link.account.ambiguous);
  line("account+bank unlinked", link.account.unlinked);
  console.log("");
  line("unreadable receipts", link.unreadable);
  console.log("");
  for (const [k, v] of Object.entries(link.reasons)) line(k, v);
  console.log("");

  console.log("── ④ اختلاف صيغ أسماء البنوك ──");
  const pairs = [...link.aliasPairs.values()].sort((a, b) => b.count - a.count);
  if (!pairs.length) {
    console.log("bank_alias_needed: (none)");
  } else {
    console.log("bank_alias_needed:");
    const label = labeller();
    for (const p of pairs) {
      console.log(`- ${label(p.receipt)} -> ${label(p.record)} : count ${p.count}  [${p.source}]`);
    }
    console.log("");
    console.log("⚠️ لا مرادف يُضاف تلقائيًا. هذه اقتراحات تُراجَع أوّلًا.");
    if (showBanks) {
      console.log("");
      console.log("── الصيغ الحقيقية (محلّي فقط — لا يُلصق في محادثة) ──");
      for (const p of pairs) console.log(`  ${p.receipt}  ->  ${p.record}   (${p.count})`);
    }
  }
}

/* ─── main ─── */

async function main() {
  const argv = process.argv.slice(2);
  const runId = argValue(argv, "--run");
  const receiptsDir = argValue(argv, "--receipts");
  const showBanks = argv.includes("--show-banks");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL غير مُهيّأ — السكربت يقرأ سجلّ الموظفين من القاعدة.");
    process.exit(1);
  }
  if (receiptsDir && !fs.existsSync(receiptsDir)) {
    console.error(`مجلّد الإيصالات غير موجود: ${receiptsDir}`);
    process.exit(1);
  }

  const { getSql } = require("../lib/db");
  const sql = getSql();

  const { employees, scope } = await readEmployees(sql, runId);
  const index = M.indexEmployees(employees);
  const cov = coverage(employees);
  const uniq = uniqueness(index);

  let link = null;
  const meta = { scope, files: 0, failed: [] };
  if (receiptsDir) {
    const read = await readReceipts(receiptsDir);
    meta.files = read.files;
    meta.failed = read.failed;
    link = linkReport(read.receipts, employees, index);
  }

  print(cov, uniq, link, meta, showBanks);
}

/* يُصدَّر ليُختبر منطقُه كما يُختبر أي منطق: تقريرٌ معطوب يمحو أثر
   قياسٍ سليم — وقد انهار تقرير الـbackfill يومًا بعد عمل صحيح تمامًا.
   وmain لا تعمل إلا عند التشغيل المباشر، فلا يفتح require اتصالًا. */
module.exports = {
  selectOnly, labeller, coverage, uniqueness, linkReport, readEmployees, readReceipts, print,
  Q_EMPLOYEES, Q_RUN_EIDS, main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("فشل:", err && err.message);
    process.exit(1);
  });
}
