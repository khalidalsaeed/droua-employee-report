# سجل تنفيذ Phase 1 — وحدة مقارنة التأمين الطبي

> نُفِّذ محليًّا على الفرع فقط: لا Production، ولا Migration على Production، ولا Deploy، ولا PR. Droua وأجير بلا أيّ تغيير.

## 1. ما بُني

| الطبقة | الملفّات |
|---|---|
| طبقة الأمن المشتركة | `lib/secure-kit/` — 13 وحدة عامّة (token، password، config، sessions، rateLimit، audit، context، http، keyring، store، authz، gate، identifiers) |
| الوحدة | `lib/medins/` — config، limits، members، security، router، routes، validate، files، `data/*` (insurers، offers، classes، catalog، benefits، terms، locations، auditView)، `views/*`، catalogProposal |
| التوجيه | `api/app.js` (+14 سطرًا: دالّة مطابقة + سطر تفويض كسول)، `vercel.json` (+2 rewrite) |
| التهيئة | `scripts/setup-medins-gate.js`، `setup-medins-core.js`، `verify-medins-schema.js`، `teardown-medins.js`، `check-medins-config.js`، `medins-members.js`، `seed-medins-catalog.js`، `lib/medins-migrate.js` |
| الاختبارات | 10 ملفّات + مساعدان (`medins-harness`، `psql-sql`) |

## 2. انحرافات عن العقد (كلّها بقرارك أو لصالح الأمان)

1. **العضويّة في القاعدة لا في البيئة (D1):** جدول `medins_members` (الدور، والتفعيل، وهاش كلمة البوابة لكل عضو)، يُدار بسكربت الآن وبشاشة لاحقًا. الحساب المحميّ شرطٌ إضافي يُفحص **بلا قاعدة** قبل أي استعلام.
2. **الكتالوج غير مزروع (D7):** الهجرة تُنشئ الجدول فارغًا. البنود تُضاف من الواجهة، والقائمة المقترحة في سكربت مستقل لا يكتب بلا `--apply`.
3. **قيم المنافع بعمود لكل نوع** (`amount`، `percent`، `bool`، `count`، `text`) مع قيد `num_nonnulls` = 1 لـknown و0 لغيره. بندٌ مثل «20% بحدٍّ أقصى 75» صار بندين قابلين للمقارنة.
4. **التنزيل جزءًا جزءًا** (حدّ ردّ Vercel 4.5MB): كل جزء يُتحقّق من وسمه على الخادم قبل إرساله، والمتصفّح يجمع ويتحقّق من sha256 قبل الحفظ.
5. **الفلفل إلزامي** (`MEDINS_GATE_PEPPER`)، لأن الهاشات في القاعدة.

## 3. مصفوفة الصلاحيات

| | Editor | Viewer |
|---|:-:|:-:|
| فتح القسم، وعرض العروض والفئات والقيم والشروط والملفّات والمواقع والكتالوج | ✅ | ✅ |
| تنزيل الملفّات الأصلية (كل جزء يُدقَّق `action=download`) | ✅ | ✅ |
| إنشاء أو تعديل أو أرشفة أو حذف (شركات، عروض، فئات، قيم، شروط، كتالوج، مواقع) | ✅ | ❌ 403 + تدقيق |
| رفع الملفّات وحذفها، والاعتماد وتغيير الحالة | ✅ | ❌ |
| سجل التدقيق | ✅ | ❌ |
| إدارة الأعضاء | سكربت فقط (Phase 1) | — |

المصدر الوحيد: `lib/medins/routes.js` (37 مسارًا + 3 مسارات للبوابة، كلٌّ بحاجته). اختبارٌ يمرّ عليها كلها آليًا بالدورين.

## 4. أحداث التدقيق (`medins_audit`)

`access_denied` · `section_opened` · `gate_unlock_success` · `gate_unlock_failed` (reason: bad_password / no_password) · `gate_locked_out` · `gate_locked` (خروج) · `forbidden_action` · `insurer_created|updated|archived|unarchived` · `offer_created|updated|deleted|status_changed` · `class_created|updated|deleted` · `catalog_item_created|updated` · `benefit_value_changed` (code + fromStatus → toStatus) · `benefit_values_verified` · `term_created|updated|deleted` · `file_upload_started|completed|rejected|expired` · `file_downloaded` (action=download، fileId، offerId، partIndex، المستخدم، الوقت) · `file_deleted` · `blob_orphan` · `blob_stale` · `location_created|updated` · `member_granted|role_changed|disabled|enabled|password_set|sessions_revoked` (من السكربت)

**قائمة meta مسموحة:** معرّفات وتصنيفات فقط. لا أسماء ملفّات، ولا مبالغ، ولا نصوص منافع أو شروط، ولا أسماء شركات، ولا كلمات مرور أو هاشات. اختبار التكامل يفحص ذلك على صفوف حقيقية.

## 5. القائمة المقترحة للكتالوج (18 بندًا — بانتظار اعتمادك)

| # | الرمز | البند | النوع | الأفضل |
|---|---|---|---|---|
| 1 | `annual_limit` | الحد السنوي للمستفيد | مبلغ SAR | الأعلى |
| 2 | `inpatient_covered` | التنويم مغطّى | نعم/لا | الأعلى |
| 3 | `room_type` | نوع الغرفة / الإقامة | نص | — |
| 4 | `inpatient_copay_pct` | نسبة التحمّل في التنويم | نسبة | الأقل |
| 5 | `outpatient_covered` | العيادات الخارجية مغطّاة | نعم/لا | الأعلى |
| 6 | `outpatient_copay_pct` | نسبة التحمّل في العيادات | نسبة | الأقل |
| 7 | `copay_cap_per_visit` | الحد الأعلى للتحمّل للزيارة | مبلغ SAR | الأقل |
| 8 | `emergency_covered` | الطوارئ مغطّاة | نعم/لا | الأعلى |
| 9 | `dental_limit` | حد الأسنان | مبلغ SAR | الأعلى |
| 10 | `optical_limit` | حد النظارات | مبلغ SAR | الأعلى |
| 11 | `maternity_limit` | حد الحمل والولادة | مبلغ SAR | الأعلى |
| 12 | `chronic_covered` | الأمراض المزمنة مغطّاة | نعم/لا | الأعلى |
| 13 | `preexisting_covered` | الأمراض السابقة / القائمة | نعم/لا | الأعلى |
| 14 | `physiotherapy_sessions` | جلسات العلاج الطبيعي في السنة | عدد (session) | الأعلى |
| 15 | `pharmacy_copay_pct` | نسبة التحمّل في الأدوية | نسبة | الأقل |
| 16 | `mental_health_covered` | العلاج النفسي مغطّى | نعم/لا | الأعلى |
| 17 | `medical_evacuation_covered` | الإخلاء الطبي مغطّى | نعم/لا | الأعلى |
| 18 | `out_of_network_covered` | التغطية خارج الشبكة | نعم/لا | الأعلى |

«الاستثناءات والملاحظات الخاصة» ليست بندًا هنا: مكانها جدول الشروط (`medins_offer_terms`)، نصوصًا بخطورة 0–3 ومصدر.

## 6. الاختبارات

- **قبل:** 523 (كلها ناجحة بعد `npm ci`).
- **بعد:** 615.
  - **بلا Postgres:** 609 ناجحة و6 متخطّاة (ملف التكامل).
  - **مع Postgres 16 محلي مؤقت** (`MEDINS_TEST_PG_URL`): **615/615**.
- لم يُعدَّل أيّ اختبار قائم.
- **تجربة متصفّح فعلية (Chromium) عبر api/app.js:** دورة المحرّر كاملة، ورفع PDF من 3MB على جزأين، وتنزيله من المحرّر والمشاهد مطابقًا بايتًا ببايت، والمشاهد بلا أدوات تعديل، وصفر أخطاء في الصفحة.

## 7. Serverless Functions

**2** كما هي (`api/app.js`، `api/cron/check-expirations.js`)، ومفروض باختبارين. لا cron جديد، ولا إعداد دالّة جديد، ولا dependency جديدة.

## 8. مخاطر متبقّية

| الخطر | الوضع |
|---|---|
| تنفيذان مؤقّتان للمنطق الأمني (Droua وsecure-kit) | مقيَّدان باختبار تكافؤ (16 حالة). نقل Droua تاسك مستقل |
| فرق زمنيّ للحساب **المحمي غير العضو** (رحلتا قاعدة قبل 404) | لا يراه إلا حاملو الحماية، وهم قلّة. وكل من سواهم يُرفض بلا قاعدة |
| الحساب المحمي ما زال مُجمَّدًا في إدارة المستخدمين (سلوك المنصّة القائم، لم يُمسّ) | العضويّة نفسها لم تعد تحتاج Vercel |
| حدود الأرقام في موضعين (limits.js وقيود SQL) | اختبار يقارنهما |
| الواجهة صفحة واحدة مضمَّنة (~42KB) | تُقسَّم عند نموّ Phase 2/3 |
