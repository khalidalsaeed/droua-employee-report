# متابعة موظفي ذروة — متابعة السفر

صفحة مستقلّة عن أجير: `/staff-travel.html`، وتظهر في الدرج ضمن «أقسام هذه الصفحة» بعد «الموظفون».

> **التسمية:** كلمة `droua` محجوزة لقسم المراجعة المخفي — اختبارات العزل تمنعها في الروابط العامّة وأسماء ملفّات `.html` و`api/app.js`. لذلك: الصفحة `staff-travel`، الصلاحية `staff_travel:*`، الجدول `employee_travel`.

## الملفّات

| الملفّ | الدور |
|---|---|
| `staff-travel-status.js` | المصدر الوحيد للحالات والشارات والتنبيهات والملخّص والتحقّق (متصفّح + خادم + اختبارات) |
| `staff-travel-shell.html` · `staff-travel.js` · `staff-travel.css` | الصفحة |
| `lib/data/staffTravel.js` | القراءة والكتابة على الجدول، ورفض التداخل، والموظف من السجلّ |
| `api/app.js` → `handleStaffTravel` | `GET/POST/PUT/DELETE /api/data/staff-travel` |
| `scripts/setup-staff-travel.js` | الهجرة (**لم تُشغَّل — بانتظار الاعتماد**) |
| `test/staff-travel.test.js` | 26 اختبارًا |

لا دالّة خادمة جديدة (يبقى العدد 2)، ولا اعتماديات جديدة.

## قاعدة البيانات — `employee_travel` (بانتظار الاعتماد)

| العمود | النوع | ملاحظة |
|---|---|---|
| `id` | bigserial PK | |
| `employee_eid` | text NOT NULL | FK → `employees(eid)` (text NOT NULL + UNIQUE `employees_eid_key` — مُتحقَّق منه على القاعدة) ON UPDATE CASCADE **ON DELETE RESTRICT** |
| `start_date` · `end_date` · `visa_expiry_date` | date NOT NULL | CHECK `end_date >= start_date` |
| `visa_number` · `visa_type` · `destination` · `notes` | text NULL | حدود طول 40 / 60 / 120 / 1000 |
| `return_confirmed_at` · `return_confirmed_by` | timestamptz · text NULL | تأكيد العودة الفعلية — شرط حالة «عاد» |
| `created_by` · `created_by_name` · `updated_by` | text | بلا FK (حسابات البيئة لا صفّ لها في users) |
| `created_at` · `updated_at` | timestamptz DEFAULT now() | |

فهارس: `(employee_eid, start_date DESC)` · `(end_date)` · `(visa_expiry_date)`.

العلاقة: Employee → Many Travel Records. التداخل بين رحلتين للموظف نفسه يُرفض في التطبيق.

**RESTRICT لا CASCADE:** سجلّ السفر تاريخيّ. حذف موظف له رحلات يُرفض (409 برسالة عربية) بدل أن يمحو رحلاته ضمنًا؛ ولا حاجة لـSET NULL ولقطة اسم لأن صفّ الموظف يبقى دائمًا.

```bash
node scripts/setup-staff-travel.js --dry-run     # معاينة بلا اتّصال
node scripts/setup-staff-travel.js               # التطبيق (بعد الاعتماد فقط)
node scripts/setup-staff-travel.js --rollback --yes   # التراجع: DROP TABLE employee_travel
```

قبل إنشاء الجدول: الصفحة تعرض تنبيهًا وتُعطّل الإضافة، وتتيح «عرض بيانات تجريبية» (أسماء وهمية في المتصفّح فقط — لا طلب كتابة واحد). وكذلك `?demo=1`.

## الحالات التلقائية (لا تُخزَّن)

| الحالة | الشرط | اللون |
|---|---|---|
| مجدولة | البداية بعد أكثر من `SOON_DAYS` | رمادي مزرقّ |
| قريب السفر | البداية خلال `SOON_DAYS` (افتراضي 7) | ذهبي |
| مسافر | البداية ≤ اليوم ≤ النهاية (يوم النهاية: حتى تُؤكَّد العودة) | أخضر |
| بانتظار تأكيد العودة | مضت النهاية ولم تُؤكَّد العودة | أحمر |
| عاد | أُكِّدت العودة | أزرق |

**قاعدة «عاد»:** مرور تاريخ النهاية لا يكفي. تصير الرحلة «عاد» بأحد ثلاثة: (1) زرّ «تأكيد العودة» — متاح من يوم النهاية، والعودة المبكرة تُسجَّل بتعديل تاريخ النهاية؛ (2) رحلة تُسجَّل بعد انتهائها — يؤكّد مُدخِلها عودتها عند الإضافة ويُحفظ اسمه؛ (3) بدأت للموظف رحلة لاحقة فعلًا — عودة ضمنية تُحسب عند العرض ولا تُكتب. تمديد النهاية إلى ما بعد اليوم يُسقط التأكيد. «اليوم» بتوقيت الرياض في الخادم.

العتبات في `StaffTravel.DEFAULTS` (`SOON_DAYS` 7، `RETURN_SOON_DAYS` 7، `VISA_SOON_DAYS` 30، `VISA_URGENT_DAYS` 7)، ويمكن تجاوزها بمفتاح `staff_travel_thresholds` في جدول `settings`.

## التنبيهات (داخل الصفحة)

سفر خلال 7 أيام · عودة خلال 7 أيام · تأشيرة تنتهي خلال 30 يومًا · تأشيرة منتهية · تأشيرة تنتهي قبل موعد العودة · تجاوز تاريخ العودة دون تأكيد (لآخر رحلة فقط؛ رحلة تُسجَّل بعد انتهائها مؤكَّدة ضمنًا).

## الصلاحيات

`staff_travel:view|create|edit|delete`. Owner/Admin الكل، HR الكل، Viewer وFinance لا شيء. الصفحة محروسة في الخادم (`PAGE_PERMISSION`)، وكل طلب API يُفحص، وتأكيد العودة يتطلّب `edit`.

## الأمان

لا بيانات حقيقية في Git، ولا تخزين ملفّات، ولا `localStorage`. سجلّ التدقيق يحمل المعرّف ورقم الموظف فقط — لا رقم تأشيرة. دليل الموظفين في الاستجابة مختصر (الاسم، الرقم، المهنة، الإقامة، الجواز) بلا رواتب ولا حسابات.

## التراجع

- الشيفرة: `git revert` لالتزامات الفرع (أو عدم الدمج).
- القاعدة (إن طُبّقت الهجرة): `node scripts/setup-staff-travel.js --rollback --yes` — الجدول طرفٌ لا يعتمد عليه شيء.
