/* employee-photos.js — صور الموظفين في الواجهة.
   =========================================================================
   سكربت كلاسيكي → EmployeePhotos في النطاق العام. يجلب فهرس الصور مرّة
   واحدة (معرّفات عشوائية فقط، لا روابط تخزين) ويبني رابط العرض الداخلي
   /api/files/employee-photo?id=… الذي يفحص الجلسة وemployees:view في كل
   طلب.

   الصورة طبقةٌ فوق الأحرف الأولى لا بديل عنها: الـPlaceholder يُرسم دائمًا
   والصورة فوقه. فإن تعذّر تحميلها (متجر غير مُهيّأ، صلاحية، شبكة) تُزال
   وتبقى الأحرف كما كانت — لا صورة مكسورة أبدًا.

   البحث برقم ضمان (eid) أوّلًا ثم بالبريد: البريد مفتاح المعاينة الحالية
   (الهيكل التنظيمي يربط بالبريد)، ورقم ضمان هو المفتاح الدائم حين
   يُملأ في lib/photos/manifest.js. */
(function (root) {
  "use strict";

  const byEid = new Map();
  const byEmail = new Map();
  let loading = null;

  const normEmail = (v) => String(v == null ? "" : v).trim().toLowerCase();

  function load() {
    if (loading) return loading;
    loading = (async () => {
      /* AdminUI مُعرَّف بـconst في سكربت كلاسيكي: في النطاق المشترك لا
         خاصيّةً على window — فالفحص بـtypeof لا بـroot.AdminUI. */
      if (typeof AdminUI === "undefined" || !AdminUI.can("employees", "view")) return;
      try {
        const j = await AdminUI.api("GET", "/api/data/employee-photos");
        (j.items || []).forEach((p) => {
          if (!/^[0-9a-f]{16}$/.test(String(p.photoId || ""))) return;
          if (p.eid) byEid.set(String(p.eid), p.photoId);
          if (p.email) byEmail.set(normEmail(p.email), p.photoId);
        });
      } catch (err) {
        /* بلا صور ليس عطلًا: تبقى الأحرف الأولى في كل مكان. */
      }
    })();
    return loading;
  }

  function idFor(ref) {
    if (!ref) return null;
    if (ref.eid != null && byEid.has(String(ref.eid))) return byEid.get(String(ref.eid));
    const k = normEmail(ref.email);
    return (k && byEmail.get(k)) || null;
  }

  function urlFor(ref) {
    const id = idFor(ref);
    return id ? `/api/files/employee-photo?id=${id}` : null;
  }

  /* وسم الصورة فقط — يوضع داخل حاوية الأحرف الأولى. alt فارغ لأن الاسم
     مكتوب بجانبها دائمًا؛ قراءته مرّتين ضجيج لقارئ الشاشة. */
  function img(ref) {
    const url = urlFor(ref);
    return url ? `<img class="ep-img" src="${url}" alt="" loading="lazy" decoding="async" draggable="false">` : "";
  }

  /* حدث error لا يصعد، فالالتقاط على المستند يغطّي كل صورة تُضاف لاحقًا. */
  if (root.document) {
    document.addEventListener("error", (ev) => {
      const t = ev.target;
      if (t && t.classList && t.classList.contains("ep-img")) t.remove();
    }, true);
  }

  root.EmployeePhotos = { load, urlFor, img, idFor };
})(window);
