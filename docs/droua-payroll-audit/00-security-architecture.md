# Droua Payroll Audit — تصميم الأمان والمعمارية

> **حالة المستند:** مقترح للاعتماد. لم يُكتب أي كود بعد، ولم تُنشأ أي جداول،
> ولم تُضبط أي متغيّرات بيئة، ولم يُنشر شيء. لم يُمسّ مسير أجير الحالي بحرف.
>
> **بُني على فحص فعلي للمشروع** (لا افتراضات): `middleware.mjs`، `api/app.js`،
> `lib/auth/*`، `lib/db.js`، `lib/blob.js`، `lib/data/registry.js`،
> `lib/payroll/*`، `lib/data/payrollRuns.js`، `vercel.json`، `sw.js`،
> `app-nav.js`، `scripts/setup-*.js`، ومجلد `test/`.

---

## 0. ما وجدته في المنصّة الحالية (الأساس الذي بُني عليه كل قرار)

| الجانب | الواقع الحالي | أثره على التصميم |
|---|---|---|
| **Auth** | كوكي `session` يحمل توكن HMAC-SHA256 يدويًا (`lib/auth/tokens.js`)، حمولته `{sub, email, role, remember, iat, exp}`، موقّع بـ`SESSION_SECRET`. | نعيد استخدام آلية التوقيع نفسها لجلسة القسم — لكن **بسرّ مستقلّ**. |
| **الكوكي** | `HttpOnly; Secure; SameSite=Lax; Path=/`، مهلة خمول 30 دقيقة أو 30 يومًا مع «تذكّرني». | `SameSite=Lax` **لا يكفي** ضد CSRF على POST؛ كوكي القسم سيكون `Strict`. |
| **التحقّق في كل مسار** | `requireUser(req)` يقرأ الكوكي ثم يقرأ المستخدم من Neon ويتحقّق `status === 'active'` — **لا يثق بأي هيدر من الوسيط**. | ممتاز؛ نبني فوقه بالضبط. |
| **Middleware** | `matcher: ["/((?!api/cron).*)"]` — كل شيء عدا الكرون. يمرّر من عنده جلسة صالحة، ويردّ 401 على `/api/*` أو 302 إلى `/login.html` على الصفحات. | مسارات ذروة ستمرّ به تلقائيًا كطبقة أولى، وهذا **يخفي وجود القسم عن غير المسجَّلين** لأن كل مسار غير موجود يتصرّف بالطريقة نفسها. |
| **Roles / Permissions** | كتالوج `SECTIONS` في `lib/auth/permissions.js`. **`owner` يُرجع `true` لكل شيء دائمًا** (`hasPermission`: `if (user.role === "owner") return true`). | ⚠️ **هذا وحده يُبطل أي حماية قائمة على صلاحية**. لذلك الحصر سيكون **allowlist صريحة بهوية المستخدم**، لا صلاحية ولا دور. |
| **API routing** | دالّة خادمة واحدة `api/app.js` تستقبل كل شيء عبر rewrites في `vercel.json`، وتوزّع على `auth/data/files/reports/push`. | ذروة تحصل على **دالّة خادمة مستقلّة** لعزل حقيقي في مستوى الشيفرة. |
| **Data layer** | `lib/data/registry.js` يربط `/api/data/:resource` بوحدات CRUD عامّة، والحارس فيها `hasPermission(actor, mod.section, action)`. | ⚠️ **ممنوع منعًا باتًا تسجيل ذروة في هذا الـregistry** — التسجيل وحده يجعلها قابلة للوصول بصلاحية عامّة. |
| **Neon** | `lib/db.js` singleton كسول على `DATABASE_URL`. لا نظام migrations — الجداول تُنشأ بسكربتات `scripts/setup-*.js` كلّها `IF NOT EXISTS` وقابلة لإعادة التشغيل، مع `--dry-run`. | نتبع النمط نفسه حرفيًا: `scripts/setup-droua-payroll.js`. |
| **Vercel Blob** | `lib/blob.js` يستعمل `access: "public"` + `addRandomSuffix` ويخزّن **الرابط** في القاعدة. | ⚠️ روابط عامّة: من يملك الرابط يفتح الملف بلا جلسة. **غير مقبول لذروة إطلاقًا.** |
| **إصدار الـSDK** | `@vercel/blob@2.8.0`. فحصت تعريفات الأنواع فعليًا: `BlobAccessType = 'public' \| 'private'`، و`put(..., {access:'private'})` مدعوم، و`get(pathname, {access:'private'})` يُرجع stream، و`presignUrl()` موجود. | ✅ **التخزين الخاص متاح في الـSDK المثبَّت.** يبقى التحقّق من تفعيله على المتجر الفعلي (خطوة نشر، ليست الآن). |
| **Audit** | جدول `audit_log` مشترك (`type, actor_email, actor_id, target_id, meta jsonb, ts`)، و`readLog` **بلا أي مستدعٍ** — لا واجهة تعرضه. | ذروة تحصل على **جدول تدقيق مستقلّ** كي لا يكشف وجودها لمن يقرأ الجدول المشترك. |
| **Rate limiting** | **لا يوجد إطلاقًا** في المنصّة. `login_failed` يُسجَّل فقط، بلا عدّ ولا قفل. | يجب بناؤه من الصفر لبوابة ذروة، وفي Neon لا في الذاكرة. |
| **Service Worker** | `sw.js` فيه `push` و`notificationclick` فقط — **لا `fetch` handler ولا cache**. | ✅ لا خطر تخزين مؤقّت لأي استجابة ذروة في المتصفّح عبر الـSW. |
| **Nav** | `app-nav.js` يبني القائمة من مصفوفة `DEST` بمفتاح `perm`. | ذروة **لا تُضاف إليها إطلاقًا**، وصفحات ذروة لا تُحمّل `app-nav.js` أصلًا. |
| **عدد الدوالّ** | 2 فقط (`api/app.js`, `api/cron/check-expirations.js`). سقف Hobby = 12. | إضافة دالّة ثالثة آمنة تمامًا. |

---

## 1. كيف نضمن الفصل التام عن أجير

الفصل ليس نيّة، بل **قواعد قابلة للفحص**. هذه القائمة هي عقد المشروع:

### ملفات جديدة بالكامل (لا يلمسها أجير ولا تلمسه)

```
api/droua.js                         ← دالّة خادمة مستقلّة
lib/droua/access.js                  ← الحارس الموحّد (allowlist + بوابة)
lib/droua/gateToken.js               ← توقيع/تحقّق جلسة القسم (سرّ مستقلّ)
lib/droua/gatePassword.js            ← تحقّق كلمة المرور الثانية
lib/droua/rateLimit.js               ← عدّ المحاولات والقفل
lib/droua/audit.js                   ← التدقيق المستقلّ + مُنقّي الحقول
lib/droua/storage.js                 ← Blob خاصّ + تشفير + بثّ عبر الخادم
lib/droua/runs.js                    ← أشهر المسير
lib/droua/files.js                   ← الملفات الأربعة
lib/droua/employees.js               ← صفوف الموظفين لكل شهر
lib/droua/notes.js                   ← الملاحظات
lib/droua/parse/{cash,full,transfer,roster}.js
lib/droua/review/engine.js           ← محرّك المقارنة والملاحظات
droua-audit-shell.html               ← قائمة الأشهر
droua-audit-month-shell.html         ← صفحة الشهر
droua-audit-gate-shell.html          ← شاشة كلمة المرور
droua-audit.css / droua-audit.js     ← واجهة مستقلّة
scripts/setup-droua-payroll.js       ← تهيئة الجداول (IF NOT EXISTS + --dry-run)
test/droua-*.test.js                 ← اختبارات مستقلّة
```

### ما يُعاد استعماله — وهو **utilities عامّة بلا أي منطق أجير**

| الوحدة | لماذا الاستعمال آمن |
|---|---|
| `lib/db.js` | مجرّد `neon(DATABASE_URL)` singleton. لا يعرف جدولًا واحدًا. |
| `lib/auth/requireAuth.js` | يتحقّق من **هوية المنصّة** فقط. لا يقرّر صلاحية ولا يمسّ بيانات. |
| `lib/auth/tokens.js` (`sign`/`verify`) | تشفير خالص. سنستعمله **بسرّ مختلف** — ولذلك لن يُقبل توكن أحدهما في الآخر. |
| `lib/auth/passwords.js` | scrypt خالص. (سأغلّفه بمعاملات أقوى لبوابة ذروة.) |
| `ui.css` + `assets/fonts/*` | أنماط وخطوط. صفر بيانات. |

### ما هو **ممنوع** صراحةً (كل بند منها ثغرة فعلية لو خولف)

1. ❌ **ممنوع** تسجيل أي وحدة ذروة في `lib/data/registry.js`.
   السبب: التسجيل وحده يجعلها قابلة للنداء عبر `/api/data/<name>` تحت حارس
   `hasPermission(actor, mod.section, action)` — أي حامل صلاحية عامّة يصل.
2. ❌ **ممنوع** إضافة قسم `droua` إلى `SECTIONS` في `lib/auth/permissions.js`.
   السبب: الكتالوج يُرسل كاملًا إلى مودال «إدارة الصلاحيات» لكل من يملك
   `users:manage` — فيرى اسم القسم ووجوده.
3. ❌ **ممنوع** إضافة مفتاح إلى `PAGE_PERMISSION` أو `PAGE_FILES` في `api/app.js`.
4. ❌ **ممنوع** إضافة عنصر إلى `DEST` في `app-nav.js`، أو أي شارة/عدّاد/إشعار.
5. ❌ **ممنوع** الكتابة في `payroll_runs` أو `payroll_attachments` أو
   `payroll_transfer_proofs` أو `audit_log` أو `employees`.
6. ❌ **ممنوع** استعمال `lib/blob.js` (لأنه `access: "public"`).
7. ❌ **ممنوع** استعمال `lib/push/*` أو `lib/notifications/*` —
   إشعار على شاشة القفل أو بريد في صندوق مشترك يكشف وجود القسم ومحتواه.
8. ❌ **ممنوع** استعمال `SESSION_SECRET` لتوقيع جلسة القسم.
9. ❌ **ممنوع** وضع أي مسار ذروة تحت `/api/cron/` (الوسيط يستثنيه من الفحص).

### الملفات المشتركة التي سنلمسها — القائمة كاملة وبصدق

| الملف | التغيير | أثره على أجير |
|---|---|---|
| `vercel.json` | **إضافة** 3 rewrites + مدخل `functions` لـ`api/droua.js` | صفر — إضافة بحتة، لا تعديل سطر قائم |
| `api/app.js` | **سطر واحد اختياري**: عند `logout` يُمسح كوكي البوابة أيضًا | صفر — سلوك الخروج لا يتغيّر |
| `package.json` | ربما مكتبة قراءة Excel واحدة (حسب صيغة ملفاتك) | صفر |

**لا شيء غير ذلك.** ولو فضّلت، حتى السطر في `api/app.js` يمكن إسقاطه: جلسة
البوابة عديمة الأثر أصلًا بلا جلسة منصّة صالحة (الحارس يتحقّق من الاثنتين معًا).

### حاجز آلي يمنع الانزلاق مستقبلًا

اختبار `test/droua-isolation.test.js` يقرأ ملفات `lib/droua/**` و`api/droua.js`
نصًّا ويفشل لو ظهر فيها أيّ من: `payroll_runs`، `payroll_transfer_proofs`،
`payroll_attachments`، `audit_log`، `data/registry`، `auth/permissions`،
`lib/blob`، `lib/push`، `lib/notifications`. واختبار مقابل يفشل لو ظهرت كلمة
`droua` في `permissions.js` أو `registry.js` أو `app-nav.js`.
**الفصل يصير مفروضًا في CI لا موثوقًا به في المراجعة.**

---

## 2. نموذج البيانات المقترح (Data Model)

كل الأسماء ببادئة `droua_`. لا مفتاح أجنبي واحد نحو أي جدول قائم.

### `droua_payroll_runs` — شهر واحد لكل صفّ

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_runs (
  id             text PRIMARY KEY,           -- 'YYYY-MM' مثل '2026-09'
  month_label    text NOT NULL,              -- 'سبتمبر 2026' (من lib/reports/period.js)
  status         text NOT NULL DEFAULT 'draft',
                 -- draft | files_complete | reviewed
  review_summary jsonb,                      -- أرقام لوحة المعلومات فقط، بلا أسماء ولا مبالغ فردية
                 -- {employees:45, unchanged:39, changed:4, openNotes:2, reviewedAt:'...'}
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_at    timestamptz
);
```

### `droua_payroll_files` — أربعة ملفات لكل شهر

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_files (
  id             bigserial PRIMARY KEY,
  run_id         text NOT NULL REFERENCES droua_payroll_runs(id) ON DELETE CASCADE,
  kind           text NOT NULL,   -- cash | full | transfer | roster
  -- ⚠️ نُخزّن pathname لا URL. لا يوجد في القاعدة كلّها رابط قابل للفتح.
  blob_pathname  text NOT NULL,
  file_name      text NOT NULL,
  content_type   text NOT NULL,
  size_bytes     bigint NOT NULL,
  sha256         text NOT NULL,   -- سلامة + كشف رفع الملف نفسه مرّتين
  enc_algo       text,            -- 'aes-256-gcm' حين يُشفَّر قبل الرفع
  enc_iv         text,
  enc_tag        text,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  uploaded_by    text NOT NULL,
  parse_status   text NOT NULL DEFAULT 'pending',  -- pending | ok | failed
  parsed_at      timestamptz,
  parse_error    text,            -- سبب مختصر بلا أي محتوى من الملف
  -- أربع خانات لا غير: الاستبدال UPDATE لا صفّ ثانٍ
  UNIQUE (run_id, kind)
);
```

**`kind`:** `cash` = مسير الرواتب كاش · `full` = مسير الرواتب كامل ·
`transfer` = مسير الرواتب تحويل · `roster` = تقرير قائمة الموظفين.

### `droua_payroll_employees` — لقطة صفوف الموظفين لكل شهر ولكل ملف

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_employees (
  id               bigserial PRIMARY KEY,
  run_id           text NOT NULL REFERENCES droua_payroll_runs(id) ON DELETE CASCADE,
  source           text NOT NULL,     -- cash | full | transfer | roster
  row_no           integer NOT NULL,  -- رقم السطر في الملف — للتتبّع عند الخطأ
  emp_no           text,              -- الرقم الوظيفي في ذروة
  full_name        text,
  job_title        text,
  basic            numeric(12,2),
  housing          numeric(12,2),
  transport        numeric(12,2),
  other_allowances numeric(12,2),
  overtime         numeric(12,2),
  deductions       numeric(12,2),
  absence          numeric(12,2),
  advance          numeric(12,2),     -- سلفة
  gross            numeric(12,2),
  net              numeric(12,2),
  pay_method       text,              -- cash | transfer | unknown
  bank_name        text,
  iban_last4       text,              -- آخر أربعة فقط
  iban_hash        text,              -- HMAC للمقارنة بين الشهور بلا تخزين الرقم
  raw              jsonb,             -- بقية الأعمدة كما قُرئت
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_droua_emp_run_src  ON droua_payroll_employees (run_id, source);
CREATE INDEX IF NOT EXISTS idx_droua_emp_run_emp  ON droua_payroll_employees (run_id, emp_no);
```

**قراران يستحقّان التوقّف عندهما:**

1. **لا `UNIQUE (run_id, source, emp_no)` عمدًا.** أنت طلبت «تكرار موظف»
   كملاحظة. لو وضعنا قيد فرادة، لفشل الاستيراد بدل أن يُنتج الملاحظة —
   أي أن الحاجز يبتلع النتيجة المطلوبة. **الملف دليل يُخزَّن كما هو،
   والتكرار يُكتشف في المراجعة.**
2. **لا `IBAN` كاملًا افتراضيًا.** التخزين `iban_last4` للعرض و`iban_hash`
   للمقارنة بين الشهور يكفي لكل ملاحظاتك، ويقلّل الضرر جذريًا لو تسرّبت
   القاعدة. لو احتجت الرقم كاملًا لاحقًا نضيف عمودًا مشفَّرًا بمفتاح منفصل.

### `droua_payroll_notes` — الملاحظات

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_notes (
  id             bigserial PRIMARY KEY,
  run_id         text NOT NULL REFERENCES droua_payroll_runs(id) ON DELETE CASCADE,
  code           text NOT NULL,       -- انظر الجدول أدناه
  severity       text NOT NULL,       -- info | warn | critical
  title          text NOT NULL,       -- العنوان
  emp_no         text,                -- الموظف
  emp_name       text,
  current_month  text NOT NULL,       -- الشهر الحالي  'YYYY-MM'
  previous_month text,                -- الشهر السابق  'YYYY-MM'
  field          text,                -- الحقل المتغيّر (net/basic/housing/...)
  old_value      text,                -- القيمة السابقة
  new_value      text,                -- القيمة الجديدة
  delta          numeric(12,2),       -- مقدار الفرق
  description    text NOT NULL,       -- الوصف
  status         text NOT NULL DEFAULT 'needs_review',
                 -- needs_review | verified | approved_change | needs_correction
  user_note      text,                -- ملاحظة المستخدم
  -- بصمة ثابتة = hash(run_id, code, emp_no, field) — الحاجز الذي يجعل
  -- إعادة تشغيل المراجعة تُحدِّث الملاحظة ولا تُنشئ ثانية ولا تمحو حالتي.
  fingerprint    text NOT NULL,
  detector_ver   integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by    text,
  UNIQUE (run_id, fingerprint)
);
```

**نقطة تصميم جوهرية:** «تشغيل المراجعة» يجب أن يكون **idempotent**. إعادة
تشغيله بعد أسبوع — بعد أن أكون قد وضعت «تم التحقق» على ثلاث ملاحظات —
يجب ألّا تعود الحالات إلى «تحتاج مراجعة». الآلية:
`INSERT ... ON CONFLICT (run_id, fingerprint) DO UPDATE SET` الحقول
المحسوبة فقط (`old_value`, `new_value`, `delta`, `description`, `updated_at`)،
و**`status` و`user_note` لا تُلمسان إطلاقًا**. وملاحظة اختفت من نتيجة
التشغيل الجديد تُوسم `stale` بدل أن تُحذف.

**كتالوج رموز الملاحظات** (مطابق لقائمتك حرفًا بحرف):

| `code` | المعنى | `severity` |
|---|---|---|
| `new_employee` | موظف جديد لم يكن في الشهر السابق | info |
| `missing_employee` | موظف اختفى عن الشهر السابق | warn |
| `net_changed` | تغيّر صافي الراتب | warn |
| `basic_changed` | تغيّر الأساسي | warn |
| `housing_changed` | تغيّر بدل السكن | warn |
| `transport_changed` | تغيّرت المواصلات | warn |
| `overtime_changed` | تغيّر الـovertime | info |
| `deduction_changed` | تغيّرت الخصومات | warn |
| `absence_changed` | تغيّر الغياب | info |
| `advance_changed` | تغيّرت السلفة | warn |
| `full_vs_transfer_mismatch` | اختلاف بين مسير كامل ومسير تحويل | critical |
| `in_roster_not_in_payroll` | في قائمة الموظفين وغير موجود في المسير | critical |
| `in_payroll_not_in_roster` | في المسير وغير موجود في قائمة الموظفين | critical |
| `cash_placement_mismatch` | موجود في Cash وغير موجود حيث يجب | critical |
| `duplicate_employee` | تكرار موظف داخل الملف نفسه | critical |
| `pay_method_changed` | تغيّر وسيلة الصرف Cash ↔ Transfer | warn |
| `iban_changed` | تغيّر حساب التحويل (بمقارنة `iban_hash`) | critical |
| `totals_mismatch` | مجموع الصفوف ≠ إجمالي الملف | critical |
| `name_number_conflict` | الاسم نفسه برقم وظيفي مختلف (أو العكس) | warn |
| `inconsistency` | أي فرق أو تعارض آخر بين الملفات | warn |

**مطابقة الموظف بين الشهور:** المفتاح الأساسي `emp_no`. المطابقة بالاسم
تُستعمل **للتحقّق فقط** لا للربط — وهذا مقصود: الربط بالاسم هو المصدر
الأول لملاحظات «موظف جديد» + «موظف اختفى» الكاذبة (المتلازمتين). لو اختلف
الرقم مع تطابق الاسم نُخرج `name_number_conflict` بدل أن نخمّن.

### `droua_payroll_audit` — التدقيق المستقلّ

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_audit (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  event        text NOT NULL,
  actor_id     text,
  actor_email  text,
  run_id       text,
  target       text,        -- kind الملف / معرّف الملاحظة / emp_no
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash      text,        -- HMAC(ip, DROUA_AUDIT_HASH_KEY) — لا IP خام
  ua_hash      text
);
CREATE INDEX IF NOT EXISTS idx_droua_audit_ts ON droua_payroll_audit (ts DESC);
```

### `droua_gate_attempts` — عدّ محاولات كلمة المرور

```sql
CREATE TABLE IF NOT EXISTS droua_gate_attempts (
  id        bigserial PRIMARY KEY,
  actor_id  text NOT NULL,
  ip_hash   text,
  outcome   text NOT NULL,   -- fail | success
  ts        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_droua_attempts ON droua_gate_attempts (actor_id, ts DESC);
```

### `droua_gate_sessions` — جلسات القسم (لتمكين الإبطال الفعلي)

```sql
CREATE TABLE IF NOT EXISTS droua_gate_sessions (
  sid          text PRIMARY KEY,        -- jti عشوائي 32 بايت
  user_id      text NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_exp timestamptz NOT NULL,    -- السقف المطلق — لا يُمدَّد أبدًا
  revoked_at   timestamptz,
  ua_hash      text
);
```

**لماذا هذا الجدول ضروري:** توكن HMAC وحده **لا يمكن إبطاله**. بلا صفّ في
القاعدة، «قفل القسم» يمسح الكوكي من متصفّحي فقط — ونسخة مسروقة منه تبقى
صالحة حتى انتهائها. مع `sid` يصير الإبطال حقيقيًا وفوريًا.

---

## 3. المسارات (Routes)

### الصفحات

| المسار | ما يُقدَّم |
|---|---|
| `GET /droua-audit.html` | قائمة الأشهر — أو **شاشة كلمة المرور** إن لم تكن البوابة مفتوحة |
| `GET /droua-audit/:month` | صفحة الشهر (`2026-09`) — أو شاشة كلمة المرور |

شاشة كلمة المرور **ليست مسارًا مستقلًّا** بل تُعرَض من نفس المسار. السبب:
مسار `/droua-unlock.html` مستقلّ يصير سطحًا إضافيًا يمكن استهدافه ورصده،
بلا أي مكسب.

### الـAPI — كلّها تحت `/api/droua/*`

| الفعل | المسار | البوابة مطلوبة؟ |
|---|---|---|
| `GET` | `/api/droua/gate/status` | ❌ (allowlist فقط) |
| `POST` | `/api/droua/gate/unlock` | ❌ (allowlist فقط) |
| `POST` | `/api/droua/gate/lock` | ❌ (allowlist فقط) |
| `GET` | `/api/droua/runs` | ✅ |
| `POST` | `/api/droua/runs` | ✅ |
| `GET` | `/api/droua/runs/:month` | ✅ |
| `POST` | `/api/droua/files?month=&kind=` | ✅ |
| `GET` | `/api/droua/files/:id/download` | ✅ |
| `DELETE` | `/api/droua/files/:id` | ✅ |
| `POST` | `/api/droua/review?month=` | ✅ |
| `GET` | `/api/droua/notes?month=` | ✅ |
| `PUT` | `/api/droua/notes/:id` | ✅ |

**كل واحد منها — بلا استثناء — أول سطر فيه `requireDrouaAccess(req)`.**
لا وراثة، ولا حارس على مستوى الموزّع وحده، ولا افتراض «الوسيط تكفّل».

### إضافات `vercel.json` (إضافة بحتة)

```json
{ "source": "/droua-audit.html",  "destination": "/api/droua?kind=page&page=list" },
{ "source": "/droua-audit/:month","destination": "/api/droua?kind=page&page=month&month=:month" },
{ "source": "/api/droua/:path*",  "destination": "/api/droua?kind=api&apiPath=:path*" }
```

```json
"functions": {
  "api/app.js":   { "includeFiles": "{*-shell.html,assets/fonts/*.ttf}" },
  "api/droua.js": { "includeFiles": "droua-audit*.html" }
}
```

---

## 4. آلية حصر الدخول على يوزري أنا وحدي

### أقوى مُعرّف مستقرّ في نظام الدخول الحالي: `users.id`

فحصت الخيارات الثلاثة في `lib/auth/users.js`:

| المُعرّف | صالح؟ | لماذا |
|---|---|---|
| `user.role` | ❌ | `owner` يُرجع `true` لكل صلاحية. وأي admin يستطيع تغيير الأدوار. |
| `user.email` | ⚠️ ليس وحده | **قابل للتغيير**: أي حامل `users:edit` ينفّذ `PUT /api/data/users` بـ`{email}` — فيستطيع تسمية حسابه ببريدي وينتحل الـallowlist. |
| `user.id` | ✅ **الأقوى** | UUID يولّده الخادم بـ`crypto.randomUUID()` عند الإنشاء. `updateUser` يكتب كل عمود **عدا `id`** (`WHERE id = ${id}`) — فلا مسار في التطبيق كلّه يغيّره أو يحدّده. غير قابل للتخمين وغير قابل للتزوير. |

### القرار: `user.id` أساسًا + `email` تأكيدًا (يجب تطابق الاثنين)

```js
// lib/droua/access.js  (توضيحي)
const ALLOWED_IDS    = (process.env.DROUA_AUDIT_USER_IDS || "").split(",").map(s=>s.trim()).filter(Boolean);
const ALLOWED_EMAILS = (process.env.DROUA_AUDIT_EMAILS  || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

function isAllowlisted(user) {
  if (!ALLOWED_IDS.length || !ALLOWED_EMAILS.length) return false;   // fail-closed
  return ALLOWED_IDS.includes(user.id)
      && ALLOWED_EMAILS.includes(String(user.email).toLowerCase());
}
```

الشرطان معًا يغلقان الاتجاهين: من يبدّل بريده لا ينفع لأن `id` مختلف،
ولو تسرّب `id` بطريقة ما لا ينفع لأن البريد مختلف. و**الفشل المغلق**
(`fail-closed`) مقصود: بيئة بلا المتغيّرين لا تفتح القسم لأحد.

### الحارس الموحّد — تسلسل ستّ خطوات

```
requireDrouaAccess(req, res, { needGate })
  1) طريقة HTTP ضمن المسموح لهذا المسار      → 404 وإلا
  2) requireUser(req)  (جلسة منصّة + active)  → 404 وإلا
  3) isAllowlisted(user)                      → 404 وإلا  + تدقيق access_denied
  4) needGate ? جلسة بوابة صالحة : تخطَّ      → 401 gate_required وإلا
  5) Origin / Sec-Fetch-Site على الطرق الكاتبة → 403 وإلا
  6) رؤوس الأمان + no-store على كل استجابة
```

الخطوة 3 تُرجع **404** لا 403 — سبب ذلك في القسم 9.
الخطوة 4 تُرجع 401 لا 404 لأننا هنا **نعرف أنه أنا**، فإخفاء وجود القسم
عن صاحبه بلا معنى؛ والواجهة تحتاج إشارة واضحة لتعرض شاشة كلمة المرور.

### ⚠️ ثغرة حقيقية وجدتها — يجب أن تعرفها قبل الاعتماد

في `api/app.js` مسار `PUT /api/data/users`:

```js
if (password) patch.passwordHash = hashPassword(password);
```

و`canManageUser(actorRole, targetRole)` يحمي **حسابات `owner` فقط**.

**النتيجة:** لو كان حسابي **ليس** `owner`، فأي مستخدم يملك `users:edit`
يستطيع تصفير كلمة مروري والدخول بحسابي — بنفس `id` ونفس البريد — فيجتاز
الـallowlist كاملة.

**العلاج (ثلاث طبقات):**
1. **حسابي يجب أن يكون `role = 'owner'`** — عندها `canManageUser` يمنع أي
   admin من لمسه. (تأكّد أيضًا أن عدد حسابات `owner` في المنصّة = 1.)
2. **كلمة مرور القسم هي الحاجز المستقلّ**: لا توجد في القاعدة ولا في الكود،
   فمن ينتحل حسابي يقف عندها.
3. **تدقيق + إشعار سلوكي**: `gate_unlock_success` من `ua_hash` جديد يُسجَّل
   بوضوح كي يُرى في المراجعة.

> **سؤال لك:** ما دور حسابك الحالي `hr-manager@droua.com` في المنصّة؟
> لو لم يكن `owner`، هذه أول خطوة قبل أي كود.

---

## 5. آلية كلمة المرور الثانية

### التخزين — لا كلمة مرور في أي مكان

```
DROUA_AUDIT_PASSWORD_HASH = "scrypt$17$8$1$<salt-hex>$<hash-hex>"
DROUA_AUDIT_PEPPER        = "<32 بايت عشوائية>"
```

* المتغيّران **Environment Variables في Vercel** (Production فقط، مع
  Sensitive مفعّلة كي لا تُقرأ من اللوحة بعد الحفظ).
* الهاش يُولَّد **على جهازك** بسكربت محلّي `scripts/hash-droua-password.js`
  (يقرأ من stdin بلا echo، يطبع الهاش فقط، ولا يتّصل بشبكة ولا بقاعدة).
  **أنا لا أرى كلمة المرور ولا الهاش في أي لحظة.**
* ❌ ليست في الكود · ❌ ليست في Git · ❌ ليست في Neon · ❌ ليست plaintext في أي مكان.
* الـ**pepper** المستقلّ يُدمج `HMAC-SHA256(password, PEPPER)` **قبل** الـscrypt.
  الفائدة: من يسرّب الهاش وحده (تسريب لقطة شاشة، نسخة قديمة من متغيّرات
  البيئة) لا يستطيع مهاجمته offline بلا الـpepper أيضًا.

### التحقّق

```js
// lib/droua/gatePassword.js  (توضيحي)
function verifyGatePassword(input) {
  const stored = process.env.DROUA_AUDIT_PASSWORD_HASH;
  if (!stored) return false;                                  // fail-closed
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const peppered = crypto.createHmac("sha256", process.env.DROUA_AUDIT_PEPPER).update(input).digest();
  const candidate = crypto.scryptSync(peppered, Buffer.from(salt,"hex"), 64,
                      { N: 1<<Number(N), r: Number(r), p: Number(p), maxmem: 256*1024*1024 });
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length
      && crypto.timingSafeEqual(candidate, expected);          // مقارنة ثابتة الزمن
}
```

* **`timingSafeEqual`** لا `===` — نفس ما تفعله `lib/auth/passwords.js` أصلًا.
* **`N = 2^17`** (أقوى من افتراضي المنصّة `2^14`): ≈ 300ms لكل محاولة على
  الخادم. هذا وحده يجعل التخمين الآلي مكلفًا جدًا، وهو مقبول تمامًا لعملية
  تحدث مرّة أو مرّتين في اليوم.
* **`maxmem`** مضبوط صراحةً وإلّا رمى Node عند `N` كبير.

### عدم التسريب في اللوجّات ولا في الردّ

| القاعدة | التنفيذ |
|---|---|
| لا تُسجَّل كلمة المرور | الحقل يُقرأ في متغيّر محلّي ويُستهلك فورًا؛ **ممنوع** `console.log(body)` أو `JSON.stringify(req.body)` في كامل الوحدة، ويفحصه اختبار نصّي |
| لا تُسجَّل في التدقيق | `sanitizeMeta()` بقائمة مفاتيح **مسموحة** (whitelist) — انظر القسم 10 |
| لا تفاصيل في الردّ | الفشل دائمًا `{ ok:false, error:"تعذّر فتح القسم" }` — لا «كلمة المرور قصيرة» ولا «حرف خاطئ» ولا أي تمييز |
| لا فرق بين «خطأ» و«غير مضبوطة» | البيئة بلا `DROUA_AUDIT_PASSWORD_HASH` تعطي **الردّ نفسه** |
| لا تسريب زمني | زمن `scryptSync` ثابت أساسًا؛ ويُضاف حدّ أدنى ثابت ≈400ms على المسار كلّه (ناجحًا كان أو فاشلًا) قبل الردّ |

### الحماية من brute force

| العدّاد | النافذة | الإجراء |
|---|---|---|
| 5 محاولات فاشلة | 15 دقيقة | قفل 15 دقيقة |
| 10 محاولات فاشلة | ساعة | قفل ساعة |
| 15 محاولة فاشلة | 24 ساعة | قفل 24 ساعة + `severity: critical` في التدقيق |

* العدّ في **Neon** لا في الذاكرة. سبب حاسم: كل طلب على Vercel قد يقع على
  نسخة دالّة جديدة أو متوازية — **عدّاد في الذاكرة ليس ضابطًا، بل وهم ضابط**.
* القفل **لكل `actor_id`**. ولا خطر «حجب الخدمة عنّي» من غريب: كل من ليس في
  الـallowlist يتلقّى 404 **قبل** أن يبلغ المُتحقّق أصلًا، فلا يستطيع رفع
  عدّادي.
* نجاح واحد يمسح العدّاد. وكل `unlock` ينظّف صفوف أقدم من 30 يومًا (تقليم
  دون كرون).
* في حالة القفل الردّ يذكر `retryAfterSeconds` — هذا مقبول لأن الوصول إلى
  هذه النقطة يعني أنه أنا بالفعل.

---

## 6. تصميم جلسة القسم (Session Design)

### الكوكي

```
Set-Cookie: droua_gate=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900
```

| السمة | القيمة | لماذا |
|---|---|---|
| `HttpOnly` | ✅ | لا يصل إليه JavaScript إطلاقًا — يحيّد XSS كمسار سرقة |
| `Secure` | ✅ | HTTPS فقط |
| `SameSite` | **`Strict`** | أقوى من `Lax` المستعمل في كوكي المنصّة: طلب قادم من أي موقع آخر **لا يحمل الكوكي أصلًا**، فينهار CSRF قبل أن يبدأ |
| `Path` | `/` | تحتاجه الصفحات والـAPI معًا |
| `Max-Age` | 900 ثانية | ينتهي في المتصفّح، والخادم لا يعتمد عليه على أي حال |

### الحمولة

```js
{ sub: user.id, sid: "<32 بايت عشوائية>", iat, exp, aexp }
```
موقّعة بـ**`DROUA_GATE_SECRET`** — سرّ **مستقلّ تمامًا** عن `SESSION_SECRET`.
النتيجة: تسريب أحدهما لا يفتح الآخر، وتوكن منصّة لا يُقبل كتوكن بوابة والعكس.

### الارتباط بهويتي (أربعة قيود متزامنة)

1. `payload.sub === user.id` للمستخدم **الحالي** في هذا الطلب.
2. `isAllowlisted(user)` تُعاد في كل طلب — لا تُخزَّن في التوكن.
3. صفّ `droua_gate_sessions` بـ`sid` موجود و`revoked_at IS NULL`.
4. `now() < absolute_exp` **و** `now() - last_seen_at < IDLE`.

**النتيجة العملية:** لو خرجتُ من المنصّة ودخل شخص آخر في المتصفّح نفسه،
كوكي البوابة يبقى موجودًا لكنه **عديم الأثر** — لأن `sub` لن يطابق هويّته،
ولأن الخطوة 3 في الحارس ستردّه بـ404 قبل ذلك أصلًا.

### المدّة المقترحة

> ## ✅ **التوصية: خمول 15 دقيقة · سقف مطلق 60 دقيقة**

| الخيار | خمول | سقف | متى يناسب |
|---|---|---|---|
| متشدّد | 10 د | 45 د | لو راجعت من جهاز مشترك أو مكتب مفتوح |
| **موصى به** | **15 د** | **60 د** | مراجعة مركّزة تستغرق عادة 20–40 دقيقة |
| متساهل | 30 د | 120 د | لا أنصح به لبيانات رواتب |

**المنطق:** مراجعة مسير شهر عمل مركّز ينتهي في جلسة واحدة. 15 دقيقة خمول
تعني أن ابتعادك عن المكتب يقفل القسم تلقائيًا. والسقف المطلق 60 دقيقة يعني
أن جلسة مسروقة — حتى لو ظلّت «نشطة» صناعيًا — تموت خلال ساعة كحدّ أقصى ولا
تُمدَّد إلى الأبد. **السقف المطلق لا يُمدَّد أبدًا؛ الخمول وحده ينزلق.**

الانزلاق يقع على **الطلبات المصادَق عليها فقط** (`UPDATE last_seen_at`)،
ولا يتجاوز `absolute_exp` بحال.

### انتهاء الجلسة والخروج

| الحدث | الأثر |
|---|---|
| مرور 15 د بلا نشاط | الطلب التالي → 401 → شاشة كلمة المرور |
| مرور 60 د من الفتح | نفس الشيء، حتمًا |
| `POST /api/droua/gate/lock` | `revoked_at = now()` + مسح الكوكي |
| تسجيل الخروج من المنصّة | الجلسة تصير عديمة الأثر تلقائيًا (الخطوة 2 في الحارس) — وإن أضفنا السطر الاختياري في `api/app.js` يُمسح الكوكي أيضًا |
| تعطيل حسابي (`status ≠ active`) | `requireUser` يردّ null → 404 |

### ممنوع `localStorage`

* التوكن في كوكي `HttpOnly` — **لا يمكن** لـJS قراءته أو حفظه ولو أراد.
* الواجهة تعرف «القسم مفتوح» من ردّ الخادم `{unlocked:true, expiresAt}` لا
  من تخزين محلّي.
* ❌ لا `localStorage` · ❌ لا `sessionStorage` · ❌ لا IndexedDB لأي شيء من
  هذا القسم — لا كلمة مرور، ولا توكن، ولا بيانات رواتب مخبّأة، ولا حتى
  «آخر شهر فتحته».
* عدّاد الوقت المتبقّي في الواجهة يعتمد على `expiresAt` من الردّ، وهي معلومة
  غير حسّاسة.

---

## 7. تصميم التخزين الخاصّ للملفات

### ما وجدته فعليًا في `@vercel/blob@2.8.0`

فحصت تعريفات الأنواع في الحزمة نفسها (لا من الذاكرة):

```
BlobAccessType = 'public' | 'private'                  ← put() يقبل الاثنين
get(pathname, { access:'private' }) → { stream, blob } ← قراءة بالتوكن
presignUrl(..., { access:'public'|'private' })         ← روابط موقّتة موقّعة
```

✅ **التخزين الخاصّ مدعوم في الـSDK المثبَّت.** يبقى التأكّد من تفعيله على
المتجر الفعلي في حسابك — وهذه خطوة نشر لا تقع الآن.

### التصميم الموصى به — ثلاث طبقات

```
1) put(pathname, ciphertext, { access:'private', addRandomSuffix:true })
2) تشفير AES-256-GCM على الخادم قبل الرفع
3) التنزيل بثًّا عبر الخادم — لا رابط للمتصفّح إطلاقًا
```

**الطبقة 2 (التشفير) ليست زائدة عن الحاجة.** هي التي تجعل الأمان مستقلًّا
عن صحّة إعداد المتجر: لو تبيّن أن الخصوصية غير مفعّلة على الخطة، أو أُعيد
ضبط المتجر خطأً، أو تسرّب `BLOB_READ_WRITE_TOKEN` وحده — **يبقى ما يخرج
منه شيفرة لا معنى لها** بلا `DROUA_FILE_KEY`. تكلفتها صفر عمليًا لأربعة
ملفات صغيرة في الشهر.

### المسارات

```
droua-payroll-audit/2026-09/cash/<random>-<safe-name>.pdf
droua-payroll-audit/2026-09/full/...
droua-payroll-audit/2026-09/transfer/...
droua-payroll-audit/2026-09/roster/...
```
بالضبط كما طلبت: `droua-payroll-audit/<year-month>/...` — ولا يشترك في أي
جزء من مسار مع ملفات أجير (`payroll/`، `permits/`، `uploads/`).

### التنزيل — نقطة الحماية الحقيقية

```js
GET /api/droua/files/:id/download
  1. requireDrouaAccess(req, { needGate: true })   ← أنا + البوابة مفتوحة
  2. اقرأ الصفّ من droua_payroll_files             ← pathname من القاعدة لا من الطلب
  3. get(pathname, { access:'private', token })     ← بتوكن الخادم
  4. فُكّ التشفير (AES-256-GCM، والوسم يُتحقّق منه)
  5. ابعث بالرؤوس القسرية أدناه
```

```
Content-Type: <من قائمة مسموحة قسرًا — لا من الطلب ولا من الملف>
Content-Disposition: attachment; filename*=UTF-8''<encoded>
Cache-Control: no-store, private, max-age=0, must-revalidate
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
Referrer-Policy: no-referrer
X-Robots-Tag: noindex, nofollow, noarchive
```

**`Content-Type` قسريّ** (`application/pdf` أو نوع Excel أو
`application/octet-stream`) وليس ما أرسله العميل عند الرفع. سبب ذلك حاسم:
ملف يُقدَّم بـ`text/html` من **نطاقنا نفسه** يصير XSS مخزَّنًا يعمل داخل
سياق يملك كوكي المنصّة وكوكي البوابة معًا. هذا خطأ شائع جدًا ومكلف.

### ⚠️ لماذا لا أنصح بـ`presignUrl` كمسار افتراضي

الرابط الموقّع **هو نفسه كلمة مرور مكتوبة في شريط العنوان**: يدخل تاريخ
المتصفّح، وقد يُرسَل في `Referer`، ويظهر في لقطة شاشة أو مشاركة سريعة،
وينسخه أي إضافة متصفّح. البثّ عبر الخادم يزيل هذه الفئة كاملة.
يبقى `presignUrl` احتياطًا وحيدًا لو تجاوز ملفٌ ما حدود حجم استجابة الدالّة،
وعندها بـ`validUntil ≤ 60` ثانية وللتنزيل فقط.

### سلّم البدائل — بصراحة تامّة

| # | الخيار | الحكم |
|---|---|---|
| 1 | Private Blob + تشفير + بثّ عبر الخادم | ✅ **الموصى به** |
| 2 | Public Blob + تشفير + بثّ عبر الخادم | ✅ مقبول تمامًا — الرابط المسرَّب يعطي شيفرة فقط |
| 3 | تخزين البايتات في Neon (`bytea`) | ✅ مقبول — 4 ملفات صغيرة/شهر، تحكّم كامل، بلا اعتماد على Blob |
| 4 | Public Blob + `addRandomSuffix` بلا تشفير | ❌ **مرفوض** — هذا «إخفاء» لا «حماية»، ويخالف شرطك نصًّا |

لن نصل إلى (4) بأي حال. لو تعذّرت الخصوصية على الخطة، ننتقل إلى (2) أو (3)
وأخبرك صراحةً بأيّهما.

### الرفع والاستبدال

* حدّ حجم (10 MB مقترح) يُفرض **أثناء البثّ** لا بعده.
* فحص **البايتات الأولى** لا الامتداد ولا `Content-Type`: `%PDF-` للـPDF،
  `PK\x03\x04` للـxlsx. الامتداد وحده يُزوَّر بنداء API مباشر.
* الاستبدال: ارفع الجديد ← حدّث الصفّ ← ثم احذف القديم (best-effort).
  **لا حذف قبل نجاح الرفع** كي لا يبقى شهر بلا ملف بسبب انقطاع.

---

## 8. حماية الـAPIs

### مبدأ واحد لا استثناء له

> **كل endpoint يتحقّق من الهوية بنفسه.** لا وراثة من الوسيط، ولا حارس على
> مستوى الموزّع وحده، ولا افتراض «الطلب وصل إلى هنا فهو موثوق».

هذا ليس اجتهادًا مني — هو نفس المبدأ الموثّق في `lib/auth/requireAuth.js`
في مشروعك: *«it never trusts a header set by the routing middleware»*.
نكمل عليه.

### طبقات كل طلب

| # | الطبقة | الفشل |
|---|---|---|
| 1 | `middleware.mjs` — جلسة منصّة موجودة | 401 / 302 (سلوك عام لكل المسارات) |
| 2 | طريقة HTTP ضمن المسموح لهذا المسار | 404 |
| 3 | `requireUser` — جلسة صالحة + `status='active'` | 404 |
| 4 | `isAllowlisted(user)` | 404 |
| 5 | جلسة بوابة صالحة | 401 `gate_required` |
| 6 | CSRF: `Origin` + `Sec-Fetch-Site` على POST/PUT/DELETE | 403 |
| 7 | تحقّق المدخلات (شهر بصيغة `YYYY-MM`، `kind` من أربعة، `status` من أربعة) | 400 |
| 8 | حدّ معدّل لكل حساب | 429 |

### CSRF

* الدفاع الأول: `SameSite=Strict` على كوكي البوابة. طلب من موقع آخر **لا
  يحمله**، فيسقط عند الطبقة 5.
* الدفاع الثاني: على كل طريقة كاتبة، رفض `Sec-Fetch-Site: cross-site` ورفض
  `Origin` مخالف لـ`Host`.
* ملاحظة مهمّة: كوكي المنصّة `SameSite=Lax` — وهذا **لا يكفي** وحده لمنع
  CSRF على POST. لكن ذروة لا تعتمد عليه: بلا كوكي البوابة (Strict) لا شيء
  يمرّ.

### IDOR

* `/api/droua/files/:id` و`/api/droua/notes/:id` يقرآن الصفّ ويتحقّقان أن
  `run_id` يعود إلى مسير ذروة قبل أي عملية. الجداول ذروية بالكامل فالشرط
  محقّق تلقائيًا — لكن **يُكتب صراحةً** كي لا يسقط عند أي توسعة لاحقة.

### رؤوس على **كل** استجابة (صفحات وAPI)

```
Cache-Control: no-store, private, max-age=0, must-revalidate
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-Robots-Tag: noindex, nofollow, noarchive
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'
```

### الأخطاء

`api/droua.js` لا يستعمل الـcatch-all في `api/app.js` (الذي يُرجع
`err.message` إلى العميل). له `try/catch` خاصّ يُرجع
`{ ok:false, error:"تعذّر تنفيذ العملية" }` ويسجّل التفصيل في التدقيق
بعد تنقيته. **رسالة خطأ Postgres مسرَّبة تكشف أسماء الجداول والأعمدة.**

---

## 9. حماية مباشرة الرابط (Direct-link)

### مصفوفة السلوك

| من | الطلب | الردّ | ما يستنتجه |
|---|---|---|---|
| غير مسجَّل | `/droua-audit.html` | 302 → `/login.html` | لا شيء — كل مسار في المنصّة يفعل هذا |
| غير مسجَّل | `/api/droua/runs` | 401 `{ok:false,error:"غير مسجّل الدخول"}` | لا شيء — نفس ردّ أي مسار |
| مسجَّل، ليس في الـallowlist | `/droua-audit.html` | **404** `Not found` | «هذه الصفحة غير موجودة» |
| مسجَّل، ليس في الـallowlist | `/api/droua/runs` | **404** `{ok:false,error:"Not found"}` | «هذا المسار غير موجود» |
| أنا، البوابة مقفلة | صفحة | 200 + شاشة كلمة المرور، **بلا أي بيانات** | — |
| أنا، البوابة مقفلة | API | 401 `{ok:false,error:"gate_required"}` | — |

### لماذا 404 وليس 403 — وهل يناسب البنية الحالية؟ **نعم تمامًا**

403 يقول «هذا موجود لكن لا تملك صلاحيته» — أي **يؤكّد وجود قسم رواتب سرّي**.
404 يقول «لا شيء هنا».

والأجمل أن الردّ **مطابق حرفيًا** لما تُنتجه المنصّة أصلًا لمسار غير موجود:

* الصفحات: `res.status(404).end("Not found")` — نفس `api/app.js:82`
* الـAPI: `res.status(404).json({ ok:false, error:"Not found" })` — نفس `api/app.js:72`

فالردّ ليس «404 مصطنعًا» يمكن تمييزه، بل **نفس البايتات ونفس الرؤوس** التي
يراها من يكتب `/xyz.html`. لا فرق في المحتوى ولا في الطول ولا في الرؤوس.

### الإخفاء من الواجهة (طبقة ثانية، لا الأولى)

* ❌ لا عنصر في `DEST` داخل `app-nav.js` — القسم غير موجود في القائمة لأحد.
* ❌ لا زرّ، لا رابط، لا بطاقة في لوحة المعلومات.
* ❌ لا شارة ولا عدّاد ولا إشعار — **الوحدة لا تستورد `lib/push/*` ولا
  `lib/notifications/*` إطلاقًا**، فلا يمكن أن يظهر عنوان على شاشة قفل جهاز
  أو في بريد مشترك.
* ❌ صفحات ذروة **لا تُحمّل `app-nav.js`** أصلًا — لها ترويسة خاصّة بسيطة.
  هكذا يستحيل تسرّب عبر تعديل مستقبلي في شريط التنقّل.
* ✅ `sw.js` بلا `fetch` handler وبلا cache — لا استجابة ذروة تُخزَّن في
  المتصفّح عبر عامل الخدمة (تحقّقت من ذلك في الملف).
* ✅ لا ذكر لأي مسار ذروة في `manifest.webmanifest`.

> **وأكرّر ما قلته أنت حرفًا:** الإخفاء **ليس** وسيلة الحماية. لو نُزع كل ما
> في هذه القائمة وبقي الحارس في الخادم، لبقي القسم محميًا تمامًا. الإخفاء
> يمنع الفضول والتسريب العَرَضي، والخادم هو الذي يمنع الوصول.

---

## 10. التدقيق (Audit)

### الأحداث المسجَّلة

| الحدث | متى |
|---|---|
| `access_denied` | مستخدم مسجَّل ليس في الـallowlist طرق أي مسار ذروة |
| `gate_unlock_success` | **فتح القسم** بنجاح |
| `gate_unlock_failed` | **محاولة دخول فاشلة** |
| `gate_locked_out` | تجاوز حدّ المحاولات |
| `gate_locked` | قفل يدوي |
| `gate_session_expired` | انتهاء خمول أو سقف مطلق |
| `section_opened` | فتح قائمة الأشهر |
| `month_opened` / `month_created` | فتح/إنشاء شهر |
| `file_uploaded` / `file_replaced` | **رفع ملف** |
| `file_opened` | **فتح ملف** (عرض) |
| `file_downloaded` | **تنزيل ملف** |
| `file_deleted` | **حذف ملف** |
| `file_parse_ok` / `file_parse_failed` | نتيجة قراءة الملف |
| `review_started` / `review_completed` | **تشغيل مراجعة** |
| `note_status_changed` / `note_annotated` | **معالجة ملاحظة** |

### ما يُسجَّل فعلًا

```
ts · event · actor_id · actor_email · run_id · target · meta · ip_hash · ua_hash
```
`ip_hash = HMAC(ip, DROUA_AUDIT_HASH_KEY)` مقطوعًا إلى 16 حرفًا — يكفي
للتمييز بين الأجهزة، ولا يخزّن عنوانًا حقيقيًا.

### ⛔ ما لا يُسجَّل أبدًا — والآلية التي تفرضه

**ممنوع في `meta`:** أي مبلغ · أي IBAN أو رقم حساب · اسم موظف · أي محتوى
من الملف · كلمة مرور القسم أو أي جزء منها · توكن البوابة · مسار Blob.

**الآلية — قائمة مفاتيح مسموحة (whitelist)، لا ممنوعة:**

```js
// lib/droua/audit.js  (توضيحي)
const META_ALLOWED = new Set([
  "kind","month","previousMonth","noteId","noteCode","fromStatus","toStatus",
  "fileId","sizeBytes","contentType","sha256Prefix","rowCount","notesCreated",
  "notesUpdated","durationMs","reason","attemptCount","retryAfter","detectorVer",
]);
function sanitizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (!META_ALLOWED.has(k)) continue;                       // كل ما عداه يُسقط
    if (typeof v === "object" && v !== null) continue;         // لا كائنات متداخلة
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}
```

**لماذا whitelist لا blacklist:** قائمة الممنوع تحمي ممّا فكّرنا فيه اليوم.
قائمة المسموح تحمي أيضًا ممّا يضيفه أحدنا بعد ستة أشهر بلا انتباه. وهذا
بالضبط الفرق بين نظام يصمد ونظام يتسرّب بهدوء. **يفرضه اختبار** يمرّر
`{ iban:"SA...", net:9500, name:"...", password:"..." }` ويؤكّد أن الناتج `{}`.

**وقاعدة موازية للّوجّات:** `console.error` في وحدة ذروة يطبع **رقم السطر
وسبب الخطأ فقط** — لا محتوى الصفّ. لوجّات Vercel يقرأها كل من له وصول إلى
المشروع؛ صفّ راتب واحد فيها يُبطل كل ما سبق.

### خصائص السجلّ

* **جدول مستقلّ** `droua_payroll_audit` — لا يمرّ عبر `lib/auth/audit.js`
  ولا يكتب في `audit_log`. سببان: الفصل الذي طلبته، **و**أن `audit_log`
  المشترك يكشف وجود القسم لمن يقرؤه.
* **إلحاق فقط**: لا `UPDATE` ولا `DELETE` في شيفرة الوحدة. (يمكن تثبيته
  في القاعدة بـ`REVOKE`/trigger لاحقًا لو أردت ضمانًا أقوى.)
* **الفشل لا يُسقط العملية**: `try/catch` حول الكتابة كما في
  `lib/auth/audit.js` — عطل تدقيق لا يمنعك من رفع ملف.
* **الاستثناء الوحيد:** فشل تسجيل `gate_unlock_*` **يُسقط الطلب** —
  بوابة لا تُدقَّق يجب ألّا تُفتح.

---

## 11. تحديد المعدّل (Rate Limiting)

| الطبقة | الهدف | السياسة |
|---|---|---|
| **1. بوابة كلمة المرور** | brute force | 5/15د → قفل 15د · 10/ساعة → ساعة · 15/24س → 24س |
| **2. الاستكشاف من غير المصرّح** | كشف الوجود + تضخّم التدقيق | صفّ تدقيق **واحد** لكل `ip_hash` كل 10 دقائق مهما تكرّر الطلب؛ والردّ 404 لا يتغيّر إطلاقًا |
| **3. الرفع** | تكلفة Blob | 30 رفعة/ساعة لكل حساب |
| **4. تشغيل المراجعة** | تكلفة تنفيذ | 20/ساعة لكل حساب |
| **5. التنزيل** | تسريب بالجملة | 100/ساعة لكل حساب |

**الطبقة 2 أهمّ ممّا تبدو:** بلا حدّ عليها يستطيع أي مسجَّل — أو سكربت —
أن يطرق `/api/droua/*` آلاف المرّات فيملأ جدول التدقيق ويستهلك Neon.
تسجيل واحد لكل نافذة يحفظ الإشارة ويمنع الإغراق.

**بصراحة عن الحدود:**
* Vercel Hobby **لا يوفّر WAF ولا Rate Limiting على مستوى الحافة**. كل ما
  سبق تطبيقي، ويكلّف رحلة إلى Neon.
* لا حماية من إغراق موزَّع (DDoS) على مستوى المصدر. لكن **الخطر هنا تكلفة
  لا بيانات**: كل طلب من غير المصرَّح يقف عند 404 قبل أن يلمس أي بيانات.
* العدّ في Neon هو الخيار الوحيد الصحيح على serverless. عدّاد في الذاكرة
  يبدو ناجحًا في الاختبار ويفشل في الإنتاج بصمت.

---

## 12. الأخطاء الأمنية المحتملة — وكيف نمنع كلّ واحد منها

هذه ليست قائمة نظرية. كل بند فيها إمّا وجدته في الكود الحالي، أو هو الخطأ
الذي تقع فيه أنظمة كهذه فعليًا.

| # | الخطر | الأثر | المنع |
|---|---|---|---|
| 1 | تسجيل الوحدة في `lib/data/registry.js` | وصول فوري عبر `/api/data/droua-*` بصلاحية عامّة | ممنوع نصًّا + اختبار عزل |
| 2 | إضافة قسم `droua` إلى `permissions.js` | يظهر في مودال الصلاحيات لكل `users:manage` | ممنوع نصًّا + اختبار عزل |
| 3 | **`owner` يتجاوز كل الصلاحيات** (`hasPermission` سطر 2) | أي حارس بصلاحية = مفتوح لكل مالك | الحصر بـallowlist للهوية، لا بصلاحية |
| 4 | **admin يصفّر كلمة مرور حسابي** (`api/app.js`) | انتحال كامل لهويتي | حسابي `owner` + كلمة مرور القسم المستقلّة |
| 5 | تخزين رابط Blob عام | من يملك الرابط يفتح المسير بلا جلسة | نخزّن `pathname` + خاصّ + مشفَّر |
| 6 | تقديم الملف بـ`Content-Type` من العميل | XSS مخزَّن على نطاقنا يملك الكوكيين | نوع قسريّ + `nosniff` + `sandbox` CSP |
| 7 | إرجاع 403 بدل 404 | يؤكّد وجود قسم سرّي | 404 مطابق بايتًا لردّ المنصّة |
| 8 | `err.message` إلى العميل | يكشف أسماء الجداول والأعمدة | catch محلّي برسالة عامّة |
| 9 | `console.log` لصفّ فشل تحليله | راتب في لوجّات Vercel | تسجيل رقم السطر فقط + قاعدة مكتوبة |
| 10 | `meta` تحمل مبلغًا أو IBAN | تسريب داخل التدقيق نفسه | whitelist + اختبار |
| 11 | استعمال `SESSION_SECRET` للبوابة | تسريب سرّ واحد يفتح الاثنين | `DROUA_GATE_SECRET` مستقلّ |
| 12 | جلسة بوابة بلا سقف مطلق | تُمدَّد إلى الأبد بنشاط صناعي | `absolute_exp` لا يُمدَّد أبدًا |
| 13 | جلسة بلا `sid` في القاعدة | «قفل القسم» لا يُبطل نسخة مسروقة | `droua_gate_sessions` + `revoked_at` |
| 14 | عدّاد محاولات في الذاكرة | ضابط وهمي على serverless | العدّ في Neon |
| 15 | كوكي `SameSite=Lax` | CSRF على POST | `Strict` + فحص `Origin`/`Sec-Fetch-Site` |
| 16 | حفظ التوكن أو الحالة في `localStorage` | XSS يقرؤه | `HttpOnly` فقط، ولا تخزين محلّي بتاتًا |
| 17 | إعادة تشغيل المراجعة تمحو حالاتي | فقدان عمل مراجعة | `fingerprint` + `ON CONFLICT DO UPDATE` بلا لمس `status` |
| 18 | قيد `UNIQUE` يمنع استيراد صفّ مكرّر | نفقد الملاحظة المطلوبة أصلًا | لا قيد فرادة؛ الكشف في المراجعة |
| 19 | ملاحظات محسوبة في المتصفّح من dump كامل | البيانات كلّها في الشبكة والذاكرة | الحساب في الخادم، والردّ بما تحتاجه الشاشة فقط |
| 20 | مسار ذروة تحت `/api/cron/` | الوسيط يستثنيه من الفحص | ممنوع نصًّا |
| 21 | إشعار/بريد عن ذروة | عنوان على شاشة قفل أو في صندوق مشترك | لا استيراد لـ`push`/`notifications` |
| 22 | رفع ملف ضخم | استنزاف ذاكرة الدالّة | حدّ 10 MB أثناء البثّ |
| 23 | الثقة بالامتداد أو `Content-Type` | ملف مزوّر | فحص البايتات الأولى |
| 24 | حذف الملف القديم قبل نجاح الجديد | شهر بلا ملف عند انقطاع | ارفع ← حدّث ← ثم احذف |
| 25 | لقطة PDF/Excel حقيقية في المستودع | راتب حقيقي في Git إلى الأبد | فيكستشرات مُصنَّعة فقط + `.gitignore` |
| 26 | تصدير/تقرير لاحق يتجاوز البوابة | باب خلفي للبيانات | لا ميزة تصدير في v1 |

---

## 13. ماذا يمكن ضمانه أمنيًا — وماذا لا يمكن

### ✅ ما أضمنه فعلًا

1. لا مستخدم آخر في المنصّة — **بما فيهم `admin` وحاملو `payroll:*` وأي
   `owner` آخر** — يستطيع رؤية القسم أو بياناته عبر الواجهة أو الـAPI أو
   رابط مباشر.
2. من ليس في الـallowlist يتلقّى **404 لا يمكن تمييزه** عن أي مسار غير
   موجود — فلا يعرف حتى أن القسم موجود.
3. كل endpoint يتحقّق بنفسه؛ خلل في الوسيط لا يمنح وصولًا.
4. ملفات المسير **غير قابلة للفتح برابط**، ومشفّرة في التخزين.
5. كلمة المرور الثانية **ليست في الكود ولا في Git ولا في القاعدة** ولا
   بصيغة plaintext في أي مكان، والتحقّق ثابت الزمن.
6. التخمين محدود بقفل تصاعدي مبنيّ على القاعدة.
7. جلسة القسم قصيرة، مرتبطة بهويتي، قابلة للإبطال فورًا.
8. لا تداخل تخزيني أو منطقي مع أجير — يفرضه اختبار في CI لا مراجعة بشرية.
9. سجلّ تدقيق كامل لكل فعل، خالٍ من الرواتب والحسابات بحكم البنية.

### ❌ ما لا أستطيع ضمانه — وأقوله بوضوح لأن معرفته جزء من الأمان

1. **من يملك وصولًا إلى لوحة Vercel أو قاعدة Neon يملك كل شيء.**
   متغيّرات البيئة تعطيه توكن Blob ومفتاح التشفير وسرّ البوابة؛ ورابط
   القاعدة يعطيه الصفوف. **كلمة مرور القسم تحمي من الوصول عبر التطبيق، لا
   من الوصول إلى البنية التحتية.** العلاج الوحيد الحقيقي: تقليل من يملك
   وصولًا إلى حساب Vercel وحساب Neon إلى أدنى حدّ، وتفعيل 2FA عليهما.
   ولو كان بينهما شريك لا تريده أن يرى الرواتب، **فهذا القيد لا يُحلّ
   ببرمجة داخل المنصّة نفسها**.
2. **من يستطيع النشر يستطيع زرع باب خلفي.** حماية المستودع والفرع
   ومراجعة أي تغيير على `lib/droua/**` جزء من النموذج الأمني.
3. **اختراق جهازي أو متصفّحي** (برمجية خبيثة، جهاز مفتوح بلا قفل) يتجاوز
   كل ما سبق. الخمول 15 دقيقة يضيّق النافذة ولا يلغيها.
4. **تسريب صورة الشاشة أو ملف نزّلته** خارج سيطرة النظام تمامًا.
5. **النسخ الاحتياطية**: صفّ محذوف من Neon أو ملف محذوف من Blob قد يبقى
   في اللقطات مدّة. «حذف» ≠ «مُحي إلى الأبد».
6. **البيانات الوصفية في لوجّات Vercel**: أن طلبًا وصل إلى
   `/droua-audit.html` في وقت ما يظهر لمن يقرأ لوجّات المشروع — والمسار
   نفسه يحمل الاسم.
   *خيار لك:* تسمية المسارات بشكل محايد (`/finance-review.html`) لإبقاء
   عبارة «مسير ذروة» خارج اللوجّات. أسماء الجداول تبقى صريحة كما طلبت.
   وأكرّر: هذا **تقليل بصمة**، لا حماية.
7. **قنوات جانبية زمنية** مضبوطة إلى حدّ كبير (حدّ أدنى ثابت للزمن) لكنها
   ليست صفرًا رياضيًا.
8. **دقّة المراجعة نفسها**: النظام يقارن ما استخرجه من الملفات. ملف بصيغة
   غير متوقّعة قد يُقرأ ناقصًا — ولذلك حاجز «مجموع الصفوف = إجمالي الملف»
   (`totals_mismatch`) الذي يمنع مرور استخراج ناقص بصمت. هذا نمط مثبت
   يعمل في `lib/payroll/sheetRoster.js` عندك بالفعل.

---

## 14. خطة البناء على مراحل

كل مرحلة = commit مستقلّ على `claude/droua-payroll-audit-module-qlk6ri`.
**لا merge ولا نشر ولا لمس لقاعدة الإنتاج قبل إذنك في كل مرحلة.**

| # | المرحلة | المخرجات | المعيار |
|---|---|---|---|
| **0** | *(هذا المستند)* | التصميم | **اعتمادك** |
| **1** | الهيكل والبوابة | `api/droua.js` · `lib/droua/{access,gateToken,gatePassword,rateLimit,audit}.js` · شاشة كلمة المرور · `scripts/setup-droua-payroll.js` (**`--dry-run` فقط**) | اختبارات: allowlist، تطابق 404 بايتًا، توقيع التوكن، الخمول والسقف، القفل التصاعدي، مُنقّي `meta` |
| **2** | الأشهر والملفات | إنشاء شهر · رفع/استبدال الأربعة · تخزين خاصّ مشفَّر · تنزيل بثًّا · حذف | اختبارات: النوع القسريّ، فحص البايتات، عدم ظهور `pathname` في أي ردّ، ترتيب الاستبدال |
| **3** | القُرّاء (Parsers) | قارئ لكل نوع · استيراد إلى `droua_payroll_employees` · `parse_status` · حاجز الإجماليات | اختبارات على **فيكستشرات مُصنَّعة** — لا ملف حقيقي في Git أبدًا |
| **4** | محرّك المراجعة | العشرون قاعدة · البصمة · إعادة التشغيل الآمنة · `review_summary` | اختبار مستقلّ لكل رمز ملاحظة + اختبار «إعادة التشغيل لا تمحو حالتي» |
| **5** | الواجهة | قائمة الأشهر · صفحة الشهر · اللوحة المختصرة · الملاحظات بالحالات الأربع + ملاحظتي | مراجعة بصرية معك |
| **6** | التقسية | حدود المعدّل الكاملة · مراجعة أمنية ذاتية (`/security-review`) · اختبار العزل في CI | لا اكتشاف مفتوح |
| **7** | التشغيل | تضبط أنت المتغيّرات في Vercel · تشغيل واحد لسكربت التهيئة · تحقّق من Private Blob على المتجر · **اختبار قبول بحساب آخر يجب أن يرى 404** | إقرارك |

**المرحلة 7 لا أنفّذها وحدي**: إنشاء الأسرار وتشغيل السكربت على القاعدة
الحيّة قرارك أنت، بعد اعتماد ما قبله.

### المتغيّرات المقترحة (تُنشأ في المرحلة 7 — لا الآن)

```
DROUA_AUDIT_USER_IDS       معرّف حسابك (UUID) — تجلبه أنت من قاعدة البيانات
DROUA_AUDIT_EMAILS         hr-manager@droua.com
DROUA_AUDIT_PASSWORD_HASH  ناتج سكربت محلّي — لا كلمة مرور
DROUA_AUDIT_PEPPER         32 بايت عشوائية
DROUA_GATE_SECRET          32 بايت عشوائية (≠ SESSION_SECRET)
DROUA_FILE_KEY             مفتاح AES-256 (32 بايت)
DROUA_AUDIT_HASH_KEY       مفتاح HMAC لتجزئة IP/UA
```
كلها **Sensitive** وعلى بيئة Production فقط. ولا يمرّ أيّ منها عبري.

---

## 15. كيف نحافظ على Vercel Hobby

| المورد | السقف | الآن | بعد ذروة | الحكم |
|---|---|---|---|---|
| Serverless Functions | 12 | 2 | **3** | ✅ مريح جدًا |
| Cron Jobs | 2 (يومي) | 1 | **1** | ✅ ذروة **لا تحتاج كرون** — المراجعة عند الطلب |
| Middleware | — | 1 | 1 | ✅ بلا تغيير |
| Blob Storage | مساحة الخطة | ملفات أجير | +4 ملفات/شهر (~20 MB/سنة) | ✅ لا يُذكر |
| Neon | الخطة المجانية | جداول قائمة | 6 جداول صغيرة | ✅ لا يُذكر |
| Function Duration | حدّ Hobby | — | انظر أدناه | ⚠️ يُدار بالتصميم |

### القرارات التي تحفظ الخطة

1. **دالّة ثالثة فقط.** كل مسارات ذروة — صفحات وAPI — تدخل من
   `api/droua.js` عبر ثلاثة rewrites. ولا تُضاف رابعة بأي حال.
2. **لا كرون.** «تشغيل المراجعة» فعل يدوي تبدأه أنت من صفحة الشهر. هذا يحفظ
   خانة الكرون الثانية، **وهو الأصحّ أمنيًا أيضًا**: لا عملية خلفية تعمل على
   بيانات ذروة بلا جلسة مفتوحة وبلا هوية فاعل في التدقيق.
3. **⚠️ التحليل عند الرفع لا عند المراجعة.** كل ملف يُقرأ في **نداء الرفع
   الخاصّ به** ويُستورَد إلى `droua_payroll_employees`. عندها «تشغيل
   المراجعة» يصير **حسابًا على صفوف جاهزة**: استعلامان وعمليات حسابية — أجزاء
   من الثانية. لو حلّلنا الملفات الأربعة داخل نداء المراجعة، لخاطرنا بتجاوز
   حدّ زمن التنفيذ في أي شهر كبير. **هذا القرار هو ما يجعل النظام يعمل على
   Hobby أصلًا.**
4. **البثّ عبر الخادم للتنزيل** يستهلك عرض نطاق الدالّة — لكن لمستخدم واحد
   وأربعة ملفات صغيرة شهريًا، الاستهلاك مهمَل.
5. **تقليم تلقائي بلا كرون:** كل `unlock` يحذف صفوف `droua_gate_attempts`
   و`droua_gate_sessions` المنتهية الأقدم من 30 يومًا. تنظيف يركب على نداء
   قائم بلا مُطلِق جديد — نفس النمط الذي اتّبعه المسير الشهري عندك.
6. **اعتماديات:** لا شيء جديد للـPDF (`pdfjs-dist` موجود). لو كانت الملفات
   Excel نحتاج قارئ `xlsx` صغيرًا واحدًا — وهذا يتوقّف على جوابك أدناه.

---

## 16. الصفحات كما ستبدو

### `/droua-audit.html`

```
┌────────────────────────────────────────────┐
│  مراجعة مسير رواتب ذروة                    │
│                                     [قفل]  │
├────────────────────────────────────────────┤
│  سبتمبر 2026    ●●●●  4/4    ⚠ 2 ملاحظة   │
│  أغسطس 2026     ●●●●  4/4    ✓ مكتمل      │
│  يوليو 2026     ●●●○  3/4    — لم تُراجَع  │
└────────────────────────────────────────────┘
```

### `/droua-audit/2026-09`

```
┌────────────────────────────────────────────┐
│  سبتمبر 2026                        [قفل]  │
├────────────────────────────────────────────┤
│  45 موظف │ 39 بدون تغيير │ 4 تغييرات │ 2 تحتاج مراجعة │
├────────────────────────────────────────────┤
│  الملفات الأربعة                            │
│  ✓ مسير الرواتب كاش        [عرض][استبدال]  │
│  ✓ مسير الرواتب كامل       [عرض][استبدال]  │
│  ✓ مسير الرواتب تحويل      [عرض][استبدال]  │
│  ✓ تقرير قائمة الموظفين    [عرض][استبدال]  │
│                                             │
│              [ تشغيل المراجعة ]             │
├────────────────────────────────────────────┤
│  المقارنة مع أغسطس 2026                     │
│  الملاحظات                                  │
│  ⚠ تغيّر صافي الراتب — 4312                │
│    أغسطس 6,500 ← سبتمبر 7,200  (+700)      │
│    [تحتاج مراجعة ▾]  [ملاحظتي...]          │
└────────────────────────────────────────────┘
```

---

## 17. أسئلة أحتاج جوابها قبل البدء

1. **صيغة الملفات الأربعة**: PDF أم Excel أم خليط؟
   يحدّد القارئ وحاجة مكتبة إضافية. (الملفات المرفوعة عندك حاليًا PDF.)
2. **دور حسابك في المنصّة**: هل `hr-manager@droua.com` حسابه `owner`؟
   لو لا، فهذه أول خطوة (السبب في القسم 4).
   وسأحتاج منك لاحقًا `users.id` الخاص به — **تجلبه أنت وتضعه في متغيّر
   البيئة مباشرة؛ لا يمرّ عبري ولا يُكتب في المستودع.**
3. **مدّة الجلسة**: أوافق على 15 دقيقة خمول / 60 دقيقة سقف مطلق؟
4. **اسم المسار**: `/droua-audit.html` صريح، أم تفضّل اسمًا محايدًا يُبقي
   عبارة «مسير ذروة» خارج لوجّات Vercel؟ (أسماء الجداول تبقى صريحة كما طلبت.)
5. **الـallowlist**: مستخدم واحد إلى الأبد، أم أترك البنية تقبل قائمة
   (وهي تقبلها أصلًا) تحسّبًا لحساب احتياطي لك؟
6. **الرقم الوظيفي في ذروة**: هل هو ثابت لكل موظف بين الشهور؟
   عليه تقوم كل المقارنة (القسم 2).
7. **IBAN**: أكتفي بآخر أربعة + hash للمقارنة (توصيتي)، أم تحتاج الرقم
   كاملًا معروضًا في الواجهة؟

---

## الخلاصة

الحماية الفعلية تقوم على **أربعة حواجز مستقلّة** يجب أن تُجتاز كلّها معًا،
ولا يعوّض أحدها عن الآخر:

```
1. جلسة منصّة صالحة        ← موجود في المشروع أصلًا
2. allowlist بـ user.id     ← لا دور، لا صلاحية، لا owner-bypass
3. كلمة مرور القسم         ← سرّ خارج الكود والقاعدة تمامًا
4. جلسة قسم قصيرة قابلة للإبطال
```

وفوقها: **الملفات نفسها مقفلة** — خاصّة، مشفّرة، ولا يوجد لها رابط قابل
للفتح في أي مكان. وهذا — كما قلت تمامًا — هو ما يعطي الحماية الفعلية،
لا إخفاء الرابط.

**بانتظار اعتمادك للبدء بالمرحلة 1.**
