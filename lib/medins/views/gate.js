/* شاشة كلمة مرور البوابة. لا اسم للوحدة ولا وصف لمحتواها.
   الإرشاد يظهر دائمًا لا عند القفل وحده — وإلّا صار فرقًا يكشف سبب الفشل. */
const { page } = require("./layout");

const BODY = `
<main class="card">
<h1>أدخل كلمة المرور</h1>
<form id="f" autocomplete="off">
  <label for="p">كلمة المرور</label>
  <input id="p" name="p" type="password" autocomplete="current-password" required autofocus>
  <button id="b" class="full" type="submit">فتح</button>
  <p class="msg" id="m" role="alert" aria-live="polite"></p>
  <p class="hint">إن تكرّر الفشل فانتظر قليلًا ثم أعد المحاولة.</p>
</form>
</main>`;

function gateClient() {
  var f = document.getElementById("f"), p = document.getElementById("p"),
    b = document.getElementById("b"), m = document.getElementById("m");
  f.addEventListener("submit", function (e) {
    e.preventDefault(); b.disabled = true; m.textContent = "";
    fetch(location.pathname.replace(/\/$/, "") + "/api/gate/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      /* القيمة لا تُخزَّن في متغيّر يعيش بعد الطلب، ولا في تخزين محلّي. */
      body: JSON.stringify({ password: p.value })
    }).then(function (r) {
      /* 401 = جلسة المنصّة انتهت، لا كلمة مرورٍ خاطئة. */
      if (r.status === 401) { m.textContent = "انتهت جلستك. يُعاد توجيهك لتسجيل الدخول…"; location.reload(); return null; }
      return r.json().catch(function () { return {}; });
    }).then(function (j) {
      if (j === null) return;
      if (j && j.ok) { location.reload(); return; }
      m.textContent = "تعذّر فتح القسم."; b.disabled = false; p.value = ""; p.focus();
    }).catch(function () {
      m.textContent = "تعذّر فتح القسم."; b.disabled = false; p.value = "";
    });
  });
}

module.exports = (nonce) => page({ nonce, title: "الدخول", body: BODY, script: `(${gateClient.toString()})();`, center: true });
module.exports.gateClient = gateClient;
