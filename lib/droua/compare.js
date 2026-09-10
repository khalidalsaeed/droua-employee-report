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
  /* قائمة الموظفين مصدرٌ ثالث للحساب والبنك — ومسيراتُ الرواتب الحقيقية قد
     لا تحمل عمود حساب أصلًا. فبلا هذا السقوط تصير مقارنةُ الحساب بين
     شهرين مقارنةَ فراغٍ بفراغ: صفر ملاحظات، وهو أسوأ أنواع الصمت. */
  const listed = indexBy(docs.employees);
  const out = new Map();
  for (const [empNo, row] of indexBy(docs.full)) {
    const paid = transfer.get(empNo) || cash.get(empNo) || {};
    const onList = listed.get(empNo) || {};
    out.set(empNo, {
      ...row,
      iban4: row.iban4 || paid.iban4 || onList.iban4 || null,
      bank: row.bank || paid.bank || onList.bank || null,
      method: row.method || paid.method || onList.method
        || (transfer.has(empNo) ? "تحويل" : cash.has(empNo) ? "كاش" : null),
    });
  }
  return out;
}

/* توحيد تسمية قناة الصرف: «بنك» و«تحويل» و«حوالة» شيءٌ واحد، و«نقد»
   و«كاش» شيءٌ واحد. وما عداهما مجهولٌ لا يُخمَّن. */
function channelOf(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/بنك|تحويل|حوال|bank|transfer/i.test(value)) return "bank";
  if (/نقد|كاش|cash/i.test(value)) return "cash";
  return null;
}

const sum = (doc, field) => ((doc && doc.rows) || []).reduce((t, r) => t + Number(r[field] || 0), 0);
const nameOf = (...rows) => (rows.find((r) => r && r.name) || {}).name || null;

/* عتبات تغيّر الصافي. النسبة لا المبلغ: زيادةُ 500 على راتب 3000 حدثٌ،
   وعلى راتب 60000 تسوية. */
const PCT_WARN = 5;
const PCT_CRITICAL = 25;

/* ── عتبةُ الارتفاع: نسبةٌ ومبلغٌ معًا، لا أحدهما ──
   النسبةُ وحدها تجعل ارتفاع مئة ريال على راتب مئة «حرجًا» — وهو تصحيحُ
   قيدٍ لا حدث. والمبلغُ وحده يجعل ارتفاع خمس مئة على عشرين ألفًا (2.5%)
   كارتفاعها على ألف (50%). فتُشترط العتبتان معًا لكل درجة، والباقي
   **يُبلَّغ معلومةً ولا يُكتَم**: التغيّر واقعٌ يُرى، ودرجتُه وحدها ما
   تُقاس. */
const SPIKE = Object.freeze({
  critical: { pct: PCT_CRITICAL, abs: 500 },
  warn: { pct: PCT_WARN, abs: 100 },
});

function spikeOf(before, after) {
  const delta = Number(after || 0) - Number(before || 0);
  const base = Math.abs(Number(before || 0)) || 1;
  const pct = Math.abs(delta) / base * 100;
  const abs = Math.abs(delta);
  const severity = pct >= SPIKE.critical.pct && abs >= SPIKE.critical.abs ? "critical"
    : pct >= SPIKE.warn.pct && abs >= SPIKE.warn.abs ? "warn" : "info";
  return { delta, pct, severity };
}

/* «+420.00 (12.4%)» — ومعها ما يفسّره إن وُجد. */
const spikeText = (s) => `${s.delta > 0 ? "+" : ""}${money(s.delta)} (${s.pct.toFixed(1)}%)`;

/* ── تفسيرُ فرق الخصم ببنوده ──
   «ارتفع الخصم 420» لا تُصلح شيئًا. و«غياب +300 وتأخير +120» تقول لصاحبها
   أين ينظر. والبندُ الغائب من أحد الشهرين **لا يُحوَّل صفرًا**: يُذكر أنه
   غير متوفّر، فالفرقُ غير المفسَّر يُعلَن ولا يُلفَّق له سبب. */
function explainParts(beforeMap, afterMap) {
  const names = new Set([...Object.keys(beforeMap || {}), ...Object.keys(afterMap || {})]);
  const moved = [];
  for (const name of names) {
    const a = (beforeMap || {})[name];
    const b = (afterMap || {})[name];
    const d = Number(b || 0) - Number(a || 0);
    if (Math.abs(d) <= EPS) continue;
    moved.push({ name, delta: d, onlyOneSide: a === undefined || b === undefined });
  }
  moved.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return moved;
}

function partsSentence(moved) {
  if (!moved.length) return "";
  const top = moved.slice(0, 4)
    .map((m) => `${m.name} ${m.delta > 0 ? "+" : ""}${money(m.delta)}`)
    .join("، ");
  return ` والسبب: ${top}${moved.length > 4 ? " وغيرها" : ""}.`;
}

/* ── العمل الإضافي ──
   الصفوف تُجمع بالرقم الوظيفيّ: صفٌّ لكل يوم ولكل مصدر اعتماد، والمجموع
   هو ما يُقارَن. والاسمُ للعرض لا للمطابقة، والمبلغُ ليس مفتاح هويّة. */
function overtimeByEmployee(doc) {
  const out = new Map();
  for (const row of (doc && doc.rows) || []) {
    if (!row.empNo) continue;
    const key = String(row.empNo);
    const entry = out.get(key) || { empNo: key, name: row.name || null, minutes: {}, rows: 0, keys: new Map() };
    entry.rows += 1;
    if (!entry.name && row.name) entry.name = row.name;
    for (const [mult, mins] of Object.entries(row.minutes || {})) {
      entry.minutes[mult] = (entry.minutes[mult] || 0) + Number(mins || 0);
    }
    /* التكرار الحقيقيّ: الموظّف واليوم والمصدر نفسها مرّتين. وتعدّدُ
       الأيّام أو المصادر ليس تكرارًا. */
    const signature = `${row.date || "—"}|${row.source || "—"}`;
    entry.keys.set(signature, (entry.keys.get(signature) || 0) + 1);
    out.set(key, entry);
  }
  return out;
}

/* المعاملات التي نملك لها صيغةً معتمدة. وما عداها يُعلَن ولا يُحسب:
   اختراعُ صيغةٍ لمعاملٍ لم يُقرَّر يُنتج فرقًا ماليًّا مخترَعًا. */
const SUPPORTED_MULTIPLIERS = Object.freeze([1.5]);

/* القاسم المستعمَل: المحفوظ للموظّف، وإلّا الافتراضيّ. فلا شهرَ يمرّ بلا
   حساب لأن أحدًا لم يُسأل. */
const DEFAULT_DIVISOR = require("./settings").DEFAULT_OVERTIME_DIVISOR;
const divisorFor = (empNo, divisors) => Number((divisors && divisors.get(empNo)) || DEFAULT_DIVISOR);

/* أجرُ ساعة العمل الإضافي عند معامل 1.5 — سياسةُ الشركة كما أُقرّت:
   أجرُ الساعة (من إجمالي الراتب) + نصفُ أجر الساعة **الأساسي**.

   والراتبان يُقرآن منفصلين عمدًا: مسيراتُنا تحمل «الراتب الاساسي»
   و«اجمالي الراتب» عمودين، وافتراضُ تساويهما يُنقص الأجر أو يزيده بمقدار
   البدلات كلّها. */
function overtimeRate(row, divisor, multiplier) {
  if (multiplier !== 1.5) return null;
  const gross = Number(row.gross || 0);
  const basic = Number(row.basic || 0);
  if (!gross || !basic || !divisor) return null;
  const hourlyGross = gross / 30 / divisor;
  const hourlyBasic = basic / 30 / divisor;
  return hourlyGross + (hourlyBasic / 2);
}

/* ── المصادر التي تحتاجها كل قاعدة ──
   مصدرٌ غير متاح **ليس خطأً في الرواتب**. وقاعدةٌ تُشغَّل بلا مصدرها تُنتج
   نتيجةً مخترعة: «مستحقٌّ بلا صرف» لكل من صُرف له كاشًا، لمجرّد أن ملفّ
   الكاش غير موجود عندنا. ولذلك تُعلن كل قاعدة ما تحتاجه، وما نقص مصدره
   **لا يُقيَّم** ويُعلَن أنه لم يُقيَّم — لا يُخمَّن ولا يُسكت عنه.

   والافتراض حين لا تُعلن القاعدة: «كامل» للشهر الجاري، ومعه «كامل» السابق
   لقواعد المقارنة. */
const DEFAULT_NEEDS = { current: ["full"], previous: ["full"] };

/* ── ولا يكفي وجودُ الملفّ: العمود نفسه قد يغيب ──
   مسيراتُ الرواتب الحقيقية عندنا **لا تحمل عمود حساب ولا عمود بنك** — هي
   كشوفُ مبالغ مقسومة بالقناة لا ملفّات بنكية. فقاعدةٌ تقارن الحساب بين
   المسير والقائمة تمرّ على الجميع ولا تجد ما تقارنه، فتُخرج **صفرًا**
   يُقرأ «لا مخالفة» وهو في الحقيقة «لم يُفحص شيء».

   وهذا الصفر الصامت أخطر من إنذارٍ كاذب: الإنذار يُراجَع فيُردّ، والصفر
   يُطمئن. فتُعلن كل قاعدة الحقلَ الذي تقوم عليه — وغيابُه يوقفها ويُعلَن.

   `doc: "merged"` يعني الصورة المدموجة (مسير + صرف + قائمة)، وما عداه
   مستندٌ بعينه. */
const FIELD_SOURCES = ["merged", "full", "transfer", "cash", "employees", "overtime"];

/* ── والعمود الرقميّ يحتاج فحصًا آخر ──
   المطبِّع يجعل العمود الغائب **صفرًا** لا فراغًا: مسيرٌ بلا عمود بدلات
   يُخرج `allowances: 0` لكل موظّف. فمقارنةُ شهرين كلاهما كذلك تُخرج «لم
   تتغيّر البدلات» بثقة — ولم تُقرأ بدلاتٌ أصلًا.

   والصفر قيمةٌ لا فراغ، فلا يكشفه فحصُ الامتلاء. ويُكشف من **المطابقة**
   وحدها: هل أُسنِد عمودٌ إلى هذا الحقل؟ ولذلك تُعلن هذه القواعد
   `mapped` بمفاتيح المطابقة المقبولة بدل اسم الحقل. */
const CONTRIBUTING = ["full", "transfer", "cash"];

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
    needs: { current: ["full", "transfer", "cash"] },
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
    needs: { current: ["full", "transfer", "cash"] },
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
    needs: { current: ["full", "transfer", "cash"] },
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
    needs: { current: ["full", "transfer", "cash"] },
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
    needs: { current: ["transfer", "cash"] },
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
    needs: { current: ["full", "employees"] },
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
    needs: { current: ["full", "employees"] },
    scope: "within_month",
    severity: "warn",
    run({ full, employees, docs, leaves }) {
      if (!docs.employees) return [];
      const out = [];
      for (const [empNo, row] of employees) {
        if (full.has(empNo)) continue;
        const status = String(row.status || "").trim();
        /* الموقوف والمنتهية خدمته لا يُتوقَّع لهما راتب. */
        if (/موقوف|منته|منتهي|مستقيل|إجازة بدون|inactive|terminated|suspended/i.test(status)) continue;
        /* وإجازةٌ **تغطّي الشهر كلَّه** تفسّر الغياب فتُسكته. والتغطية
           الجزئية لا تُسكت شيئًا: من كان في إجازة نصف الشهر يُتوقَّع له
           نصفُ راتب، وغيابُه بالكامل يبقى سؤالًا — بل يُقال في الملاحظة
           أن له إجازةً جزئية، فيُقرأ الغياب على وجهه لا مبتورًا. */
        const leave = leaves.get(empNo);
        if (leave && leave.full) continue;
        const partial = leave && !leave.full
          ? " وله إجازةٌ تغطّي جزءًا من الشهر لا كلَّه — فالغياب الكامل يبقى سؤالًا."
          : "";
        out.push({
          employeeRef: empNo, employeeName: row.name, field: "payroll",
          title: "على القائمة ولا راتب له هذا الشهر",
          currentValue: status || "—",
          /* بندُ مراجعةٍ لا تهمة. وللغياب أسبابٌ مشروعة كثيرة: إجازةٌ بلا
             راتب، والتحاقٌ بعد قفل المسير، وانتهاءُ خدمةٍ لم تُسجَّل في
             القائمة بعد. والحكمُ عليه خطأً من عيّنةٍ واحدة يُنتج إنذارًا
             كاذبًا يُدرّب المستخدم على تجاهل الباقي. */
          description: "يُراجَع ولا يُفترض خطأً: قد يكون في إجازةٍ بلا راتب، "
            + "أو التحق بعد قفل المسير، أو لم تُحدَّث حالتُه في القائمة." + partial,
        });
      }
      return out;
    },
  },
  {
    id: "iban_vs_list",
    needsField: { current: [{ doc: "transfer", field: "iban4" }, { doc: "employees", field: "iban4" }] },
    needs: { current: ["transfer", "employees"] },
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

  {
    id: "method_vs_channel",
    needsField: { current: [{ doc: "employees", field: "method" }] },
    needs: { current: ["full", "transfer", "cash", "employees"] },
    scope: "within_month",
    severity: "warn",
    run({ transfer, cash, employees, docs }) {
      if (!docs.employees) return [];
      const out = [];
      for (const [empNo, listed] of employees) {
        const actual = transfer.has(empNo) ? "bank" : cash.has(empNo) ? "cash" : null;
        if (!actual) continue;
        const declared = channelOf(listed.method);
        if (!declared || declared === actual) continue;
        out.push({
          employeeRef: empNo, employeeName: listed.name, field: "method",
          title: "طريقة الصرف تخالف المسجَّل في القائمة",
          previousValue: listed.method,
          currentValue: actual === "bank" ? "تحويل بنكيّ" : "نقدًا",
          description: "صُرف بقناةٍ غير المعتمدة له — أو القائمة لم تُحدَّث.",
        });
      }
      return out;
    },
  },
  {
    id: "bank_without_account",
    needsField: { current: [{ doc: "employees", field: "iban4" }] },
    needs: { current: ["transfer", "employees"] },
    scope: "within_month",
    severity: "warn",
    run({ transfer, employees, docs }) {
      if (!docs.employees) return [];
      const out = [];
      for (const [empNo, listed] of employees) {
        if (!transfer.has(empNo)) continue;
        if (listed.iban4) continue;
        out.push({
          employeeRef: empNo, employeeName: listed.name, field: "iban4",
          title: "تحويلٌ بنكيّ بلا حسابٍ مسجَّل في القائمة",
          description: "لا مرجع يُقارَن به الحساب — فتغيّره لاحقًا لن يُكتشف.",
        });
      }
      return out;
    },
  },

  /* ── العمل الإضافي ──────────────────────────────────────────────────
     كلّها تحتاج ملفّ العمل الإضافي، وغيابُه يوقفها ويُعلنها «لم تُقيَّم» —
     لا يجعل العمل الإضافيّ صفرًا. */
  {
    id: "ot_not_in_payroll",
    needs: { current: ["full", "overtime"] },
    scope: "within_month",
    severity: "critical",
    run({ full, overtime }) {
      const out = [];
      for (const [empNo, entry] of overtime) {
        if (full.has(empNo)) continue;
        /* ملفّ العمل الإضافي يسرد **كل** من له سجلُّ دوام، وأكثرُهم بصفر
           دقيقة. فمن لا دقائق له لا «عملَ إضافيًّا» له، وإعلانُه يُغرق
           الشاشة بمن لا شأن لهم: أربعةَ عشرَ من ثمانيةَ عشرَ في أغسطس. */
        const minutes = Object.values(entry.minutes).reduce((t, m) => t + Number(m || 0), 0);
        if (!minutes) continue;
        out.push({
          employeeRef: empNo, employeeName: entry.name, field: "overtime",
          title: "له عملٌ إضافيّ ولا يظهر في المسير",
          currentValue: `${entry.rows} صفًّا`,
          description: "ساعاتٌ اعتُمدت لمن لا راتب له هذا الشهر — يُراجَع قبل الإغلاق.",
        });
      }
      return out;
    },
  },
  {
    id: "ot_missing_source",
    needs: { current: ["full", "overtime"] },
    needsField: { current: [{ doc: "full", field: "otAmount" }] },
    scope: "within_month",
    severity: "warn",
    run({ full, overtime }) {
      const out = [];
      for (const [empNo, row] of full) {
        /* `null` = لا عمود عملٍ إضافيّ أصلًا؛ و0 = عمودٌ موجود بلا مبلغ.
           والفرق بينهما هو الفرق بين «لا يُفحص» و«لا شيء». */
        if (row.otAmount === null || row.otAmount === undefined) continue;
        if (!differs(row.otAmount, 0) || overtime.has(empNo)) continue;
        out.push({
          employeeRef: empNo, employeeName: row.name, field: "overtime",
          title: "مبلغُ عملٍ إضافيّ في المسير بلا مصدرٍ في ملفّ العمل الإضافي",
          currentValue: money(row.otAmount),
          description: "صُرف بلا ساعاتٍ معتمدة تقابله — أو الملفّ لا يشمله.",
        });
      }
      return out;
    },
  },
  {
    id: "ot_no_divisor",
    needs: { current: ["overtime"] },
    scope: "within_month",
    severity: "info",
    run({ overtime, divisors }) {
      /* ملاحظةٌ **واحدة** لا واحدةٌ لكل موظّف: السبب واحد — سياسةٌ عامّة
         طُبِّقت — وخمسَ عشرةَ ملاحظةً عنها كل شهر تُغرق ما يهمّ وتُدرّب على
         تجاهل التنبيه. والتفصيلُ مكانُه شاشةُ الإعدادات لا قائمةُ الملاحظات.

         ولم تعد توقّفًا: القيمة تُحسب. وتبقى **شفافيّةً** تقول بأيّ قاسمٍ
         حُسبت، فمن يراجع مبلغًا يعرف على أي أساسٍ بُني. */
      let count = 0;
      for (const [empNo, entry] of overtime) {
        if (divisors.has(empNo)) continue;
        const minutes = Object.values(entry.minutes).reduce((t, m) => t + Number(m || 0), 0);
        if (minutes) count += 1;
      }
      if (!count) return [];
      return [{
        field: "overtimeDivisor",
        title: `حُسبوا بالقاسم الافتراضيّ (${DEFAULT_DIVISOR} ساعات)`,
        currentValue: `${count} موظّفًا`,
        description: "لا قاسمَ محفوظًا لهم، فطُبِّقت السياسة العامّة. ومن يستثنيه "
          + "نظامُ الشركة بثماني ساعات يُحدَّد في إعدادات الشهر مرّةً واحدة — يبقى للشهور التالية.",
      }];
    },
  },
  {
    id: "ot_inputs_missing",
    needs: { current: ["full", "overtime"] },
    /* غيابُ عمود العمل الإضافي من الكشف علّةٌ **على مستوى الملفّ**، تُعلنها
       آليّةُ «لم تُقيَّم» مرّةً واحدة. فلا تُعاد هنا لكل موظّف. */
    needsField: { current: [{ doc: "full", field: "otAmount" }] },
    scope: "within_month",
    severity: "warn",
    run({ full, overtime }) {
      const out = [];
      for (const [empNo, entry] of overtime) {
        const minutes = Object.entries(entry.minutes)
          .filter(([m]) => SUPPORTED_MULTIPLIERS.includes(Number(m)))
          .reduce((t, [, v]) => t + Number(v || 0), 0);
        if (!minutes) continue;
        const row = full.get(empNo);
        if (!row) continue;                       // تمسكها ot_not_in_payroll
        /* ما ينقص يُسمّى، ولا يُحوَّل غيابُه صفرًا: صفرٌ هنا يُنتج «فرقًا»
           مساويًا للمبلغ كلِّه — رقمٌ مخترَع يُطارَد. */
        const missing = [];
        if (!Number(row.basic)) missing.push("الراتب الأساسي");
        if (!Number(row.gross)) missing.push("إجمالي الراتب");
        if (!missing.length) continue;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, entry), field: "overtimeInputs",
          title: "قيمةُ العمل الإضافي لم تُقيَّم — ينقصها عنصر",
          currentValue: missing.join(" · "),
          description: `له ${(minutes / 60).toFixed(2)} ساعة معتمدة، ولا تُحوَّل إلى مبلغ `
            + "ما دام أحدُ عناصر المعادلة غائبًا. والغائبُ لا يُقرأ صفرًا.",
        });
      }
      return out;
    },
  },
  {
    id: "ot_multiplier_unsupported",
    needs: { current: ["overtime"] },
    scope: "within_month",
    severity: "warn",
    run({ overtime }) {
      const seen = new Map();
      for (const [, entry] of overtime) {
        for (const [mult, mins] of Object.entries(entry.minutes)) {
          if (!Number(mins)) continue;
          if (SUPPORTED_MULTIPLIERS.includes(Number(mult))) continue;
          seen.set(mult, (seen.get(mult) || 0) + Number(mins));
        }
      }
      /* ملاحظةٌ واحدة لكل معامل لا واحدة لكل موظّف: السبب واحد. */
      return [...seen].map(([mult, mins]) => ({
        field: `overtimeMultiplier:${mult}`,
        title: `معاملُ عملٍ إضافيّ بلا صيغةٍ معتمدة: ×${mult}`,
        currentValue: `${(mins / 60).toFixed(2)} ساعة`,
        description: "الدقائق مقروءةٌ ومحفوظة، ولا تُحوَّل إلى مالٍ حتى تُقرَّ "
          + "صيغتُه. ولا تُخمَّن: صيغةٌ مخترعة تُنتج فرقًا ماليًّا مخترعًا.",
      }));
    },
  },
  {
    id: "ot_unmatched_row",
    needs: { current: ["overtime"] },
    scope: "within_month",
    severity: "warn",
    run({ docs }) {
      const orphans = ((docs.overtime && docs.overtime.rows) || []).filter((r) => !r.empNo);
      if (!orphans.length) return [];
      return [{
        field: "overtimeRows",
        title: "صفوفُ عملٍ إضافيّ بلا رقمٍ وظيفيّ",
        currentValue: `${orphans.length} صفًّا`,
        description: "لا تُطابَق بأحد — والاسم وحده لا يكفي مفتاحًا.",
      }];
    },
  },
  {
    id: "ot_duplicate_entry",
    needs: { current: ["overtime"] },
    scope: "within_month",
    severity: "warn",
    run({ overtime }) {
      const out = [];
      for (const [empNo, entry] of overtime) {
        /* التكرار الحقيقيّ: الموظّف واليوم والمصدر نفسها مرّتين. وتعدّدُ
           الأيّام أو المصادر ليس تكرارًا — وهو الشائع في هذا الملفّ. */
        const dupes = [...entry.keys].filter(([, n]) => n > 1);
        if (!dupes.length) continue;
        out.push({
          employeeRef: empNo, employeeName: entry.name, field: "overtimeDuplicate",
          title: "صفٌّ مكرّر في ملفّ العمل الإضافي",
          currentValue: dupes.map(([k, n]) => `${k} ×${n}`).slice(0, 3).join(" · "),
          description: "اليوم نفسه والمصدر نفسه أكثر من مرّة — يُحتسب مرّتين إن لم يُراجَع.",
        });
      }
      return out;
    },
  },
  {
    id: "ot_amount_mismatch",
    needs: { current: ["full", "overtime"] },
    needsField: { current: [{ doc: "full", field: "otAmount" }] },
    scope: "within_month",
    severity: "critical",
    run({ full, overtime, divisors }) {
      const out = [];
      for (const [empNo, entry] of overtime) {
        const row = full.get(empNo);
        if (!row) continue;                        // تمسكها ot_not_in_payroll
        const divisor = divisorFor(empNo, divisors);
        if (row.otAmount === null || row.otAmount === undefined) continue; // تمسكها ot_inputs_missing

        let expected = 0;
        let priced = 0;
        for (const [mult, mins] of Object.entries(entry.minutes)) {
          const multiplier = Number(mult);
          if (!SUPPORTED_MULTIPLIERS.includes(multiplier) || !Number(mins)) continue;
          const rate = overtimeRate(row, divisor, multiplier);
          if (rate === null) continue;             // ينقصه أساسيّ أو إجمالي
          expected += (Number(mins) / 60) * rate;
          priced += Number(mins);
        }
        if (!priced) continue;                     // لا دقائق مسعَّرة
        if (!differs(expected, row.otAmount)) continue;

        const delta = Number(row.otAmount) - expected;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, entry), field: "overtimeAmount",
          severity: spikeOf(expected, row.otAmount).severity === "info" ? "warn" : "critical",
          title: "قيمةُ العمل الإضافي في المسير تخالف المحسوبة من الساعات",
          previousValue: `متوقَّع ${money(expected)}`,
          currentValue: `في المسير ${money(row.otAmount)}`,
          delta: Number(money(delta)),
          description: `${(priced / 60).toFixed(2)} ساعة على قاسم ${divisor} — `
            + `أجرُ الساعة من الإجمالي زائدَ نصفِ أجر الساعة الأساسيّ.`
            + (Object.keys(entry.minutes).some((m) => !SUPPORTED_MULTIPLIERS.includes(Number(m)))
              ? " ولا يشمل معاملاتٍ بلا صيغةٍ معتمدة." : ""),
        });
      }
      return out;
    },
  },

  /* ── ② مع الشهر السابق ───────────────────────────────────────────── */
  {
    id: "iban_changed",
    needsField: { current: [{ doc: "merged", field: "iban4" }], previous: [{ doc: "merged", field: "iban4" }] },
    needs: { current: ["full"], previous: ["full"], previousAny: ["employees", "transfer"] },
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
        const spike = spikeOf(before.net, row.net);
        /* وما يفسّر الحركة: الأساسيّ والبدلات والخصم — فيُقرأ سببُ التغيّر
           مع التغيّر نفسه لا في ملاحظةٍ أخرى يبحث عنها. */
        const causes = explainParts(
          { "الأساسي": before.basic, "البدلات": before.allowances, "الخصميات": before.deductions },
          { "الأساسي": row.basic, "البدلات": row.allowances, "الخصميات": row.deductions });
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "net",
          severity: spike.severity,
          title: spike.delta > 0 ? "ارتفاع في الصافي" : "انخفاض في الصافي",
          previousValue: money(before.net), currentValue: money(row.net),
          delta: Number(money(spike.delta)),
          description: `${spikeText(spike)}.${partsSentence(causes)}`,
        });
      }
      return out;
    },
  },
  {
    id: "basic_changed",
    needsField: { current: [{ doc: "merged", field: "basic", mapped: ["basic"] }],
                  previous: [{ doc: "merged", field: "basic", mapped: ["basic"] }] },
    scope: "vs_previous",
    severity: "warn",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        const before = previous.get(empNo);
        if (!before) continue;
        if (!differs(row.basic, before.basic)) continue;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "basic",
          title: "تغيّر الراتب الأساسيّ",
          previousValue: money(before.basic), currentValue: money(row.basic),
          delta: Number(money(Number(row.basic) - Number(before.basic))),
          description: "الأساسيّ يتغيّر بقرار — لا بتسويةٍ شهرية كالبدلات.",
        });
      }
      return out;
    },
  },
  {
    id: "allowances_changed",
    needsField: { current: [{ doc: "merged", field: "allowances", mapped: ["allowancesTotal", "allowanceParts"] }],
                  previous: [{ doc: "merged", field: "allowances", mapped: ["allowancesTotal", "allowanceParts"] }] },
    scope: "vs_previous",
    severity: "info",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        const before = previous.get(empNo);
        if (!before) continue;
        if (!differs(row.allowances, before.allowances)) continue;
        const delta = Number(row.allowances) - Number(before.allowances);
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "allowances",
          /* البدل يتذبذب شهريًّا بطبيعته (انتداب، إضافيّ) — فالافتراض
             «معلومة» لا «تنبيه»، ويرتفع حين يبتلع البدلُ نصفَ الأساسيّ. */
          severity: Math.abs(delta) > Math.abs(Number(before.basic || 0)) * 0.5 ? "warn" : "info",
          title: delta > 0 ? "ارتفاع في البدلات" : "انخفاض في البدلات",
          previousValue: money(before.allowances), currentValue: money(row.allowances),
          delta: Number(money(delta)),
          description: "بدلٌ أُضيف أو رُفع.",
        });
      }
      return out;
    },
  },
  {
    id: "deductions_changed",
    needsField: { current: [{ doc: "merged", field: "deductions", mapped: ["deductionsTotal", "deductionParts"] }],
                  previous: [{ doc: "merged", field: "deductions", mapped: ["deductionsTotal", "deductionParts"] }] },
    scope: "vs_previous",
    severity: "warn",
    run({ current, previous }) {
      const out = [];
      for (const [empNo, row] of current) {
        const before = previous.get(empNo);
        if (!before) continue;
        if (!differs(row.deductions, before.deductions)) continue;
        const delta = Number(row.deductions) - Number(before.deductions);
        const moved = explainParts(before.deductionBreakdown, row.deductionBreakdown);
        /* الفرقُ الذي لا تفسّره البنود يُعلَن ولا يُلفَّق له سبب: قد يكون
           بندًا موجودًا في شهرٍ وغائبًا عن الآخر، والغائبُ **ليس صفرًا**. */
        const explained = moved.reduce((t, m) => t + m.delta, 0);
        const gap = Math.abs(delta - explained) > EPS;
        const hasParts = Object.keys(row.deductionBreakdown || {}).length
          || Object.keys(before.deductionBreakdown || {}).length;
        out.push({
          employeeRef: empNo, employeeName: nameOf(row, before), field: "deductions",
          title: delta > 0 ? "ارتفع إجمالي الخصم" : "انخفض إجمالي الخصم",
          previousValue: money(before.deductions), currentValue: money(row.deductions),
          delta: Number(money(delta)),
          description: `${delta > 0 ? "+" : ""}${money(delta)}.`
            + (hasParts ? partsSentence(moved) : " ولا بنودَ خصمٍ مفصَّلة في الملفّات لتفسيره.")
            + (gap && hasParts
              ? ` ويبقى ${money(delta - explained)} بلا تفسير من البنود — قد يكون بندًا غائبًا عن أحد الشهرين.`
              : ""),
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
    needsField: { current: [{ doc: "merged", field: "bank" }], previous: [{ doc: "merged", field: "bank" }] },
    needs: { current: ["full"], previous: ["full"], previousAny: ["employees", "transfer"] },
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
function compare({ docs, previousDocs, settings = null }) {
  const ctx = {
    docs,
    full: indexBy(docs.full),
    transfer: indexBy(docs.transfer),
    cash: indexBy(docs.cash),
    employees: indexBy(docs.employees),
    current: mergeSplit(docs),
    previous: mergeSplit(previousDocs),
    /* إعداداتُ الشهر: قاسمُ الساعة لكل موظّف، وتغطيةُ إجازته. وكلاهما
       يدخل من المستخدم — فما لم يُدخل لا يُخمَّن. */
    divisors: (settings && settings.divisors) || new Map(),
    leaves: (settings && settings.leaves) || new Map(),
    overtime: overtimeByEmployee(docs && docs.overtime),
  };

  const findings = [];
  const applied = [];
  const skipped = [];
  const notEvaluable = [];

  const has = (set, kind) => Boolean(set && set[kind]);

  /* «متوفّر» = صفٌّ واحد على الأقلّ يحمل قيمة. وعمودٌ موجودٌ فارغٌ في كل
     صفّ لا يُثبت شيئًا أكثر من عمودٍ غائب — فيُعامَل معاملته. */
  const filled = (rows, field) => (rows || []).some((r) => {
    const v = r[field];
    return v !== null && v !== undefined && v !== "";
  });
  const monthOf = (month) => (month === "previous"
    ? { docs: previousDocs, merged: ctx.previous }
    : { docs, merged: ctx.current });
  const mappedIn = (doc, keys) => {
    const mapping = (doc && doc.meta && doc.meta.mapping) || null;
    return Boolean(mapping) && keys.some((k) => mapping[k]);
  };
  const hasField = (month, spec) => {
    const { docs: monthDocs, merged } = monthOf(month);
    if (spec.mapped) {
      const names = spec.doc === "merged" ? CONTRIBUTING : [spec.doc];
      return names.some((n) => mappedIn(monthDocs && monthDocs[n], spec.mapped));
    }
    if (spec.doc === "merged") return filled([...merged.values()], spec.field);
    const doc = monthDocs && monthDocs[spec.doc];
    return Boolean(doc) && filled(doc.rows, spec.field);
  };
  /* تُبنى من `FIELD_SOURCES` لا بقائمةٍ مكتوبة بيد: نوعٌ جديد يُضاف إلى
     الخانات وينسى أحدٌ ذكرَه هنا يصير «غائبًا أبدًا»، فتتوقّف قواعدُه وهي
     متوفّرة — وتُقرأ «لم تُفحص» بينما الملفّ مرفوع. */
  const availability = (d) => {
    const out = {};
    for (const kind of FIELD_SOURCES) {
      if (kind === "merged") continue;
      out[kind] = Boolean(d && d[kind]);
    }
    return out;
  };
  const current = availability(docs);
  const previous = availability(previousDocs);
  const hasPrevious = Boolean(previousDocs && previousDocs.full);

  for (const rule of RULES) {
    /* لا شهرَ سابق أصلًا: تخطٍّ متوقَّع — أول شهرٍ في النظام لا سابق له،
       وليس نقصًا في مصدرٍ يُبلَّغ عنه. */
    if (rule.scope === "vs_previous" && !hasPrevious) { skipped.push(rule.id); continue; }

    const needs = rule.needs || DEFAULT_NEEDS;
    const missing = [];
    for (const kind of needs.current || DEFAULT_NEEDS.current) {
      if (!has(current, kind)) missing.push({ month: "current", kind });
    }
    if (rule.scope === "vs_previous") {
      for (const kind of needs.previous || DEFAULT_NEEDS.previous) {
        if (!has(previous, kind)) missing.push({ month: "previous", kind });
      }
      /* «أيٌّ من هذه» لا «كلّها»: مقارنة الحساب تكفيها قائمةُ الموظفين أو
         ملفّ التحويل — أيّهما حمل حسابًا. */
      if (needs.previousAny && !needs.previousAny.some((k) => has(previous, k))) {
        missing.push({ month: "previous", kind: needs.previousAny.join("|") });
      }
    }

    /* الحقل بعد الملفّ — و**فقط** إن كان الملفّ حاضرًا. فملفٌّ غائب سببٌ
       واحد لتوقّف القاعدة، وذكرُ أعمدته الغائبة معه يُضاعف الإبلاغ عن
       العلّة نفسها: «ينقصك ملفّ العمل الإضافي» ثمّ «وينقصك عمودٌ فيه». */
    if (missing.length) { notEvaluable.push({ rule: rule.id, scope: rule.scope, missing }); continue; }

    for (const spec of (rule.needsField || {}).current || []) {
      if (!hasField("current", spec)) missing.push({ month: "current", ...spec });
    }
    if (rule.scope === "vs_previous") {
      for (const spec of (rule.needsField || {}).previous || []) {
        if (!hasField("previous", spec)) missing.push({ month: "previous", ...spec });
      }
    }

    if (missing.length) { notEvaluable.push({ rule: rule.id, scope: rule.scope, missing }); continue; }
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
  return { findings, applied, skipped, notEvaluable };
}

module.exports = { compare, RULES, DEFAULT_NEEDS, FIELD_SOURCES, indexBy, mergeSplit, channelOf, differs, money, EPS, PCT_WARN, PCT_CRITICAL };
