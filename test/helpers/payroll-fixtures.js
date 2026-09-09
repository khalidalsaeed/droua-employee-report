/* عيّنات رواتب **مصنوعة بالكامل**.
   =========================================================================
   ⛔ لا بيان حقيقيّ هنا: أسماءٌ مخترعة، وأرقامٌ وظيفية متسلسلة، وحسابات
   بنكية بصيغةٍ سليمة الشكل لا تخصّ أحدًا. والغرض إثبات المنطق لا محاكاة
   ملفّ الشركة.

   والبناء من مصفوفات لا من ملفّات على القرص: العيّنة تُقرأ في الاختبار
   نفسه، فيُرى ما يُقارَن. */

const EMPLOYEES = [
  { empNo: "1001", name: "أحمد المثال", jobTitle: "محاسب", status: "نشط", iban: "SA0380000000608010167519" },
  { empNo: "1002", name: "سارة التجريبية", jobTitle: "إدارية", status: "نشط", iban: "SA4420000001234567891234" },
  { empNo: "1003", name: "خالد الوهمي", jobTitle: "فنّي", status: "نشط", iban: "SA1010000009876543210987" },
  { empNo: "1004", name: "نورة الافتراضية", jobTitle: "مشرفة", status: "نشط", iban: "SA5530000005555666677778" },
];

const csv = (header, rows) =>
  [header.join(","), ...rows.map((r) => r.map((c) => {
    const s = String(c === null || c === undefined ? "" : c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n") + "\n";

/* مسير كامل: رقم، اسم، أساسي، بدلات، استقطاعات، صافٍ. */
function fullCsv(rows) {
  return csv(["رقم الموظف", "الاسم", "الراتب الأساسي", "البدلات", "الاستقطاعات", "الصافي"],
    rows.map((r) => [r.empNo, r.name, r.basic, r.allowances || 0, r.deductions || 0,
      r.net === undefined ? r.basic + (r.allowances || 0) - (r.deductions || 0) : r.net]));
}

/* مسير تحويل: يحمل الحساب والبنك. */
function transferCsv(rows) {
  return csv(["رقم الموظف", "الاسم", "الايبان", "البنك", "الصافي"],
    rows.map((r) => [r.empNo, r.name, r.iban, r.bank || "بنك تجريبيّ", r.net]));
}

function cashCsv(rows) {
  return csv(["رقم الموظف", "الاسم", "الصافي"], rows.map((r) => [r.empNo, r.name, r.net]));
}

function employeesCsv(rows = EMPLOYEES) {
  return csv(["رقم الموظف", "الاسم", "المسمى الوظيفي", "الحالة", "رقم الحساب"],
    rows.map((r) => [r.empNo, r.name, r.jobTitle, r.status, r.iban]));
}

/* شهرٌ متّسق تمامًا: الكامل = التحويل + الكاش، والقائمة تطابق. */
function consistentMonth(over = {}) {
  /* `salaries` يستبدل المجموعة كلّها ولا يُدمج: الدمج كان يُبقي موظّفًا
     ظنّ الاختبارُ أنه أزاله — وعيّنةٌ تكذب أسوأ من اختبارٍ يسقط. */
  const salaries = over.salaries || { 1001: 9000, 1002: 7500, 1003: 6000, 1004: 8200 };
  const cashOnly = over.cashOnly || ["1003"];
  /* موظّفٌ خارج القائمة الثابتة يُولَّد له اسمٌ وحساب — فتُبنى حالات
     «اسمٌ جديد» بلا توسيع القائمة الأصلية. */
  const emp = (no) => EMPLOYEES.find((e) => e.empNo === no)
    || { empNo: no, name: `موظّف ${no}`, jobTitle: "—", status: "نشط", iban: `SA00000000000000000${no}` };
  const list = Object.keys(salaries);

  const full = list.map((no) => ({
    empNo: no, name: emp(no).name, basic: salaries[no], allowances: 0,
    deductions: (over.deductions || {})[no] || 0,
  }));
  const netOf = (no) => salaries[no] - ((over.deductions || {})[no] || 0);
  const transfer = list.filter((no) => !cashOnly.includes(no))
    .map((no) => ({ empNo: no, name: emp(no).name, iban: (over.ibans || {})[no] || emp(no).iban, net: netOf(no) }));
  const cash = list.filter((no) => cashOnly.includes(no))
    .map((no) => ({ empNo: no, name: emp(no).name, net: netOf(no) }));

  return {
    full: fullCsv(full),
    transfer: transferCsv(transfer),
    cash: cashCsv(cash),
    employees: employeesCsv(list.map(emp).concat(over.keepAll ? EMPLOYEES.filter((e) => !list.includes(e.empNo)) : [])),
  };
}

module.exports = { EMPLOYEES, csv, fullCsv, transferCsv, cashCsv, employeesCsv, consistentMonth };
