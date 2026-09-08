/* الصفحة بعد الفتح. فارغة عمدًا في هذه المرحلة: لا أشهر، ولا رفع ملفات،
   ولا أي بيان — البوابة وحدها هي نطاق المرحلة. */
const { page } = require("./layout");

const BODY = `
<h1>القسم مفتوح</h1>
<p class="meta">تنتهي الجلسة خلال <span id="t">—</span></p>
<button id="lk" class="lock" type="button">قفل القسم</button>
<p class="msg" id="m" role="alert" aria-live="polite"></p>`;

/* العدّاد يُحسب من expiresAt القادم في الردّ — لا من تخزين محلّي، ولا من
   أي قيمة يحملها العميل بين الجلسات. */
const SCRIPT = `
var t=document.getElementById('t'),lk=document.getElementById('lk'),m=document.getElementById('m'),until=0;
function pad(n){return (n<10?'0':'')+n}
function tick(){
  var left=Math.max(0,until-Date.now());
  if(!until){t.textContent='—';return}
  if(left<=0){location.reload();return}
  var s=Math.floor(left/1000);
  t.textContent=pad(Math.floor(s/60))+':'+pad(s%60);
}
function status(){
  fetch('/secure-audit/api/gate/status',{credentials:'same-origin'})
    .then(function(r){return r.json().catch(function(){return {}})})
    .then(function(j){
      if(!j||!j.ok||!j.unlocked){location.reload();return}
      until=j.expiresAt||0; tick();
    }).catch(function(){});
}
lk.addEventListener('click',function(){
  lk.disabled=true;
  fetch('/secure-audit/api/gate/lock',{method:'POST',credentials:'same-origin'})
    .then(function(){location.reload()})
    .catch(function(){m.textContent='تعذّر إتمام العملية.';lk.disabled=false});
});
status(); setInterval(tick,1000);`;

module.exports = (nonce) => page({ nonce, title: "القسم", body: BODY, script: SCRIPT });
