/* الشاشة بعد فتح البوابة: الأشهر، وملفّات الشهر، وملاحظاته.
   =========================================================================
   صفحةٌ واحدة بلا إطار عمل ولا اعتماد: كل ما تفعله هو نداءُ
   `/secure-audit/api` ورسمُ ما يعود. والحالة كلّها في الخادم — لا تخزين
   محلّيّ، ولا شيء يبقى في المتصفّح بعد القفل.

   ── ثلاث حالاتٍ لكل عملية، لا حالةٌ واحدة ──
   جارية، ونجحت، وفشلت. وواجهةٌ تعرض الأولى والثانية وتصمت عن الثالثة
   تجعل المستخدم يظنّ أن ما فعله وقع — وفي نظامٍ يرفع ملفّات رواتب، ظنٌّ
   كهذا أسوأ من رسالة خطأ صريحة. ولذلك: كل نداء يُعطّل زرّه ويُظهر دوّارة،
   وكل فشلٍ يُعرض بنصٍّ يقول ما جرى وبإطارٍ أحمر يميّزه عن النجاح.

   ولا اسم للقسم في أي نصّ ظاهر خارج ما يراه صاحبه بعد الفتح. */

const { page } = require("./layout");

/* يجب أن يطابق api.MAX_UPLOAD_BYTES: الفحص هنا يوفّر رحلةً كاملة لملفٍّ
   سيُرفض، والفحص هناك هو الحارس الحقيقيّ. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const FORMATS = ["pdf", "xlsx", "xls", "csv"];

const BODY = `
<div class="bar">
  <h1 id="ttl">الأشهر</h1>
  <div class="row">
    <span class="small muted" id="t">—</span>
    <button id="lk" class="lock" type="button">قفل القسم</button>
  </div>
</div>

<section id="v-runs" hidden>
  <div class="row">
    <input id="p" type="month" aria-label="الشهر">
    <button id="add" type="button">إضافة شهر</button>
  </div>
  <div class="scroll"><table>
    <thead><tr><th>الشهر</th><th>الحالة</th><th>الملفّات</th><th>ملاحظات</th><th>حرجة</th></tr></thead>
    <tbody id="runs"></tbody>
  </table></div>
  <p class="empty" id="empty" hidden>لا أشهر بعد. اختر شهرًا وأضفه للبدء.</p>
</section>

<section id="v-run" hidden>
  <p class="row">
    <button id="back" class="ghost" type="button">رجوع</button>
    <span class="small muted" id="prev"></span>
  </p>
  <div id="slots"></div>

  <details id="cfg" class="cfgbox">
    <summary>إعدادات الشهر — قبل التحليل</summary>
    <div class="cfgbody">
      <h4>الموظفون في إجازة هذا الشهر</h4>
      <p class="small muted">تُفسَّر بها غيابةُ الموظّف عن كشف الشهر. والإجازة التي
        تغطّي الشهر كلَّه تُسكت ملاحظة «على القائمة بلا راتب»؛ والجزئية تُذكر
        في الملاحظة ولا تُسكتها — فنصفُ شهرٍ إجازةً يُتوقَّع له نصفُ راتب.</p>
      <p class="row">
        <input id="lv-no" type="text" inputmode="numeric" placeholder="الرقم الوظيفي" aria-label="الرقم الوظيفي">
        <input id="lv-from" type="date" aria-label="من تاريخ">
        <input id="lv-to" type="date" aria-label="إلى تاريخ">
        <button id="lv-add" class="ghost" type="button">إضافة</button>
      </p>
      <div class="scroll"><table>
        <thead><tr><th>الموظّف</th><th>من</th><th>إلى</th><th></th></tr></thead>
        <tbody id="lv-list"></tbody>
      </table></div>
      <p class="empty small" id="lv-empty" hidden>لا إجازات مسجَّلة لهذا الشهر.</p>

      <h4>قاسم ساعة العمل الإضافي</h4>
      <p class="small muted">أجرُ الساعة = الراتب ÷ 30 ÷ القاسم. وهو سياسةُ
        الموظّف (8 أو 10) لا يُستنتج من الملفّ: عمود «الساعات المقرّرة» يحمل
        قيمًا مختلفة في اليوم الواحد. ومن لا قاسم له لا تُحسب قيمةُ عمله
        الإضافيّ — وتُعلَن العلّة بدل أن يُخمَّن مبلغ.</p>
      <p class="row">
        <input id="dv-no" type="text" inputmode="numeric" placeholder="الرقم الوظيفي" aria-label="الرقم الوظيفي">
        <select id="dv-val" aria-label="القاسم"><option value="8">8 ساعات</option><option value="10">10 ساعات</option></select>
        <button id="dv-add" class="ghost" type="button">حفظ</button>
      </p>
      <div class="scroll"><table>
        <thead><tr><th>الموظّف</th><th>القاسم</th><th></th></tr></thead>
        <tbody id="dv-list"></tbody>
      </table></div>
      <p class="empty small" id="dv-empty" hidden>لا قواسم محدَّدة بعد.</p>
    </div>
  </details>

  <p class="row">
    <button id="run" type="button">تحليل الشهر</button>
    <button id="tgl" class="ghost" type="button">إظهار المُعالَجة</button>
    <button id="del" class="danger" type="button">حذف الشهر</button>
  </p>
  <p class="small muted" id="sum"></p>
  <p class="cov" id="cov" role="status" aria-live="polite"></p>
  <div class="scroll"><table>
    <thead><tr><th>الملاحظة</th><th>الموظّف</th><th>السابق</th><th>الحالي</th><th>الفرق</th><th>الحالة</th></tr></thead>
    <tbody id="fnd"></tbody>
  </table></div>
  <p class="empty" id="fempty" hidden></p>
</section>

<div id="load" class="note ok" hidden><span class="spin"></span><span id="loadtxt">جارٍ…</span></div>
<p class="note" id="m" role="alert" aria-live="polite"></p>`;

const SCRIPT = `
var API='/secure-audit/api',MAX=${MAX_UPLOAD_BYTES},OK=${JSON.stringify(FORMATS)};
var $=function(id){return document.getElementById(id)};
var t=$('t'),m=$('m'),load=$('load'),until=0,runId=null,statuses=[],showAll=false,busy=0,totalRules=0,analyzed=false;

function esc(s){var d=document.createElement('span');d.textContent=s==null?'':String(s);return d.innerHTML}
function show(el,on){el.hidden=!on}
function err(x){m.textContent=x||'';m.className='note '+(x?'err':'')}
function ok(x){m.textContent=x||'';m.className='note '+(x?'ok':'')}

/* عدّاد النداءات الجارية لا علمٌ ثنائيّ: نداءان متزامنان ينتهي أوّلهما
   فيرفع «جارٍ» عن الثاني — فيظنّ المستخدم أن كل شيء انتهى. */
function begin(text){busy++;$('loadtxt').textContent=text||'جارٍ…';show(load,true);document.body.setAttribute('aria-busy','true')}
function end(){busy=Math.max(0,busy-1);if(!busy){show(load,false);document.body.removeAttribute('aria-busy')}}

function pad(n){return (n<10?'0':'')+n}
function tick(){
  if(!until){t.textContent='—';return}
  var left=Math.max(0,until-Date.now());
  if(left<=0){location.reload();return}
  var s=Math.floor(left/1000);
  t.textContent='تنتهي الجلسة خلال '+pad(Math.floor(s/60))+':'+pad(s%60);
}

function api(path,opts){
  opts=opts||{};opts.credentials='same-origin';
  if(opts.body){opts.headers={'content-type':'application/json'};opts.body=JSON.stringify(opts.body)}
  return fetch(API+path,opts).then(function(r){
    if(r.status===401){location.reload();return Promise.reject(new Error('انتهت الجلسة'))}
    if(r.status===404)return Promise.reject(new Error('غير موجود'));
    return r.json().catch(function(){return null}).then(function(j){
      if(!j||!j.ok)return Promise.reject(new Error((j&&j.error)||'تعذّر إتمام العملية ('+r.status+')'));
      return j;
    });
  },function(){
    /* انقطاع شبكة لا ردّ خادم: يُقال كما هو بدل «تعذّر» غامضة. */
    return Promise.reject(new Error('تعذّر الاتّصال — تحقّق من الشبكة'));
  });
}
/* كل عملية تمرّ من هنا: تُعطّل الواجهة، وتُظهر الجارية، وتعرض الفشل. */
function act(text,fn){
  begin(text);err('');
  return fn().catch(function(e){err(e.message);throw e}).finally(function(){end()});
}
function view(name){
  show($('v-runs'),name==='runs');
  show($('v-run'),name==='run');
  $('ttl').textContent=name==='runs'?'الأشهر':'الشهر';
}

/* ── قائمة الأشهر ── */
function loadRuns(){
  return act('جارٍ تحميل الأشهر…',function(){
    return api('/runs').then(function(j){
      var b=$('runs');b.textContent='';
      (j.runs||[]).forEach(function(r){
        var f=r.findings||{},tr=document.createElement('tr');
        tr.className='clickable';tr.tabIndex=0;
        tr.innerHTML='<td>'+esc(r.period)+'</td>'+
          '<td><span class="pill">'+esc(runState(r.status))+'</span></td>'+
          '<td>'+r.filesPresent+' / '+r.filesExpected+'</td>'+
          '<td>'+(f.open||0)+'</td>'+
          '<td>'+(f.critical?'<span class="pill critical">'+f.critical+'</span>':'<span class="pill ok">0</span>')+'</td>';
        var go=function(){openRun(r.runId).catch(function(){})};
        tr.addEventListener('click',go);
        tr.addEventListener('keydown',function(e){if(e.key==='Enter')go()});
        b.appendChild(tr);
      });
      show($('empty'),!(j.runs&&j.runs.length));
      view('runs');
    });
  });
}

/* ── شهر واحد ── */
function slotHtml(s){
  var f=s.file;
  return '<div class="slot"><h3>'+esc(s.label)+
    (f?' <span class="pill ok">مرفوع</span>':' <span class="pill warn">ناقص</span>')+'</h3>'+
    (f?('<p class="small">'+esc(f.fileName)+' · '+Math.ceil(f.sizeBytes/1024)+' ك.ب · '+esc(f.format)+'</p>'):
        '<p class="small muted">لم يُرفع بعد — الصيغ المقبولة: '+OK.join(' · ')+'</p>')+
    '<p class="row"><input type="file" class="pick" data-kind="'+esc(s.kind)+
      '" accept=".pdf,.xlsx,.xls,.csv" aria-label="'+esc(s.label)+'">'+
    (f?('<button class="ghost dl" data-id="'+esc(f.fileId)+'" type="button">تنزيل</button>'+
        '<button class="danger rm" data-id="'+esc(f.fileId)+'" type="button">حذف</button>'):'')+
    '</p></div>';
}
function openRun(id){
  runId=id;
  return act('جارٍ تحميل الشهر…',function(){
    return api('/runs/'+id).then(function(j){
      statuses=j.statuses||[];
      totalRules=j.totalRules||0;
      analyzed=j.run.status==='analyzed'||j.run.status==='closed';
      $('prev').textContent=j.run.period+' · '+runState(j.run.status)+' · '+
        (j.previousExists?'المقارنة مع '+j.previousPeriod
          :'لا شهر سابق ('+j.previousPeriod+') — قواعد المقارنة لن تُفحص');
      $('slots').innerHTML=(j.slots||[]).map(slotHtml).join('');
      var s=j.findings||{};
      $('sum').textContent='مفتوحة '+(s.open||0)+' · حرجة '+(s.critical||0)+
        ' · تحتاج مراجعة '+(s.needsReview||0)+' · مُعالَجة '+(s.resolved||0);
      bindSlots();
      view('run');
      return loadSettings().then(loadFindings);
    });
  });
}
function bindSlots(){
  [].forEach.call(document.querySelectorAll('.pick'),function(el){
    el.addEventListener('change',function(){upload(el)});
  });
  [].forEach.call(document.querySelectorAll('.dl'),function(el){
    el.addEventListener('click',function(){location.href=API+'/files/'+el.dataset.id+'/download'});
  });
  [].forEach.call(document.querySelectorAll('.rm'),function(el){
    el.addEventListener('click',function(){
      if(!confirm('حذف الملفّ ومحو بايتاته نهائيًّا؟'))return;
      act('جارٍ الحذف…',function(){
        return api('/files/'+el.dataset.id,{method:'DELETE'}).then(function(){
          return openRun(runId).then(function(){ok('حُذف الملفّ.')});
        });
      }).catch(function(){});
    });
  });
}
function upload(el){
  var file=el.files&&el.files[0];if(!file)return;
  var dot=file.name.lastIndexOf('.'),ext=dot>0?file.name.slice(dot+1).toLowerCase():'';
  /* التحقّق قبل القراءة: رفعُ ملفٍّ سيُرفض ينتظر المستخدم بلا سبب. */
  if(OK.indexOf(ext)<0){err('صيغة غير مقبولة: '+(ext||'بلا امتداد')+'. المقبول: '+OK.join(' · '));el.value='';return}
  if(!file.size){err('الملفّ فارغ.');el.value='';return}
  if(file.size>MAX){err('الملفّ '+Math.ceil(file.size/1048576)+' م.ب — والحدّ '+(MAX/1048576)+' م.ب.');el.value='';return}

  var has=!!(el.closest('.slot').querySelector('.dl'));
  if(has&&!confirm('استبدال الملفّ الحالي؟ ستبقى نسخته السابقة في السجلّ.')){el.value='';return}

  act(has?'جارٍ الاستبدال…':'جارٍ الرفع…',function(){
    return new Promise(function(resolve,reject){
      var fr=new FileReader();
      fr.onload=function(){resolve(String(fr.result).split(',')[1]||'')};
      fr.onerror=function(){reject(new Error('تعذّرت قراءة الملفّ من جهازك'))};
      fr.readAsDataURL(file);
    }).then(function(b64){
      return api('/runs/'+runId+'/files',{method:'POST',body:{
        kind:el.dataset.kind,fileName:file.name,format:ext,data:b64,replace:has}});
    }).then(function(){
      return openRun(runId).then(function(){ok(has?'تمّ الاستبدال.':'تمّ الرفع.')});
    });
  }).catch(function(){el.value=''});
}

/* ── أربع حالاتٍ لا ثلاث ──
   والرابعة ⚪ ليست درجةً أدنى من «معلومة»: تلك نتيجةُ فحصٍ، وهذه **لا
   فحص**. ولذلك نصُّها ولونُها مختلفان، وتُقرأ من «rule» لا من «severity»
   — فالخطورة المخزَّنة تصف إلحاح المراجعة، لا نوع الحال. */
var SEV={critical:'حرج',warn:'تحذير',info:'معلومة'};
/* حالاتُ الشهر تُخزَّن بالإنجليزية وتُعرض بالعربية: «analyzed» و«draft»
   ليستا كلمتين يقرؤهما من يُغلق شهرًا. */
var RUNST={draft:'مسوّدة',ready:'مكتمل الملفّات',analyzed:'حُلِّل',closed:'مُغلَق'};
var runState=function(s){return RUNST[s]||s};
function sevPill(f){
  if(f.rule==='not_evaluable')return{cls:'na',txt:'لم يُقيَّم'};
  return{cls:f.severity,txt:SEV[f.severity]||f.severity};
}

/* شريط التغطية يُحسب من الملاحظات المخزَّنة لا من ردّ التحليل وحده:
   المستخدم يفتح الشهر بعد أيّام فيجب أن يرى النقص كما رآه أوّل مرّة. */
/* تمييزُ العدد بالعربية: الواحدُ والاثنان لهما صيغتاهما، ومن ثلاثة إلى
   عشرة جمعُ قلّة، ومن أحد عشر فصاعدًا مفردٌ منصوب. و«20 قواعد» خطأٌ يقرؤه
   المستخدم فيشكّ فيما يقرأ كلَّه. */
function countRules(n){
  if(n===1)return 'قاعدة واحدة لم يمكن تقييمها';
  if(n===2)return 'قاعدتان لم يمكن تقييمهما';
  if(n<=10)return n+' قواعد لم يمكن تقييمها';
  return n+' قاعدة لم يمكن تقييمها';
}
function coverage(list){
  var el=$('cov');
  if(!totalRules){el.textContent='';el.className='cov';return 0}
  /* العدد من «delta» وحده: خادمُ التحليل يقسّم القواعد على المصادر بلا
     تكرار، فالجمع دقيق. وقائمةُ المعرّفات في «currentValue» للعرض فقط —
     وهي قابلة للاقتطاع فلا يُحسب منها شيء. */
  var n=0;
  (list||[]).forEach(function(f){
    if(f.rule!=='not_evaluable'||f.resolvedAt)return;
    n+=Number(f.delta||0);
  });
  if(!n){el.className='cov';el.textContent='تم تقييم '+totalRules+' من '+totalRules+' قاعدة — التحليل كامل.';return 0}
  el.className='cov gap';
  el.textContent='تم تقييم '+(totalRules-n)+' من '+totalRules+' قاعدة — '+countRules(n)+
    ' لعدم توفر البيانات المطلوبة. وغياب المصدر ليس دليلًا على سلامة.';
  return n;
}

/* ── إعدادات الشهر ── */
function loadSettings(){
  return api('/runs/'+runId+'/settings').then(function(j){
    var lv=$('lv-list'); lv.textContent='';
    (j.leaves||[]).forEach(function(x){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>'+esc(x.empNo)+'</td><td>'+esc(x.startDate)+'</td><td>'+esc(x.endDate)+'</td>'+
        '<td><button class="ghost lv-del" data-id="'+esc(x.leaveId)+'" type="button">حذف</button></td>';
      lv.appendChild(tr);
    });
    show($('lv-empty'),!(j.leaves&&j.leaves.length));

    var dv=$('dv-list'); dv.textContent='';
    (j.divisors||[]).forEach(function(x){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>'+esc(x.empNo)+'</td><td>'+esc(x.overtimeDivisor)+' ساعات</td>'+
        '<td><button class="ghost dv-del" data-no="'+esc(x.empNo)+'" type="button">حذف</button></td>';
      dv.appendChild(tr);
    });
    show($('dv-empty'),!(j.divisors&&j.divisors.length));
    bindSettings();
  });
}
function bindSettings(){
  [].forEach.call(document.querySelectorAll('.lv-del'),function(el){
    el.addEventListener('click',function(){
      act('جارٍ الحذف…',function(){
        return api('/leaves/'+el.dataset.id,{method:'DELETE'}).then(function(){
          return loadSettings().then(function(){ok('حُذفت الإجازة.')});
        });
      }).catch(function(){});
    });
  });
  [].forEach.call(document.querySelectorAll('.dv-del'),function(el){
    el.addEventListener('click',function(){
      act('جارٍ الحذف…',function(){
        return api('/settings/divisors/'+encodeURIComponent(el.dataset.no),{method:'DELETE'}).then(function(){
          return loadSettings().then(function(){ok('حُذف القاسم.')});
        });
      }).catch(function(){});
    });
  });
}

/* ── الملاحظات ── */
function loadFindings(){
  return api('/runs/'+runId+'/findings'+(showAll?'/all':'')).then(function(j){
    var b=$('fnd');b.textContent='';
    (j.findings||[]).forEach(function(f){
      var tr=document.createElement('tr');
      var opts=statuses.map(function(s){
        return '<option value="'+esc(s.value)+'"'+(s.value===f.status?' selected':'')+'>'+esc(s.label)+'</option>';
      }).join('');
      var sv=sevPill(f);
      if(sv.cls==='na')tr.className='na';
      tr.innerHTML='<td>'+
          '<span class="pill '+esc(sv.cls)+'">'+esc(sv.txt)+'</span> '+esc(f.title)+
          (f.resolvedAt?' <span class="pill ok">عولجت</span>':'')+
          '<div class="small muted">'+esc(f.description||'')+'</div>'+
          '<textarea class="nt" data-id="'+esc(f.findingId)+'" rows="2" '+
            'placeholder="ملاحظتك">'+esc(f.userNote||'')+'</textarea></td>'+
        '<td>'+esc(f.employeeName||'')+'<div class="small muted">'+esc(f.employeeRef||'')+'</div></td>'+
        '<td>'+esc(f.previousValue||'—')+'</td><td>'+esc(f.currentValue||'—')+'</td>'+
        '<td>'+(f.delta==null?'—':esc(f.delta))+'</td>'+
        '<td><select class="st" data-id="'+esc(f.findingId)+'">'+opts+'</select></td>';
      b.appendChild(tr);
    });
    var none=!(j.findings&&j.findings.length);
    var gaps=coverage(j.findings);
    /* «ارفع الملفّات ثمّ شغّل التحليل» تُقال لمن رفع وحلّل بالفعل فتُشكّكه
       في نتيجته. والفراغ بعد تحليلٍ تامّ **نتيجةٌ** لا غياب نتيجة: أن
       يُفحص شهرٌ كاملًا فلا يُوجد فيه شيء خبرٌ يستحقّ أن يُقال بوضوح. */
    var done=analyzed&&!gaps;
    $('fempty').textContent=showAll
      ?(done?'لا ملاحظات في هذا الشهر — لم يُعثر على شيء.':'لا ملاحظات في هذا الشهر بعد.')
      :done?'اكتمل الفحص ولم يُعثر على ملاحظة واحدة في هذا الشهر.'
      :analyzed?'لا ملاحظات مفتوحة — راجع شريط التغطية أعلاه، فبعض القواعد لم تُفحص.'
      :'لم يُشغَّل التحليل بعد. ارفع الملفّات ثمّ اضغط «تحليل الشهر».';
    show($('fempty'),none);
    bindFindings();
  });
}
function bindFindings(){
  [].forEach.call(document.querySelectorAll('.st'),function(el){
    el.addEventListener('change',function(){
      var was=el.dataset.was||'';
      act('جارٍ الحفظ…',function(){
        return api('/findings/'+el.dataset.id,{method:'PATCH',body:{status:el.value}})
          .then(function(){el.dataset.was=el.value;ok('حُفظت الحالة.')});
      }).catch(function(){if(was)el.value=was});
    });
    el.dataset.was=el.value;
  });
  [].forEach.call(document.querySelectorAll('.nt'),function(el){
    el.addEventListener('change',function(){
      act('جارٍ الحفظ…',function(){
        return api('/findings/'+el.dataset.id,{method:'PATCH',body:{userNote:el.value}})
          .then(function(j){
            /* الخادم قد يُقنّع أو يقتطع — فيُعرض ما حُفظ فعلًا لا ما كُتب. */
            if(j.finding&&j.finding.userNote!=null)el.value=j.finding.userNote;
            ok('حُفظت الملاحظة.');
          });
      }).catch(function(){});
    });
  });
}

/* ── الأزرار ── */
$('add').addEventListener('click',function(){
  var v=$('p').value;
  if(!v){err('اختر شهرًا أوّلًا.');$('p').focus();return}
  if(!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(v)){err('صيغة الشهر يجب أن تكون YYYY-MM.');return}
  act('جارٍ إنشاء الشهر…',function(){
    return api('/runs',{method:'POST',body:{period:v}}).then(function(j){
      return openRun(j.run.runId).then(function(){ok('أُنشئ الشهر '+v+'.')});
    });
  }).catch(function(){});
});
$('back').addEventListener('click',function(){runId=null;showAll=false;err('');loadRuns().catch(function(){})});
$('tgl').addEventListener('click',function(){
  showAll=!showAll;
  $('tgl').textContent=showAll?'إظهار المفتوحة فقط':'إظهار المُعالَجة';
  act('جارٍ التحديث…',loadFindings).catch(function(){});
});
$('lv-add').addEventListener('click',function(){
  var no=$('lv-no').value.trim(),from=$('lv-from').value,to=$('lv-to').value;
  if(!no||!from||!to){err('أدخل الرقم الوظيفي وتاريخَي الإجازة.');return}
  /* الفحص هنا **وفي القاعدة**: فترةٌ مقلوبة تُسكت غيابًا لا تفسّره. */
  if(to<from){err('نهاية الإجازة قبل بدايتها.');return}
  act('جارٍ الحفظ…',function(){
    return api('/runs/'+runId+'/leaves',{method:'POST',body:{empNo:no,startDate:from,endDate:to}})
      .then(function(){$('lv-no').value='';return loadSettings().then(function(){ok('أُضيفت الإجازة. أعد التحليل ليُحتسب أثرها.')})});
  }).catch(function(){});
});
$('dv-add').addEventListener('click',function(){
  var no=$('dv-no').value.trim();
  if(!no){err('أدخل الرقم الوظيفي.');return}
  act('جارٍ الحفظ…',function(){
    return api('/settings/divisors',{method:'PUT',body:{empNo:no,overtimeDivisor:Number($('dv-val').value)}})
      .then(function(){$('dv-no').value='';return loadSettings().then(function(){ok('حُفظ القاسم. أعد التحليل ليُحتسب.')})});
  }).catch(function(){});
});
$('run').addEventListener('click',function(){
  act('جارٍ التحليل…',function(){
    return api('/runs/'+runId+'/analyze',{method:'POST'}).then(function(j){
      var a=j.analysis||{};
      return openRun(runId).then(function(){
        /* عددُ ما لم يُقيَّم يُقال هنا لا في الملاحظات وحدها: من يقرأ
           «صفر ملاحظات» يستنتج سلامةً لم تُفحص. */
        var stalled=(a.rulesNotEvaluable||[]).length;
        ok('انتهى التحليل: '+a.created+' جديدة، '+a.updated+' محدَّثة، '+a.resolved+' عولجت'+
          ' · '+a.rulesApplied+' قاعدة فُحصت'+
          (stalled?'، و'+stalled+' لم تُقيَّم لنقص مصدر':'')+
          (a.previousPeriod?' · قورن مع '+a.previousPeriod:' · لا شهر سابق للمقارنة')+'.');
      });
    });
  }).catch(function(){});
});
$('del').addEventListener('click',function(){
  if(!confirm('حذف الشهر وكل ملفّاته وملاحظاته نهائيًّا؟'))return;
  act('جارٍ حذف الشهر…',function(){
    return api('/runs/'+runId,{method:'DELETE'}).then(function(){
      runId=null;
      return loadRuns().then(function(){ok('حُذف الشهر.')});
    });
  }).catch(function(){});
});
$('lk').addEventListener('click',function(){
  $('lk').disabled=true;
  fetch('/secure-audit/api/gate/lock',{method:'POST',credentials:'same-origin'})
    .then(function(){location.reload()})
    .catch(function(){err('تعذّر إتمام العملية.');$('lk').disabled=false});
});

function status(){
  fetch('/secure-audit/api/gate/status',{credentials:'same-origin'})
    .then(function(r){return r.json().catch(function(){return {}})})
    .then(function(j){
      if(!j||!j.ok||!j.unlocked){location.reload();return}
      until=j.expiresAt||0; tick();
    }).catch(function(){});
}
status(); setInterval(tick,1000); setInterval(status,60000);
loadRuns().catch(function(){});`;

module.exports = (nonce) => page({ nonce, title: "القسم", body: BODY, script: SCRIPT, wide: true });
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports.FORMATS = FORMATS;
