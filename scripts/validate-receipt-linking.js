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

/* ─── ⑤ تشخيص حالة account_no_owner ─── */

/* «رقم حساب الإيصال لا يقابل أي موظف» سببٌ واحد بأربعة أصول مختلفة
   العلاج: سجلٌّ بلا حساب · سجلٌّ بلا بنك · فرقُ صيغةٍ في الرقم · أو
   إيصالٌ لموظف آخر أصلًا. وبلا تمييزها يُفتَح عشرة سجلّات بحثًا عمّا
   يخصّ واحدًا.

   ── كيف يُعرَف الموظف المقابل بلا مطابقة اسم ──
   بالإقصاء: إذا بقي في المسير موظفٌ واحد بلا إيصال مربوط، وبقي إيصالٌ
   واحد بهذا السبب، فهما متقابلان بالضرورة — لا تخمين فيه ولا اسم
   يُقارَن. وإن تعدّد أيّ الطرفين فالإقصاء لا يحسم، ويُقال unknown بدل
   أن يُختار أحدهم.

   ويُضاف تأكيدٌ ثانٍ بلا طباعة: هل يتّفق اسم المستفيد على الإيصال مع
   الاسم البنكي في السجلّ؟ يُعرَض yes/no وحدهما — والاسمان لا يخرجان. */

/* مطابقات أضعف من التطابق التامّ، للتشخيص وحده — لا يربط منها شيء.
   أصلُ فرقِ الصيغة المعروف: أصفارٌ بادئة تُكتب في جهة وتُسقط في أخرى،
   وBBAN داخل الآيبان يحمل الحساب مسبوقًا بأصفار. */
const stripZeros = (v) => String(v || "").replace(/^0+/, "");
function looseMatch(receiptAccount, record) {
  const a = M.normId(receiptAccount);
  if (!a) return "none";
  const acc = M.normId(record[M.F_ACCOUNT]);
  const iban = M.normId(record[M.F_IBAN]);
  if (acc && acc === a) return "exact_account";
  if (acc && stripZeros(acc) === stripZeros(a)) return "leading_zeros";
  if (acc && (acc.includes(a) || a.includes(acc))) return "substring_account";
  if (iban && iban.includes(a)) return "inside_iban";
  return "none";
}

/* يُرجَع تقرير الحالة الواحدة — أو حالاتها إن تعدّدت. */
function diagnoseAccountNoOwner(receipts, employees, index) {
  const linked = receipts.map((r) => ({ r, link: M.linkReceipt(r, index) }));
  const orphans = linked.filter((x) => x.link.linkReasonCode === "account_no_owner");

  const claimed = new Set(linked.filter((x) => x.link.employeeEid).map((x) => x.link.employeeEid));
  const unmatched = employees.filter((e) => !claimed.has(String(e[M.F_DAMANAH] || "").trim()));

  const has = (e, f) => String(e && e[f] != null ? e[f] : "").trim() !== "";
  const yn = (b) => (b ? "yes" : "no");

  /* الإقصاء يحسم حين يبقى واحدٌ في كل جهة، ولا يحسم فيما عدا ذلك. */
  const decided = orphans.length === 1 && unmatched.length === 1 ? unmatched[0] : null;

  const out = {
    account_no_owner_count: orphans.length,
    payroll_employees_without_linked_receipt: unmatched.length,
    corresponding_employee_identified_by_elimination: yn(!!decided),
  };

  if (!decided) {
    out.corresponding_payroll_employee_has_identifier = "unknown";
    out.employee_record_has_account = "unknown";
    out.employee_record_has_iban = "unknown";
    out.employee_record_has_bank = "unknown";
    out.beneficiary_name_agrees_with_record = "unknown";
    out.receipt_account_matches_any_record_raw = orphans.length
      ? yn(orphans.some((x) => (index.byAccount.get(M.normId(x.r.extAccount)) || []).length > 0))
      : "n/a";
    out.receipt_account_loose_match = "unknown";
    out.likely_reason = "unknown";
    return out;
  }

  const { r } = orphans[0];
  const hasAccount = has(decided, M.F_ACCOUNT);
  const hasIban = has(decided, M.F_IBAN);
  const hasBank = has(decided, M.F_BANK);

  /* التطابق التامّ الخام: لا بدّ أن يكون no — لأن account_no_owner لا
     تُرجَع إلا حين يخلو فهرس الرقم الخام. ويُطبع مع ذلك، فغيابه من
     التقرير يجعل القارئ يتساءل، ووجوده yes يومًا يعني أن السبب
     نفسه صار يُرجَع من فرع آخر — عطلٌ يجب أن يُرى. */
  const rawAnywhere = (index.byAccount.get(M.normId(r.extAccount)) || []).length > 0;
  const mine = looseMatch(r.extAccount, decided);
  const other = employees.some((e) => e !== decided && looseMatch(r.extAccount, e) !== "none");

  const warn = M.nameWarning(r, decided);
  out.corresponding_payroll_employee_has_identifier = yn(hasAccount || hasIban);
  out.employee_record_has_account = yn(hasAccount);
  out.employee_record_has_iban = yn(hasIban);
  out.employee_record_has_bank = yn(hasBank);
  out.beneficiary_name_agrees_with_record =
    !r.extBeneficiary || !decided[M.F_NAME_BANK] ? "unknown" : yn(!warn);
  out.receipt_account_matches_any_record_raw = yn(rawAnywhere);
  out.receipt_account_loose_match = mine;
  out.receipt_account_loose_match_other_employee = yn(other);

  /* الترتيب هو المنطق: كل صورة نقصٍ في السجلّ تُحسم قبل أي حكم على
     الصيغة، فلا يُقال «فرق صيغة» عن سجلٍّ لا حساب فيه أصلًا. */
  out.likely_reason =
    !hasAccount && !hasIban ? "missing_employee_account"
    : mine !== "none" && !hasBank ? "missing_employee_bank_data"
    : mine !== "none" ? "receipt_account_format_difference"
    : other ? "receipt_belongs_to_other_employee"
    : !hasAccount ? "missing_employee_account"
    : !hasBank ? "missing_employee_bank_data"
    : "unknown";
  return out;
}

/* ─── الطباعة ─── */

const line = (k, v) => console.log(`${k}: ${v}`);

function print(cov, uniq, link, meta, showBanks, diag) {
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

  if (diag) {
    console.log("── ⑤ تشخيص account_no_owner ──");
    for (const [k, v] of Object.entries(diag)) line(k, v);
    console.log("");
  }

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
  let diag = null;
  const meta = { scope, files: 0, failed: [] };
  if (receiptsDir) {
    const read = await readReceipts(receiptsDir);
    meta.files = read.files;
    meta.failed = read.failed;
    link = linkReport(read.receipts, employees, index);
    /* لا يُشخَّص إلا ما وقع فعلًا: بلا حالة لا قسم. */
    if (link.reasons.account_no_owner > 0) {
      diag = diagnoseAccountNoOwner(read.receipts, employees, index);
    }
  }

  print(cov, uniq, link, meta, showBanks, diag);
}

/* يُصدَّر ليُختبر منطقُه كما يُختبر أي منطق: تقريرٌ معطوب يمحو أثر
   قياسٍ سليم — وقد انهار تقرير الـbackfill يومًا بعد عمل صحيح تمامًا.
   وmain لا تعمل إلا عند التشغيل المباشر، فلا يفتح require اتصالًا. */
module.exports = {
  selectOnly, labeller, coverage, uniqueness, linkReport, readEmployees, readReceipts, print,
  diagnoseAccountNoOwner, looseMatch,
  Q_EMPLOYEES, Q_RUN_EIDS, main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("فشل:", err && err.message);
    process.exit(1);
  });
}
