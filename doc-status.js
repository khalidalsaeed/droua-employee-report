/* doc-status.js — المصدر الوحيد لحالة وثائق الموظفين.
   =========================================================================
   استُخرج من app-shell.html حين صارت «الوثائق قريبة الانتهاء» تُعرض في
   موضعين: رقم البطاقة في لوحة المؤشّرات، وصفحة /expiring.html المستقلّة.

   القاعدة التي يقوم عليها هذا الملف: لا تُكرَّر عتبة SOON ولا دالّة isSoon
   ولا قائمة أنواع الوثائق في أي ملف آخر. من أراد «قريبة الانتهاء» يستدعي
   collectSoonDocs() — وهي وحدها من يعرف ما الذي يُحتسب وكيف يُرتَّب.
   نسختان من الشرط تعنيان حتمًا أن يخالف الرقمُ القائمةَ يومًا ما.

   سكربت كلاسيكي بلا وحدات ولا أداة بناء، كبقية المشروع. تعريفاته عامّة
   عمدًا: app-shell.html كان يعرّفها بنفسه ويستدعيها في عشرات المواضع،
   فبقاؤها بالأسماء نفسها يُبقي تلك المواضع كما هي بلا تعديل.
   كائن DocStatus أدناه هو الواجهة المفضَّلة للشيفرة الجديدة.

   لا يمسّ هذا الملف أي منطق أعمال في الخادم: الخادم يحسب صلاحياته
   وتنبيهاته بنفسه (api/cron/check-expirations.js)، وهذه حسبة عرضٍ
   للمتصفّح فقط. */

/* عتبة «قريب الانتهاء» بالأيام. الرقم الوحيد في المنصّة كلها. */
const SOON = 90;

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
   خارجه لأن إجراءها جارٍ فعلًا. */
function isSoon(st){return st.key==="warn"||st.key==="today";}

/* كل وثيقة يحملها الموظف ولها تاريخ انتهاء. إضافة نوع جديد هنا تسري
   تلقائيًا على البطاقة والصفحة معًا. */
function empDocs(e){return [
  {type:"إقامة",     tk:"iq",  exp:e[F.iqExp],   st:statusOf(e[F.iqExp])},
  {type:"رخصة عمل",  tk:"lic", exp:e[F.licExp],  st:licStatus(e)},
  {type:"الجواز",    tk:"pass",exp:e[F.passExp], st:statusOf(e[F.passExp])},
];}

/* ======================================================================
   الدالّة التي يعتمد عليها الطرفان
   ----------------------------------------------------------------------
   تُرجع كل وثيقة قريبة الانتهاء عبر كل الموظفين، مرتّبة من الأقرب انتهاءً
   إلى الأبعد. كل عنصر يحمل ما تحتاجه أي واجهة لعرضه:
     i     فهرس الموظف في القائمة الممرَّرة
     emp   كائن الموظف نفسه (منه الاسم والرقم الوظيفي)
     type  نوع الوثيقة  ·  tk مفتاحه القصير للأيقونة
     exp   تاريخ الانتهاء الخام  ·  st حالتها المحسوبة (st.n = الأيام)
   ====================================================================== */
function collectSoonDocs(list){
  const out=[];
  (list||[]).forEach((e,i)=>empDocs(e).forEach(dc=>{
    if(dc.st.key==="na")return;          /* وثيقة بلا تاريخ مسجَّل */
    if(isSoon(dc.st)) out.push({i,emp:e,...dc});
  }));
  return out.sort((a,b)=>a.st.n-b.st.n);
}

/* كل وثيقة منتهية بالفعل — تُستعمل في بطاقة «وثائق منتهية». */
function collectExpiredDocs(list){
  const out=[];
  (list||[]).forEach((e,i)=>empDocs(e).forEach(dc=>{
    if(dc.st.key==="na")return;
    if(isExpired(dc.st)) out.push({i,emp:e,...dc});
  }));
  return out;
}

/* «إقامات 3 · رخص عمل 1» — مُنسِّق واحد يستعمله الطرفان.
   الأنواع الصفرية تُحذف: «رخص عمل 0» ضجيج لا معلومة. */
function summarizeDocs(arr){
  const LABELS=[["iq","إقامات"],["lic","رخص عمل"],["pass","جوازات"]];
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
  statusOf, licStatus, isExpired, isValid, isSoon,
  empDocs, collectSoonDocs, collectExpiredDocs, summarizeDocs,
};
