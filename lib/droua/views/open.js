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
  <p class="row">
    <button id="run" type="button">تحليل الشهر</button>
    <button id="tgl" class="ghost" type="button">إظهار المُعالَجة</button>
    <button id="del" class="danger" type="button">حذف الشهر</button>
  </p>
  <p class="small muted" id="sum"></p>
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
var t=$('t'),m=$('m'),load=$('load'),until=0,runId=null,statuses=[],showAll=false,busy=0;

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
          '<td><span class="pill">'+esc(r.status)+'</span></td>'+
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
      $('prev').textContent=j.run.period+' · '+j.run.status+' · المقارنة مع '+j.previousPeriod;
      $('slots').innerHTML=(j.slots||[]).map(slotHtml).join('');
      var s=j.findings||{};
      $('sum').textContent='مفتوحة '+(s.open||0)+' · حرجة '+(s.critical||0)+
        ' · تحتاج مراجعة '+(s.needsReview||0)+' · مُعالَجة '+(s.resolved||0);
      bindSlots();
      view('run');
      return loadFindings();
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

/* ── الملاحظات ── */
function loadFindings(){
  return api('/runs/'+runId+'/findings'+(showAll?'/all':'')).then(function(j){
    var b=$('fnd');b.textContent='';
    (j.findings||[]).forEach(function(f){
      var tr=document.createElement('tr');
      var opts=statuses.map(function(s){
        return '<option value="'+esc(s.value)+'"'+(s.value===f.status?' selected':'')+'>'+esc(s.label)+'</option>';
      }).join('');
      tr.innerHTML='<td>'+
          '<span class="pill '+esc(f.severity)+'">'+esc(f.severity)+'</span> '+esc(f.title)+
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
    $('fempty').textContent=showAll?'لا ملاحظات في هذا الشهر بعد.'
      :'لا ملاحظات مفتوحة. ارفع الملفّات ثمّ شغّل التحليل.';
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
$('run').addEventListener('click',function(){
  act('جارٍ التحليل…',function(){
    return api('/runs/'+runId+'/analyze',{method:'POST'}).then(function(j){
      var a=j.analysis||{};
      return openRun(runId).then(function(){
        ok('انتهى التحليل: '+a.created+' جديدة، '+a.updated+' محدَّثة، '+a.resolved+' عولجت'+
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
