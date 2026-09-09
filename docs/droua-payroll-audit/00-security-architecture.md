# Droua Payroll Audit — تصميم الأمان والمعمارية

> **النسخة 2** — بعد اعتمادك المبدئي وتعديلاتك السبعة.
> **حالة المستند:** معتمد مبدئيًا. لم يُكتب كود، ولم تُنشأ جداول، ولم تُضبط
> أسرار، ولم يُنشر شيء، ولم يُمسّ مسير أجير بحرف.

---

## ما تغيّر في هذه النسخة

| # | قرارك | أثره |
|---|---|---|
| 1 | **لا اعتماد على `owner` كحماية** — أضِف Protected User صريحًا | **قسم 4 أُعيدت كتابته بالكامل** + وحدة جديدة `lib/auth/protectedUsers.js` + ثابت يربط الحمايتين |
| 2 | الجلسة 15 د خمول / 60 د سقف مطلق | ✅ مثبّت (كان توصيتي، صار قرارًا) |
| 3 | مسار محايد `/secure-audit` بلا `payroll` ولا `droua` | **الأقسام 3 و7 و9 و15** + قاعدة جديدة: تضمين CSS/JS داخل الصفحة كي لا يتسرّب الاسم في رابط أصل |
| 4 | IBAN: آخر 4 + HMAC فقط، والكامل داخل الملف المشفَّر | **قسم 2** — حُذف خيار «عمود مشفَّر للرقم الكامل» نهائيًا |
| 5 | دعم PDF وExcel معًا من البداية، بلا مكتبة قبل العيّنات | **قسم 8 جديد** — طبقة قُرّاء بكاشف صيغة، وقارئ Excel كـstub |
| 6 | افحص دور `hr-manager@droua.com` بلا تغييره | ⚠️ **لا أستطيع** — لا `DATABASE_URL` في هذه الجلسة. التفصيل والـSQL في قسم 4.6 |
| 7 | الرقم الوظيفي مفتاحًا إن ثبت، وإلا اقترح بديلًا ثابتًا | **قسم 2.6 جديد** — جدول هوية داخلية + عمود `person_id` يُبنى الآن ويُملأ عند الحاجة |

**اكتشاف جديد أثناء تنفيذ التعديل الأول** (قسم 4.4): `lib/data/registry.js`
يحمل مسارًا ثانيًا كامنًا إلى `updateUser`/`deleteUser`. لا يمكن بلوغه اليوم،
لكنه موجود — **ولهذا انتقل الحارس من الموزّع إلى طبقة البيانات**.

---

## 0. ما وجدته في المنصّة الحالية

| الجانب | الواقع | أثره |
|---|---|---|
| **Auth** | كوكي `session` بتوقيع HMAC-SHA256 يدوي (`lib/auth/tokens.js`)، حمولته `{sub,email,role,remember,iat,exp}`، بسرّ `SESSION_SECRET`. | نعيد استعمال آلية التوقيع بسرّ **مستقلّ**. |
| **الكوكي** | `HttpOnly; Secure; SameSite=Lax; Path=/` | `Lax` لا يكفي ضد CSRF على POST؛ كوكي القسم `Strict`. |
| **كل مسار** | `requireUser(req)` يقرأ الكوكي ثم يقرأ المستخدم من Neon ويتحقّق `status==='active'` — لا يثق بأي هيدر من الوسيط. | نبني فوقه. |
| **Middleware** | `matcher: ["/((?!api/cron).*)"]` — 401 على `/api/*` و302 على الصفحات. | يخفي وجود القسم عن غير المسجَّلين مجّانًا. |
| **Permissions** | `hasPermission`: `if (user.role === "owner") return true` **قبل أي فحص**. | ⚠️ أي حارس بصلاحية = مفتوح لكل مالك. |
| **API routing** | دالّة واحدة `api/app.js` عبر rewrites. | ذروة تأخذ دالّة **مستقلّة**. |
| **Data layer** | `lib/data/registry.js` يربط `/api/data/:resource` بحارس `hasPermission(actor, mod.section, action)`. | ⛔ ممنوع تسجيل ذروة فيه. |
| **Neon** | `lib/db.js` singleton كسول. لا migrations — سكربتات `IF NOT EXISTS` + `--dry-run`. | نتبع النمط حرفيًا. |
| **Blob** | `lib/blob.js` بـ`access:"public"` ويخزّن **الرابط**. | ⛔ غير مقبول لذروة. |
| **`@vercel/blob@2.8.0`** | فحصت تعريفات الأنواع: `BlobAccessType='public'\|'private'`، `put(..,{access:'private'})`، `get(pathname,{access:'private'})→stream`، `presignUrl()`. | ✅ الخصوصية متاحة في الـSDK. |
| **Audit** | `audit_log` مشترك، و`readLog` **بلا أي مستدعٍ**. | جدول مستقلّ لذروة. |
| **Rate limiting** | **لا يوجد إطلاقًا**. | يُبنى من الصفر، في Neon. |
| **Service Worker** | `push` و`notificationclick` فقط — **لا `fetch` ولا cache**. | ✅ لا تخزين مؤقّت لأي استجابة. |
| **Nav** | `app-nav.js` يبني القائمة من `DEST` بمفتاح `perm`. | لا يُضاف إليه شيء، وصفحاتنا لا تُحمّله. |
| **الدوالّ** | 2 من سقف Hobby 12. | إضافة ثالثة آمنة. |

---

## 1. الفصل التام عن أجير

### ملفات جديدة بالكامل

```
api/secure-audit.js                  ← دالّة خادمة مستقلّة (اسم محايد)
lib/droua/access.js                  ← الحارس الموحّد
lib/droua/gateToken.js               ← توقيع/تحقّق جلسة القسم
lib/droua/gatePassword.js            ← كلمة المرور الثانية
lib/droua/rateLimit.js               ← عدّ المحاولات والقفل
lib/droua/audit.js                   ← التدقيق + مُنقّي الحقول
lib/droua/storage.js                 ← Blob خاصّ + تشفير + بثّ
lib/droua/runs.js  files.js  employees.js  notes.js  identity.js
lib/droua/parse/{detect,pdf,xlsx,csv}.js  +  parse/{cash,full,transfer,roster}.js
lib/droua/review/engine.js
droua-audit-*-shell.html             ← صفحات مكتفية ذاتيًا (CSS/JS مضمّنان)
scripts/setup-droua-payroll.js       ← IF NOT EXISTS + --dry-run
test/droua-*.test.js
```

**قاعدة التسمية المعتمدة:** *الاسم صريح داخل المستودع، محايد في الـURL.*
الجداول `droua_*` وملفات `lib/droua/**` صريحة لمنع الالتباس كما طلبت أصلًا؛
وكل ما يظهر في شريط العنوان أو في لوجّات Vercel محايد (`/secure-audit`).

### وحدة مشتركة جديدة (ليست ذروية، ولا تذكر ذروة)

```
lib/auth/protectedUsers.js           ← حماية الحساب — قسم 4
```

### ما يُعاد استعماله (utilities عامّة بلا منطق أجير)

`lib/db.js` · `lib/auth/requireAuth.js` · `lib/auth/tokens.js` (بسرّ مختلف) ·
`lib/auth/passwords.js` · `lib/reports/period.js` (أسماء الشهور العربية) ·
`ui.css` + الخطوط.

### الممنوعات (كل بند ثغرة فعلية لو خولف)

1. ⛔ تسجيل أي وحدة ذروة في `lib/data/registry.js`.
2. ⛔ إضافة قسم `droua` إلى `SECTIONS` في `lib/auth/permissions.js`.
3. ⛔ مفتاح في `PAGE_PERMISSION` أو `PAGE_FILES`.
4. ⛔ عنصر في `DEST` داخل `app-nav.js`، أو أي شارة أو عدّاد.
5. ⛔ الكتابة في `payroll_runs` / `payroll_attachments` / `payroll_transfer_proofs` / `audit_log` / `employees`.
6. ⛔ استعمال `lib/blob.js` (عام).
7. ⛔ استعمال `lib/push/*` أو `lib/notifications/*`.
8. ⛔ استعمال `SESSION_SECRET` لجلسة القسم.
9. ⛔ أي مسار تحت `/api/cron/` (الوسيط يستثنيه).
10. ⛔ **ملف CSS أو JS منفصل لصفحات القسم** — انظر قسم 9.3.

### الملفات المشتركة التي سنلمسها — القائمة كاملة

| الملف | التغيير | أثره على أجير |
|---|---|---|
| `vercel.json` | **إضافة** 3 rewrites + مدخل `functions` | صفر — إضافة بحتة |
| `lib/auth/users.js` | استدعاء حارس Protected User في `updateUser`/`deleteUser`/`createUser` | صفر لكل حساب غير محميّ — نفس السلوك بايتًا |
| `api/app.js` | 403 واضح في `handleUsers` + مسح كوكي البوابة عند الخروج | صفر على أي مسار رواتب |
| `package.json` | ربما قارئ Excel — **بعد العيّنات فقط** | صفر |

> **مهم:** التغيير في `lib/auth/users.js` و`api/app.js` يقع في **إدارة
> المستخدمين** حصرًا. **لا سطر واحد** في أي مسار رواتب أو مسير أو مرفقات.

### حاجز آلي في CI

`test/droua-isolation.test.js` يقرأ `lib/droua/**` و`api/secure-audit.js`
نصًّا ويفشل عند ظهور: `payroll_runs`, `payroll_transfer_proofs`,
`payroll_attachments`, `audit_log`, `data/registry`, `auth/permissions`,
`lib/blob`, `lib/push`, `lib/notifications`.
واختبار مقابل يفشل لو ظهرت `droua` في `permissions.js` أو `registry.js`
أو `app-nav.js`. **الفصل مفروض في CI لا موثوق به في المراجعة.**

---

## 2. نموذج البيانات

### 2.1 `droua_payroll_runs`

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_runs (
  id             text PRIMARY KEY,          -- 'YYYY-MM'
  month_label    text NOT NULL,             -- 'سبتمبر 2026'
  status         text NOT NULL DEFAULT 'draft',   -- draft|files_complete|reviewed
  review_summary jsonb,   -- أرقام اللوحة فقط: {employees,unchanged,changed,openNotes}
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_at    timestamptz
);
```

### 2.2 `droua_payroll_files`

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_files (
  id            bigserial PRIMARY KEY,
  run_id        text NOT NULL REFERENCES droua_payroll_runs(id) ON DELETE CASCADE,
  kind          text NOT NULL,     -- cash | full | transfer | roster
  -- pathname لا URL: لا يوجد في القاعدة كلّها رابط قابل للفتح
  blob_pathname text NOT NULL,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  format        text NOT NULL,     -- pdf | xlsx | xls | csv  (من البايتات لا الامتداد)
  size_bytes    bigint NOT NULL,
  sha256        text NOT NULL,
  enc_algo      text,              -- 'aes-256-gcm'
  enc_iv        text,
  enc_tag       text,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   text NOT NULL,
  parse_status  text NOT NULL DEFAULT 'pending',  -- pending|ok|failed|unsupported_format
  parsed_at     timestamptz,
  parse_error   text,              -- سبب مختصر بلا أي محتوى من الملف
  UNIQUE (run_id, kind)            -- أربع خانات؛ الاستبدال UPDATE لا صفّ ثانٍ
);
```

### 2.3 `droua_payroll_employees`

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_employees (
  id               bigserial PRIMARY KEY,
  run_id           text NOT NULL REFERENCES droua_payroll_runs(id) ON DELETE CASCADE,
  source           text NOT NULL,     -- cash|full|transfer|roster
  row_no           integer NOT NULL,
  emp_no           text,              -- الرقم الوظيفي في ذروة
  person_id        bigint,            -- الهوية الداخلية الثابتة — قسم 2.6
  full_name        text,
  full_name_norm   text,              -- مطبَّع للمطابقة والتحقّق
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
  pay_method       text,              -- cash|transfer|unknown
  bank_name        text,
  -- ── IBAN: قرارك 4 ──────────────────────────────────────────────
  iban_last4       text,              -- للعرض فقط
  iban_hmac        text,              -- HMAC-SHA256 بعد التطبيع — للمقارنة
  -- لا عمود للرقم الكامل. لا مشفَّرًا ولا غير مشفَّر. البتّة.
  -- ───────────────────────────────────────────────────────────────
  national_id_hmac text,              -- HMAC لرقم الهوية/الإقامة إن وُجد
  raw              jsonb,             -- بقية الأعمدة، بعد إسقاط أي حقل حسّاس
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_droua_emp_run_src ON droua_payroll_employees (run_id, source);
CREATE INDEX IF NOT EXISTS idx_droua_emp_run_emp ON droua_payroll_employees (run_id, emp_no);
CREATE INDEX IF NOT EXISTS idx_droua_emp_person  ON droua_payroll_employees (person_id);
```

**لا `UNIQUE (run_id, source, emp_no)` عمدًا.** أنت طلبت «تكرار موظف» كملاحظة؛
قيد الفرادة كان سيُفشل الاستيراد بدل أن يُنتج الملاحظة — أي أن الحاجز يبتلع
النتيجة المطلوبة. **الملف دليل يُخزَّن كما هو، والتكرار يُكتشف في المراجعة.**

### 2.4 معالجة الـIBAN — قرارك 4

```js
// lib/droua/identity.js  (توضيحي)
function normalizeIban(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");   // SA03 8000… → SA038000…
}
function ibanHmac(raw) {
  const n = normalizeIban(raw);
  if (n.length < 8) return null;
  return crypto.createHmac("sha256", process.env.DROUA_IBAN_HMAC_KEY).update(n).digest("hex");
}
function ibanLast4(raw) {
  const n = normalizeIban(raw);
  return n.length >= 4 ? n.slice(-4) : null;
}
```

| ما نخزّنه | لماذا |
|---|---|
| `iban_last4` | العرض في الواجهة والتمييز البصري |
| `iban_hmac` | كل ما تحتاجه ملاحظة `iban_changed`: مقارنة شهر بشهر |
| **الرقم الكامل** | **داخل الملف الأصلي المشفَّر فقط** — يُقرأ عند فتح الملف للتدقيق، ولا يُكتب في القاعدة أبدًا |

**لماذا HMAC بمفتاح سرّي لا SHA-256 مجرّدًا:** فضاء الآيبان السعودي ضيّق
(`SA` + رقمَي فحص + 22 رقمًا، ورمز البنك يضيّقه أكثر). هاش بلا مفتاح
**قابل للكسر بالقوة الغاشمة offline** لمن يسرّب القاعدة. مع
`DROUA_IBAN_HMAC_KEY` يصير الكسر مستحيلًا بلا المفتاح — والمفتاح في
متغيّر بيئة لا في القاعدة، فتسريب القاعدة وحده لا يكفي.

**نفس المعالجة لرقم الهوية/الإقامة** (`national_id_hmac`) إن ظهر في الملفات.

**تنظيف `raw`:** عمود `raw jsonb` يحفظ بقية الأعمدة كما قُرئت — ويمرّ على
مصفاة تُسقط أي مفتاح يطابق `/iban|حساب|bank.?account|هوية|إقامة|national/i`
**قبل** الكتابة. بلا هذه المصفاة يعود الآيبان الكامل من الباب الخلفي.
يفرضه اختبار.

### 2.5 `droua_payroll_notes`

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_notes (
  id             bigserial PRIMARY KEY,
  run_id         text NOT NULL REFERENCES droua_payroll_runs(id) ON DELETE CASCADE,
  code           text NOT NULL,
  severity       text NOT NULL,       -- info|warn|critical
  title          text NOT NULL,       -- العنوان
  emp_no         text,                -- الموظف
  person_id      bigint,
  emp_name       text,
  current_month  text NOT NULL,       -- الشهر الحالي
  previous_month text,                -- الشهر السابق
  field          text,
  old_value      text,                -- القيمة السابقة
  new_value      text,                -- القيمة الجديدة
  delta          numeric(12,2),       -- مقدار الفرق
  description    text NOT NULL,       -- الوصف
  status         text NOT NULL DEFAULT 'needs_review',
                 -- needs_review | verified | approved_change | needs_correction
  user_note      text,                -- ملاحظة المستخدم
  fingerprint    text NOT NULL,       -- hash(run_id, code, emp_no|person_id, field)
  detector_ver   integer NOT NULL DEFAULT 1,
  is_stale       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by    text,
  UNIQUE (run_id, fingerprint)
);
```

**«تشغيل المراجعة» يجب أن يكون idempotent.** إعادة تشغيله بعد أسبوع —
وقد وضعتَ «تم التحقق» على ثلاث ملاحظات — يجب ألّا تُرجع الحالات إلى
«تحتاج مراجعة». الآلية: `ON CONFLICT (run_id, fingerprint) DO UPDATE SET`
الحقول **المحسوبة** فقط، و**`status` و`user_note` لا تُلمسان إطلاقًا**.
وملاحظة اختفت من التشغيل الجديد تُوسم `is_stale=true` بدل أن تُحذف.

**كتالوج الرموز** (مطابق لقائمتك):

| `code` | المعنى | `severity` |
|---|---|---|
| `new_employee` | موظف جديد | info |
| `missing_employee` | موظف اختفى عن الشهر السابق | warn |
| `net_changed` | تغيّر صافي الراتب | warn |
| `basic_changed` | تغيّر الأساسي | warn |
| `housing_changed` | تغيّر بدل السكن | warn |
| `transport_changed` | تغيّرت المواصلات | warn |
| `overtime_changed` | تغيّر الـovertime | info |
| `deduction_changed` | تغيّرت الخصومات | warn |
| `absence_changed` | تغيّر الغياب | info |
| `advance_changed` | تغيّرت السلفة | warn |
| `full_vs_transfer_mismatch` | اختلاف بين كامل وتحويل | critical |
| `in_roster_not_in_payroll` | في قائمة الموظفين وغير موجود في المسير | critical |
| `in_payroll_not_in_roster` | في المسير وغير موجود في القائمة | critical |
| `cash_placement_mismatch` | في Cash وغير موجود حيث يجب | critical |
| `duplicate_employee` | تكرار موظف | critical |
| `pay_method_changed` | تغيّر Cash ↔ Transfer | warn |
| `iban_changed` | تغيّر حساب التحويل (بمقارنة `iban_hmac`) | critical |
| `totals_mismatch` | مجموع الصفوف ≠ إجمالي الملف | critical |
| `name_number_conflict` | الاسم نفسه برقم مختلف أو العكس | warn |
| `inconsistency` | أي فرق أو تعارض آخر | warn |

### 2.6 مفتاح المطابقة الشهرية — قرارك 7

**الأساس:** `emp_no` هو المفتاح، **إن ثبت أنه ثابت بين الشهور**.

**كيف نُثبت ذلك قبل البرمجة** — سكربت تحقّق لمرّة واحدة يعمل على العيّنات
محلّيًا (لا قاعدة، لا شبكة):
```
node scripts/check-emp-no-stability.js sept.pdf aug.pdf
```
يُخرج ثلاثة أرقام: كم رقمًا ظهر في الشهرين باسم مطابق (✅ ثابت) · كم رقمًا
تغيّر اسمه (⚠️) · كم اسمًا تغيّر رقمه (⛔ غير ثابت). **قرار المفتاح يُبنى
على هذا الرقم لا على افتراض.**

**البديل الثابت — يُبنى الآن ويُملأ عند الحاجة:**

```sql
CREATE TABLE IF NOT EXISTS droua_employee_identity (
  person_id        bigserial PRIMARY KEY,   -- المعرّف الداخلي الثابت
  national_id_hmac text,                    -- الأقوى إن توفّر في الملفات
  emp_no_current   text,
  emp_no_history   jsonb NOT NULL DEFAULT '[]'::jsonb,
  full_name_norm   text,
  first_seen_run   text,
  last_seen_run    text,
  merged_into      bigint,   -- عند اكتشاف أن هويتين شخص واحد
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_droua_ident_nid ON droua_employee_identity (national_id_hmac);
CREATE INDEX IF NOT EXISTS idx_droua_ident_emp ON droua_employee_identity (emp_no_current);
```

**ترتيب الحسم عند الربط:**
1. `national_id_hmac` — إن وُجد رقم هوية/إقامة في الملفات (الأقوى قطعًا).
2. `emp_no` — المفتاح الافتراضي.
3. `full_name_norm` — **لا يربط تلقائيًا أبدًا**، بل يُخرج ملاحظة
   `name_number_conflict` تُقرّرها أنت.

> **لماذا نبني الجدول والعمود الآن رغم أننا قد لا نحتاجهما:** `person_id`
> عمود nullable وجدول فارغ = صفر تكلفة اليوم. أمّا إضافتهما بعد تراكم ستّة
> أشهر من الملاحظات فهجرة بيانات وإعادة حساب بصمات — أي إعادة بناء
> الملاحظات كلّها. **نبني الباب الآن ونفتحه إن لزم.**

**الربط بالاسم هو المصدر الأول لملاحظات «موظف جديد» + «موظف اختفى» الكاذبة
(المتلازمتين).** لذلك لا يربط تلقائيًا بحال.

### 2.7 `droua_payroll_audit` · `droua_gate_attempts` · `droua_gate_sessions`

```sql
CREATE TABLE IF NOT EXISTS droua_payroll_audit (
  id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL, actor_id text, actor_email text,
  run_id text, target text, meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text, ua_hash text
);
CREATE INDEX IF NOT EXISTS idx_droua_audit_ts ON droua_payroll_audit (ts DESC);

CREATE TABLE IF NOT EXISTS droua_gate_attempts (
  id bigserial PRIMARY KEY, actor_id text NOT NULL, ip_hash text,
  outcome text NOT NULL, ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_droua_attempts ON droua_gate_attempts (actor_id, ts DESC);

CREATE TABLE IF NOT EXISTS droua_gate_sessions (
  sid text PRIMARY KEY, user_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_exp timestamptz NOT NULL,   -- السقف المطلق — لا يُمدَّد أبدًا
  revoked_at timestamptz, ua_hash text
);
```

**لماذا `droua_gate_sessions` ضروري:** توكن HMAC وحده **لا يُبطَل**. بلا صفّ
في القاعدة، «قفل القسم» يمسح الكوكي من متصفّحي فقط، ونسخة مسروقة تبقى صالحة
حتى انتهائها. مع `sid` يصير الإبطال حقيقيًا وفوريًا.

---

## 3. المسارات — أسماء محايدة (قرارك 3)

### الصفحات

| المسار | ما يُقدَّم |
|---|---|
| `GET /secure-audit` | قائمة الأشهر — أو **شاشة كلمة المرور** إن كانت البوابة مقفلة |
| `GET /secure-audit/:month` | صفحة الشهر (`2026-09`) — أو شاشة كلمة المرور |

شاشة كلمة المرور **ليست مسارًا مستقلًّا**: مسار `unlock` منفصل سطحٌ إضافي
يُرصد ويُستهدف، بلا مكسب.

### الـAPI — تحت `/api/secure-audit/*`

| الفعل | المسار | البوابة؟ |
|---|---|---|
| `GET` | `/api/secure-audit/gate/status` | ❌ (allowlist فقط) |
| `POST` | `/api/secure-audit/gate/unlock` | ❌ |
| `POST` | `/api/secure-audit/gate/lock` | ❌ |
| `GET` `POST` | `/api/secure-audit/runs` | ✅ |
| `GET` | `/api/secure-audit/runs/:month` | ✅ |
| `POST` | `/api/secure-audit/files?month=&kind=` | ✅ |
| `GET` | `/api/secure-audit/files/:id/download` | ✅ |
| `DELETE` | `/api/secure-audit/files/:id` | ✅ |
| `POST` | `/api/secure-audit/review?month=` | ✅ |
| `GET` | `/api/secure-audit/notes?month=` | ✅ |
| `PUT` | `/api/secure-audit/notes/:id` | ✅ |

**كل واحد منها — بلا استثناء — أول سطر فيه `requireDrouaAccess(req)`.**

### إضافات `vercel.json` (إضافة بحتة)

```json
{ "source": "/secure-audit",        "destination": "/api/secure-audit?kind=page&page=list" },
{ "source": "/secure-audit/:month", "destination": "/api/secure-audit?kind=page&page=month&month=:month" },
{ "source": "/api/secure-audit/:path*", "destination": "/api/secure-audit?kind=api&apiPath=:path*" }
```
```json
"functions": {
  "api/app.js":          { "includeFiles": "{*-shell.html,assets/fonts/*.ttf}" },
  "api/secure-audit.js": { "includeFiles": "droua-audit-*-shell.html" }
}
```

لاحظ: **لا `payroll` ولا `droua`** في أي مسار يراه المتصفّح أو تراه لوجّات
Vercel. الملفات على القرص تحتفظ بالاسم الصريح.

---

## 4. حصر الدخول: Protected User + Allowlist (قرارك 1)

### 4.1 لماذا `owner` وحده لا يكفي — وأنت محقّ تمامًا

في `lib/auth/permissions.js`:
```js
function hasPermission(user, section, action) {
  if (user.role === "owner") return true;        // قبل أي فحص
```
الاعتماد على `owner` يعني أن أماني مرهون بأمرين خارجَي سيطرة القسم:
أن يبقى دور حسابي `owner`، وأن يبقى عدد المالكين واحدًا. **كلاهما قابل
للتغيير من واجهة إدارة المستخدمين.** فالحماية القائمة عليه بناء على رمل.

### 4.2 أقوى مُعرّف مستقرّ: `users.id`

| المُعرّف | صالح؟ | لماذا |
|---|---|---|
| `role` | ❌ | `owner` يتجاوز كل شيء، وقابل للتغيير |
| `email` | ⚠️ ليس وحده | **قابل للتغيير** بصلاحية `users:edit` |
| **`user.id`** | ✅ | UUID يولّده الخادم بـ`crypto.randomUUID()`، و`updateUser` يكتب كل عمود **عداه** (`WHERE id = ${id}`) — لا مسار في التطبيق كلّه يغيّره أو يحدّده |

### 4.3 وحدة الحماية `lib/auth/protectedUsers.js`

وحدة **عامّة للمنصّة** لا تذكر ذروة إطلاقًا، ولا تعرف بوجود القسم.

```js
// توضيحي
const IDS    = (process.env.PROTECTED_USER_IDS    || "").split(",").map(s=>s.trim()).filter(Boolean);
const EMAILS = (process.env.PROTECTED_USER_EMAILS || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);

const isConfigured   = () => IDS.length > 0 && EMAILS.length > 0;
const isProtectedId  = (id)    => IDS.includes(String(id));
const isProtectedMail= (email) => EMAILS.includes(String(email||"").trim().toLowerCase());

/* الحقول: من يجوز له تعديل ماذا على حساب محميّ. */
const SYSTEM_FIELDS = new Set(["lastLogin"]);                      // النظام — دائمًا
const SELF_ONLY     = new Set(["name", "jobTitle", "passwordHash"]); // هو وحده
const FROZEN        = new Set(["email", "role", "status", "permissions"]);
                    // لا أحد — ولا هو نفسه. تغييرها قرار خارج التطبيق.
```

### 4.4 ⚠️ أين يوضع الحارس — والسبب الذي غيّر التصميم

كنت سأضعه في `handleUsers` داخل `api/app.js`. الفحص أظهر مسارًا ثانيًا:

```js
// lib/data/registry.js
const usersAdapter = {
  update: (id, patch) => users.updateUser(id, patch),
  remove: (id) => users.deleteUser(id),
};
```

هذا المسار **غير قابل للبلوغ اليوم** — `handleData` يحوّل `users` إلى
`handleUsers` في السطر 286 قبل الوصول إلى `getResource` في 289. **لكنه
موجود**، وسطر واحد يُعاد ترتيبه مستقبلًا يفتحه.

> **القرار: الحارس في `lib/auth/users.js` نفسه — لا في الموزّع.**
> `updateUser` و`deleteUser` و`createUser` ترمي عند ملامسة حساب محميّ.
> فأي مُنادٍ — اليوم أو بعد سنة، من الموزّع أو من الـadapter أو من سكربت —
> يصطدم بالحارس. الموزّع يضيف فوقه 403 برسالة عربية واضحة، لكنه **ليس**
> خطّ الدفاع.

```js
// lib/auth/users.js — توضيحي
async function updateUser(id, patch, opts = {}) {
  if (protectedUsers.isProtectedId(id)) {
    for (const field of Object.keys(patch)) {
      if (protectedUsers.SYSTEM_FIELDS.has(field)) continue;                 // lastLogin
      if (protectedUsers.FROZEN.has(field)) throw new Error("هذا الحقل غير قابل للتعديل على هذا الحساب");
      if (protectedUsers.SELF_ONLY.has(field) && !opts.selfEdit) throw new Error("هذا الحساب محميّ ولا يمكن تعديله من أدوات الإدارة");
      if (!protectedUsers.SELF_ONLY.has(field)) throw new Error("هذا الحساب محميّ");   // fail-closed لأي حقل جديد
    }
  }
  /* ... بقية الدالّة كما هي حرفًا بحرف ... */
}
```

**`fail-closed` على الحقول الجديدة مقصود:** حقل يُضاف إلى المستخدمين بعد
سنة يكون **ممنوعًا افتراضيًا** على الحساب المحميّ حتى يُصنَّف صراحةً. قائمة
مسموح لا قائمة ممنوع — نفس مبدأ مُنقّي التدقيق.

**`touchLastLogin` يبقى يعمل**: يمرّر `lastLogin` وحده، وهو في `SYSTEM_FIELDS`.

### 4.5 ما يمنعه الحارس بالضبط

| المحاولة | النتيجة |
|---|---|
| Admin/Owner آخر يغيّر **بريد** الحساب المحميّ | ⛔ مرفوض (مجمَّد للجميع) |
| Admin/Owner آخر يغيّر **كلمة مرور** الحساب المحميّ | ⛔ مرفوض |
| Admin/Owner آخر يغيّر **دور** الحساب المحميّ | ⛔ مرفوض (مجمَّد) |
| Admin/Owner آخر **يعطّل** الحساب (`status`) | ⛔ مرفوض (مجمَّد) |
| Admin/Owner آخر يغيّر **صلاحيات** الحساب | ⛔ مرفوض (مجمَّد) |
| Admin/Owner آخر **يحذف** الحساب | ⛔ مرفوض |
| **الحساب نفسه** يغيّر اسمه أو مسمّاه الوظيفي | ✅ مسموح |
| **الحساب نفسه** يغيّر كلمة مروره | ✅ مسموح **بشرط تقديم كلمة المرور الحالية** |
| **الحساب نفسه** يغيّر بريده أو دوره أو حالته | ⛔ مرفوض — قرار خارج التطبيق |
| إنشاء حساب جديد ببريد الحساب المحميّ (بأي حالة أحرف) | ⛔ مرفوض |
| تسجيل آخر دخول (`lastLogin`) | ✅ مسموح (النظام) |

**لماذا البريد مجمَّد حتى عليّ:** الـallowlist تشترط تطابق البريد. تغييره من
الواجهة يقفل القسم في وجهي فورًا — قفل ذاتي بلا وسيلة استرجاع من داخل
التطبيق. تجميده يمنع الحادث ويمنع كذلك مَن سرق جلستي من نقل الحساب.

**لماذا كلمة المرور الحالية مطلوبة لتغييرها:** مسار `PUT` الحالي **لا يطلب
كلمة المرور القديمة**. فمن يسرق كوكي جلستي يستطيع تغيير كلمة مروري وإقصائي.
هذا الشرط يقع **على الحسابات المحميّة فقط** — سلوك كل حساب آخر لا يتغيّر بحرف.

### 4.6 ⚠️ ثغرة إضافية وجدتها: تصادم البريد باختلاف حالة الأحرف

`findByEmailRaw` يبحث بـ`lower(email) = lower($1)`، بينما قيد الفرادة على
عمود `email` **قد يكون حسّاسًا لحالة الأحرف** (لا أستطيع التحقّق — لا وصول
إلى القاعدة، و`/db/` مستثنى من Git).

إن كان حسّاسًا، يستطيع admin إنشاء `HR-Manager@droua.com` بجانب
`hr-manager@droua.com`، فيصير في الجدول صفّان يطابقان استعلام الدخول —
و`rows[0]` **غير محدَّد أيّهما**.

* **أثره على القسم:** لا شيء — الـallowlist تفحص `user.id` أيضًا، وصفّ
  المنتحل معرّفه مختلف. ✅
* **أثره على المنصّة:** حقيقي — التباس هوية عند تسجيل الدخول.
* **العلاج المضمَّن:** الحارس يرفض إنشاء أو تعديل أي حساب يطابق بريده
  المُصغَّر بريدَ حساب محميّ.
* **يبقى للتحقّق منك:** هل الفهرس على `email` حسّاس لحالة الأحرف؟
  ```sql
  SELECT indexdef FROM pg_indexes WHERE tablename = 'users';
  ```
  إن كان حسّاسًا، فتوصيتي فهرس فريد على `lower(email)` — **إصلاح منصّة عام،
  خارج نطاق هذا القسم، وقرارك متى نعمله.**

### 4.7 الثابت الذي يربط الحمايتين

```js
// lib/droua/access.js — توضيحي
function isAllowlisted(user) {
  if (!ALLOWED_IDS.length || !ALLOWED_EMAILS.length) return false;   // fail-closed
  // الحماية شرطٌ لوجود القسم لا إضافةٌ إليه:
  if (!protectedUsers.isConfigured()) return false;
  if (!ALLOWED_IDS.every(protectedUsers.isProtectedId)) return false;
  if (!ALLOWED_EMAILS.every(protectedUsers.isProtectedMail)) return false;
  return ALLOWED_IDS.includes(user.id)
      && ALLOWED_EMAILS.includes(String(user.email).toLowerCase());
}
```

> **نزع الحماية يقفل القسم تلقائيًا.** من يحذف `PROTECTED_USER_IDS` طمعًا في
> إضعاف الحساب لا يحصل على قسم مكشوف، بل على قسم **لا يفتح لأحد**. الحماية
> والوصول شيء واحد لا شيئان متجاوران.

### 4.8 شروط الدخول الستّة — كلّها معًا

```
1. جلسة منصّة صالحة و status='active'      (requireUser)
2. Protected User مضبوط ومتّسق مع الـallowlist   ← قرارك 1
3. تطابق users.id                            ← قرارك 1
4. تطابق البريد المتوقّع                      ← قرارك 1
5. نجاح كلمة مرور البوابة الثانية             ← قرارك 1
6. جلسة قسم صالحة (غير منتهية وغير مُبطَلة)    ← قرارك 1
```
الأربعة الأخيرة هي ما طلبته نصًّا؛ والأولان هما أرضيّتها.

### 4.9 دور `hr-manager@droua.com` — قرارك 6

**لا أستطيع فحصه، وأقولها صراحة بدل التخمين:** لا `DATABASE_URL` في هذه
الجلسة إطلاقًا (تحقّقت)، وأنت منعت لمس قاعدة الإنتاج في هذه المرحلة —
وحتى `SELECT` للقراءة اتّصالٌ بالإنتاج.

**استعلام للقراءة فقط، تُشغّله أنت متى شئت:**
```sql
SELECT id, email, role, status FROM users WHERE lower(email) = 'hr-manager@droua.com';
```

* **الدور** (`role`) — أخبرني به، فهو يؤثّر في نصّ الحارس فقط.
* **المعرّف** (`id`) — **ضعه أنت مباشرة في متغيّر البيئة. لا ترسله لي ولا
  تكتبه في المستودع.** لا حاجة بي إليه إطلاقًا لكتابة الكود.

> **وأهم ما في هذا التعديل:** بعد Protected User **لم يعد الدور يقرّر
> شيئًا**. لو كان `hr` أو `viewer` فالحماية قائمة كما هي. أنت طلبت ألّا
> نعتمد على `owner` — والنتيجة أننا لم نعد نحتاج معرفة الدور أصلًا،
> ولا تغييره. **فلن أغيّره، ولن أطلب تغييره.**

---

## 5. كلمة المرور الثانية

### التخزين

```
DROUA_AUDIT_PASSWORD_HASH = "scrypt$17$8$1$<salt-hex>$<hash-hex>"
DROUA_AUDIT_PEPPER        = "<32 بايت عشوائية>"
```
* متغيّرا بيئة في Vercel، Production فقط، بخاصية **Sensitive**.
* الهاش يُولَّد **على جهازك** بـ`scripts/hash-droua-password.js` (يقرأ من
  stdin بلا echo، يطبع الهاش فقط، بلا شبكة وبلا قاعدة).
  **لا أرى كلمة المرور ولا الهاش في أي لحظة.**
* ❌ ليست في الكود · ❌ ليست في Git · ❌ ليست في Neon · ❌ لا plaintext في أي مكان.
* **الـpepper المستقلّ** يُدمج `HMAC-SHA256(password, PEPPER)` **قبل** الـscrypt:
  من يسرّب الهاش وحده لا يهاجمه offline بلا الـpepper أيضًا.

### التحقّق

```js
function verifyGatePassword(input) {
  const stored = process.env.DROUA_AUDIT_PASSWORD_HASH;
  if (!stored) return false;                                   // fail-closed
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const peppered = crypto.createHmac("sha256", process.env.DROUA_AUDIT_PEPPER).update(input).digest();
  const candidate = crypto.scryptSync(peppered, Buffer.from(salt,"hex"), 64,
                      { N: 1<<Number(N), r: Number(r), p: Number(p), maxmem: 256*1024*1024 });
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
```
`timingSafeEqual` لا `===`. و`N=2^17` (أقوى من افتراضي المنصّة `2^14`)
≈ 300ms للمحاولة — يجعل التخمين الآلي مكلفًا، ومقبول لعملية تقع مرّة في اليوم.
`maxmem` مضبوط صراحةً وإلّا رمى Node عند `N` كبير.

### لا تسريب في اللوجّات ولا في الردّ

| القاعدة | التنفيذ |
|---|---|
| لا تُسجَّل كلمة المرور | متغيّر محلّي يُستهلك فورًا؛ **ممنوع** `console.log(body)` في الوحدة كلّها، يفحصه اختبار نصّي |
| لا تُسجَّل في التدقيق | `sanitizeMeta()` بقائمة مفاتيح مسموحة — قسم 11 |
| لا تفاصيل في الردّ | الفشل دائمًا `{ok:false, error:"تعذّر فتح القسم"}` بلا أي تمييز |
| لا فرق بين «خطأ» و«غير مضبوطة» | البيئة بلا الهاش تعطي الردّ نفسه |
| لا تسريب زمني | حدّ أدنى ثابت ≈400ms على المسار كلّه، ناجحًا كان أو فاشلًا |

### القفل التصاعدي

| المحاولات الفاشلة | النافذة | القفل |
|---|---|---|
| 5 | 15 دقيقة | 15 دقيقة |
| 10 | ساعة | ساعة |
| 15 | 24 ساعة | 24 ساعة + `severity: critical` |

العدّ في **Neon** لا في الذاكرة: كل طلب على Vercel قد يقع على نسخة دالّة
جديدة أو متوازية — **عدّاد في الذاكرة ليس ضابطًا بل وهم ضابط**.
والقفل لكل `actor_id`؛ ولا خطر حجب خدمة من غريب لأن كل من ليس في الـallowlist
يتلقّى 404 **قبل** بلوغ المُتحقّق. ونجاح واحد يمسح العدّاد، وكل `unlock`
ينظّف ما تجاوز 30 يومًا.

---

## 6. جلسة القسم (قرارك 2)

```
Set-Cookie: droua_gate=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900
```

| السمة | لماذا |
|---|---|
| `HttpOnly` | لا يصل إليه JavaScript إطلاقًا — يحيّد XSS كمسار سرقة |
| `Secure` | HTTPS فقط |
| **`SameSite=Strict`** | أقوى من `Lax` في كوكي المنصّة: طلب من موقع آخر **لا يحمله**، فينهار CSRF قبل أن يبدأ |
| `Max-Age=900` | ينتهي في المتصفّح، والخادم لا يعتمد عليه على أي حال |

**الحمولة:** `{ sub: user.id, sid, iat, exp, aexp }` موقّعة بـ
**`DROUA_GATE_SECRET`** — مستقلّ تمامًا عن `SESSION_SECRET`، فتوكن أحدهما
لا يُقبل في الآخر.

**أربعة قيود متزامنة في كل طلب:**
1. `payload.sub === user.id` للمستخدم الحالي.
2. `isAllowlisted(user)` تُعاد كل مرّة — لا تُخزَّن في التوكن.
3. صفّ `droua_gate_sessions` موجود و`revoked_at IS NULL`.
4. `now() < absolute_exp` **و** `now() - last_seen_at < 15 دقيقة`.

### المدّة — **معتمدة**

> ## خمول **15 دقيقة** · سقف مطلق **60 دقيقة**

الانزلاق على الطلبات المصادَق عليها فقط (`UPDATE last_seen_at`)،
و**`absolute_exp` لا يُمدَّد أبدًا**. جلسة مسروقة تموت خلال ساعة كحدّ أقصى
مهما بدت نشطة.

### انتهاء الجلسة والخروج

| الحدث | الأثر |
|---|---|
| 15 د بلا نشاط | الطلب التالي → 401 → شاشة كلمة المرور |
| 60 د من الفتح | نفس الشيء، حتمًا |
| `POST .../gate/lock` | `revoked_at = now()` + مسح الكوكي |
| تسجيل الخروج من المنصّة | الجلسة عديمة الأثر تلقائيًا + مسح الكوكي |
| تعطيل الحساب | `requireUser` → null → 404 |

### ممنوع `localStorage`

التوكن في كوكي `HttpOnly` — لا يمكن لـJS قراءته ولو أراد. والواجهة تعرف
«القسم مفتوح» من ردّ الخادم `{unlocked:true, expiresAt}`.
❌ لا `localStorage` · ❌ لا `sessionStorage` · ❌ لا IndexedDB — لا كلمة مرور،
ولا توكن، ولا بيانات رواتب مخبّأة، ولا حتى «آخر شهر فتحته».

---

## 7. التخزين الخاصّ للملفات

### ثلاث طبقات

```
1) put(pathname, ciphertext, { access:'private', addRandomSuffix:true })
2) تشفير AES-256-GCM على الخادم قبل الرفع
3) التنزيل بثًّا عبر الخادم — لا رابط للمتصفّح إطلاقًا
```

**الطبقة 2 ليست زائدة.** هي التي تجعل الأمان مستقلًّا عن صحّة إعداد المتجر:
لو تبيّن أن الخصوصية غير مفعّلة على الخطة، أو أُعيد ضبط المتجر خطأً، أو تسرّب
`BLOB_READ_WRITE_TOKEN` وحده — **يبقى ما يخرج منه شيفرة بلا معنى** دون
`DROUA_FILE_KEY`.

### المسارات (كما طلبت في البداية)

```
droua-payroll-audit/2026-09/{cash,full,transfer,roster}/<random>-<safe-name>.<ext>
```
مسارات Blob **داخلية بحتة** — لا تظهر في رابط ولا في ردّ ولا في لوجّ، لأن
التنزيل يمرّ عبر الخادم. فالاسم الصريح هنا لا يخالف قرار الحياد في الروابط.

### التنزيل — نقطة الحماية الحقيقية

```
GET /api/secure-audit/files/:id/download
  1. requireDrouaAccess(req, { needGate: true })
  2. اقرأ الصفّ  ← pathname من القاعدة لا من الطلب
  3. get(pathname, { access:'private', token })
  4. فُكّ AES-256-GCM (ويُتحقّق من وسم المصادقة)
  5. الرؤوس القسرية
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

**`Content-Type` قسريّ** لا ما أرسله العميل: ملف يُقدَّم بـ`text/html` من
**نطاقنا نفسه** يصير XSS مخزَّنًا يعمل في سياق يملك كوكي المنصّة وكوكي
البوابة معًا. خطأ شائع ومكلف.

### لماذا لا `presignUrl` افتراضيًا

الرابط الموقّع **كلمة مرور مكتوبة في شريط العنوان**: يدخل تاريخ المتصفّح،
وقد يُرسل في `Referer`، ويظهر في لقطة شاشة، وتنسخه أي إضافة. البثّ عبر
الخادم يزيل الفئة كاملة. يبقى احتياطًا وحيدًا لو تجاوز ملفٌ حدود حجم
الاستجابة، وعندها `validUntil ≤ 60` ثانية وللتنزيل فقط.

### سلّم البدائل — بصراحة

| # | الخيار | الحكم |
|---|---|---|
| 1 | Private Blob + تشفير + بثّ | ✅ **الموصى به** |
| 2 | Public Blob + تشفير + بثّ | ✅ مقبول — الرابط المسرَّب يعطي شيفرة |
| 3 | البايتات في Neon (`bytea`) | ✅ مقبول — 4 ملفات صغيرة/شهر |
| 4 | Public Blob + `addRandomSuffix` بلا تشفير | ❌ **مرفوض** — إخفاء لا حماية |

### الرفع والاستبدال

* حدّ 10 MB يُفرض **أثناء البثّ** لا بعده.
* **فحص البايتات الأولى** لا الامتداد ولا `Content-Type` (قسم 8).
* الاستبدال: ارفع الجديد ← حدّث الصفّ ← ثم احذف القديم.
  **لا حذف قبل نجاح الرفع** كي لا يبقى شهر بلا ملف بسبب انقطاع.

---

## 8. القُرّاء: PDF و Excel معًا من البداية (قرارك 5)

### المبدأ

> **البنية تدعم الصيغتين من اليوم الأول. المكتبة لا تُضاف قبل العيّنات.**

كل ما يتعلّق بالصيغة معزول خلف واجهة واحدة، فإضافة قارئ لاحقًا **ملفّ واحد
جديد وسطر في جدول التوزيع** — لا هجرة، ولا تعديل على القاعدة، ولا مساس
بمحرّك المراجعة.

### كاشف الصيغة — من البايتات لا من الاسم

```js
// lib/droua/parse/detect.js — توضيحي
function detectFormat(buf) {
  if (buf.slice(0,5).toString("latin1") === "%PDF-")            return "pdf";
  if (buf.slice(0,4).toString("hex")    === "504b0304")          return "xlsx"; // ZIP → OOXML
  if (buf.slice(0,8).toString("hex")    === "d0cf11e0a1b11ae1")  return "xls";  // OLE2 القديم
  if (looksLikeText(buf))                                        return "csv";
  return "unknown";
}
```
الامتداد و`Content-Type` **لا يُصدَّقان**: كلاهما يُزوَّر بنداء API مباشر.
هذا الكاشف **حارس أمني قبل أن يكون أداة تصنيف**.

### الواجهة الموحّدة

```js
// كل قارئ يُنفّذ هذا العقد بالضبط
async function read(buffer) → {
  ok: boolean,
  rows: [{ /* خلايا مطبَّعة */ }],
  totals: { net, gross, count } | null,   // صفّ الإجماليات المطبوع
  reason: string | null                   // عند ok:false
}
```

| الصيغة | الحالة في المرحلة 3 | المكتبة |
|---|---|---|
| `pdf` | ✅ يُبنى الآن | `pdfjs-dist` — **موجود أصلًا** |
| `xlsx` | 🔸 stub يُرجع `unsupported_format` | تُختار **بعد العيّنات** |
| `xls` | 🔸 stub | قد تحتاج مكتبة أخرى — انظر التنبيه |
| `csv` | ✅ يُبنى الآن | **بلا مكتبة** — تحليل يدوي |

الملف بصيغة غير مدعومة بعدُ **يُرفع ويُخزَّن ويُشفَّر بنجاح**، ويُسجَّل
`parse_status='unsupported_format'`. فلا يضيع شيء، وتظهر الصفوف فور إضافة
القارئ بضغطة «إعادة التحليل». **لا رفع ثانٍ ولا فقدان ملف.**

> ⚠️ **تنبيه يهمّك قبل إرسال العيّنات:** `.xls` القديم (OLE2) و`.xlsx`
> الحديث **صيغتان مختلفتان تمامًا** وقد تحتاجان مكتبتين. لو أمكن أن يخرج
> النظام عندك `.xlsx` دائمًا، وفّر ذلك اعتمادية كاملة. وسأعرف الجواب من
> أول عيّنة.

### حاجز السلامة — يعمل على كل الصيغ

مجموع صوافي الصفوف المستخرجة **يجب أن يطابق** صافي صفّ الإجماليات المطبوع
في الملف، وإلّا `totals_mismatch` (`critical`) والاستيراد يُوسم ناقصًا.
**استخراج ناقص لا يمرّ صامتًا فيُنتج مراجعة تنقصها ملاحظة.**
نمط مثبت يعمل عندك بالفعل في `lib/payroll/sheetRoster.js`.

### الفيكستشرات

❌ **ممنوع منعًا باتًا** إدخال ملف رواتب حقيقي في المستودع — Git لا ينسى.
اختبارات القُرّاء تعمل على **ملفات مُصنَّعة** بأسماء وأرقام وهمية،
و`/droua-fixtures/` يُضاف إلى `.gitignore` للعيّنات الحقيقية محلّيًا.

---

## 9. حماية الـAPIs ومباشرة الرابط

### 9.1 المبدأ

> **كل endpoint يتحقّق من الهوية بنفسه.** لا وراثة من الوسيط، ولا حارس على
> مستوى الموزّع وحده. وهو نفس المبدأ الموثّق في `lib/auth/requireAuth.js`
> عندك: *«it never trusts a header set by the routing middleware»*.

| # | الطبقة | الفشل |
|---|---|---|
| 1 | `middleware.mjs` — جلسة منصّة موجودة | 401 / 302 (سلوك عام) |
| 2 | طريقة HTTP مسموحة لهذا المسار | 404 |
| 3 | `requireUser` — جلسة صالحة + `active` | 404 |
| 4 | `isAllowlisted` (يشمل ثابت Protected User) | 404 + تدقيق |
| 5 | جلسة بوابة صالحة | 401 `gate_required` |
| 6 | `Origin` + `Sec-Fetch-Site` على الطرق الكاتبة | 403 |
| 7 | تحقّق المدخلات (`YYYY-MM`، `kind`، `status`) | 400 |
| 8 | حدّ المعدّل | 429 |

### 9.2 مصفوفة مباشرة الرابط

| من | الطلب | الردّ | ما يستنتجه |
|---|---|---|---|
| غير مسجَّل | `/secure-audit` | 302 → `/login.html` | لا شيء — كل مسار يفعل هذا |
| غير مسجَّل | `/api/secure-audit/runs` | 401 عام | لا شيء |
| مسجَّل، ليس في الـallowlist | `/secure-audit` | **404** `Not found` | «صفحة غير موجودة» |
| مسجَّل، ليس في الـallowlist | `/api/secure-audit/*` | **404** `{ok:false,error:"Not found"}` | «مسار غير موجود» |
| أنا، البوابة مقفلة | صفحة | 200 + شاشة كلمة المرور، **بلا بيانات** | — |
| أنا، البوابة مقفلة | API | 401 `gate_required` | — |

**404 لا 403.** 403 يقول «موجود لكن ممنوع» — أي **يؤكّد وجود قسم رواتب سرّي**.
والردّ **مطابق حرفيًا** لما تنتجه المنصّة أصلًا: `res.status(404).end("Not found")`
للصفحات (`api/app.js:82`) و`{ok:false,error:"Not found"}` للـAPI
(`api/app.js:72`). ليس 404 مصطنعًا يمكن تمييزه — **نفس البايتات ونفس الرؤوس**
التي يراها من يكتب `/xyz.html`.

### 9.3 ⚠️ قاعدة جديدة أوجبها قرار المسار المحايد

مسار الصفحة صار محايدًا — لكن لو حمّلت الصفحة `droua-audit.css` أو
`droua-audit.js` كملفّين منفصلين، **لظهر الاسم في لوجّات Vercel من رابط
الأصل**، فيُبطل الحياد كلّه من الباب الخلفي.

> **القرار: صفحات القسم مكتفية ذاتيًا — CSS وJS مضمّنان داخل الـHTML.**

فائدة إضافية: لا ملفّ أصل للقسم يمكن جلبه بلا حارس، ولا يُخبَّأ شيء في
المتصفّح. (`ui.css` مشترك مع كل صفحات المنصّة، فطلبه لا يحمل إشارة.)

### 9.4 الإخفاء من الواجهة — طبقة ثانية لا أولى

❌ لا عنصر في `DEST` · ❌ لا زرّ ولا رابط ولا بطاقة · ❌ لا شارة ولا عدّاد ولا
إشعار (**الوحدة لا تستورد `lib/push/*` ولا `lib/notifications/*` أصلًا**) ·
❌ الصفحات **لا تُحمّل `app-nav.js`** · ✅ `sw.js` بلا `fetch` ولا cache ·
✅ لا ذكر في `manifest.webmanifest`.

> **وأكرّر ما قلته أنت:** الإخفاء **ليس** وسيلة الحماية. لو نُزع كل ما في
> هذه القائمة وبقي الحارس في الخادم، لبقي القسم محميًا تمامًا.

### 9.5 الرؤوس والأخطاء

```
Cache-Control: no-store, private, max-age=0, must-revalidate
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-Robots-Tag: noindex, nofollow, noarchive
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'
```
و`api/secure-audit.js` لا يستعمل catch-all الخاص بـ`api/app.js` (الذي يُرجع
`err.message`): له `try/catch` يُرجع رسالة عامّة ويسجّل التفصيل بعد تنقيته.
**رسالة خطأ Postgres مسرَّبة تكشف أسماء الجداول والأعمدة.**

---

## 10. IDOR والمدخلات

`/files/:id` و`/notes/:id` يقرآن الصفّ ويتحقّقان أن `run_id` يعود إلى مسير
ذروة قبل أي عملية. الجداول ذروية بالكامل فالشرط محقّق تلقائيًا — لكنه
**يُكتب صراحةً** كي لا يسقط عند أي توسعة لاحقة.
والشهر يُتحقّق بـ`/^\d{4}-(0[1-9]|1[0-2])$/`، و`kind` من أربعة، و`status`
من أربعة — قوائم مغلقة لا فحص نمط مفتوح.

---

## 11. التدقيق (Audit)

### الأحداث

`access_denied` · `gate_unlock_success` · `gate_unlock_failed` ·
`gate_locked_out` · `gate_locked` · `gate_session_expired` · `section_opened` ·
`month_opened` · `month_created` · `file_uploaded` · `file_replaced` ·
`file_opened` · `file_downloaded` · `file_deleted` · `file_parse_ok` ·
`file_parse_failed` · `review_started` · `review_completed` ·
`note_status_changed` · `note_annotated` · `protected_user_write_blocked`

الأخير جديد: كل محاولة من admin للكتابة على الحساب المحميّ تُسجَّل — فتراها
لو حدثت.

### ما يُسجَّل

```
ts · event · actor_id · actor_email · run_id · target · meta · ip_hash · ua_hash
```
`ip_hash = HMAC(ip, DROUA_AUDIT_HASH_KEY)` مقطوعًا إلى 16 حرفًا — يميّز
الأجهزة بلا تخزين عنوان حقيقي.

### ⛔ ما لا يُسجَّل أبدًا

أي مبلغ · **أي IBAN أو رقم حساب أو آخر أربعة منه** · أي رقم هوية · اسم موظف ·
أي محتوى من الملف · كلمة مرور القسم أو جزء منها · توكن البوابة · مسار Blob.

**الآلية — قائمة مفاتيح مسموحة (whitelist) لا ممنوعة:**

```js
const META_ALLOWED = new Set([
  "kind","format","month","previousMonth","noteId","noteCode","fromStatus","toStatus",
  "fileId","sizeBytes","contentType","sha256Prefix","rowCount","notesCreated",
  "notesUpdated","notesStale","durationMs","reason","attemptCount","retryAfter","detectorVer",
]);
function sanitizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (!META_ALLOWED.has(k)) continue;                  // كل ما عداه يُسقط
    if (typeof v === "object" && v !== null) continue;    // لا كائنات متداخلة
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}
```

**لماذا whitelist:** قائمة الممنوع تحمي ممّا فكّرنا فيه اليوم؛ قائمة المسموح
تحمي أيضًا ممّا يضيفه أحدنا بعد ستّة أشهر بلا انتباه. **يفرضه اختبار** يمرّر
`{iban, ibanLast4, net, name, nationalId, password}` ويؤكّد أن الناتج `{}`.

**وقاعدة موازية للّوجّات:** `console.error` في الوحدة يطبع **رقم السطر وسبب
الخطأ فقط** — لا محتوى الصفّ. لوجّات Vercel يقرأها كل من له وصول إلى
المشروع؛ صفّ راتب واحد فيها يُبطل ما سبق كلّه.

### الخصائص

* **جدول مستقلّ** — لا يمرّ عبر `lib/auth/audit.js`، لسببين: الفصل الذي
  طلبته، **و**أن `audit_log` المشترك يكشف وجود القسم لمن يقرؤه.
* **إلحاق فقط**: لا `UPDATE` ولا `DELETE` في شيفرة الوحدة.
* **الفشل لا يُسقط العملية** — إلا `gate_unlock_*`: **بوابة لا تُدقَّق يجب
  ألّا تُفتح**.

---

## 12. تحديد المعدّل

| الطبقة | الهدف | السياسة |
|---|---|---|
| 1. بوابة كلمة المرور | brute force | 5/15د → 15د · 10/ساعة → ساعة · 15/24س → 24س |
| 2. استكشاف غير المصرّح | كشف الوجود + تضخّم التدقيق | صفّ تدقيق **واحد** لكل `ip_hash` كل 10 دقائق؛ **والردّ 404 لا يتغيّر إطلاقًا** |
| 3. الرفع | تكلفة Blob | 30/ساعة |
| 4. تشغيل المراجعة | تكلفة تنفيذ | 20/ساعة |
| 5. التنزيل | تسريب بالجملة | 100/ساعة |

**الطبقة 2 أهمّ ممّا تبدو:** بلا حدّ عليها يستطيع أي مسجَّل — أو سكربت —
طرق `/api/secure-audit/*` آلاف المرّات فيملأ جدول التدقيق ويستهلك Neon.

**وبصراحة:** Vercel Hobby **لا يوفّر WAF ولا rate limiting على الحافة**؛ كل
ما سبق تطبيقي ويكلّف رحلة إلى Neon. ولا حماية من إغراق موزَّع — لكن **الخطر
هنا تكلفة لا بيانات**: كل طلب من غير مصرَّح يقف عند 404 قبل ملامسة أي بيانات.

---

## 13. الأخطاء الأمنية المحتملة

| # | الخطر | الأثر | المنع |
|---|---|---|---|
| 1 | تسجيل الوحدة في `registry.js` | وصول فوري بصلاحية عامّة | ممنوع + اختبار عزل |
| 2 | إضافة قسم إلى `permissions.js` | يظهر لكل `users:manage` | ممنوع + اختبار عزل |
| 3 | `owner` يتجاوز كل الصلاحيات | أي حارس بصلاحية = مفتوح | allowlist بالهوية |
| 4 | **admin يغيّر بريدي/كلمتي/دوري** | انتحال كامل | **Protected User في طبقة البيانات** |
| 5 | **المسار الكامن في `usersAdapter`** | تجاوز حارس الموزّع | الحارس في `lib/auth/users.js` لا في الموزّع |
| 6 | **تصادم البريد باختلاف حالة الأحرف** | التباس هوية عند الدخول | رفض بريد محميّ مصغَّرًا + فحص الفهرس (4.6) |
| 7 | **حقل جديد على المستخدم بعد سنة** | يفلت من الحماية | `fail-closed`: ممنوع حتى يُصنَّف |
| 8 | **تغيير كلمة المرور بلا القديمة** | سارق الجلسة يقصيني | شرط كلمة المرور الحالية للحساب المحميّ |
| 9 | **نزع `PROTECTED_USER_IDS`** | إضعاف الحماية | القسم **لا يفتح** بلا حماية متّسقة (4.7) |
| 10 | تخزين رابط Blob عام | فتح بلا جلسة | `pathname` + خاصّ + مشفَّر |
| 11 | `Content-Type` من العميل | XSS مخزَّن يملك الكوكيين | نوع قسريّ + `nosniff` + `sandbox` |
| 12 | **ملف CSS/JS منفصل للقسم** | الاسم في لوجّات Vercel | تضمينهما في الصفحة (9.3) |
| 13 | **الآيبان الكامل في `raw jsonb`** | يعود من الباب الخلفي | مصفاة مفاتيح قبل الكتابة (2.4) |
| 14 | **هاش آيبان بلا مفتاح** | كسر offline لفضاء ضيّق | HMAC بمفتاح سرّي (2.4) |
| 15 | 403 بدل 404 | يؤكّد وجود القسم | 404 مطابق بايتًا |
| 16 | `err.message` إلى العميل | يكشف الجداول والأعمدة | catch محلّي |
| 17 | `console.log` لصفّ فشل تحليله | راتب في لوجّات Vercel | رقم السطر فقط |
| 18 | `meta` تحمل مبلغًا أو آيبان | تسريب داخل التدقيق | whitelist + اختبار |
| 19 | `SESSION_SECRET` للبوابة | تسريب واحد يفتح الاثنين | سرّ مستقلّ |
| 20 | جلسة بلا سقف مطلق | تُمدَّد إلى الأبد | `absolute_exp` لا يُمدَّد |
| 21 | جلسة بلا `sid` | «قفل القسم» لا يُبطل نسخة مسروقة | صفّ + `revoked_at` |
| 22 | عدّاد محاولات في الذاكرة | ضابط وهمي على serverless | العدّ في Neon |
| 23 | `SameSite=Lax` | CSRF على POST | `Strict` + فحص `Origin` |
| 24 | `localStorage` للتوكن أو الحالة | XSS يقرؤه | `HttpOnly` فقط |
| 25 | إعادة المراجعة تمحو حالاتي | فقدان عمل مراجعة | `fingerprint` + عدم لمس `status` |
| 26 | `UNIQUE` يمنع الصفّ المكرّر | نفقد الملاحظة المطلوبة | لا قيد فرادة |
| 27 | الثقة بالامتداد أو `Content-Type` | ملف مزوّر | كاشف البايتات (قسم 8) |
| 28 | ملاحظات محسوبة في المتصفّح من dump | البيانات كلّها في الشبكة | الحساب في الخادم |
| 29 | مسار تحت `/api/cron/` | الوسيط يستثنيه | ممنوع |
| 30 | إشعار أو بريد عن القسم | عنوان على شاشة قفل | لا `push` ولا `notifications` |
| 31 | حذف القديم قبل نجاح الجديد | شهر بلا ملف | ارفع ← حدّث ← احذف |
| 32 | ملف رواتب حقيقي في Git | راتب في التاريخ إلى الأبد | فيكستشرات مُصنَّعة + `.gitignore` |
| 33 | ميزة تصدير لاحقة | باب خلفي للبيانات | لا تصدير في v1 |

---

## 14. ما يمكن ضمانه — وما لا يمكن

### ✅ ما أضمنه

1. لا مستخدم آخر — **بما فيهم `admin` وأي `owner` آخر** — يرى القسم أو
   بياناته عبر الواجهة أو الـAPI أو رابط مباشر.
2. **لا أحد يستطيع تغيير بريد حسابي أو كلمة مروري أو دوري أو حالتي أو حذفه
   من أدوات الإدارة** — والحارس في طبقة البيانات فيغطّي كل مُنادٍ حاضر ومستقبل.
3. **الأمان لم يعد معلَّقًا بدور `owner`** — الدور صار بلا أثر على القسم.
4. من ليس في الـallowlist يتلقّى **404 لا يمكن تمييزه** عن أي مسار غير موجود.
5. كل endpoint يتحقّق بنفسه؛ خلل في الوسيط لا يمنح وصولًا.
6. الملفات **غير قابلة للفتح برابط**، ومشفّرة في التخزين.
7. **لا آيبان كامل في القاعدة** — آخر أربعة وHMAC بمفتاح سرّي فقط.
8. كلمة المرور الثانية ليست في الكود ولا Git ولا القاعدة، والتحقّق ثابت الزمن.
9. التخمين محدود بقفل تصاعدي مبنيّ على القاعدة.
10. جلسة قصيرة (15/60)، مرتبطة بهويتي، قابلة للإبطال فورًا.
11. لا تداخل مع أجير — يفرضه اختبار في CI لا مراجعة بشرية.
12. سجلّ تدقيق كامل، خالٍ من الرواتب والحسابات **بحكم البنية** لا بحكم الانتباه.

### ❌ ما لا أستطيع ضمانه

1. **من يملك وصولًا إلى لوحة Vercel أو قاعدة Neon يملك كل شيء.** متغيّرات
   البيئة تعطيه مفتاح التشفير وسرّ البوابة ومفتاح HMAC؛ ورابط القاعدة يعطيه
   الصفوف. **Protected User وكلمة مرور القسم يحميان من الوصول عبر التطبيق،
   لا من الوصول إلى البنية التحتية.** العلاج الوحيد: تقليل من يملك وصولًا
   إلى Vercel وNeon إلى أدنى حدّ + 2FA. ولو كان بينهم شريك لا تريده أن يرى
   الرواتب، **فهذا القيد لا يُحلّ ببرمجة داخل المنصّة**.
2. **من يستطيع النشر يستطيع زرع باب خلفي** — بما في ذلك تعطيل Protected User
   بتعديل `lib/auth/users.js`. حماية المستودع ومراجعة أي تغيير على
   `lib/auth/protectedUsers.js` و`lib/droua/**` جزء من النموذج الأمني.
3. **اختراق جهازي أو متصفّحي** يتجاوز كل ما سبق. الخمول 15 دقيقة يضيّق
   النافذة ولا يلغيها.
4. **تسريب لقطة شاشة أو ملف نزّلته** خارج سيطرة النظام تمامًا.
5. **النسخ الاحتياطية**: صفّ محذوف من Neon أو ملف من Blob قد يبقى في اللقطات
   مدّة. «حذف» ≠ «مُحي إلى الأبد».
6. **البيانات الوصفية**: أن طلبًا وصل إلى `/secure-audit` يظهر لمن يقرأ لوجّات
   المشروع — لكن المسار **لم يعد يحمل الاسم** بعد قرارك 3، وهذا أقصى ما
   تستطيعه البرمجة هنا.
7. **قنوات جانبية زمنية** مضبوطة إلى حدّ كبير (حدّ أدنى ثابت) لكنها ليست
   صفرًا رياضيًا.
8. **دقّة المراجعة**: النظام يقارن ما استخرجه. ملف بصيغة غير متوقّعة قد
   يُقرأ ناقصًا — ولذلك حاجز `totals_mismatch` الذي يمنع مرور استخراج ناقص
   بصمت.

---

## 15. خطة البناء

كل مرحلة = commit مستقلّ على `claude/droua-payroll-audit-module-qlk6ri`.
**لا merge ولا نشر ولا لمس لقاعدة الإنتاج قبل إذنك في كل مرحلة.**

| # | المرحلة | المخرجات | المعيار |
|---|---|---|---|
| **0** | التصميم | *(هذا المستند، نسخة 2)* | **اعتمادك النهائي** |
| **1أ** | **Protected User** | `lib/auth/protectedUsers.js` · حارس في `lib/auth/users.js` · 403 في `api/app.js` · شرط كلمة المرور الحالية | اختبارات: منع كل حقل مجمَّد · سماح `lastLogin` · سماح التعديل الذاتي · **fail-closed لحقل جديد** · منع تصادم البريد · **حساب غير محميّ سلوكه لم يتغيّر** |
| **1ب** | البوابة | `api/secure-audit.js` · `lib/droua/{access,gateToken,gatePassword,rateLimit,audit}.js` · شاشة كلمة المرور · `scripts/setup-droua-payroll.js` (**`--dry-run` فقط**) | اختبارات: allowlist · **ثابت اتّساق الحماية** · تطابق 404 بايتًا · التوقيع · 15/60 · القفل التصاعدي · مُنقّي `meta` |
| **2** | الأشهر والملفات | إنشاء شهر · رفع/استبدال الأربعة · تخزين خاصّ مشفَّر · تنزيل بثًّا · حذف | النوع القسريّ · كاشف البايتات · عدم ظهور `pathname` في أي ردّ · ترتيب الاستبدال |
| **3** | القُرّاء | كاشف الصيغة · قارئ PDF · قارئ CSV · stubs لـExcel · حاجز الإجماليات · مصفاة `raw` | على **فيكستشرات مُصنَّعة** — لا ملف حقيقي في Git |
| **3ب** | *(بعد عيّناتك)* | قارئ Excel + المكتبة المختارة | — |
| **4** | محرّك المراجعة | العشرون قاعدة · البصمة · الهوية الداخلية · إعادة التشغيل الآمنة | اختبار لكل رمز + «إعادة التشغيل لا تمحو حالتي» |
| **5** | الواجهة | قائمة الأشهر · صفحة الشهر · اللوحة · الملاحظات بالحالات الأربع | مراجعة بصرية معك |
| **6** | التقسية | حدود المعدّل · `/security-review` · اختبار العزل في CI | لا اكتشاف مفتوح |
| **7** | التشغيل | **أنت** تضبط الأسرار · تشغيل واحد للسكربت · تحقّق من Private Blob · **اختبار قبول بحساب آخر يجب أن يرى 404** | إقرارك |

### المتغيّرات المقترحة (المرحلة 7 — لا الآن)

```
PROTECTED_USER_IDS         معرّف حسابك (UUID) — تضعه أنت
PROTECTED_USER_EMAILS      hr-manager@droua.com
DROUA_AUDIT_USER_IDS       نفس المعرّف
DROUA_AUDIT_EMAILS         نفس البريد
DROUA_AUDIT_PASSWORD_HASH  ناتج سكربت محلّي — لا كلمة مرور
DROUA_AUDIT_PEPPER         32 بايت عشوائية
DROUA_GATE_SECRET          32 بايت عشوائية (≠ SESSION_SECRET)
DROUA_FILE_KEY             مفتاح AES-256
DROUA_IBAN_HMAC_KEY        مفتاح HMAC للآيبان والهوية
DROUA_AUDIT_HASH_KEY       مفتاح HMAC لتجزئة IP/UA
```
كلها **Sensitive**، Production فقط، **ولا يمرّ أيٌّ منها عبري**.

---

## 16. الحفاظ على Vercel Hobby

| المورد | السقف | الآن | بعد | الحكم |
|---|---|---|---|---|
| Functions | 12 | 2 | **3** | ✅ مريح |
| Cron | 2 (يومي) | 1 | **1** | ✅ لا كرون للقسم |
| Middleware | — | 1 | 1 | ✅ بلا تغيير |
| Blob | مساحة الخطة | أجير | +~20 MB/سنة | ✅ لا يُذكر |
| Neon | المجانية | قائمة | 7 جداول صغيرة | ✅ لا يُذكر |
| Duration | حدّ Hobby | — | مُدار بالتصميم | ⚠️ انظر 3 |

1. **دالّة ثالثة فقط** — كل شيء عبر `api/secure-audit.js` بثلاثة rewrites.
2. **لا كرون.** المراجعة فعل يدوي تبدأه أنت — يحفظ الخانة الثانية، **وهو
   الأصحّ أمنيًا**: لا عملية خلفية تعمل على بيانات ذروة بلا جلسة مفتوحة وبلا
   هوية فاعل في التدقيق.
3. **⚠️ التحليل عند الرفع لا عند المراجعة.** كل ملف يُقرأ في **نداء رفعه**
   ويُستورَد. عندها «تشغيل المراجعة» حسابٌ على صفوف جاهزة — أجزاء من الثانية.
   لو حلّلنا الأربعة داخل نداء المراجعة لخاطرنا بحدّ زمن التنفيذ.
   **هذا القرار هو ما يجعل النظام يعمل على Hobby أصلًا.**
4. **تقليم بلا كرون:** كل `unlock` يحذف صفوف المحاولات والجلسات المنتهية
   الأقدم من 30 يومًا — يركب على نداء قائم، نفس نمط المسير الشهري عندك.
5. **الاعتماديات:** لا شيء للـPDF (`pdfjs-dist` موجود)، ولا شيء للـCSV،
   وقارئ Excel **بعد العيّنات فقط**.

---

## 17. الصفحات

### `/secure-audit`
```
┌────────────────────────────────────────────┐
│  مراجعة مسير رواتب ذروة             [قفل]  │
├────────────────────────────────────────────┤
│  سبتمبر 2026    ●●●●  4/4    ⚠ 2 ملاحظة   │
│  أغسطس 2026     ●●●●  4/4    ✓ مكتمل      │
│  يوليو 2026     ●●●○  3/4    — لم تُراجَع  │
└────────────────────────────────────────────┘
```

### `/secure-audit/2026-09`
```
┌────────────────────────────────────────────┐
│  سبتمبر 2026                        [قفل]  │
├────────────────────────────────────────────┤
│  45 موظف │ 39 بدون تغيير │ 4 تغييرات │ 2 تحتاج مراجعة │
├────────────────────────────────────────────┤
│  ✓ مسير الرواتب كاش        [عرض][استبدال]  │
│  ✓ مسير الرواتب كامل       [عرض][استبدال]  │
│  ✓ مسير الرواتب تحويل      [عرض][استبدال]  │
│  ✓ تقرير قائمة الموظفين    [عرض][استبدال]  │
│              [ تشغيل المراجعة ]             │
├────────────────────────────────────────────┤
│  المقارنة مع أغسطس 2026 — الملاحظات         │
│  ⚠ تغيّر صافي الراتب — 4312                │
│    أغسطس 6,500 ← سبتمبر 7,200  (+700)      │
│    [تحتاج مراجعة ▾]  [ملاحظتي...]          │
└────────────────────────────────────────────┘
```
عنوان الصفحة صريح بالعربية — **الرابط وحده هو المحايد**، وهو ما يظهر في
اللوجّات وتاريخ المتصفّح.

---

## 18. القرارات المعتمدة

| # | القرار | الحالة |
|---|---|---|
| 1 | Protected User في طبقة البيانات + allowlist بـ`users.id` + البريد + كلمة البوابة + جلسة القسم | ✅ معتمد |
| 2 | جلسة القسم: 15 د خمول / 60 د سقف مطلق | ✅ معتمد |
| 3 | مسار محايد `/secure-audit` بلا `payroll` ولا `droua` | ✅ معتمد |
| 4 | IBAN: آخر 4 + HMAC بمفتاح سرّي؛ الكامل داخل الملف المشفَّر فقط | ✅ معتمد |
| 5 | البنية تدعم PDF وExcel؛ المكتبة بعد العيّنات | ✅ معتمد |
| 6 | لا فحص ولا تغيير لدور الحساب الآن | ✅ معتمد |
| 7 | `emp_no` مفتاحًا إن ثبت؛ وجدول هوية داخلية جاهز كبديل | ✅ معتمد |

---

## 19. ما أحتاجه منك قبل المرحلة 1

**قراران يمنعان إعادة عمل، وواحد يمكن تأجيله:**

1. **هل أبدأ بالمرحلة 1أ (Protected User) وحدها وأقف لمراجعتك؟**
   توصيتي **نعم**: هي التغيير الوحيد الذي يلمس ملفًّا مشتركًا تستعمله المنصّة
   كلّها اليوم. مراجعتها منفردة — قبل أن تختلط بـ1500 سطر من كود القسم —
   أأمن بكثير.
2. **الحساب المحميّ: هل هو حسابك وحده، أم أضيف حسابًا احتياطيًا لك؟**
   البنية تقبل قائمة أصلًا. **تنبيه:** بحساب واحد، فقدان كلمة مرور المنصّة
   **أو** كلمة مرور القسم يعني استرجاعًا يدويًا من قاعدة البيانات. لو أردت
   حسابًا احتياطيًا باسمك، الآن أرخص وقت.
3. *(يمكن تأجيله)* **فهرس البريد**: أشغّل `SELECT indexdef FROM pg_indexes
   WHERE tablename='users';` متى شئت. إن كان حسّاسًا لحالة الأحرف، فإصلاحه
   **مسألة منصّة عامّة** أفصلها في مقترح مستقلّ — ولا تعطّل المرحلة 1.

**ثم — كما قلت — العيّنات:** أربعة ملفات حقيقية لشهرين متتاليين (سبتمبر
وأغسطس) لأبني القارئ مضبوطًا من أول مرّة، وأحسم بها ثلاثة أشياء دفعة واحدة:
الصيغة الفعلية · ثبات الرقم الوظيفي · وجود رقم الهوية من عدمه.
لا ترسلها قبل المرحلة 2 — لا حاجة بها قبل ذلك.

---

## الخلاصة

الحماية تقوم على **خمسة حواجز مستقلّة** تُجتاز كلّها معًا، ولا يعوّض أحدها
عن الآخر:

```
1. جلسة منصّة صالحة                ← موجود في المشروع أصلًا
2. Protected User                   ← لا أحد يمسّ حسابي من أدوات الإدارة
3. allowlist بـ users.id + البريد   ← لا دور، لا صلاحية، لا owner-bypass
4. كلمة مرور القسم                  ← سرّ خارج الكود والقاعدة تمامًا
5. جلسة قسم 15/60 قابلة للإبطال
```

وفوقها **الملفات نفسها مقفلة** — خاصّة، مشفّرة، بلا رابط قابل للفتح —
و**لا آيبان كامل في القاعدة أصلًا**.

والفرق الجوهري بين النسخة 1 وهذه: **لم يعد شيء من هذا معلَّقًا بدور
`owner`.** حتى لو تغيّر دور حسابي غدًا، الحماية قائمة كما هي.

**بانتظار جوابك على السؤالين في القسم 19 لأبدأ المرحلة 1أ.**
