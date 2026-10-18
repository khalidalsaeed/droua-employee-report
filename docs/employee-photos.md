# صور الموظفين

## ما تفعله الميزة

تظهر صورة الموظف المعتمدة مكان الأحرف الأولى في:
- رأس ملف الموظف
- بطاقات قائمة الموظفين
- عُقد الهيكل التنظيمي
- لوحة تفاصيل الهيكل
- قائمة الهيكل على الجوال

موظف بلا صورة، أو صورة تعذّر تحميلها، يبقى على الأحرف الأولى. وعقدة المدير المرجعية (بلا سجلّ موظف) تبقى على الأحرف الأولى دائمًا.

بطاقات تصاريح أجير لم تتغيّر.

## التخزين

| ما | أين |
|---|---|
| بايتات الصور | متجر Vercel Blob **خاصّ** مستقلّ، توكنه `EMPLOYEE_PHOTOS_READ_WRITE_TOKEN` |
| الربط (مَن ← أيّ صورة) | `lib/photos/manifest.js` — معرّف عشوائي، بصمة sha256، مسار عشوائي |
| المستودع | لا صور، لا روابط، لا base64 |
| قاعدة البيانات | لا شيء — لا هجرة |

- لا يُستعمل متجر أجير العامّ (`BLOB_READ_WRITE_TOKEN`)، ولا متجر قسم المراجعة (`DROUA_BLOB_READ_WRITE_TOKEN`). مطابقة التوكن لأيٍّ منهما ترفض العمل.
- العرض عبر `/api/files/employee-photo?id=<photoId>` داخل الدالّة الخادمة نفسها (عدد الدوالّ يبقى 2).
  - فحص الجلسة و`employees:view` في كل طلب.
  - `Cache-Control: private`.
  - تحقّق من البصمة والتوقيع قبل الإرسال.
  - مسار التخزين لا يخرج من الخادم.
- غياب التوكن (الإنتاج قبل الاعتماد) = لا صور = الأحرف الأولى في كل مكان، بلا روابط مكسورة.

## المطابقة

من **اسم الملفّ وحده** (`lib/photos/match.js`)، بلا أي تحليل للصورة.

الترتيب:
1. تطابق تامّ عربي
2. تطابق تامّ إنجليزي
3. اسم مكرّر في السجلّ خطأَ إدخال
4. اختصار معتمد صراحةً

غير ذلك `ambiguous` أو `unmatched`، ولا يُربط.

النتيجة المعتمدة: 12/12 matched (اعتُمدت الاختصارات الأربعة في 2026-10-18).

## المعالجة

إزالة الإطار الأبيض للقطة الشاشة فقط (مقارنة بكسلات بلون الإطار، لا تحليل محتوى)، ثم حفظها JPEG بلا بيانات وصفية.

نسخة واحدة لكل صورة (~266×266، 13–32KB). القصّ الدائري أو المستدير عند العرض فقط (`object-fit: cover`).

## الرفع (Preview)

```
node scripts/upload-employee-photos.js "<مجلّد الصور المعالجة>"          # معاينة
node scripts/upload-employee-photos.js "<مجلّد الصور المعالجة>" --apply  # رفع
```

يفحص السكربت:
- المطابقة
- التوقيع والنوع والامتداد والحجم والاكتمال
- التكرار
- تطابق البصمة مع الـmanifest

ثم يتحقّق بعد كل رفع أن الكائن لا يُقدَّم بلا مصادقة.

## الانتقال إلى الإنتاج (لاحقًا، بموافقة)

1. ربط المتجر نفسه ببيئة Production (أو متجر إنتاج مستقلّ ثم إعادة الرفع).
2. ملء `match.eid` في الـmanifest من سجلّات القاعدة. الواجهة تبحث بـeid أوّلًا، فلا تغيير فيها.
3. حين يُبنى الرفع والاستبدال والحذف من الواجهة يُنقل الربط إلى جدول:

```sql
CREATE TABLE employee_photos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_eid TEXT NOT NULL REFERENCES employees(eid) ON UPDATE CASCADE ON DELETE CASCADE,
  storage_key  TEXT NOT NULL UNIQUE,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by  UUID NULL,
  active       BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX employee_photos_one_active ON employee_photos (employee_eid) WHERE active;
```

- كل رفع/استبدال/حذف يُسجَّل في `audit_log`: employee_eid، الإجراء (upload / replace / delete)، الفاعل، الوقت — بلا بايتات.
- **لم يُطبَّق** — لا هجرة الآن.

## الرجوع

1. `git revert` لكوميتات هذه الميزة الثلاثة: تعود القوائم والهيكل إلى الأحرف الأولى كما كانت. لا ملفّ آخر يتأثّر.
2. حذف متجر الصور من Vercel (Storage ← المتجر ← Settings ← Delete Store) ومتغيّره من Preview.
