/* الشاشة بعد فتح البوابة: الأشهر، وملفّات الشهر، وملاحظاته.
   =========================================================================
   صفحةٌ واحدة بلا إطار عمل ولا اعتماد: كل ما تفعله هو نداءُ `/secure-audit/api`
   ورسمُ ما يعود. والحالة كلّها في الخادم — لا تخزين محلّيّ، ولا شيء يبقى في
   المتصفّح بعد القفل.

   ولا اسم للقسم في أي نصّ ظاهر خارج ما يراه صاحبه بعد الفتح. */

const { page } = require("./layout");

const BODY = `
<div class="bar">
  <h1 id="ttl">الأشهر</h1>
  <div class="row">
    <span class="small" id="t">—</span>
    <button id="lk" class="lock" type="button">قفل القسم</button>
  </div>
</div>

<section id="v-runs">
  <div class="row">
    <input id="p" type="month" aria-label="الشهر">
    <button id="add" type="button">إضافة شهر</button>
  </div>
  <table>
    <thead><tr><th>الشهر</th><th>الحالة</th><th>الملفّات</th><th>ملاحظات</th><th>حرجة</th></tr></thead>
    <tbody id="runs"></tbody>
  </table>
  <p class="small muted" id="empty"></p>
</section>

<section id="v-run" class="hidden">
  <p class="row"><button id="back" class="ghost" type="button">رجوع</button>
    <span class="small muted" id="prev"></span></p>
  <div id="slots"></div>
  <p class="row">
    <button id="run" type="button">تحليل الشهر</button>
    <button id="del" class="danger" type="button">حذف الشهر</button>
    <span class="small muted" id="sum"></span>
  </p>
  <table>
    <thead><tr><th>الملاحظة</th><th>الموظّف</th><th>السابق</th><th>الحالي</th><th>الفرق</th><th>الحالة</th></tr></thead>
    <tbody id="fnd"></tbody>
  </table>
  <p class="small muted" id="fnote"></p>
</section>

<p class="msg" id="m" role="alert" aria-live="polite"></p>`;

const SCRIPT = `
var API='/secure-audit/api',$=function(id){return document.getElementById(id)};
var t=$('t'),m=$('m'),until=0,runId=null,statuses=[],kinds=[];

function esc(s){var d=document.createElement('span');d.textContent=s==null?'':String(s);return d.innerHTML}
function say(x){m.textContent=x||''}
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
    if(r.status===401){location.reload();return Promise.reject(new Error('locked'))}
    return r.json().catch(function(){return {ok:false,error:'ردٌّ غير مفهوم'}}).then(function(j){
      if(!j||!j.ok)return Promise.reject(new Error((j&&j.error)||'تعذّر إتمام العملية'));
      return j;
    });
  });
}
function show(view){
  $('v-runs').className=view==='runs'?'':'hidden';
  $('v-run').className=view==='run'?'':'hidden';
  $('ttl').textContent=view==='runs'?'الأشهر':'الشهر';
}

/* ── قائمة الأشهر ── */
function loadRuns(){
  return api('/runs').then(function(j){
    kinds=j.kinds||[];
    var b=$('runs');b.textContent='';
    (j.runs||[]).forEach(function(r){
      var f=r.findings||{},tr=document.createElement('tr');
      tr.className='clickable';
      tr.innerHTML='<td>'+esc(r.period)+'</td>'+
        '<td><span class="pill">'+esc(r.status)+'</span></td>'+
        '<td>'+r.filesPresent+' / '+r.filesExpected+'</td>'+
        '<td>'+(f.open||0)+'</td>'+
        '<td>'+(f.critical?'<span class="pill critical">'+f.critical+'</span>':'<span class="pill ok">0</span>')+'</td>';
      tr.addEventListener('click',function(){openRun(r.runId)});
      b.appendChild(tr);
    });
    $('empty').textContent=(j.runs&&j.runs.length)?'':'لا أشهر بعد. أضف شهرًا للبدء.';
    show('runs');
  });
}

/* ── شهر واحد ── */
function slotHtml(s){
  var f=s.file;
  return '<div class="slot"><h3>'+esc(s.label)+'</h3>'+
    (f?('<p class="small">'+esc(f.fileName)+' · '+f.sizeBytes+' بايت · '+esc(f.format)+'</p>'):
        '<p class="small muted">لم يُرفع بعد</p>')+
    '<p class="row"><input type="file" data-kind="'+esc(s.kind)+'" class="pick">'+
    (f?('<button class="ghost dl" data-id="'+esc(f.fileId)+'" type="button">تنزيل</button>'+
        '<button class="danger rm" data-id="'+esc(f.fileId)+'" type="button">حذف</button>'):'')+
    '</p></div>';
}
function openRun(id){
  runId=id;
  return api('/runs/'+id).then(function(j){
    statuses=j.statuses||[];
    $('prev').textContent='المقارنة مع '+j.previousPeriod+' · '+j.run.period+' · '+j.run.status;
    $('slots').innerHTML=(j.slots||[]).map(slotHtml).join('');
    var s=j.findings||{};
    $('sum').textContent='ملاحظات مفتوحة '+(s.open||0)+' · حرجة '+(s.critical||0)+' · تحتاج مراجعة '+(s.needsReview||0);
    bindSlots();
    show('run');
    return loadFindings();
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
      if(!confirm('حذف الملفّ نهائيًّا؟'))return;
      api('/files/'+el.dataset.id,{method:'DELETE'}).then(function(){say('حُذف.');openRun(runId)}).catch(function(e){say(e.message)});
    });
  });
}
function upload(el){
  var file=el.files&&el.files[0];if(!file)return;
  var dot=file.name.lastIndexOf('.'),ext=dot>0?file.name.slice(dot+1).toLowerCase():'';
  if(['pdf','xlsx','xls','csv'].indexOf(ext)<0){say('صيغة غير مسموحة: '+ext);el.value='';return}
  say('جارٍ الرفع…');
  var fr=new FileReader();
  fr.onload=function(){
    var b64=String(fr.result).split(',')[1]||'';
    var has=!!(el.closest('.slot').querySelector('.dl'));
    api('/runs/'+runId+'/files',{method:'POST',body:{
      kind:el.dataset.kind,fileName:file.name,format:ext,data:b64,replace:has}})
      .then(function(){say('تمّ الرفع.');openRun(runId)})
      .catch(function(e){say(e.message)});
  };
  fr.onerror=function(){say('تعذّرت قراءة الملفّ.')};
  fr.readAsDataURL(file);
}

/* ── الملاحظات ── */
function loadFindings(){
  return api('/runs/'+runId+'/findings').then(function(j){
    var b=$('fnd');b.textContent='';
    (j.findings||[]).forEach(function(f){
      var tr=document.createElement('tr');
      var opts=statuses.map(function(s){
        return '<option value="'+esc(s.value)+'"'+(s.value===f.status?' selected':'')+'>'+esc(s.label)+'</option>';
      }).join('');
      tr.innerHTML='<td><span class="pill '+esc(f.severity)+'">'+esc(f.severity)+'</span> '+esc(f.title)+
          '<div class="small muted">'+esc(f.description||'')+'</div>'+
          '<textarea class="nt" data-id="'+esc(f.findingId)+'" placeholder="ملاحظتك">'+esc(f.userNote||'')+'</textarea></td>'+
        '<td>'+esc(f.employeeName||'')+'<div class="small muted">'+esc(f.employeeRef||'')+'</div></td>'+
        '<td>'+esc(f.previousValue||'')+'</td><td>'+esc(f.currentValue||'')+'</td>'+
        '<td>'+(f.delta==null?'':esc(f.delta))+'</td>'+
        '<td><select class="st" data-id="'+esc(f.findingId)+'">'+opts+'</select></td>';
      b.appendChild(tr);
    });
    $('fnote').textContent=(j.findings&&j.findings.length)?'':'لا ملاحظات مفتوحة. شغّل التحليل بعد رفع الملفّات.';
    bindFindings();
  });
}
function bindFindings(){
  [].forEach.call(document.querySelectorAll('.st'),function(el){
    el.addEventListener('change',function(){
      api('/findings/'+el.dataset.id,{method:'PATCH',body:{status:el.value}})
        .then(function(){say('حُفظت الحالة.')}).catch(function(e){say(e.message)});
    });
  });
  [].forEach.call(document.querySelectorAll('.nt'),function(el){
    el.addEventListener('change',function(){
      api('/findings/'+el.dataset.id,{method:'PATCH',body:{userNote:el.value}})
        .then(function(){say('حُفظت الملاحظة.')}).catch(function(e){say(e.message)});
    });
  });
}

/* ── الأزرار ── */
$('add').addEventListener('click',function(){
  var v=$('p').value;
  if(!v){say('اختر شهرًا.');return}
  api('/runs',{method:'POST',body:{period:v}})
    .then(function(j){say('');return openRun(j.run.runId)}).catch(function(e){say(e.message)});
});
$('back').addEventListener('click',function(){runId=null;say('');loadRuns()});
$('run').addEventListener('click',function(){
  say('جارٍ التحليل…');
  api('/runs/'+runId+'/analyze',{method:'POST'}).then(function(j){
    var a=j.analysis||{};
    say('انتهى: '+a.created+' جديدة، '+a.updated+' محدَّثة، '+a.resolved+' عولجت.');
    return openRun(runId);
  }).catch(function(e){say(e.message)});
});
$('del').addEventListener('click',function(){
  if(!confirm('حذف الشهر وكل ملفّاته نهائيًّا؟'))return;
  api('/runs/'+runId,{method:'DELETE'})
    .then(function(){runId=null;say('حُذف الشهر.');loadRuns()}).catch(function(e){say(e.message)});
});
$('lk').addEventListener('click',function(){
  $('lk').disabled=true;
  fetch('/secure-audit/api/gate/lock',{method:'POST',credentials:'same-origin'})
    .then(function(){location.reload()})
    .catch(function(){say('تعذّر إتمام العملية.');$('lk').disabled=false});
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
loadRuns().catch(function(e){say(e.message)});`;

module.exports = (nonce) => page({ nonce, title: "القسم", body: BODY, script: SCRIPT, wide: true });
