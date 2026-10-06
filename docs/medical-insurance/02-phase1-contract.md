# عقد تنفيذ Phase 1 — وحدة «مقارنة التأمين الطبي» (`/secure-benefits`)

> **الحالة:** عقد للمراجعة فقط. لم يُعدَّل أيّ ملف، ولم تُنفَّذ Migration، ولم يُلمس Production ولا أجير ولا Droua.
> **خط الأساس:** بعد `npm ci` (تثبيت الحزم المقفلة، دون تغيير أيّ ملف متتبَّع) نجحت الاختبارات **523/523**.
> **التاريخ:** 2026-10-06

> **تعديلٌ معتمد بعد هذا العقد (قرار D1):** العضويّة والأدوار وكلمات مرور البوابة **ليست** في متغيّرات البيئة كما يرد أدناه في §6 و§9،
> بل في جدول `medins_members` يُدار بـ`scripts/medins-members.js` (ولاحقًا من شاشة داخل الوحدة). الحساب المحميّ (`PROTECTED_USER_IDS`)
> يبقى شرطًا إضافيًا للهويّة. وكتالوج المنافع **لا يُزرع** في الهجرة (D7). التنفيذ الفعلي موثَّق في `04-phase1-implementation.md`.

---

## 0. ما تغيّر عن Phase 0 بناءً على مراجعتك

| البند | القرار |
|---|---|
| نسخ حماية Droua | **ملغى.** أبني طبقة أمن مشتركة عامّة باسم `lib/secure-kit/`، تعمل بالـnamespace، وتستخدمها الوحدة الجديدة وحدها الآن. يبقى Droua دون أيّ تغيير، ونقله إلى هذه الطبقة تاسك لاحق مستقل (§1). |
| الأدوار | Editor وViewer، من قوائم في متغيّرات البيئة، دون نظام مستخدمين جديد (§9). |
| Must-have | فاقد الـMust-have غير مؤهّل لتوصيتَي «أفضل تغطية» و«أفضل توازن»، ويبقى ظاهرًا وله Score ويمكن أن يظهر كالأرخص. التنفيذ في Phase 2. |
| مدة الجلسة | 15 دقيقة خمول و60 حدًّا أقصى، قابلة للضبط من مكان واحد (§6). |
| Leaflet | حزمة npm في Phase 3 فقط. **صفر dependencies في Phase 1** (§14). |
| الخرائط والمسارات | مزوِّد البلاطات ومزوِّد المسارات قابلان للتبديل، ولا يُثبَّت أيّ مزوّد قبل اختبار فعلي. لا مسافات إطلاقًا في Phase 1. |
| مسافة الطريق | لا «تقدير بمعامل». في Phase 3 المسافة الوحيدة هي «مسافة تقريبية بخط مستقيم»، ومسافة الطريق في Phase 4 من مزوّد حقيقي مع المصدر وتاريخ الحساب. |
| مقرّ الشركة | جدول `medins_company_locations` من Phase 1 (label وlatitude وlongitude وactive)، دون أيّ إحداثيات في الكود. |
| الأولوية | الأولوية خاصة بالشركة لا بالمنشأة: جدول `company_provider_priority` منفصل في Phase 2. لا عمود `insurance_company` في Provider. |
| البيانات الناقصة | التمييز بين `0` و`unknown` و`not_applicable` مفروض في **قيود القاعدة** من Phase 1 (§4). |

---

## 1. طبقة الأمن المشتركة: أقل تكرار آمن

### الخيارات التي فحصتها

| الخيار | التكرار | خطر على Droua | الحكم |
|---|---|---|---|
| أ. نسخ وحدات Droua حرفيًا | قرابة 600–1000 سطر نسخة ثانية | صفر | **مرفوض منك**، ودَين تقني حقيقي |
| ب. استيراد وحدات Droua مباشرة من الوحدة الجديدة | صفر للأجزاء الخالصة | صفر الآن | **لا يكفي:** الخالص فيها صغير (اشتقاق كلمة المرور، وتحليل الهاش، ودالّة العتبات، وبصمة IP: قرابة 100 سطر). والباقي مربوط بأسماء Droua حرفيًا: `TOKEN_TYPE = "droua-gate"`، وجداول `droua_gate_*`، وبادئة AAD، ومتغيّرات `DROUA_*`. فلا يُستعمل دون تعديله، والتعديل ممنوع. كما يجعل الوحدة تابعة لداخليات قسم آخر |
| ج. **طبقة عامّة جديدة + اختبارات تكافؤ مع Droua** ✅ | الطبقة تنفيذ ثانٍ **مؤقت** مقيَّد آليًا بـDroua (انظر أدناه) | **صفر:** لا يُلمس سطر في Droua | **الموصى به** |
| د. استخراج الطبقة الآن ونقل Droua إليها | صفر | **حقيقي:** Droua يعمل في Production على ملفّات مشفَّرة وجلسات حيّة. أيّ انحراف في صيغة التوكن أو الـAAD أو نصّ SQL يعني قفل الوصول أو ملفّات لا تُفك | مؤجَّل إلى تاسك مستقل بعد Phase 1 |

### لماذا الخيار ج لا يكرّر مشكلة «يصلحها في واحد وينساها في الثاني»
**اختبار التكافؤ (`test/secure-kit-parity.test.js`) يشغّل الطبقة الجديدة بإعداد Droua نفسه ويقارنها بوحدات Droua الحالية بايتًا ببايت:**

| الوحدة | ما يُثبته الاختبار |
|---|---|
| التوكن | `sign()` يُنتج النصّ نفسه للحمولة والسرّ نفسيهما، و`verify()` يقبل توكن الآخر. وتوكن `medins-gate` يُرفض في Droua والعكس، أي فصل النطاقين مثبَت |
| كلمة المرور | `derive()` بالـsalt نفسه يعطي الهاش نفسه، و`verify()` له جدول الحقيقة نفسه (بما فيه حدّ 256 حرفًا) |
| تحليل الهاش | النتائج نفسها على قائمة صيغ صحيحة وتالفة |
| حدّ المحاولات | `evaluate` متطابق على كل التركيبات من 0 إلى 20، و**نصّ SQL** للدوالّ الأربع متطابق حرفيًا (عبر `fake-sql` القائم) حين يُعطى الجدول `droua_gate_attempts` |
| الجلسات | نصّ SQL متطابق، وجدول حقيقة `isUsable` متطابق، والقيم الافتراضية 15 و60 متطابقة |
| التدقيق | `sanitizeMeta` و`hashIp` و`clientIp` ونصّ SQL و`logThrottled` متطابقة |
| التخزين المشفَّر | ملف تشفّره الطبقة بإعداد Droua تفكّه `lib/droua/storage.getDecrypted`، والعكس. وملف مشفَّر بإعداد medins **لا يُفك** بإعداد Droua |
| الردود | أشكال 404 و401 وغير المسجَّل متطابقة مع Droua ومع المنصّة |

**النتيجة:** أيّ إصلاح أمني يُدخل لاحقًا على وحدة في Droua دون الطبقة (أو العكس) **يُسقط CI فورًا**. لا يمكن نسيانه بصمت.
والاختبار نفسه هو مواصفة تاسك نقل Droua لاحقًا: النقل يصبح استبدالًا ميكانيكيًا مثبَت التكافؤ، ثم تُحذف وحدات Droua القديمة ويبقى تنفيذ واحد.

### ما تحتويه الطبقة (عامّة، دون أيّ اسم وحدة أو متغيّر بيئة مضمَّن)

```
lib/secure-kit/
  identifiers.js   UUID_RE، والتحقّق من أسماء الجداول ^[a-z][a-z0-9_]{2,40}$ عند الإنشاء لا من الطلب
  token.js         createTokenCodec({ type })        → sign / verify / issue / hashSid / newSid
  password.js      verify / derive / parseHash        (scrypt + pepper، مقارنة ثابتة الزمن)
  config.js        splitList / parseMembers / assertDistinct / boundedMinutes
  sessions.js      createSessionStore({ table, idleMs, absoluteMs, pruneGraceMs })
  rateLimit.js     createRateLimiter({ table, windows })
  audit.js         createAudit({ table, allowedMeta, throttleMs })  + hashIp / clientIp
  context.js       createGateContext()   → AsyncLocalStorage **مستقل لكل وحدة**
  http.js          readCookie / appendCookie / gateCookie({name,path}) / notFound* / secureApi / securePage({nonce, csp})
  keyring.js       createKeyring({ envPrefix, activeEnv })
  store.js         createEncryptedStore({ tokenEnv, forbiddenEqualEnvs, keyring, aadPrefix, aadFields, pathPrefix, maxPartBytes, formats })
  gate.js          createGate({ config, sessions, limiter, audit, codec, cookie, deps })
                   → evaluate / liveGate / requireAccess / handlers{ status, unlock, lock } / slidePlatformSession
  authz.js         createAuthz({ roles: { editor:['view','edit'], viewer:['view'] } }) → can(role, need)
```

- **أسماء الجداول تُحقن عبر `sql.unsafe()`** مثل النمط المستخدم في Production في `lib/data/tickets.js` و`permits.js` و`payrollRuns.js`، بعد التحقّق منها بتعبير مغلق عند الإنشاء. لا تأتي من الطلب أبدًا.
- **لا تستورد الطبقة `lib/auth`** ولا أيّ وحدة. الوحدة المستهلكة تحقن ما يلزم: `loadUser` و`verifyPlatformToken` و`isProtected` و`issueSessionToken`. فتُختبر الطبقة وحدها دون قاعدة ولا خادم.
- **الحجم التقديري:** قرابة 1000 سطر بأسلوب المشروع (التعليقات التوثيقية جزء كبير منها)، تحلّ محلّ قرابة 1000 سطر في Droua عند النقل. **ربط الوحدة الجديدة بالطبقة:** قرابة 150–200 سطر من الإعداد فقط.
- **بعد Phase 1 تظل الوحدة الجديدة مستقلة بالكامل في الأسرار والجلسة والكوكي والصلاحيات والتدقيق والمتجر والمفاتيح** (§6).

---

## 2. الملفّات

### ملفّات قائمة تُعدَّل (القائمة كاملة)
| الملف | التعديل |
|---|---|
| `api/app.js` | `BENEFITS_SECTION = "secure-benefits"` + `isBenefitsSectionRequest()` (مطابقة بادئة كاملة، على نمط Droua حرفيًا) + سطر تفويض بـ`require` كسول قبل `handlePage`/`handleApi`. قرابة 15 سطرًا |
| `vercel.json` | قاعدتا rewrite (الـAPI **قبل** الصفحة)، تُضافان قبل قاعدة `"/"` |
| `.env.example` | قسم `MEDINS_*` بقيم وهمية فقط مع الشرح |

**لا يُلمس:** `lib/droua/**`، `test/droua-*`، `scripts/*droua*`، `middleware.mjs`، `app-nav.js`، `lib/auth/**`، `lib/blob.js`، `lib/data/**`، `package.json`، `package-lock.json`، أيّ صفحة `.html`، ولا أيّ شيء يخص أجير.

### ملفّات جديدة
```
lib/secure-kit/            (13 وحدة — §1)

lib/medins/
  config.js                تحميل MEDINS_* والتحقّق منها؛ أيّ خلل يعني null فـ404 للجميع
  security.js              بناء نُسخ الطبقة: codec("medins-gate")، والجلسات، والمحدِّد، والتدقيق، والمتجر، والبوابة، والصلاحيات
  router.js                المدخل الوحيد؛ لا يرمي للخارج؛ كل خطأ داخلي يعني 404
  routes.js                جدول المسارات: { method, pattern, need: 'view'|'edit', handler }
  validate.js              مدقّقات المدخلات (مفاتيح مسموحة فقط، والحقول الممنوعة بالاسم)
  files.js                 تنسيق القاعدة والمتجر: init / part / complete / downloadPart / remove / sweep
  data/insurers.js · offers.js · classes.js · catalog.js · benefits.js · terms.js · locations.js · auditView.js
  views/gate.js            صفحة البوابة (قالب JS + nonce)
  views/app.js             صفحة الوحدة: التبويبان «العروض» و«الإعدادات» في Phase 1

scripts/
  setup-medins-gate.js     جداول البوابة (IF NOT EXISTS + --dry-run)
  setup-medins-core.js     جداول البيانات + زرع الكتالوج
  verify-medins-schema.js  فحص للقراءة فقط
  check-medins-config.js   فحص محلي للإعداد: يطبع **أسماء** الشروط الفاشلة لا القيم (لأن الإعداد الخاطئ يظهر في HTTP كـ404 فقط)

test/
  secure-kit.test.js · secure-kit-parity.test.js
  medins-isolation.test.js · medins-dispatch.test.js · medins-config.test.js
  medins-gate.test.js · medins-authz.test.js · medins-data.test.js
  medins-files.test.js · medins-migration-sql.test.js
  helpers/medins-harness.js

docs/medical-insurance/
  01-phase0-design.md · 02-phase1-contract.md (هذا العقد) · 03-production-runbook.md
```

**كلمة مرور البوابة:** يُستعمل السكربت القائم `scripts/hash-gate-password.js` كما هو، **دون تعديل** (الصيغة واحدة، ويثبتها اختبار التكافؤ). هذا سكربت جديد أقل.

---

## 3. الـRoute النهائي

| المصدر | الوجهة |
|---|---|
| `/secure-benefits/api/:path*` | `/api/app?kind=api&apiPath=secure-benefits/:path*` |
| `/secure-benefits` | `/api/app?kind=page&page=secure-benefits` |

- **الكوكي:** `medins_gate`، `Path=/secure-benefits`، `HttpOnly; Secure; SameSite=Strict`. لا يُرسَل مع أيّ طلب آخر، ولا مع `/secure-audit`.
- **نوع التوكن:** `medins-gate`، فتوكن Droua لا يتحقّق هنا رياضيًا ولا بالنوع.
- **التبويبات** تُدار داخل الصفحة بـhash (`#offers`، `#settings`)، ولا تحتاج rewrites إضافية.
- **لا رابط في أيّ قائمة** في المنصّة. الوصول بالإشارة المرجعية، كما في Droua.

---

## 4. Schema Phase 1

كل الجداول بالبادئة `medins_`. **المعرّفات تولَّد على الخادم** بـ`crypto.randomUUID()`، فلا اعتماد على `pgcrypto`. الأوقات `timestamptz`. وكل جدول له `created_at`، وما يُعدَّل له `updated_at`.

### 4.1 البوابة (`setup-medins-gate.js`)

```sql
medins_gate_sessions (                         -- نسخة بنيوية من droua_gate_sessions (التكافؤ يشترطها)
  sid_hash text PRIMARY KEY,                   -- sha256 للمعرّف، لا المعرّف ولا التوكن
  user_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_exp timestamptz NOT NULL,
  absolute_exp timestamptz NOT NULL,
  revoked_at timestamptz
)
  INDEX (user_id)                              -- revokeAllForUser
  INDEX (absolute_exp)                         -- prune (تحسين صغير على Droua لا يغيّر نصّ الاستعلام)

medins_gate_attempts (
  id bigserial PRIMARY KEY, user_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('fail','success')),
  ts timestamptz NOT NULL DEFAULT now()
)
  INDEX (user_id, outcome, ts DESC) · INDEX (ts)

medins_audit (
  id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL CHECK (event ~ '^[a-z_]{3,48}$'),
  user_id text, role text CHECK (role IN ('editor','viewer')),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,     -- عبر مُنقٍّ بقائمة مسموحة
  ip_hash text
)
  INDEX (ts DESC) · INDEX (event, ip_hash, ts DESC) · INDEX (user_id, ts DESC)
```

**الدور لا يُخزَّن في الجلسة:** يُعاد حسابه من متغيّرات البيئة في كل طلب. فنزع الصلاحية يسري في الطلب التالي (بعد إعادة النشر)، وجدول الجلسات يبقى مطابقًا لـDroua، وهذا شرط للتكافؤ.

### 4.2 البيانات (`setup-medins-core.js`، بهذا الترتيب بسبب المفاتيح الأجنبية)

```sql
medins_insurers (
  id uuid PRIMARY KEY,
  name_ar text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 1 AND 120),
  name_en text CHECK (name_en IS NULL OR char_length(name_en) <= 120),
  created_at, updated_at, archived_at timestamptz
)
  UNIQUE INDEX (lower(btrim(name_ar)))         -- لا شركة مكرّرة

medins_offers (
  id uuid PRIMARY KEY,
  insurer_id uuid NOT NULL REFERENCES medins_insurers(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  reference text CHECK (reference IS NULL OR char_length(reference) <= 100),
  submitted_on date,
  valid_until date,
  policy_start date,
  policy_months smallint CHECK (policy_months IS NULL OR policy_months BETWEEN 1 AND 36),
  headcount integer CHECK (headcount IS NULL OR headcount > 0),
  dependents_count integer CHECK (dependents_count IS NULL OR dependents_count >= 0),
  currency text NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  total_premium numeric(14,2) CHECK (total_premium IS NULL OR total_premium >= 0),
  vat_status text NOT NULL DEFAULT 'unknown' CHECK (vat_status IN ('included','excluded','unknown')),
  premium_per_head numeric(14,2) GENERATED ALWAYS AS (
    CASE WHEN headcount > 0 AND total_premium IS NOT NULL
         THEN round(total_premium / headcount, 2) END) STORED,   -- مشتق لا يُدخل
  status text NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','in_review','approved','archived')),
  approved_at timestamptz, approved_by text,
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  created_by text NOT NULL, created_at, updated_at,
  CHECK (valid_until IS NULL OR submitted_on IS NULL OR valid_until >= submitted_on),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL))
)
  INDEX (insurer_id) · INDEX (status, updated_at DESC)
  UNIQUE INDEX (insurer_id, lower(reference)) WHERE reference IS NOT NULL   -- منع إدخال العرض نفسه مرتين

medins_offer_classes (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES medins_offers(id) ON DELETE CASCADE,
  class_code text NOT NULL CHECK (class_code ~ '^[A-Za-z0-9+_-]{1,12}$'),   -- VIP / A / B / C …
  label text CHECK (label IS NULL OR char_length(label) <= 80),
  member_count integer CHECK (member_count IS NULL OR member_count >= 0),
  class_premium numeric(14,2) CHECK (class_premium IS NULL OR class_premium >= 0),
  sort_order smallint NOT NULL DEFAULT 0,
  created_at, updated_at,
  UNIQUE (offer_id, class_code),
  UNIQUE (id, offer_id)                       -- يخدم المفتاح المركّب في الشروط
)
  -- Phase 2 يضيف: network_version_id uuid REFERENCES medins_network_versions (ALTER … ADD COLUMN IF NOT EXISTS)

medins_benefit_catalog (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,40}$'),
  category text NOT NULL CHECK (category IN ('limits','outpatient','inpatient','emergency','dental',
                                'optical','maternity','chronic','pharmacy','other')),
  label_ar text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('sar','pct','days','count','bool','text')),
  better text NOT NULL CHECK (better IN ('higher','lower','none')),
  sort_order smallint NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
)

medins_files (                                -- قبل class_benefits لأنها تشير إليه
  id uuid PRIMARY KEY,                         -- يدخل الـAAD
  offer_id uuid NOT NULL REFERENCES medins_offers(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('quote','benefits','policy','other')),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255
             AND file_name !~ '[[:cntrl:]]' AND strpos(file_name,'/') = 0
             AND strpos(file_name, chr(92)) = 0),          -- chr(92) لا '\' (درس Droua)
  format text NOT NULL CHECK (format IN ('pdf','xlsx','xls','csv')),
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),   -- 20 MiB
  part_count smallint NOT NULL CHECK (part_count BETWEEN 1 AND 8),
  plaintext_sha256 text NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('uploading','ready','deleted')),
  enc_algo text NOT NULL CHECK (enc_algo = 'aes-256-gcm'),
  enc_key_id text NOT NULL CHECK (enc_key_id ~ '^k[1-9][0-9]{0,2}$'),
  created_by text NOT NULL, created_at,
  upload_expires_at timestamptz,               -- للرفع غير المكتمل
  completed_at timestamptz, deleted_at timestamptz, purged_at timestamptz,
  CHECK ((status = 'ready') = (completed_at IS NOT NULL AND deleted_at IS NULL)),
  CHECK (status <> 'uploading' OR upload_expires_at IS NOT NULL)
)
  INDEX (offer_id) · INDEX (status, upload_expires_at)
  UNIQUE INDEX (offer_id, plaintext_sha256) WHERE status IN ('uploading','ready')   -- منع التكرار، حتى المتزامن

medins_file_parts (
  file_id uuid NOT NULL REFERENCES medins_files(id) ON DELETE CASCADE,
  part_index smallint NOT NULL CHECK (part_index BETWEEN 0 AND 7),
  blob_pathname text NOT NULL UNIQUE CHECK (blob_pathname ~ '^medins/[0-9a-f-]{36}/[0-9a-f]{32}$'),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2621440),     -- 2.5 MiB
  part_sha256 text NOT NULL CHECK (part_sha256 ~ '^[0-9a-f]{64}$'),
  enc_iv text NOT NULL CHECK (enc_iv ~ '^[0-9a-f]{24}$'),
  enc_tag text NOT NULL CHECK (enc_tag ~ '^[0-9a-f]{32}$'),
  created_at,
  PRIMARY KEY (file_id, part_index)
)

medins_class_benefits (
  class_id uuid NOT NULL REFERENCES medins_offer_classes(id) ON DELETE CASCADE,
  benefit_key text NOT NULL REFERENCES medins_benefit_catalog(key) ON DELETE RESTRICT,
  value_status text NOT NULL CHECK (value_status IN ('known','unknown','not_applicable')),
  covered boolean,                             -- false = «غير مغطّى» وهي قيمة **معروفة** لا unknown
  amount numeric(14,2) CHECK (amount IS NULL OR amount >= 0),   -- 0 قيمة صحيحة (تحمّل 0%)
  cap_amount numeric(14,2) CHECK (cap_amount IS NULL OR cap_amount >= 0),
  text_value text CHECK (text_value IS NULL OR char_length(text_value) <= 500),
  source_file_id uuid REFERENCES medins_files(id) ON DELETE SET NULL,
  source_page smallint CHECK (source_page IS NULL OR source_page > 0),
  source_excerpt text CHECK (source_excerpt IS NULL OR char_length(source_excerpt) <= 500),
  entry_method text NOT NULL DEFAULT 'manual' CHECK (entry_method IN ('manual','template','ai')),
  verified_at timestamptz, verified_by text,
  updated_at, updated_by text,
  PRIMARY KEY (class_id, benefit_key),
  -- unknown و not_applicable لا يحملان أيّ قيمة، فلا «صفر خفيّ»
  CHECK (value_status = 'known' OR (covered IS NULL AND amount IS NULL
         AND cap_amount IS NULL AND text_value IS NULL)),
  -- known يجب أن يحمل قيمة فعلية
  CHECK (value_status <> 'known' OR num_nonnulls(covered, amount, text_value) >= 1)
)
  INDEX (benefit_key)                          -- المقارنة بندًا مقابل بند (Phase 2)

medins_offer_terms (                          -- الاستثناءات والشروط الخاصة والمزايا الإضافية
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES medins_offers(id) ON DELETE CASCADE,
  class_id uuid,                               -- NULL = يسري على كل الفئات
  kind text NOT NULL CHECK (kind IN ('exclusion','condition','extra')),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  severity smallint CHECK (severity IS NULL OR severity BETWEEN 0 AND 3),
  source_file_id uuid REFERENCES medins_files(id) ON DELETE SET NULL,
  source_page smallint CHECK (source_page IS NULL OR source_page > 0),
  source_excerpt text CHECK (source_excerpt IS NULL OR char_length(source_excerpt) <= 500),
  verified_at timestamptz, verified_by text,
  created_at, updated_at,
  CHECK (kind = 'exclusion' OR severity IS NULL),
  -- الفئة يجب أن تكون من العرض نفسه، مفروضًا في القاعدة لا في التطبيق وحده
  FOREIGN KEY (class_id, offer_id) REFERENCES medins_offer_classes(id, offer_id) ON DELETE CASCADE
)
  INDEX (offer_id, kind)

medins_company_locations (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  active boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false,   -- نقطة القياس الافتراضية للمحاكي
  created_at, updated_at,
  CHECK (NOT is_primary OR active)
)
  UNIQUE INDEX (is_primary) WHERE is_primary   -- مقرّ افتراضي واحد على الأكثر
```

**القاعدة الحاكمة للناقص:** **غياب الصفّ في `medins_class_benefits` = `unknown`**، ولا يُعامل أبدًا كصفر. `not_applicable` قيمة يُدخلها المستخدم صراحةً، و`0` قيمة معروفة. ومحرّك Phase 2 يرفض إصدار توصية إذا كانت بنود جوهرية محدّدة (قائمتها في إعدادات Phase 2) `unknown` لأيّ عرض مُقارَن، ويقول ذلك بالاسم.

**وحدات القيم** (النسبة ≤ 100، والمبلغ للوحدة `sar`، وbool للوحدة `bool`…) تُفرض في التطبيق، لأنها تعتمد على صفّ الكتالوج. ويثبتها اختبار لكل وحدة.

**زرع الكتالوج** (`INSERT … ON CONFLICT (key) DO NOTHING`)، قرابة 18 بندًا:
`annual_limit` · `op_copay_pct` · `op_copay_cap` · `op_consult_limit` · `ip_coverage` · `ip_room_class` · `ip_copay_pct` · `emergency_coverage` · `dental_limit` · `dental_copay_pct` · `optical_limit` · `maternity_limit` · `maternity_waiting_days` · `chronic_coverage` · `preexisting_coverage` · `pharmacy_copay_pct` · `physio_sessions` · `newborn_coverage`.
القائمة قابلة للتعديل قبل التنفيذ.

---

## 5. ما يبقى مؤجَّلًا

| إلى | البنود |
|---|---|
| **Phase 2** | `medins_providers`، `provider_aliases`، `company_provider_priority` (Must-have / High / Normal، خاص بالشركة)، `insurer_networks`، `network_versions`، `network_memberships`؛ عمود `network_version_id` في الفئات؛ ربط الملفّات بنسخة الشبكة (`network_version_id` + قيد «مالك واحد بالضبط» بـ`num_nonnulls`، تعديل إضافي)؛ `weight_profiles` و`evaluations`؛ محرّك التقييم والأهلية والتوصيات والتفسير؛ المقارنة جنبًا إلى جنب؛ واجهة تعديل الكتالوج وقائمة «البنود الجوهرية» |
| **Phase 2 (بعد العيّنات)** | أيّ parser لقوائم الشبكات أو العروض. لا شيء منه قبل رؤية عيّنات حقيقية |
| **Phase 3** | الخريطة (Leaflet من npm)، وطبقة مزوِّد البلاطات القابلة للتبديل، ومسافة الخط المستقيم، وتحليلات 5 و10 و15 كم، والطبقات، ومقارنة الشبكات على الخريطة |
| **Phase 4** | مسافة وزمن الطريق من مزوّد حقيقي (مع المصدر وتاريخ الحساب والتخزين وفق شروطه)، والـHeatmap، والسيناريوهات المتقدمة، والاستخراج بالذكاء الاصطناعي (معطَّل افتراضيًا، ويحتاج قائمة الإفصاح التي حدّدتها قبل تفعيله) |
| **تاسك مستقل (بموافقتك)** | نقل Droua إلى `lib/secure-kit` بشرط التكافؤ، ثم حذف التنفيذ القديم |

---

## 6. Security Flow

### الإعداد (`lib/medins/config.js`)، ويُقرأ عند كل نداء
| المتغيّر | المحتوى | الشرط (أيّ خلل يعني null فـ404 للجميع) |
|---|---|---|
| `MEDINS_EDITORS` | `uuid:email,uuid:email` | صيغة صحيحة |
| `MEDINS_VIEWERS` | `uuid:email,…` (اختياري) | لا معرّف في القائمتين معًا |
| `MEDINS_GATE_SECRET` | ≥ 32 حرفًا | **مختلف** عن `SESSION_SECRET` و`DROUA_GATE_SECRET` |
| `MEDINS_GATE_PASSWORD_HASHES` | `uuid=scrypt$…;uuid=scrypt$…` | **هاش لكل مستخدم مصرَّح**، بصيغة صالحة |
| `MEDINS_GATE_PEPPER` | 32 بايت hex | اختياري، مثل Droua (مستحسن) |
| `MEDINS_GATE_IDLE_MINUTES` | افتراضي 15 | عدد صحيح بين 5 و60 |
| `MEDINS_GATE_ABSOLUTE_MINUTES` | افتراضي 60 | بين 15 و480، و≥ الخمول |
| `MEDINS_BLOB_READ_WRITE_TOKEN` | توكن المتجر الخاص الجديد | **مختلف** عن `BLOB_READ_WRITE_TOKEN` و`DROUA_BLOB_READ_WRITE_TOKEN` |
| `MEDINS_FILE_ACTIVE_KEY_ID` + `MEDINS_FILE_KEY_K1…` | حلقة مفاتيح | المادّة لا تساوي أيّ `DROUA_FILE_KEY_*` |
| — | كل مصرَّح له | **ضمن `PROTECTED_USER_IDS`** (قرارك 3) |

**الثوابت (15 و60 والأرضية الزمنية 600ms وعتبات القفل)** تُعرَّف في `lib/medins/config.js` وحده كقيم افتراضية، وتُمرَّر إلى الطبقة. لا رقم مبعثر في الكود.

### مسار الطلب
```
1  middleware.mjs           جلسة المنصّة شرط (كما هو، دون تعديل)
2  api/app.js               isBenefitsSectionRequest → require("../lib/medins/router")  (كسول)
3  config.load()            null ⇒ 404 مطابق حرفيًا لمسار غير موجود (بلا رؤوس أمان، كما يشترط Droua)
4  رفض مبكّر بلا قاعدة      توكن المنصّة يُتحقّق منه محليًا؛ sub خارج القائمتين ⇒ 404 + access_denied (مكتوم التكرار 10 دقائق)
5  الهوية الكاملة           المستخدم من القاعدة: نشِط، والمعرّف في القائمة، والبريد مطابق، ومحمي ⇒ وإلا 404
6  الدور                    editor | viewer من القائمة (لا من الطلب ولا من الجلسة)
7  مسار API مجهول           404 **قبل** أيّ فحص بوابة (لا خريطة للقسم)
8  الصفحة                   بوابة حيّة؟ صفحة الوحدة : صفحة البوابة  (CSP بـnonce، img-src 'none' في Phase 1)
9  gate/unlock              تسجيل المحاولة ثم العدّ (عبارة واحدة) → قفل؟ (scrypt يُنفَّذ رغم ذلك) → تحقّق بهاش **هذا المستخدم**
                            → logStrict(نجاح) وإلا 404 → صفّ جلسة + كوكي → أرضية 600ms لكل النتائج، وردّ فشل واحد لكل الأسباب
10 مسارات البيانات          requireAccess(needGate) → gateContext.run() → can(role, route.need) ⇒ 403 للـViewer → المعالج
11 كل طلب مصرَّح            يمدّد خمول البوابة (دون تجاوز السقف) وخمول جلسة المنصّة (عدا «تذكّرني»)
12 gate/lock                إبطال الصفّ + مسح الكوكي بالمسار نفسه
```

### طبقات إضافية على Droua (في الوحدة الجديدة، لا تمسّ Droua)
- **CSRF:** فوق `SameSite=Strict`، كل طلب كتابة يُشترط فيه `Content-Type: application/json`، وأن يطابق `Origin` المضيف إن وُجد. وإلا 403.
- **IDOR:** كل مسار يتحقّق من سلسلة الملكية (ملف ← عرض، فئة ← عرض، شرط ← عرض)، والقاعدة تفرض «الفئة من العرض نفسه» بمفتاح مركّب.
- **الحقول الممنوعة من العميل بالاسم:** `id`، `fileId` (في الإنشاء)، `created_by`، `approved_*`، `premium_per_head`، `blob_pathname`، `enc_*`، `status` (له مسار انتقال مستقل)، `verified_*`، `content_type`، `size_bytes`.

### أحداث التدقيق (`medins_audit`)
`access_denied` · `section_opened` · `gate_unlock_success` · `gate_unlock_failed` · `gate_locked_out` · `gate_locked` · `forbidden_action` · `insurer_created|updated|archived` · `offer_created|updated|status_changed|deleted` · `class_*` · `benefits_saved` · `term_*` · `file_upload_started|completed|rejected|downloaded|deleted` · `blob_orphan` · `blob_stale` · `location_*`

**المُنقّي يسمح فقط بـ:** `reason`، `route`، `need`، `attempts`، `critical`، `offerId`، `classId`، `insurerId`، `fileId`، `locationId`، `kind`، `partIndex`، `count`، `fromStatus`، `toStatus`، `encKeyId`، `pathname`.
**لا أسماء ملفّات، ولا أسعار، ولا نصوص منافع، ولا أسماء شركات.**

---

## 7. Private File Flow

**لماذا الأجزاء؟** حدّ الطلب والردّ في Vercel 4.5MB. الجزء 2.5MiB يصبح قرابة 3.4MB بعد base64، أي دون الحدّ بهامش. الملف حتى 20MiB، أي 8 أجزاء.

```
init      POST files/init      { offerId, kind, fileName, format, sizeBytes, sha256 }      need: edit
          → التحقّق: العرض موجود وغير مؤرشف؛ الصيغة من القائمة المغلقة؛ الحجم ≤ 20MiB؛ الاسم يُنقّى
          → كنس انتهازي: صفوف 'uploading' منتهية (+ أجزاؤها في المتجر)
          → INSERT status='uploading', upload_expires_at = now()+60min
            · تعارض فهرس (offer_id, sha256) ⇒ 409 «الملف موجود مسبقًا» مع fileId الموجود
          ← { fileId, partCount, partSize }

part      POST files/:id/parts/:n  { data: base64 }                                         need: edit
          → الملف 'uploading' وغير منتهٍ، وn < partCount، والجزء غير موجود؛ الحجم = المتوقّع لهذا الرقم بالضبط
          → فحص طول النصّ **قبل** فكّ base64
          → n = 0: فحص التوقيع السحري للصيغة: %PDF- | PK\x03\x04 | D0CF11E0A1B11AE1 | CSV: UTF-8 صالح بلا NUL
          → تشفير AES-256-GCM:  AAD = "medins-file|v1|fileId|offerId|kind|n|partCount"
            (رقم الجزء والعدد داخل الـAAD، فلا إعادة ترتيب ولا اقتطاع ولا نقل جزء إلى ملف آخر)
          → put(private, octet-stream, مسار عشوائي medins/<offerId>/<32hex>, token صريح)
          → INSERT file_parts؛ فشل الإدراج ⇒ حذف الكائن، وإن فشل الحذف ⇒ blob_orphan بالمسار

complete  POST files/:id/complete                                                            need: edit
          → كل الأجزاء موجودة → فكّ كل جزء والتحقّق من وسمه ومن part_sha256 → sha256 للملف كاملًا = المعلَن
          → فشل ⇒ status='deleted' + purge + 422
          → UPDATE status='ready', completed_at

list/meta GET offers/:id/files · files/:id                                                   need: view
          (لا مسار ولا IV ولا وسم في أيّ ردّ؛ الحقول العامة فقط)

download  GET files/:id/parts/:n                                                             need: view (قرار D3)
          → status='ready' فقط → فكّ وتحقّق من الوسم **قبل** إرسال أيّ بايت → ≤ 2.5MiB لكل ردّ
          → الواجهة تجمع الأجزاء إلى Blob في المتصفح، وتتحقّق من sha256 بـWebCrypto، ثم تحفظ الملف
          → رؤوس: Content-Type: application/octet-stream، nosniff، CSP "default-src 'none'; sandbox"، no-store
          (لا روابط موقَّعة ولا روابط في القاعدة ولا بثّ لنصٍّ صريح غير متحقَّق)

delete    DELETE files/:id                                                                   need: edit
          → مرفوض إن كان مصدرًا لقيمة منفعة معتمدة؟ لا: الإشارات SET NULL، والتدقيق يسجّل
          → status='deleted', deleted_at → حذف الأجزاء (أفضل جهد) → purged_at؛ والفشل ⇒ blob_stale ويلتقطه الكنس
```

**ما يحرس المسار:**
- كل دالّة في `lib/medins/files.js` تبدأ بـ`gateContext.requireGate()`، واختبار يعدّ الحرّاس.
- **الكتابة بالتوكن الصريح فقط:** غيابه أو مساواته لتوكن أجير أو Droua يعني رمي خطأ قبل أيّ نداء شبكة.
- **المسار يُقرأ من صفّ القاعدة** دائمًا، ولا يُقبل من الطلب.
- تقديم الملفّات **مرفقات لا inline**، ولا تحليل لمحتواها في Phase 1. التحقّق يقتصر على التوقيع السحري، والتحليل في Phase 2 بحدود للصفحات وفكّ الضغط وبـ`isEvalSupported:false`.

---

## 8. API Actions (كلها عبر `api/app.js` ← `lib/medins/router`)

البادئة `/secure-benefits/api/`. **`view`** = Editor وViewer. **`edit`** = Editor فقط (الـViewer يأخذ 403).

| الطريقة | المسار | need | الوصف |
|---|---|---|---|
| GET | `gate/status` | — (هوية فقط) | حالة البوابة ومواعيد الانتهاء |
| POST | `gate/unlock` | — | فتح البوابة |
| POST | `gate/lock` | — | قفل البوابة |
| GET | `me` | view | `{ role, name, idleExp, absoluteExp }`، والواجهة تُخفي أدوات التعديل للـViewer (والخادم يفرضها على أيّ حال) |
| GET | `insurers` | view | قائمة الشركات |
| POST | `insurers` | edit | إضافة شركة |
| PUT | `insurers/:id` | edit | تعديل الاسم |
| POST | `insurers/:id/archive` · `unarchive` | edit | لا حذف نهائي (RESTRICT) |
| GET | `offers` | view | جدول العروض مع الملخص (عدد الفئات والملفّات ونسبة البنود المعروفة) |
| POST | `offers` | edit | إنشاء عرض (`draft`) |
| GET | `offers/:id` | view | العرض كاملًا: الفئات والمنافع والشروط والملفّات |
| PUT | `offers/:id` | edit | تعديل البيانات الأساسية. تعديل عرض `approved` يعيده إلى `in_review` تلقائيًا |
| POST | `offers/:id/status` | edit | `{to}`: draft↔in_review→approved، وأيّ حالة → archived، وarchived → draft |
| DELETE | `offers/:id` | edit | فقط `draft` بلا ملفّات `ready`. وإلا الأرشفة |
| POST | `offers/:id/classes` | edit | إضافة فئة |
| PUT · DELETE | `classes/:id` | edit | تعديل فئة أو حذفها |
| GET | `catalog` | view | كتالوج البنود (للقراءة في Phase 1) |
| GET | `classes/:id/benefits` | view | قيم البنود |
| PUT | `classes/:id/benefits` | edit | upsert دفعة واحدة لقيم ثلاثية الحالة (transaction) |
| POST | `classes/:id/benefits/verify` | edit | اعتماد قيم مختارة (`verified_at/by`) |
| GET | `offers/:id/terms` | view | الاستثناءات والشروط والمزايا |
| POST | `offers/:id/terms` | edit | إضافة |
| PUT · DELETE | `terms/:id` | edit | تعديل أو حذف |
| GET | `offers/:id/files` · `files/:id` | view | قائمة الملفّات وبياناتها |
| POST | `files/init` · `files/:id/parts/:n` · `files/:id/complete` | edit | §7 |
| GET | `files/:id/parts/:n` | view* | تنزيل جزء (*قرار D3) |
| DELETE | `files/:id` | edit | حذف ملف |
| GET | `locations` | view | المواقع |
| POST | `locations` | edit | إضافة موقع |
| PUT | `locations/:id` | edit | تعديل الاسم والإحداثيات والحالة؛ لا حذف (تعطيل) |
| POST | `locations/:id/primary` | edit | تعيين نقطة القياس الافتراضية (transaction: يُلغي السابقة) |
| GET | `audit?before=&limit≤100` | edit | آخر أحداث القسم (قراءة) |

**جدول المسارات هو المصدر الوحيد للصلاحية.** كل صفّ يعلن `need`، واختبار يمرّ على الجدول كله آليًا (§12). مسار بلا `need` يُسقط CI.

**حالات الردّ:** 200 · 400 (مدخل غير صالح، برسالة مقنَّنة دون صدى) · 401 `{locked:true}` (البوابة مقفلة) · 403 (Viewer على `edit`، أو CSRF) · 404 (مجهول أو غير موجود) · 409 (تكرار) · 422 (فشل سلامة الملف). **وكل خطأ غير متوقّع يُرَدّ 404، لا 500**، كما في Droua.

---

## 9. صلاحيات Editor وViewer

| القدرة | Editor | Viewer |
|---|:-:|:-:|
| فتح القسم والبوابة | ✅ | ✅ |
| عرض العروض والفئات والمنافع والشروط | ✅ | ✅ |
| عرض قائمة الملفّات | ✅ | ✅ |
| تنزيل الملف الأصلي | ✅ | ✅ *(قرار D3)* |
| إنشاء وتعديل وأرشفة الشركات والعروض والفئات والمنافع والشروط | ✅ | ❌ |
| رفع الملفّات وحذفها | ✅ | ❌ |
| اعتماد القيم وتغيير حالة العرض | ✅ | ❌ |
| إدارة المواقع (مقرّ الشركة…) | ✅ | ❌ (يرى فقط) |
| سجل التدقيق | ✅ | ❌ |
| *(Phase 2+)* الشبكات والأولويات والأوزان وإنشاء المقارنات المحفوظة | ✅ | عرض واستخدام فقط |
| *(Phase 3)* الخريطة والمحاكي | ✅ | ✅ |

**التصميم:** القوائم في متغيّرات البيئة، ونقطة قرار واحدة `authz.can(role, need)`، ودوران وحاجتان (`view` و`edit`).
**التوسّع لاحقًا** (دون كسر): نقل القوائم إلى جدول `medins_members` وإضافة حاجات جديدة. الجدول وحده يتغيّر، ومسارات الكود لا تتغيّر.

**ملاحظة تشغيلية:** إضافة مستخدم أو إزالته أو تغيير دوره = تعديل متغيّر بيئة + إعادة نشر + (للجديد) هاش كلمة مرور له.

---

## 10. الـMigrations (لا تُنفَّذ إلا بموافقتك)

| السكربت | العبارات | الخصائص |
|---|---|---|
| `setup-medins-gate.js` | 3 جداول + 7 فهارس | `IF NOT EXISTS` فقط، و`--dry-run` لا يتّصل بالقاعدة، و`sql.query()` لا `sql.unsafe()` للتنفيذ (الدرس الموثّق في المشروع)، وتشغيله مرتين لا يفعل شيئًا في الثانية |
| `setup-medins-core.js` | 9 جداول + فهارسها + زرع الكتالوج | نفس الخصائص. **لا `DROP` ولا `ALTER` لأيّ جدول قائم**، ولا لمس لأيّ جدول خارج `medins_*` |
| `verify-medins-schema.js` | قراءة فقط | يقارن الجداول والأعمدة والقيود والفهارس بالمتوقَّع |

**ترتيب التفعيل المقترح لاحقًا (منك، خطوة خطوة):**
1. إنشاء متجر Blob **خاص** جديد.
2. ضبط `MEDINS_*` في Production (Sensitive).
3. تشغيل `check-medins-config.js` محليًا.
4. `--dry-run` ثم مراجعة النصّ.
5. **(موصى به)** تشغيل السكربتين على **Neon branch** أولًا، ثم `verify`.
6. التشغيل على قاعدة Production، ثم `verify`.
7. النشر.
8. فحص Blob الخاص (403 بلا مصادقة).
9. Smoke test من الدليل.

---

## 11. Rollback

| المستوى | الإجراء | الأثر |
|---|---|---|
| **إخفاء فوري** | حذف أو إفساد أيّ متغيّر إلزامي (مثل `MEDINS_GATE_SECRET`) + إعادة نشر | القسم كله 404 للجميع، والبيانات محفوظة |
| **إبطال كل الجلسات** | تدوير `MEDINS_GATE_SECRET`، أو `UPDATE medins_gate_sessions SET revoked_at = now() WHERE revoked_at IS NULL` | خروج الجميع فورًا |
| **تراجع الكود** | `git revert` لكومِت(ات) Phase 1 | يُزال سطر التفويض وقاعدتا التوجيه، فـ`/secure-benefits` يصبح 404 كأيّ مسار. باقي المنصّة وDroua بلا أثر (لم يتغيّر فيهما سطر) |
| **القاعدة** | الجداول إضافية ومعزولة بالبادئة. تبقى دون ضرر بعد تراجع الكود. سكربت `teardown-medins.js --confirm` (يحذف `medins_*` فقط) **يُكتب ولا يُشغَّل** إلا بأمر صريح منك لأنه يتلف البيانات | — |
| **الملفّات** | المتجر الخاص مستقل، وحذفه من اللوحة يدويًا إن أردت | لا يمسّ متجرَي أجير وDroua |
| **ضمان عدم المساس بـDroua** | اختبار في CI يفشل إن تضمّن فرق الفرع أيّ ملف تحت `lib/droua/` أو `test/droua-*` أو `scripts/*droua*` | — |

---

## 12. الاختبارات المطلوبة

**المعيار:** الـ523 الحالية تبقى خضراء دون تعديل سطر فيها، والجديدة كلها خضراء.

| الملف | ما يغطّيه |
|---|---|
| `secure-kit.test.js` | سيناريوهات Droua منقولة إلى الطبقة العامة: التوكن (تزوير، وانتهاء، ونوع خاطئ، وسقف لا يُمدَّد)، والاشتقاق، والقفل (5/15د، 10/60د، الحرج، المحاولة المقفولة لا تُحسب، التزامن)، والجلسات، والتدقيق (القائمة المسموحة والكتم)، والتخزين (AAD، والمفتاح المجهول، وتبديل الأجزاء، وعدم الإفراج قبل الوسم)، ورفض أسماء جداول غير صالحة |
| `secure-kit-parity.test.js` | §1 كاملًا: تكافؤ بايت ببايت مع وحدات Droua، وفصل النطاقين |
| `medins-isolation.test.js` | `lib/medins` و`lib/secure-kit` لا يذكران `lib/droua` ولا `lib/blob` ولا `hasPermission/resolvePermissions` ولا `audit_log` ولا جداول أجير أو Droua. الطبقة لا تذكر أيّ `process.env.<اسم>` ثابت. توكن المتجر العام لا يُذكر إلا في فحص التساوي. لا ملف `.html` يكشف القسم. ملفّات المنصّة العامة (`app-nav.js` والصلاحيات والأدوار والـregistry و`sw.js` والـmanifest والـmiddleware وصفحات الجذر) لا تذكر `secure-benefits`. `lib/droua` لا يذكر `secure-kit` ولا `medins` (Phase 1). عدد الدوالّ 2. الـrewrites: الـAPI قبل الصفحة. فرق الفرع لا يلمس ملفّات Droua |
| `medins-dispatch.test.js` | `secure-benefits` و`secure-benefits/…` فقط تُفوَّض؛ `secure-benefitsX` و`data/secure-benefits` لا. كل مسارات المنصّة وDroua القائمة لا تُفوَّض إلى الوحدة. الطلب غير المعني لا يحمّل `lib/medins` (فحص `require.cache`) |
| `medins-config.test.js` | كل شرط فاشل يعني null: متغيّر غائب، سرّ قصير، سرّ يساوي `SESSION_SECRET` أو `DROUA_GATE_SECRET`، توكن يساوي توكنًا آخر، مفتاح بمادّة Droua، معرّف في القائمتين، مستخدم بلا هاش، غير محمي، مدد خارج الحدود |
| `medins-gate.test.js` | 404 مطابق للمنصّة، والرفض المبكّر بلا قاعدة، والصفحة مقابل البوابة، والفتح بالنجاح والفشل والقفل، والأرضية الزمنية، وفشل `logStrict` يعني 404، وكلمة مرور مستخدم لا تفتح لمستخدم آخر، وتوكن Droua لا يفتح هنا، ومسار الكوكي، والانزلاق، والقفل، والسقف المطلق |
| `medins-authz.test.js` | **يمرّ آليًا على جدول المسارات كله:** كل مسار له `need`؛ الـViewer يأخذ 403 على كل `edit` ويمرّ على كل `view`؛ الـEditor يمرّ؛ المجهول 404 قبل البوابة؛ CSRF (Content-Type وOrigin) |
| `medins-data.test.js` | المفاتيح المجهولة والممنوعة مرفوضة بالاسم؛ ثلاثية الحالة (unknown بقيمة مرفوض، وknown بلا قيمة مرفوض، و0 مقبول)؛ قيود الوحدات (النسبة ≤ 100)؛ الفئة من عرض آخر مرفوضة؛ انتقالات الحالة؛ تعديل `approved` يعيده إلى `in_review`؛ حذف العرض بشروطه؛ مقرّ افتراضي واحد |
| `medins-files.test.js` | الحدود (الحجم، والأجزاء، وطول base64 قبل الفكّ)؛ التوقيع السحري لكل صيغة؛ تنقية الاسم (التحكم وقلب الاتجاه والشرطات)؛ التكرار (409 حتى بالتزامن)؛ تبديل جزأين، أو نقل جزء بين ملفّين، أو اقتطاع، يعطي فشل سلامة؛ sha مخالف يعطي 422 وتطهيرًا؛ الكنس؛ التنزيل لـ`ready` فقط؛ ملف عرض A عبر مسار عرض B مرفوض؛ عدد الحرّاس = عدد الدوالّ المُصدَّرة؛ لا مسار أو IV أو وسم في أيّ ردّ |
| `medins-migration-sql.test.js` | كل عبارة `IF NOT EXISTS`؛ لا `DROP` ولا `ALTER` لغير `medins_*`؛ `chr(92)` لا `'\'`؛ `--dry-run` لا يتّصل؛ التنفيذ بـ`sql.query`؛ كل مسند مستعمل في الكود له فهرس؛ قيود ثلاثية الحالة موجودة نصًّا |

**التشغيل:** `npm test` محليًا في الجلسة. **لا Production.**

---

## 13. الـServerless Functions تبقى 2

- لا ملف جديد تحت `api/`. كل شيء يمرّ عبر `api/app.js` بسطر تفويض كسول.
- لا cron جديد. الكنس انتهازي داخل `files/init`، والتقليم داخل `gate/unlock`، كما في Droua.
- لا `functions` جديدة في `vercel.json`، ولا تعديل على `includeFiles` في Phase 1 (الواجهة قوالب JS لا ملفّات).
- **مفروض باختبار قائم** (`droua-isolation`: «عدد الدوالّ يبقى 2») **وآخر جديد** في `medins-isolation`.

---

## 14. الـDependencies

**Phase 1: صفر.** `crypto` و`AsyncLocalStorage` و`zlib` من Node، و`@vercel/blob` و`@neondatabase/serverless` موجودتان. لا تعديل على `package.json` ولا `package-lock.json`.

**للعلم فقط، Leaflet في Phase 3 (لن تُضاف الآن):**

| البند | القيمة |
|---|---|
| الإصدار المستقر | `leaflet@1.9.4` (فرع 2.0 ما زال alpha، فلن يُستخدم) |
| الرخصة | BSD-2-Clause |
| dependencies وقت التشغيل | **صفر** |
| حجم الحزمة في `node_modules` | قرابة 3.7MB (لا يُشحن للمتصفح كاملًا) |
| ما يصل للمتصفح فعلًا | `leaflet.js` قرابة 150KB (قرابة 40KB مضغوطًا) + `leaflet.css` قرابة 14KB. **أرقام تقريبية تُقاس فعليًا عند الإضافة** |
| التقديم | من خلف البوابة عبر `api/app.js` (لا CDN). يتطلّب إضافة `node_modules/leaflet/dist/*` إلى `includeFiles` لدالّة `api/app.js` القائمة |
| الأثر على الدوالّ | **صفر** (ملفّات مضمَّنة في دالّة قائمة، لا دالّة جديدة)، ويُثبت بالاختبار نفسه |

---

## 15. المخاطر والـBlockers

### ما يمنع البناء (Blockers): **لا شيء**
البناء والاختبارات تعمل بالكامل بمتجر مزيَّف وقاعدة مزيَّفة (نمط `test/helpers` القائم). الأسرار والمتجر والـMigration لازمة **للتفعيل** لا للبناء.

### المخاطر
| الخطر | الاحتمال | التخفيف |
|---|---|---|
| انحراف الطبقة المشتركة عن Droua قبل نقله | متوسط مع الزمن | اختبار التكافؤ يُسقط CI عند أيّ انحراف |
| **أثر «الحساب المحمي» على الـViewers** | **مؤكَّد** | `PROTECTED_USER_IDS` يجمّد إدارة الحساب: لا أحد (ولا المالك) يغيّر بريده أو دوره أو حالته أو كلمة مروره من الواجهة، والتعطيل يحتاج تعديل البيئة. مقبول لك ولمسؤول المالية؟ (قرار D1) |
| إعداد خاطئ يظهر كـ404 صامت | متوسط | `check-medins-config.js` يطبع أسماء الشروط الفاشلة محليًا، دون قيم |
| حدّ 4.5MB | منخفض | أجزاء 2.5MiB في الرفع والتنزيل، دون أيّ اعتماد على البثّ |
| ميزات Postgres (`GENERATED … STORED` و`num_nonnulls`) | منخفض (Neon على PG ≥ 15) | `verify` + تجربة على Neon branch قبل Production |
| `sql.unsafe` لأسماء الجداول | منخفض | أسماء من الإعداد فقط، بتعبير مغلق عند الإنشاء، ونمط مستخدم في Production أصلًا |
| حجم صفحة الوحدة مع نموّ التبويبات | متوسط لاحقًا | Phase 1 تبويبان فقط، والتقسيم إلى أجزاء JS خلف البوابة عند الحاجة |
| كائنات يتيمة في المتجر | منخفض | تراجع فوري + `blob_orphan`/`blob_stale` في التدقيق + كنس |
| عدد المتغيّرات (قرابة 10) | تشغيلي | قسم موثّق في `.env.example` + Runbook + فحص الإعداد |

---

## قرارات أحتاجها لإقفال العقد

| # | القرار | توصيتي |
|---|---|---|
| **D1** | شرط `PROTECTED_USER_IDS` على **كل** المصرَّح لهم، بما فيهم الـViewers، مع أثره (تجميد إدارة حساباتهم من الواجهة) | نعم كما طلبت، مع العلم بالأثر |
| **D2** | كلمة مرور بوابة **لكل مستخدم** (هاش لكل واحد) أم كلمة مشتركة؟ | **لكل مستخدم:** مساءلة فردية، وإلغاء شخص لا يمسّ الآخرين |
| **D3** | هل يحقّ للـViewer تنزيل الملفّات الأصلية؟ | نعم (من ضمن «عرض العروض»)، وكل تنزيل يُدقَّق |
| **D4** | حدود الملف: 20MiB و8 أجزاء من 2.5MiB | مناسبة. تُراجع عند وصول العيّنات |
| **D5** | الطبقة المشتركة (الخيار ج) + نقل Droua إليها كتاسك مستقل لاحق | نعم |
| **D6** | `medins_company_locations` مع CRUD بسيط في Phase 1 (دون خريطة) لتدخل المقرّ متى شئت | نعم (صغير، ويمنع أيّ hard-code) |
| **D7** | قائمة بنود الكتالوج المزروعة (§4) | مراجعتك أو إضافاتك |

بعد اعتمادك (مع أيّ تعديل)، أبدأ التنفيذ على الفرع `claude/jolly-lamport-sb4dpz` بكومِتات صغيرة مرتّبة: الطبقة المشتركة واختبارات التكافؤ أولًا، ثم البوابة، ثم البيانات، ثم الملفّات، ثم الواجهة. لا Production، ولا Migration، ولا Deploy، ولا PR.
