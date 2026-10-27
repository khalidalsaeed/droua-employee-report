# جولة التحديثات (Versioned Update Tour)

نافذة «قمنا بإضافة مزايا جديدة» تظهر **مرّة واحدة لكل إصدار** بعد تسجيل دخول
ناجح، ثم جولة إبراز (spotlight) على الميزات الجديدة التي **يملك المستخدم
صلاحيتها**.

## الملفات

| الملف | الدور |
|---|---|
| `lib/tour/updateTour.js` | الإصدارات (`RELEASES`)، الإصدار الحالي (`CURRENT_VERSION`)، ترشيح الخطوات بالصلاحيات، قراءة/كتابة الحالة |
| `api/app.js` → `authUpdateTour` | `GET/POST /api/auth/update-tour` داخل الدالّة نفسها (لا Function جديدة) |
| `update-tour.js` / `update-tour.css` | النافذة والجولة في المتصفّح، بلا مكتبة |
| `login.html` | يضع علامة `droua:update-tour` في `sessionStorage` عند الدخول الناجح |
| `app-shell.html` | يحمّل الوحدة ويستدعي `UpdateTour.maybeStart()` في آخر `boot()` |
| `test/update-tour.test.js` | الاختبارات |

## الإصدار الحالي

`release-2026.10.27` — تصاريح أجير، الوثائق القادمة على انتهاء الصلاحية، البطاقات البلدية.

## أين تُحفظ الحالة

في جدول `audit_log` القائم — **لا migration**:

| العمود | القيمة |
|---|---|
| `type` | `update_tour_started` / `update_tour_completed` / `update_tour_skipped` |
| `actor_id` | معرّف المستخدم (من الجلسة فقط) |
| `target_id` | معرّف الإصدار |
| `meta` | `{ "steps": n }` فقط |
| `ts` | وقت الحدث (= completed_at) |

المستخدم «شاهد الإصدار» إذا وُجد له صفّ `completed` أو `skipped` بمعرّف الإصدار.
`started` لا يُغلقه، و«لاحقًا» لا يُكتب أصلًا.

`localStorage` احتياط فقط: يُكتب حين يفشل حفظ القرار على الخادم، ويُعاد إرساله في الدخول القادم.

استعلام للمتابعة:

```sql
SELECT type, count(*) FROM audit_log
WHERE target_id = 'release-2026.10.27' AND type LIKE 'update_tour_%'
GROUP BY type;
```

## السلوك

- تظهر بعد دخول ناجح فقط، وبعد انصراف شاشة الترحيب. لا في Refresh ولا بعد التنقّل.
- **ابدأ الجولة** → `started`، ثم «إنهاء الجولة» → `completed`.
- **تخطي الجولة** (في النافذة أو أي خطوة) أو **Esc أثناء الجولة** → `skipped`.
- **لاحقًا** أو **Esc على النافذة** → لا يُحفظ شيء؛ تعود في الدخول القادم.
- خطوة بلا صلاحية لا تصل إلى المتصفّح أصلًا. ولا خطوات مسموحة = لا نافذة.
- خطوة قسمها غير ظاهر في الصفحة تُسقط أيضًا.

## إضافة جولة جديدة

1. في `lib/tour/updateTour.js` أضف إصدارًا جديدًا إلى `RELEASES` بمعرّف جديد لا يُعاد استعماله، مثل `release-2026.11.15`:

   ```js
   "release-2026.11.15": {
     title: "قمنا بإضافة مزايا جديدة",
     intro: "…",
     steps: [
       {
         id: "org-chart",
         title: "الهيكل التنظيمي",
         body: "…",
         requires: [["employees", "view"]],   // كل الصلاحيات لازمة
         section: "#orgSec",                  // القسم في app-shell.html
         target: ["#orgPreview", "#orgSec"],  // أوّل ظاهر يُبرز
         // prepare: "اسم-تجهيز",             // اختياري — يُعرَّف في PREPARE داخل update-tour.js
       },
     ],
   },
   ```

2. غيّر `CURRENT_VERSION` إلى المعرّف الجديد.
3. `npm test` — اختبار يتحقّق أن كل `section` موجود في `app-shell.html` وأن كل `prepare` معرّف.

لا migration ولا متغيّرات بيئة. كل مستخدم يرى الإصدار الجديد مرّة واحدة، مهما كان قد فعل بالسابق.

## التراجع (Rollback)

- **إيقاف الجولة فورًا بلا حذف كود:** اجعل `steps: []` في الإصدار الحالي (أو وجّه `CURRENT_VERSION` إلى معرّف غير موجود في `RELEASES`) — الخادم يردّ `show:false` للجميع.
- **إزالة كاملة:** Revert لـ commits الميزة. لا جدول ولا عمود يُحذف؛ صفوف `update_tour_*` في `audit_log` تبقى سجلًّا ولا تؤثّر في شيء.
- **Vercel:** إعادة ترقية النشر السابق (Instant Rollback) تكفي، لأن الميزة لا تمسّ القاعدة.
