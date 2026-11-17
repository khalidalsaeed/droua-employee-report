/* تجديد تصريح أجير من الواجهة: رفع التصريح الجديد على بطاقة الموظف.
   =========================================================================
   تجديد أجير يُصدر رقم تصريح جديدًا (lib/data/permits.js)، فالذي يُجدَّد هو
   العامل لا التصريح. لذلك «الاستبدال» هنا:
     - صفّ جديد في ajeer_permits بالتصريح الجديد وملفّه ورمزه (permits.create)،
       فيُسجَّل في ajeer_permit_history حدث renewed بالتصريح السابق وانتهاءيه
       ومن جدّده — البنية القائمة نفسها التي يقرأ منها التقرير الشهري.
     - الصفّ السابق يبقى كما هو (أثرًا بملفّه)، والواجهة تعرض الأحدث لكل
       إقامة (DocStatus.latestPermits) — فرمز التصريح السابق لا يظهر رمزًا
       فعّالًا بعد التجديد.
   لا هجرة ولا عمود جديد.

   المطابقة بمفتاح أجير القائم: رقم الهوية/الإقامة المطبوع على التصريح =
   iqama التصريح الحالي (وهو مفتاح ربط التصاريح بالموظفين). الاسم تعزيز فقط
   ويُقارن بالاسم المطبوع على التصريح السابق (لاتيني باللاتيني).

   الملفّ يُرفع بعد نجاح كل الفحوص فقط، وبمسار رفع أجير نفسه (lib/blob.js)،
   ويُحذف إن فشل إنشاء السجلّ. الرابط لا يعود في الاستجابة. */

const crypto = require("crypto");
const { extractAjeerPermit } = require("./extractPermit");
const { decideRenewal, riyadhToday } = require("../renewal/rules");

const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function renewAjeerPermit({ permitNo, pdf, actor, sql, permits, upload, remove, today }) {
  const t = today || riyadhToday();
  const currentPermit = await permits.get(permitNo);
  if (!currentPermit) return { ok: false, httpStatus: 404, stage: "read", reason: "not_found", message: "التصريح غير موجود" };

  const extracted = await extractAjeerPermit(pdf);
  const p = extracted.permit || {};

  const employeeRows = await sql`SELECT eid, iqama, name FROM employees WHERE iqama = ${String(currentPermit.iqama)} LIMIT 1`;
  const employee = employeeRows[0] || null;
  const otherRows = p.idNumber ? await sql`SELECT eid, iqama, name FROM employees WHERE iqama = ${p.idNumber} LIMIT 2` : [];
  /* رقم تصريح أو رمز مسجّل في أي صفّ = المستند مسجّل مسبقًا. */
  const known = p.permitNo || p.qrText
    ? await sql`SELECT permit_no FROM ajeer_permits WHERE permit_no = ${p.permitNo || ""} OR (qr_text IS NOT NULL AND qr_text = ${p.qrText || ""}) LIMIT 1`
    : [];

  const verdict = decideRenewal({
    kind: "ajeer",
    current: {
      docNumber: currentPermit.permit,
      expiryDate: currentPermit.expiryDate,
      nameOnDoc: currentPermit.nameOnPermit,
      /* المفتاح القائم: iqama التصريح الحالي. سجلّ الموظف للاسم وحده. */
      employee: { eid: employee ? String(employee.eid) : null, name: employee ? employee.name : null, iqama: currentPermit.iqama },
      knownDocNumbers: known[0] ? [p.permitNo] : [],
    },
    extracted: {
      ok: extracted.ok,
      reason: extracted.reason,
      docNumber: p.permitNo,
      idNumber: p.idNumber,
      name: p.name,
      expiryDate: p.endDate,
      qrOk: !!(p.qrText && p.qrOfficial),
    },
    fileHash: sha256hex(pdf),
    otherEmployee: otherRows.length === 1 ? otherRows[0] : null,
    today: t,
  });
  if (!verdict.ok) return { ...verdict, httpStatus: 422 };
  /* الواجهة تعرض لكل إقامة التصريح الأحدث إصدارًا (DocStatus.latestPermits)،
     فتصريح بلا تاريخ بداية، أو يبدأ في يوم بداية الحالي أو قبله، كان سيبقي
     التصريح السابق معروضًا بعد «التجديد». يُرفض بدل أن يُكتب. */
  if (!p.startDate) return { ok: false, httpStatus: 422, stage: "verify", reason: "no_start", message: "تعذّر قراءة تاريخ بداية التصريح من المستند" };
  if (currentPermit.issueDate && p.startDate <= currentPermit.issueDate) {
    return { ok: false, httpStatus: 422, stage: "verify", reason: "not_newer", message: "تاريخ بداية التصريح المرفوع ليس بعد بداية التصريح الحالي", previousExpiry: currentPermit.expiryDate, newExpiry: p.endDate };
  }

  /* ── الكتابة ── */
  const url = await upload(`ajeer-permits/${p.permitNo}/${Date.now()}-renewal.pdf`, pdf, "application/pdf");
  let item;
  try {
    item = await permits.create({
      permit: p.permitNo,
      iqama: currentPermit.iqama,
      nameOnPermit: p.name || currentPermit.nameOnPermit || null,
      issueDate: p.startDate || null,
      expiryDate: p.endDate,
      file: url,
      qrText: p.qrText,
    }, actor, {
      source: "permit_renewed",
      /* سجلّ لا يعرف سابقًا لهذا العامل (تصاريح أقدم من الجدول): التصريح
         الحالي هو السابق. */
      fallbackPrevious: { permit_no: currentPermit.permit, expiry: currentPermit.expiryDate },
    });
  } catch (err) {
    await remove(url);
    throw err;
  }

  return {
    ok: true,
    item,
    summary: {
      kind: "ajeer",
      employeeName: (employee && employee.name) || p.name || null,
      documentLabel: "تصريح أجير",
      previousNumber: currentPermit.permit,
      newNumber: p.permitNo,
      previousExpiry: verdict.previousExpiry,
      newExpiry: verdict.newExpiry,
      extendedDays: verdict.extendedDays,
      daysLeft: verdict.daysLeft,
      nameMatch: verdict.nameMatch,
    },
  };
}

module.exports = { renewAjeerPermit };
