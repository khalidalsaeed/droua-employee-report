# التذكيرات

قسم في الصفحة الرئيسية (`#remindersSec`) حلّ محلّ «الوثائق القادمة على انتهاء الصلاحية». جدول موحّد: كل وثيقة لها تاريخ انتهاء صفٌّ مستقلّ.

الملفات: `reminders.js` (المنطق النقيّ + الرسم)، `reminders.css`، والربط في `app-shell.html`. الاختبارات: `test/reminders.test.js` و`test/reminders-ui.test.js` (Playwright، يُتخطّى إن لم يتوفّر).

## مصادر البيانات — Aggregation بلا جدول جديد

| النوع | المصدر | الربط بالموظف | الإصدار | المستند | صلاحية العرض |
|---|---|---|---|---|---|
| الإقامة | `employees.data["تاريخ انتهاء الإقامة"]` ← `/api/data/employees` | `eid` | `تاريخ اصدار الاقامة` | `ملف الإقامة` (نموذج التعديل) | `employees:view` |
| رخصة العمل | `employees.data["تاريخ انتهاء رخصة العمل"]` (تُستبعد «جاري السداد») | `eid` | لا | `ملف رخصة العمل` | `employees:view` |
| جواز السفر | `employees.data["تاريخ انتهاء الجواز"]` | `eid` | لا | لا | `employees:view` |
| تصريح أجير | `ajeer_permits.expiry_date` ← `/api/data/permits` (الأحدث لكل إقامة) | رقم الإقامة | `issue_date` | PDF + QR | `ajeer:view` |
| البطاقة البلدية | `municipal-cards/index.json` (Blob خاصّ) ← `/api/data/municipal-cards` | `employeeEid` | لا | وجه الشهادة + QR | `municipal:view` |
| تأشيرة السفر | `employee_travel.visa_expiry_date` ← `/api/data/staff-travel` (الرحلات غير المنتهية بالعودة) | `staff_directory` (موظفو أجير بـ`eid`) | لا | لا | `staff_travel:view` |

لا يظهر نوع في الفلتر إلا إن كان المستخدم يملك عرضه ووُجد له سجلّ واحد على الأقل بتاريخ انتهاء.

## الصلاحيات

- الخادم يرفض بيانات القسم بلا صلاحية عرضه (403 ⇒ لا بيانات).
- `Reminders.build` يُسقط النوع كاملًا بلا صلاحيته — لا صفّ ولا عدّ.
- الإجراءات: التجديد `ajeer:manage` / `municipal:manage`؛ «تحديث البيانات» `employees:edit` (نموذج التعديل القائم، رفع المستند يستخرج التاريخ)؛ «عرض الموظف» `employees:view`؛ التأشيرة رابط `/staff-travel.html`.

## الحالات والترتيب

اليوم بتوقيت الرياض، ويوم الانتهاء يوم تقويمي (`dayKey`). منتهي (<0) · عاجل (0–10) · قريب الانتهاء (11–30) · تحت المتابعة (31–90) · ساري (>90، يظهر في «مدة محددة» فقط). الترتيب بالأيام المتبقية تصاعديًا: الأقدم انتهاءً أولًا.

المدة: جميع الحالات (المنتهية + 90 يومًا)، هذا الأسبوع (الأحد–السبت)، هذا الشهر، الشهر القادم، مدة محددة.

## التحديث بعد التجديد

- أجير: `openAjeerRenew` ← `refreshPermits()` ← `renderDashboardTop()` ← `Reminders.update({permits})`.
- البلدية: `applyRenewed` / `reload` في `municipal-cards.js` ← `onItems` ← `Reminders.update({municipal})`.
- تعديل موظف: `refreshEmployees()` ← `renderDashboardTop()`.

البحث والفلاتر تبقى كما هي عبر التحديث.
