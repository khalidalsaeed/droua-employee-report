/* صور الموظفين المعتمدة — ربط فقط، بلا صور.
   =========================================================================
   البايتات تعيش في متجر Vercel Blob **خاصّ** مستقلّ (EMPLOYEE_PHOTOS_*)
   لا في المستودع ولا في القاعدة ولا base64 في JSONB. هذا الملفّ لا يحمل إلا:

     photoId     معرّف عشوائي يراه المتصفّح — لا يكشف اسمًا ولا مسار تخزين.
     match       من صاحب الصورة:
                   eid   — رقم ضمان (employees.eid). حين يُملأ يتقدّم على البريد.
                   email — مفتاح المعاينة الحالية: الهيكل التنظيمي يربط
                           سجلّاته بسجلّات المنصّة بالبريد وحده، ولقطة
                           المصدر (lib/org/source.js) لا تحمل eid.
                 الانتقال إلى eid عند الاعتماد: يُملأ eid لكل صفّ (بعد
                 مطابقته بسجلّ القاعدة)، ثم يُترك البريد أو يُحذف — بلا
                 تغيير في الواجهة لأنها تسأل بالاثنين.
     sourceRow   صفّ المصدر في تقرير Excel للرجوع والمراجعة.
     storageKey  مسار عشوائي داخل المتجر الخاصّ — **للخادم وحده**، لا يخرج
                 في أي استجابة.
     sha256      بصمة الملفّ: يُتحقَّق منها عند الرفع وعند كل تقديم.

   المطابقة: lib/photos/match.js (اسم الملفّ ← اسم الموظف، بلا أي تحليل
   للصورة). المعالجة: إزالة الإطار الأبيض للقطة الشاشة فقط، ثم JPEG بلا
   بيانات وصفية. الرفع: scripts/upload-employee-photos.js. */

module.exports = Object.freeze([
  {
    photoId: "7812cb6e7d13f41c",
    match: { email: "shakibcuteshakib@gmail.com", eid: null },
    sourceRow: 3,
    storageKey: "employee-photos/e58f5b9870ff97ae540a17bfba1635f0",
    mime: "image/jpeg",
    bytes: 14780,
    width: 266,
    height: 266,
    sha256: "eb0b24358074bfd1ab218bbd9708a4a5afb96bc96cf9e5f9f5f0bff1ae507251",
  },
  {
    photoId: "ab7827b17e17003f",
    match: { email: "mama202vvhn@gmail.com", eid: null },
    sourceRow: 4,
    storageKey: "employee-photos/1f3f00b7b4b9c881e16e92258cde9977",
    mime: "image/jpeg",
    bytes: 17315,
    width: 266,
    height: 266,
    sha256: "53fbcc7cfa4a1441d337e0d8c561bce611b1b50c3f3c6a710c55ba11923380b7",
  },
  {
    photoId: "cb335b8b6ba60eed",
    match: { email: "toufiq82300@gmail.com", eid: null },
    sourceRow: 5,
    storageKey: "employee-photos/ae92c3eca8f3d23e23b4cb54ce193da7",
    mime: "image/jpeg",
    bytes: 29293,
    width: 266,
    height: 266,
    sha256: "aa87b57c1601dc94de7267e086ba8f4cb8e998422ddab5cb7448442b20e3773d",
  },
  {
    photoId: "81bab759f49f0fec",
    match: { email: "mdshihab17186740@gmail.com", eid: null },
    sourceRow: 6,
    storageKey: "employee-photos/b2b1e91d8437e89f1dbd048bfdc18729",
    mime: "image/jpeg",
    bytes: 32389,
    width: 266,
    height: 266,
    sha256: "9b4eed9ac51c8009b29ab2626816de6faaf60acb44c6b5fde75aec4db3b12c9c",
  },
  {
    photoId: "92001556c8555b70",
    match: { email: "sforhad188@gmail.com", eid: null },
    sourceRow: 7,
    storageKey: "employee-photos/2fc99fbefb6434c8e1b7ffe7d1e32396",
    mime: "image/jpeg",
    bytes: 15477,
    width: 266,
    height: 265,
    sha256: "f6be40bb399d9d143044c124d7e2be36beea382b2393736acacaec8592c36e52",
  },
  {
    photoId: "6da38c659dc77411",
    match: { email: "dewanrasel999@gmail.com", eid: null },
    sourceRow: 8,
    storageKey: "employee-photos/0db687b2824b6ba816ff6f32a3788f79",
    mime: "image/jpeg",
    bytes: 29241,
    width: 266,
    height: 266,
    sha256: "e33c621e8d5215415c34c239c4e71da36c5c4b740060dc7f7f0b2a8ccd523e7f",
  },
  {
    photoId: "f00b2b566f7929be",
    match: { email: "mdshohidul15727@gmail.com", eid: null },
    sourceRow: 9,
    storageKey: "employee-photos/21e32c9bf0926fdbc1832599e4f5cd16",
    mime: "image/jpeg",
    bytes: 17222,
    width: 266,
    height: 266,
    sha256: "5f255bcc2ef16f1cbf567730b596fb3da3271d6e0106ff3b77beb32ee4d93153",
  },
  {
    photoId: "e184578183203d3b",
    match: { email: "tahsinahmedmail@gmail.com", eid: null },
    sourceRow: 10,
    storageKey: "employee-photos/9ee5d917bf5b7a3f714bb364a9bc238a",
    mime: "image/jpeg",
    bytes: 12696,
    width: 266,
    height: 266,
    sha256: "56bf81fa2fc231e864aa66f80c0425795d78aa17d7f9199f5ffdfff5660d5a83",
  },
  {
    photoId: "14c228b7a3c2a793",
    match: { email: "mdhellahossain297@gmail.com", eid: null },
    sourceRow: 11,
    storageKey: "employee-photos/a9e74188e6863c5947ee610bddf65978",
    mime: "image/jpeg",
    bytes: 18975,
    width: 266,
    height: 266,
    sha256: "e59ebfe60f6f35862f2f932c59a1bfd92485191b1633940bc09ba5b069cb6f9a",
  },
  {
    photoId: "273474563792e068",
    match: { email: "sagorkhan000h@gmail.com", eid: null },
    sourceRow: 12,
    storageKey: "employee-photos/7b9529d38f81938c8610e3b304b8c8d7",
    mime: "image/jpeg",
    bytes: 15917,
    width: 266,
    height: 258,
    sha256: "e77e41e8605e1fc0b1cb629ad4367770ec3255bc1893fd6f1921dd5bf3b67e94",
  },
  {
    photoId: "aa5df72284cf9755",
    match: { email: "mdtarek22002@gmail.com", eid: "510" },
    sourceRow: 13,
    storageKey: "employee-photos/60ca155c3740b6df2d179893951031e7",
    mime: "image/jpeg",
    bytes: 21998,
    width: 266,
    height: 266,
    sha256: "d2f8225bf7e8696f92f36045b6acf5ecdbf3119146e2e7e63fc405f86bf90e31",
  },
  {
    photoId: "7fdf896529b95549",
    /* بريد السجلّ في المنصّة لا يطابق بريد تقرير Excel، فلا تُحلّ الصورة
       بالبريد في بطاقات المنصّة. رقم ضمان 511 أكّده مدير الموارد البشرية
       من البطاقة نفسها (2026-10-19). */
    match: { email: "mdrashelprodhanmdrashelprodhan@gmail.com", eid: "511" },
    sourceRow: 14,
    storageKey: "employee-photos/530f4300ff2b9513993afe2a45b67dca",
    mime: "image/jpeg",
    bytes: 15474,
    width: 266,
    height: 266,
    sha256: "b8ca81c6193a4abb89a5eccb91c4a886b61348da8570705e3e306ddcdb458975",
  },
]);
