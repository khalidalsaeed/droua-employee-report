# دليل تشغيل وحدة `/secure-benefits` — Phase 1

> **لم يُنفَّذ أيّ بند هنا.** كل خطوة إنتاج تحتاج قرارك وتنفيذك. الكود على الفرع يعمل بالكامل محليًّا واختباريًّا دون أن يمسّ Production.

## أ. التفعيل (بالترتيب)

| # | الخطوة | الأمر / المكان | التحقّق |
|---|---|---|---|
| 1 | إنشاء متجر Blob **خاص** جديد (مثل `medins-private`) | لوحة Vercel ← Storage ← Blob ← Create (Access: **Private**) | — |
| 2 | ضبط المتغيّرات في Production (Sensitive) | `MEDINS_GATE_SECRET`، `MEDINS_GATE_PEPPER`، `MEDINS_BLOB_READ_WRITE_TOKEN`، `MEDINS_FILE_ACTIVE_KEY_ID=k1`، `MEDINS_FILE_KEY_K1` (توليد كل سرّ: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) | — |
| 3 | فحص الإعداد محليًّا بعد `vercel env pull` | `node scripts/check-medins-config.js` | كل البنود ✓ |
| 4 | معاينة الهجرة | `node scripts/setup-medins-gate.js --dry-run` ثم `setup-medins-core.js --dry-run` | مراجعة النصّ |
| 5 | **(موصى به)** التجربة على Neon branch أولًا | الخطوتان 6 و7 بـ`DATABASE_URL` الفرع | — |
| 6 | تنفيذ الهجرة | `node scripts/setup-medins-gate.js` ثم `node scripts/setup-medins-core.js` | — |
| 7 | فحص المخطّط | `node scripts/verify-medins-schema.js` | «✓ المخطّط مطابق» (13 جدولًا) |
| 8 | منح العضويّة | `node scripts/medins-members.js grant --user <users.id> --email <email> --role editor --by <اسمك>` | `… list` |
| 9 | ضبط كلمة بوابة العضو | `MEDINS_GATE_PEPPER=<نفس قيمة الخادم> node scripts/medins-members.js set-password --user <id> --by <اسمك>` | — |
| 10 | التأكّد أن العضو محمي | `PROTECTED_USER_IDS` يحتوي معرّفه | `… list` يُظهر «محمي» |
| 11 | النشر | دمج الفرع بعد مراجعتك | — |
| 12 | Smoke test | §ج أدناه | — |
| 13 | (بعد اعتماد القائمة) زرع الكتالوج المقترح | `node scripts/seed-medins-catalog.js` (معاينة) ثم `--apply` | الإعدادات ← الكتالوج |

## ب. إدارة الأعضاء — بلا Vercel وبلا إعادة نشر

```
node scripts/medins-members.js list
node scripts/medins-members.js grant        --user <id> --email <email> --role viewer --by <اسمك>
node scripts/medins-members.js set-role     --user <id> --role editor --by <اسمك>
node scripts/medins-members.js disable      --user <id> --by <اسمك> --reason "انتهاء الحاجة"
node scripts/medins-members.js enable       --user <id> --by <اسمك>
node scripts/medins-members.js set-password --user <id> --by <اسمك>
node scripts/medins-members.js revoke-sessions --user <id> --by <اسمك>
```

- كل أمر معاملة واحدة: الصفّ وتدقيقه معًا. و`--dry-run` يعرض الاستعلامات دون اتصال.
- `disable` و`set-password` يُبطلان جلسات البوابة القائمة فورًا.
- الشرط الوحيد خارج الجدول: أن يكون العضو ضمن `PROTECTED_USER_IDS`. هذه خطوة لمرة واحدة لكل شخص، وتغيير الدور أو التعطيل بعدها لا يحتاجها.
- **لاحقًا:** شاشة داخل الوحدة لحاجة `manage_members`، على الجدول نفسه دون أي تغيير في المخطّط.

## ج. Smoke test بعد النشر

1. مستخدم غير عضو يفتح `/secure-benefits`، فيرى 404 مطابقًا لمسار غير موجود.
2. العضو يرى شاشة كلمة المرور، والكلمة الخاطئة تعطي «تعذّر فتح القسم.»، والصحيحة تفتح الوحدة.
3. الإعدادات: إضافة شركة، وموقع المقر (افتراضي)، وبند كتالوج.
4. العروض: عرض جديد، ثم فئة، ثم قيمة منفعة، ثم رفع PDF صغير، ثم تنزيله ومطابقته.
5. الـViewer: لا تظهر أزرار التعديل، والتنزيل يعمل، ويظهر `file_downloaded` في سجل التدقيق (عند الـEditor).
6. التحقّق من المتجر: رابط أيّ كائن بلا مصادقة يُرجع 403 (`scripts/check-blob-private.js` بتوكن الوحدة).

## د. الطوارئ والتراجع

| المستوى | الإجراء | الأثر على البيانات |
|---|---|---|
| إخراج شخص فورًا | `medins-members.js disable --user <id>` | لا شيء |
| إخراج الجميع | تدوير `MEDINS_GATE_SECRET` + إعادة نشر، أو `UPDATE medins_gate_sessions SET revoked_at = now() WHERE revoked_at IS NULL` | لا شيء |
| إخفاء الوحدة كليًّا | حذف `MEDINS_GATE_SECRET` + إعادة نشر (404 للجميع) | لا شيء |
| تراجع الكود | `git revert` لكومِتات Phase 1. سطر التفويض والـrewrites يُزالان، و`/secure-benefits` يصبح 404 | الجداول تبقى خاملة |
| حذف البيانات نهائيًّا | `node scripts/teardown-medins.js` (معاينة) ثم `--confirm-drop-all-medins-data` | **يتلف بيانات الوحدة كلّها**، ولا يمسّ غير `medins_*` |
| حذف الملفّات | حذف المتجر الخاص من لوحة Vercel | لا يمسّ متجرَي أجير وDroua |

Droua وأجير لا يتأثّران بأيّ مستوى: لم يتغيّر فيهما سطر، واختبار في CI يفشل إن لمس الفرع ملفّاتهما.
