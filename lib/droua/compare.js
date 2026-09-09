/* ─── محرّك المقارنة ───────────────────────────────────────────────────
   =========================================================================
   دالّة نقيّة: جداولٌ مطبَّعة تدخل، وملاحظاتٌ تخرج. لا قاعدة، ولا تخزين،
   ولا وقت. فتُختبر كلّها بجداول مكتوبة يدويًّا في سطور — وهذا وحده ما يجعل
   قواعد المقارنة قابلة للمراجعة فعلًا.

   ── القواعد سجلٌّ لا سلسلة `if` ──
   كل قاعدة كائنٌ له `id` و`scope` و`run`. فإضافة قاعدة سطرٌ واحد، وتعطيلها
   سطرٌ واحد، واختبارها منفردةً ممكن. والأهمّ: عددها معلوم فيُعرَض للمستخدم
   ما فُحص فعلًا.

   ── المقارنتان ──
   ① داخل الشهر:  كامل ≟ (تحويل + كاش) ≟ قائمة الموظفين.
   ② مع السابق:   ما تغيّر في الصافي والحساب والبنك ومن دخل ومن خرج.

   ⚠️ ولا رقم حساب كاملًا في أي مخرَج: الجداول تحمل آخر أربع خانات أصلًا
   (parsers/csv.js:lastFour)، وطبقة الملاحظات تقنّع ما فاتَ. */

/* مقارنة المبالغ بهامش هللة: الفروق العشرية في ملفّات محوَّلة تُنتج
   «اختلافًا» بمقدار 0.000001 يغرق التقرير بضجيج لا معنى له. */
const EPS = 0.005;
const differs = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) > EPS;

const money = (n) => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);

const indexBy = (doc, key = "empNo") => {
  const map = new Map();
  for (const row of (doc && doc.rows) || []) {
    if (row[key]) map.set(String(row[key]), row);
  }
  return map;
};

/* الصورة الكاملة للموظّف في الشهر: صفّه في «الكامل» مُغنًى ببيانات الصرف
   من «التحويل» أو «الكاش». فبيانات الحساب والبنك تعيش في ملفّ الصرف لا في
   الكامل — ومقارنةُ الحساب بين شهرين بلا هذا الدمج كانت ستقارن فراغًا
   بفراغ وتُخرج صفر ملاحظات، وهو أسوأ أنواع الصمت. */
function mergeSplit(docs) {
  if (!docs || !docs.full) return new Map();
  const transfer = indexBy(docs.transfer);
  const cash = indexBy(docs.cash);
  const out = new Map();
  for (const [empNo, row] of indexBy(docs.full)) {
    const paid = transfer.get(empNo) || cash.get(empNo) || {};
    out.set(empNo, {
      ...row,
      iban4: row.iban4 || paid.iban4 || null,
      bank: row.bank || paid.bank || null,
      method: row.method || paid.method || (transfer.has(empNo) ? "تحويل" : cash.has(empNo) ? "كاش" : null),
    });
  }
  return out;
}

const sum = (doc, field) => ((doc && doc.rows) || []).reduce((t, r) => t + Number(r[field] || 0), 0);
const nameOf = (...rows) => (rows.find((r) => r && r.name) || {}).name || null;

/* عتبات تغيّر الصافي. النسبة لا المبلغ: زيادةُ 500 على راتب 3000 حدثٌ،
   وعلى راتب 60000 تسوية. */
const PCT_WARN = 5;
const PCT_CRITICAL = 25;

const RULES = [
  /* ── ① داخل الشهر ────────────────────────────────────────────────── */
  {
    id: "duplicate_emp_no",
    scope: "within_month",
    severity: "critical",
    run({ docs }) {
      const out = [];
      for (const [kind, doc] of Object.entries(docs)) {
        if (!doc) continue;
        const seen = new Map();
        for (const row of doc.rows) {
          if (!row.empNo) continue;
          seen.set(row.empNo, (seen.get(row.empNo) || 0) + 1);
        }
        for (const [empNo, count] of seen) {
          if (count > 1) {
            out.push({
              employeeRef: empNo, field: `${kind}.empNo`,
              title: "رقم موظّف مكرّر في الملفّ",
              currentValue: `${count} مرّات في «${kind}»`,
              description: "التكرار يجعل كل مجموع في هذا الملفّ مشكوكًا فيه.",
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: "missing_in_split",
    scope: "within_month",
    severity: "critical",
    run({ full, transfer, cash }) {
      const out = [];
      for (const [empNo, row] of full) {
        if (!transfer.has(empNo) && !cash.has(empNo)) {
          out.push({
            employeeRef: empNo, employeeName: row.name, field: "net",
            title: "في المسير الكامل ولا يظهر في التحويل ولا الكاش",
            currentValue: money(row.net),
            description: "مستحقٌّ في الكامل بلا طريقة صرف — أي راتبٌ لم يُصرف.",
          });
        }
      }
      return out;
    },
  },
  {
    id: "extra_in_split",
    scope: "within_month",
    severity: "critical",
    run({ full, transfer, cash }) {
      const out = [];
      for (const [empNo, row] of [...transfer, ...cash]) {
        if (full.has(empNo)) continue;
        out.push({
          employeeRef: empNo, employeeName: row.name,
          field: transfer.has(empNo) ? "transfer" : "cash",
          title: "مصروفٌ ولا وجود له في المسير الكامل",
          currentValue: money(row.net),
          description: "صرفٌ بلا سندٍ في المسير المعتمد.",
        });
      }
      return out;
    },
  },
  {
    id: "net_mismatch",
    scope: "within_month",
    severity: "critical",
    run({ full, transfer, cash }) {
      const out = [];
      for (const [empNo, row] of full) {
        const paid = Number((transfer.get(empNo) || {}).net || 0) + Number((cash.get(empNo) || {}).net || 0);
        if (!transfer.has(empNo) && !cash.has(empNo)) continue; // تمسكها قاعدة أخرى
        if (differs(row.net, paid)) {
          out.push({
            employeeRef: empNo, employeeName: row.name, field: "net",
            title: "الصافي في الكامل لا يساوي المصروف",
            previousValue: money(row.net), currentValue: money(paid),
            delta: Number(money(paid - row.net)),
            description: "الكامل مقابل (تحويل + كاش).",
          });
        }
      }
      return out;
    },
  },
  {
    id: "totals_mismatch",
    scope: "within_month",
    severity: "critical",
    run({ docs }) {
      const fullTotal = sum(docs.full, "net");
      const paidTotal = sum(docs.transfer, "net") + sum(docs.cash, "net");
      if (!differs(fullTotal, paidTotal)) return [];
      return [{
        field: "total.net",
        title: "مجموع الشهر لا يتطابق",
        previousValue: money(fullTotal), currentValue: money(paidTotal),
        delta: Number(money(paidTotal - fullTotal)),
        description: "مجموع الكامل مقابل مجموع (تحويل + كاش).",
      }];
    },
  },
  {
    id: "paid_twice",
    scope: "within_month",
    severity: "warn",
    run({ transfer, cash }) {
      const out = [];
      for (const [empNo, row] of transfer) {
        if (!cash.has(empNo)) continue;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, cash.get(empNo)), field: "method",
          title: "مصروفٌ في التحويل والكاش معًا",
          currentValue: `تحويل ${money(row.net)} + كاش ${money(cash.get(empNo).net)}`,
          description: "قد يكون صرفًا مجزّأً مشروعًا — ويستحقّ تأكيدًا.",
        });
      }
      return out;
    },
  },
  {
    id: "non_positive_net",
    scope: "within_month",
    severity: "warn",
    run({ full }) {
      const out = [];
      for (const [empNo, row] of full) {
        if (Number(row.net) > 0) continue;
        out.push({
          employeeRef: empNo, employeeName: row.name, field: "net",
          title: "صافٍ صفر أو سالب",
          currentValue: money(row.net),
          description: "استقطاعٌ يبتلع الراتب، أو خطأٌ في القراءة.",
        });
      }
      return out;
    },
  },
  {
    id: "not_in_employee_list",
    scope: "within_month",
    severity: "warn",
    run({ full, employees, docs }) {
      if (!docs.employees) return [];
      const out = [];
      for (const [empNo, row] of full) {
        if (employees.has(empNo)) continue;
        out.push({
          employeeRef: empNo, employeeName: row.name, field: "employees",
          title: "في المسير ولا يظهر في قائمة الموظفين",
          currentValue: money(row.net),
          description: "راتبٌ لمن ليس على القائمة.",
        });
      }
      return out;
    },
  },
  {
    id: "not_in_payroll",
    scope: "within_month",
    severity: "warn",
    run({ full, employees, docs }) {
      if (!docs.employees) return [];
      const out = [];
      for (const [empNo, row] of employees) {
        if (full.has(empNo)) continue;
        const status = String(row.status || "").trim();
        /* الموقوف والمنتهية خدمته لا يُتوقَّع لهما راتب. */
        if (/موقوف|منته|منتهي|مستقيل|إجازة بدون|inactive|terminated|suspended/i.test(status)) continue;
        out.push({
          employeeRef: empNo, employeeName: row.name, field: "payroll",
          title: "على القائمة ولا راتب له هذا الشهر",
          currentValue: status || "—",
          description: "موظّفٌ نشط بلا مستحقّ.",
        });
      }
      return out;
    },
  },
  {
    id: "iban_vs_list",
    scope: "within_month",
    severity: "warn",
    run({ transfer, employees, docs }) {
      if (!docs.employees) return [];
      const out = [];
      for (const [empNo, row] of transfer) {
        const listed = employees.get(empNo);
        if (!listed || !listed.iban4 || !row.iban4) continue;
        if (listed.iban4 === row.iban4) continue;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, listed), field: "iban4",
          title: "حساب التحويل يخالف المسجَّل في القائمة",
          previousValue: `****${listed.iban4}`, currentValue: `****${row.iban4}`,
          description: "اختلافُ الحساب بين المسير والقائمة يستحقّ تأكيدًا مباشرًا.",
        });
      }
      return out;
    },
  },

  /* ── ② مع الشهر السابق ───────────────────────────────────────────── */
  {
    id: "iban_changed",
    scope: "vs_previous",
    severity: "critical",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        const before = previous.get(empNo);
        if (!before || !before.iban4 || !row.iban4) continue;
        if (before.iban4 === row.iban4) continue;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "iban4",
          title: "تغيّر حساب التحويل عن الشهر السابق",
          previousValue: `****${before.iban4}`, currentValue: `****${row.iban4}`,
          description: "أهمّ إشارةٍ تستحقّ تأكيدًا مع الموظّف نفسه لا عبر رسالة.",
        });
      }
      return out;
    },
  },
  {
    id: "net_changed",
    scope: "vs_previous",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        const before = previous.get(empNo);
        if (!before) continue;
        if (!differs(row.net, before.net)) continue;
        const delta = Number(row.net) - Number(before.net);
        const base = Math.abs(Number(before.net)) || 1;
        const pct = Math.abs(delta) / base * 100;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "net",
          severity: pct >= PCT_CRITICAL ? "critical" : pct >= PCT_WARN ? "warn" : "info",
          title: delta > 0 ? "ارتفاع في الصافي" : "انخفاض في الصافي",
          previousValue: money(before.net), currentValue: money(row.net),
          delta: Number(money(delta)),
          description: `${delta > 0 ? "+" : ""}${money(delta)} (${pct.toFixed(1)}%).`,
        });
      }
      return out;
    },
  },
  {
    id: "deductions_changed",
    scope: "vs_previous",
    severity: "warn",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        const before = previous.get(empNo);
        if (!before) continue;
        if (!differs(row.deductions, before.deductions)) continue;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "deductions",
          title: "تغيّر في الاستقطاعات",
          previousValue: money(before.deductions), currentValue: money(row.deductions),
          delta: Number(money(Number(row.deductions) - Number(before.deductions))),
          description: "استقطاعٌ جديد أو رُفع.",
        });
      }
      return out;
    },
  },
  {
    id: "new_employee",
    scope: "vs_previous",
    severity: "info",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        if (previous.has(empNo)) continue;
        out.push({
          employeeRef: empNo, employeeName: row.name, field: "presence",
          title: "اسمٌ جديد لم يكن في الشهر السابق",
          currentValue: money(row.net),
          description: "تعيينٌ جديد، أو رقمٌ وظيفيّ تغيّر.",
        });
      }
      return out;
    },
  },
  {
    id: "removed_employee",
    scope: "vs_previous",
    severity: "warn",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of previous) {
        if (current.has(empNo)) continue;
        out.push({
          employeeRef: empNo, employeeName: row.name, field: "presence",
          title: "كان في الشهر السابق واختفى",
          previousValue: money(row.net),
          description: "نهاية خدمة، أو سقوطٌ من المسير.",
        });
      }
      return out;
    },
  },
  {
    id: "bank_changed",
    scope: "vs_previous",
    severity: "warn",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        const before = previous.get(empNo);
        if (!before || !before.bank || !row.bank) continue;
        if (before.bank === row.bank) continue;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "bank",
          title: "تغيّر البنك",
          previousValue: before.bank, currentValue: row.bank,
          description: "يُقرأ مع تغيّر الحساب إن وقعا معًا.",
        });
      }
      return out;
    },
  },
];

/* `docs` = { full, transfer, cash, employees } — أيّها قد يكون null.
   `previousDocs` = مثله للشهر السابق، أو null إن لم يوجد. */
function compare({ docs, previousDocs }) {
  const ctx = {
    docs,
    full: indexBy(docs.full),
    transfer: indexBy(docs.transfer),
    cash: indexBy(docs.cash),
    employees: indexBy(docs.employees),
    current: mergeSplit(docs),
    previous: mergeSplit(previousDocs),
  };

  const findings = [];
  const applied = [];
  const skipped = [];

  for (const rule of RULES) {
    if (rule.scope === "vs_previous" && !(previousDocs && previousDocs.full)) { skipped.push(rule.id); continue; }
    if (rule.scope === "within_month" && !docs.full) { skipped.push(rule.id); continue; }
    applied.push(rule.id);
    for (const found of rule.run(ctx) || []) {
      findings.push({
        rule: rule.id,
        scope: rule.scope,
        severity: found.severity || rule.severity || "warn",
        ...found,
      });
    }
  }
  return { findings, applied, skipped };
}

module.exports = { compare, RULES, indexBy, mergeSplit, differs, money, EPS, PCT_WARN, PCT_CRITICAL };
