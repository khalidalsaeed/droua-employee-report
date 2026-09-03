/* شاشة الترحيب بعد تسجيل الدخول.
   =========================================================================
   تظهر مرّة واحدة لكل تسجيل دخول ناجح، لا في كل إعادة تحميل داخل الجلسة
   نفسها. الآلية: صفحة الدخول تضع علامة في sessionStorage قبل التحويل إلى
   "/"، وهذه الوحدة تقرأها ثم تمحوها فورًا. sessionStorage محصور بالتبويب
   الذي جرى فيه الدخول، فلا تظهر الشاشة في تبويب آخر ولا بعد إغلاقه.

   لا تمسّ هذه الوحدة المصادقة ولا الصلاحيات ولا الخادم: الاسم يصل إليها
   جاهزًا من /api/auth/me عبر initAuthGate()، وهي لا تُصدر أي طلب شبكة.

   منع الوميض: الصنف .welcoming يوضع على <html> في رأس الصفحة قبل رسم
   الجسم، فترتفع الطبقة الضبابية من أوّل إطار. أمّا نصّ التحية فيبقى
   فارغًا — بلا اسم بديل ولا placeholder — حتى تُستدعى show() باسم
   المستخدم الحقيقي. */
const Welcome = (function () {
  /* المفتاح مكرَّر حرفيًا في login.html (سطر واحد قبل التحويل). صفحة
     الدخول لا يمكنها تحميل هذا الملف: الوسيط لا يمرّر /welcome.js لمن لا
     جلسة له، وهو الصواب. أي تغيير هنا يلزمه تغيير هناك. */
  const FLAG = "droua:welcome";

  /* لو تعثّر شيء بعد رفع الطبقة ولم تُستدعَ show()، تُزال الطبقة تلقائيًا
     بدل أن يبقى الموقع محجوبًا خلف ضباب لا سبيل إلى إزالته. */
  const SAFETY_MS = 8000;
  /* شبكة أمان لإزالة العنصر لو لم يصل transitionend (تبويب في الخلفية،
     أو حركة مخفَّضة تُصفّر مدّة الانتقال). */
  const EXIT_FALLBACK_MS = 900;

  const root = document.documentElement;
  let el = null, btn = null, greetEl = null, roleEl = null;
  let prevFocus = null, safety = 0, leaving = false, inerted = [], observer = null;

  function armed() {
    try { return sessionStorage.getItem(FLAG) === "1"; } catch (e) { return false; }
  }
  function disarm() {
    try { sessionStorage.removeItem(FLAG); } catch (e) { /* وضع خاص/ممتلئ */ }
  }

  /* الوقت المحلي للجهاز حرفيًا — لا خادم ولا منطقة زمنية مفروضة.
     4:00 حتى 11:59 صباحًا، وما عداه مساءً. */
  function greetingFor(date) {
    const h = date.getHours();
    return h >= 4 && h < 12 ? "صباح الخير" : "مساء الخير";
  }

  function focusables() {
    if (!el) return [];
    return Array.prototype.filter.call(
      el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      (n) => !n.disabled && n.offsetParent !== null
    );
  }

  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    /* حبس التركيز: الخلفية مُعطَّلة بـinert حيث يتوفّر، وهذا يغطّي ما
       يُضاف إلى الجسم بعد رفع الطبقة (ترويسة app-nav مثلًا). */
    const list = focusables();
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* تعطيل الخلفية عن التركيز وقارئ الشاشة. المراقب ضروري لا زينة:
     AdminUI و AppNav يضيفان إلى الجسم عناصر (حاوية التنبيهات، الدرج،
     الشريط السفلي) بعد رفع الطبقة، فلو اكتُفي بجرد واحد لبقيت هذه
     العناصر قابلة للوصول خلف الشاشة. */
  function setBackgroundInert(on) {
    if (on) {
      const mark = () => Array.prototype.forEach.call(document.body.children, (n) => {
        if (n !== el && !n.inert) { n.inert = true; inerted.push(n); }
      });
      mark();
      observer = new MutationObserver(mark);
      observer.observe(document.body, { childList: true });
    } else {
      if (observer) { observer.disconnect(); observer = null; }
      inerted.forEach((n) => { n.inert = false; });
      inerted = [];
    }
  }

  function teardown() {
    document.removeEventListener("keydown", onKeydown, true);
    setBackgroundInert(false);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    root.classList.remove("welcoming");
    el = btn = greetEl = roleEl = null;
    if (prevFocus && document.contains(prevFocus)) { try { prevFocus.focus(); } catch (e) {} }
    prevFocus = null;
  }

  function close() {
    if (!el || leaving) return;
    leaving = true;
    clearTimeout(safety);
    /* حركة مخفَّضة: إزالة فورية. مُدد الانتقال مُصفَّرة في ui.css، وقد
       لا يُطلق المتصفّح transitionend أصلًا على تغيير بلا مدّة. */
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      teardown();
      return;
    }
    el.classList.remove("is-in");
    el.classList.add("is-leaving");

    let done = false;
    const finish = () => { if (done) return; done = true; teardown(); };
    /* الطبقة والبطاقة تتحرّكان معًا؛ الانتظار مقصور على شفافية الطبقة
       نفسها حتى لا ينتهي الأمر عند أوّل انتقال ينتهي من البطاقة. */
    el.addEventListener("transitionend", (e) => {
      if (e.target === el && e.propertyName === "opacity") finish();
    });
    setTimeout(finish, EXIT_FALLBACK_MS);
  }

  /* تُستدعى من initAuthGate() بعد أن يعود /api/auth/me — أي بعد اكتمال
     التحقق من الجلسة ومعرفة الاسم يقينًا. */
  function show(user) {
    /* لا يُعتمد على DOMContentLoaded وحده: لو عاد /api/auth/me من ذاكرة
       المتصفّح قبل اكتمال تحليل الصفحة، تُجهَّز المراجع هنا. */
    if (!el) init();
    if (!el || leaving || !armed()) return false;
    disarm();
    clearTimeout(safety);

    const name = typeof user === "object" && user && typeof user.name === "string"
      ? user.name.trim() : "";
    const greeting = greetingFor(new Date());
    /* بلا اسم لا تُعرض قيمة بديلة ولا فاصلة معلّقة — التحية وحدها. */
    greetEl.textContent = name ? `${greeting}، ${name}` : greeting;
    /* الدور بتسميته العربية. الترجمة تأتي من AppNav.roleLabel — المصدر
       المشترك المطابق لـ lib/auth/roles.js — فلا نسخة جديدة من الخريطة
       هنا. دور غير معروف يعيد "" فيُحذف السطر: القيمة البرمجية الخام
       (owner، admin) لا تُعرض للمستخدم بحال. */
    if (roleEl) {
      const label = (typeof AppNav !== "undefined" && AppNav.roleLabel)
        ? AppNav.roleLabel(user && user.role) : "";
      roleEl.textContent = label;
      roleEl.hidden = !label;
    }

    prevFocus = document.activeElement;
    setBackgroundInert(true);
    document.addEventListener("keydown", onKeydown, true);
    btn.addEventListener("click", close);

    /* إطاران قبل is-in: الأوّل يضمن أن المتصفّح رسم الحالة الابتدائية،
       فينطلق الانتقال بدل أن يقفز إلى نهايته. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!el) return;
      el.classList.add("is-in");
      try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
    }));
    return true;
  }

  function init() {
    if (el || leaving || !root.classList.contains("welcoming")) return;
    el = document.getElementById("welcome");
    if (!el) return;   /* الجسم لم يُحلَّل بعد — تُعاد المحاولة عند DOMContentLoaded */
    btn = document.getElementById("welcomeBtn");
    greetEl = document.getElementById("welcomeGreet");
    roleEl = document.getElementById("welcomeRole");
    if (!btn || !greetEl) { teardown(); return; }
    safety = setTimeout(() => { if (el && !el.classList.contains("is-in")) teardown(); }, SAFETY_MS);
  }

  /* بعد اكتمال التحليل: إن لم يوجد العنصر أصلًا يُرفع الصنف عن <html>،
     وإلا بقي الموقع مقفل التمرير خلف طبقة لا وجود لها. */
  function ready() {
    init();
    if (!el) root.classList.remove("welcoming");
  }
  if (document.readyState === "loading") { init(); document.addEventListener("DOMContentLoaded", ready); }
  else ready();

  return { show, close, greetingFor, FLAG };
})();
