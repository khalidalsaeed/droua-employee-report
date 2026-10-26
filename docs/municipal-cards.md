# البطاقات البلدية (الشهادات الصحية)

## ما تفعله الميزة

قسم «البطاقات البلدية» في الصفحة الرئيسية بعد تصاريح أجير، بالتصميم المعتمد (`ddde4a5`):
- **وجه الشهادة الأصلي** مرسومًا من ملفّ الأمانة نفسه (الصفحة الأولى، بشعارها وصورتها ورمزها ونصوصها كما هي) — لا إعادة رسم ولا نسخة اصطناعية.
- شارة الحالة من تاريخ الانتهاء الحقيقي عند كل تحميل: سارية (> 60 يومًا)، كهرماني (31–60)، أحمر (≤ 30 — موعد التجديد بنصّ الشهادة)، منتهية.
- الاسم والمسمّى من سجلّ الموظف، و«عرض الباركود» يفتح **صورة رمز QR الأصلية** من الملفّ مكبّرة.
- بحث، فلتر الحالة، فلتر القسم، «عرض الكل» (صفّان أوّلًا).

## مصدر الحقيقة: ملفّ الشهادة

| ما | من أين |
|---|---|
| الحقول (رقم الشهادة، مكان الإصدار، الانتهاء، رقم الهوية…) | `lib/municipal/extractCard.js` — النصّ العربي من جدول `cmap` في الخطّ المضمَّن (طبقة ToUnicode في الملفّ تالفة)، والهجري يُحوَّل بأم القرى |
| وجه البطاقة | `lib/municipal/render.js` — pdf.js يرسم الصفحة الأولى (×4 ≈ 605×950px). مطابق بكسليًّا لرسم poppler |
| صورة الرمز | الصورة المضمَّنة في الملفّ بكسلًا ببكسل + هامش أبيض حولها فقط (الكاميرا تحتاجه). يُتحقَّق أن البكسلات مطابقة للأصل بايتًا ببايت وأنها تُقرأ إلى **الرابط الرسمي نفسه** المقروء من الملفّ، وإلا لا تُعتمد |

ملاحظة: الرمز الصغير داخل وجه البطاقة أكثف من أن يُمسح بحجم البطاقة (كثافة الملفّ الأصلي)؛ لهذا تعرض النافذة الصورة الأصلية بحجم كامل (500×500 + هامش).

## المطابقة بالموظف — بمفتاح ثابت

`lib/municipal/match.js`: رقم الهوية على الشهادة = `employees.iqama` حرفيًا → `employee_eid`.
- سجلّ واحد → matched · أكثر → ambiguous · لا شيء → unmatched. الاسم لا يقرّر شيئًا.
- ambiguous/unmatched **لا يُرفعان**. التأكيد اليدوي بعد مراجعتك: `--assign <رقم الشهادة>=<eid>` (لـeid موجود فقط).
- بطاقتان لموظف واحد في الدفعة → الاثنتان ambiguous.
- القاعدة تُقرأ (`SELECT eid, iqama`) ولا يُكتب فيها شيء.

## التخزين — Preview-safe بلا هجرة

| ما | أين |
|---|---|
| وجه البطاقة PNG، صورة الرمز PNG | متجر Vercel Blob **خاصّ** مستقلّ `droua-municipal-cards` (`MUNICIPAL_CARDS_STORE_ID`)، OIDC قصير العمر |
| الفهرس (من يملك أيّ بطاقة + الحقول + المفاتيح + البصمات) | `municipal-cards/index.json` في المتجر الخاصّ نفسه |
| ملفّ PDF | **لا يُخزَّن** — بصمته فقط (`sourceFileHash`) |
| Git | لا ملفّات، لا صور، لا رموز، لا روابط، لا base64 (المستودع عامّ؛ اختبار يحرس ذلك) |
| القاعدة | لا شيء — لا هجرة، لا INSERT |

- المتجر مربوط ببيئة **Preview** (و Development أثناء الرفع فقط). Production لا يحمل `MUNICIPAL_CARDS_STORE_ID` ⇒ القسم فارغ هناك بلا خطأ، ولا يمسّ شيئًا.
- يُرفض أي معرّف متجر يطابق متجر أجير العامّ أو متجر المراجعة أو متجر صور الموظفين، ولا سقوط صامت إلى `BLOB_READ_WRITE_TOKEN`.
- الخادم: `GET /api/data/municipal-cards` (الحقول فقط، بلا مفاتيح ولا بصمات ولا رابط الرمز) و`/api/files/municipal-card-image?id=` و`/api/files/municipal-qr?id=` — كلها `municipal:view`، `Cache-Control: private`، والبصمة تُطابَق مع الفهرس قبل الإرسال. المتصفّح لا يعرف إلا `cardId` عشوائيًا.
- الصلاحية: `municipal:view` فقط في هذه المرحلة (HR وviewer افتراضيًا، Owner/Admin الكل، Finance لا شيء).

### مدخل الفهرس

```json
{
  "cardId": "16 hex عشوائي",
  "employeeEid": "503",
  "certificateNumber": "31319-1448",
  "issuePlace": "أمانة مدينة الرياض",
  "expiryDate": "2027-10-06",
  "expiryHijri": "1449-05-06",
  "nameOnCard": "…", "occupation": "…",
  "cardKey": "municipal-cards/card/<32 hex>.png", "cardSha256": "…",
  "qrKey": "municipal-cards/qr/<32 hex>.png", "qrSha256": "…",
  "qrTarget": "الرابط الرسمي من الملفّ — للخادم وحده",
  "sourceFileHash": "sha256 لملفّ PDF",
  "createdAt": "…", "updatedAt": "…"
}
```

## Schema المقترح للإنتاج (لم يُطبَّق)

لا حاجة إليه للمعاينة ولا للإنتاج ما دام الاستيراد بالسكربت. يصير لازمًا حين تُبنى الإضافة/الاستبدال/الحذف من الواجهة (كتابات متزامنة + سجلّ تدقيق):

```sql
CREATE TABLE municipal_cards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_eid       text NOT NULL REFERENCES employees(eid) ON UPDATE CASCADE ON DELETE CASCADE,
  certificate_number text NOT NULL UNIQUE,
  issue_place        text,
  expiry_date        date NOT NULL,
  expiry_hijri       text,
  card_blob_key      text NOT NULL UNIQUE,   -- مفتاح في المتجر الخاصّ، لا بايتات
  card_sha256        text NOT NULL,
  qr_blob_key        text UNIQUE,
  qr_sha256          text,
  qr_target          text,                   -- الرابط الرسمي من الملفّ، لا يخرج في JSON
  source_file_hash   text NOT NULL UNIQUE,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NULL
);
CREATE UNIQUE INDEX municipal_cards_one_active ON municipal_cards (employee_eid) WHERE active;
```

الانتقال: يُملأ الجدول من `index.json` نفسه، وتقرأ `lib/data/municipalCards.js` منه بدل الفهرس — الواجهة لا تتغيّر.

## التشغيل (Preview)

1. إنشاء المتجر الخاصّ وربطه بـPreview وDevelopment (خطوات Vercel أدناه).
2. معاينة بلا كتابة — تقرير المطابقة وفحص الرمز:
   ```
   vercel env run -e development -- node scripts/import-municipal-cards.js "<مجلّد الملفّات>"
   ```
   `DATABASE_URL` يُستعمل للقراءة فقط. إن لم يكن في بيئة Development فشغّل المعاينة بـ`-e preview` لتقرير المطابقة.
3. صور مراجعة محلية (خارج المستودع): `--preview-dir "<مجلّد>"`.
4. الرفع بعد مراجعة التقرير:
   ```
   vercel env run -e development -- node scripts/import-municipal-cards.js "<المجلّد>" --apply
   ```
   يُرفض برمز production. بعد كل كائن: فحص أن الرابط بلا مصادقة لا يقدّمه، وقراءة راجعة بالبصمة، ثم الفهرس آخرًا.

### خطوات Vercel

1. Storage ← Create Database ← Blob ← الاسم `droua-municipal-cards` ← **Private**.
2. Connect Project ← `droua-employee-report` ← Environments: **Preview** و**Development** فقط (لا Production) ← Prefix: `MUNICIPAL_CARDS` ← فيُضاف `MUNICIPAL_CARDS_STORE_ID`.
3. إعادة نشر Preview للفرع (أي push، أو Redeploy من لوحة النشر).

## الرجوع

- البيانات: `vercel env run -e development -- node scripts/import-municipal-cards.js --remove-all` يفرغ الفهرس ويحذف كائنات البطاقات، أو حذف المتجر كله (Storage ← المتجر ← Settings ← Delete) ومتغيّره.
- الشيفرة: `git revert` لكوميتات الميزة على الفرع؛ لا شيء آخر يتأثّر (لا هجرة، لا تغيير في القاعدة ولا في الاعتماديات).
