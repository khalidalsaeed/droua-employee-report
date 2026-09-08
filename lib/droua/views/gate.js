/* شاشة كلمة المرور. لا تحمل اسم القسم ولا أي وصف لمحتواه. */
const { page } = require("./layout");

/* الإرشاد يظهر **دائمًا** لا عند القفل: لو ظهر عند القفل وحده لصار فرقًا
   في الاستجابة يكشف سبب الفشل — وهو ما يمنعه توحيد الردّ. */
const BODY = `
<h1>أدخل كلمة المرور</h1>
<form id="f" autocomplete="off">
  <label for="p">كلمة المرور</label>
  <input id="p" name="p" type="password" autocomplete="current-password" required autofocus>
  <button id="b" type="submit">فتح</button>
  <p class="msg" id="m" role="alert" aria-live="polite"></p>
  <p class="hint">إن تكرّر الفشل فانتظر قليلًا ثم أعد المحاولة.</p>
</form>`;

const SCRIPT = `
var f=document.getElementById('f'),p=document.getElementById('p'),
    b=document.getElementById('b'),m=document.getElementById('m');
f.addEventListener('submit',function(e){
  e.preventDefault(); b.disabled=true; m.textContent='';
  fetch('/secure-audit/api/gate/unlock',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'same-origin',
    /* لا تُخزَّن القيمة في أي متغيّر يعيش بعد الطلب، ولا في أي تخزين
       محلّي. الحقل يُفرَّغ فور الإرسال. */
    body:JSON.stringify({password:p.value})
  }).then(function(r){return r.json().catch(function(){return {}})})
   .then(function(j){
      if(j&&j.ok){location.reload();return}
      m.textContent='تعذّر فتح القسم.'; b.disabled=false; p.value=''; p.focus();
   }).catch(function(){
      m.textContent='تعذّر فتح القسم.'; b.disabled=false; p.value='';
   });
});`;

module.exports = (nonce) => page({ nonce, title: "الدخول", body: BODY, script: SCRIPT });
