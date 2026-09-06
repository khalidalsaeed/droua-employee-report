/* doc-status.js — المصدر الوحيد لحالة وثائق الموظفين.
   =========================================================================
   استُخرج من app-shell.html حين صارت «الوثائق قريبة الانتهاء» تُعرض في
   موضعين: رقم البطاقة في لوحة المؤشّرات، وصفحة /expiring.html المستقلّة.

   القاعدة التي يقوم عليها هذا الملف: لا تُكرَّر عتبة SOON ولا شرط
   الاحتساب ولا قائمة أنواع الوثائق في أي ملف آخر. من أراد قائمة المتابعة
   يستدعي collectFollowUpDocs() — وهي وحدها من يعرف ما الذي يُحتسب وكيف
   يُرتَّب. نسختان من الشرط تعنيان حتمًا أن يخالف الرقمُ القائمةَ يومًا ما.

   سكربت كلاسيكي بلا وحدات ولا أداة بناء، كبقية المشروع. تعريفاته عامّة
   عمدًا: app-shell.html كان يعرّفها بنفسه ويستدعيها في عشرات المواضع،
   فبقاؤها بالأسماء نفسها يُبقي تلك المواضع كما هي بلا تعديل.
   كائن DocStatus أدناه هو الواجهة المفضَّلة للشيفرة الجديدة.

   لا يمسّ هذا الملف أي منطق أعمال في الخادم: الخادم يحسب صلاحياته
   وتنبيهاته بنفسه (api/cron/check-expirations.js)، وهذه حسبة عرضٍ
   للمتصفّح فقط. */

/* عتبة المتابعة التشغيلية بالأيام. الرقم الوحيد في المنصّة كلها.
   كانت 90 فكانت الصفحة تعرض وثيقة باقٍ عليها 86 يومًا وكأنها تحتاج
   إجراءً اليوم؛ المتابعة الفعلية لا تبدأ إلا في آخر عشرة أيام.
   سلّم التنبيهات (5/2/0 وما بعد الانتهاء) في lib/notifications/scan.js
   مستقلّ عن هذا الرقم عمدًا: ذاك متى نُرسل، وهذا ماذا نعرض. */
const SOON = 10;

const arMonths = ["يناير","فبراير","مارس","أبريل","مايو","يونيو",
                  "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

/* اليوم عند منتصف الليل — كل الحالات تُحسب من تاريخ الجهاز، لا شيء مثبَّت. */
const NOW = new Date(); NOW.setHours(0, 0, 0, 0);

/* أسماء الحقول كما تصل من المصدر (بعضها يحمل مسافة زائدة في آخره). */
const F = {
  eid:"الرقم الوظيفي", name:"اسم العامل", iqama:"رقم الإقامة", nat:"الجنسية", job:"المهنة",
  dob:"تاريخ الميلاد", iqExp:"تاريخ انتهاء الإقامة", cStart:"بداية العقد", cEnd:"نهاية العقد",
  base:"الراتب الأساسي", allow:"البدلات", total:"إجمالي الراتب", phone:"جوال العامل", email:"البريد الإلكتروني",
  transfer:"حالة النقل", iqState:"حالة الإقامة", licState:"حالة رخصة العمل ", insState:"حالة التأمين الطبي ",
  acc:"رقم الحساب", iban:"IBAN", bank:"اسم البنك", benef:"اسم المستفيد (كما في البنك)",
  licExp:"تاريخ انتهاء رخصة العمل", govCost:"التكلفة الحكومية الإجمالية", passport:"رقم الجواز",
  passExp:"تاريخ انتهاء الجواز", sex:"الجنس", iqIssue:"تاريخ اصدار الاقامة", iqHijri:"تاريخ انتهاء الاقامة بالهجري",
  employer:"رقم صاحب العمل", joinDate:"تاريخ المباشرة", annualLeave:"الاجازة السنوية",
  insCompany:"اسم شركة التأمين", insCost:"تكلفة التأمين الطبي", note:"ملاحظة"
};

function parseDate(s){
  if(s==null) return null;
  if(typeof s==="string" && s.includes("/")){const[m,d,y]=s.split("/").map(Number);return new Date(y,m-1,d);}
  const d=new Date(s); return isNaN(d)?null:d;
}
function fmtDate(s){const d=parseDate(s);if(!d)return "—";return `${d.getDate()} ${arMonths[d.getMonth()]} ${d.getFullYear()}`;}
function daysLeft(s){const d=parseDate(s);if(!d)return null;d.setHours(0,0,0,0);return Math.round((d-NOW)/86400000);}

function statusOf(s){
  const n=daysLeft(s);
  if(n===null) return {key:"na",cls:"na",n:null};
  if(n<0)      return {key:"bad",cls:"bad",n};
  if(n===0)    return {key:"today",cls:"today",n:0};
  if(n<=SOON)  return {key:"warn",cls:"warn",n};
  return {key:"ok",cls:"ok",n};
}
/* حالة رخصة العمل تحترم تجاوز «جاري السداد» إن وُجد في البيانات */
function licStatus(e){
  if(e && e._licPending) return {key:"pending",cls:"pending",n:daysLeft(e[F.licExp])};
  return statusOf(e[F.licExp]);
}

function isExpired(st){return st.key==="bad";}
function isValid(st){return st.key==="ok"||st.key==="warn"||st.key==="today"||st.key==="pending";}
/* «قريب الانتهاء» = سارٍ ويحتاج إجراءً: من اليوم حتى SOON يومًا.
   المنتهية (bad) خارجه، والبعيدة (ok) خارجه، و«جاري السداد» (pending)
   خارجه لأن إجراءها جارٍ فعلًا.
   تُستعمل للشارات والفلاتر التي تفصل «قريبة» عن «منتهية»؛ أما قائمة
   المتابعة وعدّادها فيستعملان needsFollowUp أدناه. */
function isSoon(st){return st.key==="warn"||st.key==="today";}

/* ======================================================================
   شرط «بحاجة إلى متابعة» — الشرط الوحيد للقائمة والعدّاد معًا
   ----------------------------------------------------------------------
   يشمل ثلاث حالات لا رابع لها:
     bad    منتهية فعلًا — تبقى ظاهرة حتى يُحدَّث تاريخها بتاريخ جديد
     today  تنتهي اليوم
     warn   باقٍ عليها من يوم واحد إلى SOON يومًا
   وما عداها خارج المتابعة: البعيدة (ok) لأن 11 يومًا فأكثر ليست متابعة،
   والوثيقة بلا تاريخ (na) لأن لا شيء يُحتسب، ورخصة «جاري السداد»
   (pending) لأن إجراءها جارٍ فعلًا فلا تُطالِب الموارد البشرية بشيء.
   ====================================================================== */
function needsFollowUp(st){return isExpired(st)||isSoon(st);}

/* أحدث تصريح أجير لكل رقم إقامة. تصريح أُعيد رفعه يَجُبّ الأقدم بدل أن
   يتراكم فوقه. كانت هذه القاعدة في app-shell.html وحدها، فلم تكن
   /expiring.html تعرفها؛ مكانها هنا مع بقية شروط الاحتساب. */
function latestPermits(permits){
  const byIqama=new Map();
  (permits||[]).forEach(p=>{
    if(!p||p.iqama==null)return;
    const k=String(p.iqama), cur=byIqama.get(k);
    if(!cur||new Date(p.issueDate)>new Date(cur.issueDate))byIqama.set(k,p);
  });
  return byIqama;
}

/* كل وثيقة يحملها الموظف ولها تاريخ انتهاء. إضافة نوع جديد هنا تسري
   تلقائيًا على البطاقة والصفحة معًا.
   `permitMap` خريطة إقامة→تصريح من latestPermits؛ بدونها تُحذف صفّ أجير
   بلا ضجيج، فتبقى المواضع التي لا تملك التصاريح (تصدير Excel مثلًا)
   عاملة كما كانت. */
function empDocs(e,permitMap){
  const docs=[
    {type:"إقامة",     tk:"iq",  exp:e[F.iqExp],   st:statusOf(e[F.iqExp])},
    {type:"رخصة عمل",  tk:"lic", exp:e[F.licExp],  st:licStatus(e)},
    {type:"الجواز",    tk:"pass",exp:e[F.passExp], st:statusOf(e[F.passExp])},
  ];
  /* تصريح أجير يعيش في جدول منفصل ويُربط بالموظف برقم الإقامة. يدخل
     عتبة SOON نفسها كبقية الوثائق؛ سلّم 5/2/0 الخاص ببطاقات قسم أجير
     تمييز بصري لا احتساب. */
  const p=permitMap&&e[F.iqama]!=null?permitMap.get(String(e[F.iqama])):null;
  if(p) docs.push({type:"تصريح أجير",tk:"ajeer",exp:p.expiryDate,st:statusOf(p.expiryDate),permit:p});
  return docs;
}

/* ======================================================================
   الدوالّ التي يعتمد عليها الطرفان
   ----------------------------------------------------------------------
   تمرّ كلها على كل موظف وكل وثيقة له، وتُرجع عناصر تحمل ما تحتاجه أي
   واجهة لعرضها:
     i      فهرس الموظف في القائمة الممرَّرة
     emp    كائن الموظف نفسه (منه الاسم والرقم الوظيفي)
     type   نوع الوثيقة  ·  tk مفتاحه القصير للأيقونة
     exp    تاريخ الانتهاء الخام  ·  st حالتها المحسوبة (st.n = الأيام)
     permit كائن التصريح، لصفوف أجير وحدها

   الوسيط الثاني `permits` مصفوفة تصاريح أجير الخام كما تصل من
   /api/data/permits؛ الاشتقاق كله يجري هنا من التواريخ لحظةَ النداء، فلا
   عدّاد محفوظ ولا حالة تُخزَّن: تعديلُ تاريخ انتهاء في المنصّة يُخرِج
   الوثيقة من القائمة ويُنقِص العدّاد في أول إعادة رسم بلا إدخال إضافي.
   ====================================================================== */
function collectDocs(list,permits,pred){
  const pm=latestPermits(permits);
  const out=[];
  (list||[]).forEach((e,i)=>empDocs(e,pm).forEach(dc=>{
    if(dc.st.key==="na")return;          /* وثيقة بلا تاريخ مسجَّل */
    if(pred(dc.st)) out.push({i,emp:e,...dc});
  }));
  return out;
}

/* قائمة المتابعة الكاملة: المنتهية أولًا (الأقدم انتهاءً في الصدارة) ثم
   ما يقترب من الانتهاء تصاعديًا. هذه هي القائمة التي تعرضها
   /expiring.html وهذا طولها هو رقم بطاقة «وثائق بحاجة إلى متابعة» —
   دالّة واحدة فلا يمكن للرقم أن يخالف القائمة. */
function collectFollowUpDocs(list,permits){
  return collectDocs(list,permits,needsFollowUp).sort((a,b)=>a.st.n-b.st.n);
}

/* «قريبة الانتهاء» وحدها بلا المنتهية — للشارات تحت المخططات وللمواضع
   التي تفصل الحالتين بصريًا. */
function collectSoonDocs(list,permits){
  return collectDocs(list,permits,isSoon).sort((a,b)=>a.st.n-b.st.n);
}

/* كل وثيقة منتهية بالفعل — تُستعمل في بطاقة «وثائق منتهية»، وهي مجموعة
   جزئية من قائمة المتابعة لا قائمة موازية لها. */
function collectExpiredDocs(list,permits){
  return collectDocs(list,permits,isExpired);
}

/* «إقامات 3 · رخص عمل 1» — مُنسِّق واحد يستعمله الطرفان.
   الأنواع الصفرية تُحذف: «رخص عمل 0» ضجيج لا معلومة. */
function summarizeDocs(arr){
  const LABELS=[["iq","إقامات"],["lic","رخص عمل"],["pass","جوازات"],["ajeer","تصاريح أجير"]];
  const p=[];
  for(const [tk,label] of LABELS){
    const n=arr.filter(x=>x.tk===tk).length;
    if(n) p.push(`${label} ${n}`);
  }
  return p.join(" · ");
}

const DocStatus = {
  SOON, F, arMonths, NOW,
  parseDate, fmtDate, daysLeft,
  statusOf, licStatus, isExpired, isValid, isSoon, needsFollowUp,
  latestPermits, empDocs,
  collectFollowUpDocs, collectSoonDocs, collectExpiredDocs, summarizeDocs,
};

/* يُستهلك في المتصفّح كسكربت كلاسيكي (النطاق العام)، وفي الاختبارات عبر
   require. الحارس يمنع الطرف الثاني من تغيير سلوك الأول. */
if(typeof module!=="undefined"&&module.exports) module.exports=DocStatus;
