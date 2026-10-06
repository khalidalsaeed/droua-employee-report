/* ─── شيفرة صفحة الوحدة (تعمل في المتصفّح) ─────────────────────────────
   =========================================================================
   دالّةٌ واحدة تُضمَّن في الصفحة نصًّا بـ`toString()` تحت nonce. لا تشير إلى
   أي شيء خارجها، ولا تخزّن شيئًا في localStorage، ولا تبني HTML من نصٍّ
   قادمٍ من الخادم إلا عبر esc().

   الواجهة تُخفي أدوات التعديل عن المشاهد تيسيرًا لا حمايةً: الخادم يفرض
   الصلاحية في كل مسار. */

function appClient() {
  "use strict";
  var ROOT = document.getElementById("app");
  var ROLE = document.body.getAttribute("data-role");
  var CAN_EDIT = ROLE === "editor";
  var BASE = location.pathname.replace(/\/$/, "") + "/api/";

  var STATUS_LABELS = { draft: "مسودّة", in_review: "قيد المراجعة", approved: "معتمد", archived: "مؤرشف" };
  var STATUS_PILL = { draft: "na", in_review: "warn", approved: "ok", archived: "na" };
  var NEXT = { draft: ["in_review", "archived"], in_review: ["draft", "approved", "archived"], approved: ["in_review", "archived"], archived: ["draft"] };
  var ACTION_LABELS = { in_review: "إرسال للمراجعة", draft: "إعادة إلى مسودّة", approved: "اعتماد", archived: "أرشفة" };
  var VAT = { included: "شامل الضريبة", excluded: "غير شامل الضريبة", unknown: "غير معروف" };
  var VSTATUS = { known: "معروف", unknown: "غير معروف", not_applicable: "لا ينطبق" };
  var TERM_KINDS = { exclusion: "استثناء", condition: "شرط خاص", extra: "ميزة إضافية" };
  var FILE_KINDS = { quote: "عرض السعر", benefits: "جدول المنافع", policy: "الوثيقة", other: "أخرى" };
  var CATEGORY_LABELS = {
    limits: "الحدود", inpatient: "التنويم", outpatient: "العيادات الخارجية", cost_sharing: "التحمّل",
    emergency: "الطوارئ", dental: "الأسنان", optical: "النظارات", maternity: "الحمل والولادة",
    chronic: "الأمراض المزمنة", pharmacy: "الأدوية", therapy: "العلاج الطبيعي", mental_health: "العلاج النفسي",
    evacuation: "الإخلاء الطبي", network: "الشبكة", other: "أخرى"
  };
  var TYPE_LABELS = { amount: "مبلغ", percent: "نسبة", boolean: "نعم/لا", count: "عدد", text: "نص" };
  var PART_SIZE = 2.5 * 1024 * 1024;

  var state = { tab: "offers", offerId: null, catalog: null, insurers: null };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(v) { return v == null ? '<span class="unknown">غير معروف</span>' : Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
  function num(v) { return v == null ? '<span class="unknown">غير معروف</span>' : esc(v); }
  function when(v) { return v ? esc(new Date(v).toLocaleString("en-GB")) : "—"; }
  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value : undefined; }
  function blankToNull(v) { return v === undefined || v === null || String(v).trim() === "" ? null : v; }
  function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

  /* ─── النداء ─── */
  function api(method, path, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(BASE + path, opts).then(function (r) {
      if (r.status === 401) { location.reload(); return new Promise(function () {}); }
      return r.json().catch(function () { return { ok: false, error: "ردٌّ غير متوقَّع" }; }).then(function (j) {
        if (!r.ok || !j.ok) { var e = new Error((j && j.error) || "تعذّر تنفيذ الطلب"); e.status = r.status; e.data = j; throw e; }
        return j;
      });
    });
  }
  function note(id, text, ok) { var n = el(id); if (!n) return; n.className = "note " + (ok ? "ok" : "err"); n.textContent = text || ""; }
  function guard(id, p) { return p.catch(function (e) { note(id, e.message); throw e; }); }

  /* ─── الهيكل ─── */
  function shell() {
    ROOT.innerHTML =
      '<div class="top"><div class="tabs" role="tablist">' +
      '<button role="tab" data-tab="offers">العروض</button>' +
      '<button role="tab" data-tab="settings">الإعدادات</button></div>' +
      '<div class="row"><span class="small">' + (CAN_EDIT ? "محرّر" : "مشاهد") + '</span>' +
      '<button class="ghost" id="lock">قفل</button></div></div><div id="view"></div>';
    ROOT.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { state.tab = b.getAttribute("data-tab"); state.offerId = null; route(); });
    });
    el("lock").addEventListener("click", function () {
      api("POST", "gate/lock", {}).finally(function () { location.reload(); });
    });
  }
  function route() {
    ROOT.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === state.tab)); });
    if (state.tab === "settings") return renderSettings();
    if (state.offerId) return renderOffer(state.offerId);
    return renderOffers();
  }
  function loadCatalog(force) {
    if (state.catalog && !force) return Promise.resolve(state.catalog);
    return api("GET", "catalog").then(function (j) { state.catalog = j.catalog; return j.catalog; });
  }
  function loadInsurers(force) {
    if (state.insurers && !force) return Promise.resolve(state.insurers);
    return api("GET", "insurers").then(function (j) { state.insurers = j.insurers; return j.insurers; });
  }

  /* ─── العروض ─── */
  function renderOffers() {
    var v = el("view");
    v.innerHTML = '<div class="card"><div class="top"><h2>العروض</h2><div class="row">' +
      '<label class="small"><input type="checkbox" id="arch" class="auto"> إظهار المؤرشف</label>' +
      (CAN_EDIT ? '<button id="newOffer">عرض جديد</button>' : "") + '</div></div>' +
      '<div id="newForm" class="section hidden"></div><div id="list" class="scroll"><p class="small">جارٍ التحميل…</p></div>' +
      '<p class="note" id="offersNote"></p></div>';
    el("arch").addEventListener("change", loadList);
    if (CAN_EDIT) el("newOffer").addEventListener("click", showNewOffer);
    loadList();
  }
  function loadList() {
    guard("offersNote", api("GET", "offers" + (el("arch").checked ? "?archived=1" : ""))).then(function (j) {
      if (!el("list")) return;
      if (!j.offers.length) { el("list").innerHTML = '<div class="empty">لا عروض بعد.' + (CAN_EDIT ? " أضف شركة من الإعدادات ثم أنشئ عرضًا." : "") + "</div>"; return; }
      el("list").innerHTML = "<table><thead><tr><th>الشركة</th><th>العرض</th><th class=num>الموظفون</th>" +
        "<th class=num>الإجمالي</th><th class=num>للموظف</th><th>الضريبة</th><th class=num>الفئات</th><th class=num>الملفّات</th>" +
        "<th class=num>قيم معروفة</th><th>الحالة</th></tr></thead><tbody>" +
        j.offers.map(function (o) {
          return '<tr class="click" data-id="' + esc(o.id) + '"><td>' + esc(o.insurerName) + "</td><td>" + esc(o.title) +
            "</td><td class=num>" + num(o.headcount) + "</td><td class=num>" + money(o.totalPremium) +
            "</td><td class=num>" + money(o.premiumPerHead) + "</td><td>" + esc(VAT[o.vatStatus]) +
            "</td><td class=num>" + o.counts.classes + "</td><td class=num>" + o.counts.files +
            "</td><td class=num>" + o.counts.knownValues + " / " + o.counts.recordedValues +
            '</td><td><span class="pill ' + STATUS_PILL[o.status] + '">' + esc(STATUS_LABELS[o.status]) + "</span></td></tr>";
        }).join("") + "</tbody></table>";
      el("list").querySelectorAll("tr[data-id]").forEach(function (tr) {
        tr.addEventListener("click", function () { state.offerId = tr.getAttribute("data-id"); route(); });
      });
    });
  }
  function offerFields(o) {
    o = o || {};
    function inp(id, label, value, type, extra) {
      return '<div><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + (type || "text") + '" value="' +
        esc(value == null ? "" : value) + '"' + (extra || "") + (CAN_EDIT ? "" : " disabled") + "></div>";
    }
    return '<div class="grid">' +
      inp("f_title", "اسم العرض *", o.title) + inp("f_reference", "رقم العرض", o.reference) +
      inp("f_submittedOn", "تاريخ التقديم", o.submittedOn, "date") + inp("f_validUntil", "صالح حتى", o.validUntil, "date") +
      inp("f_policyStart", "بداية الوثيقة", o.policyStart, "date") +
      inp("f_policyMonths", "المدة (أشهر)", o.policyMonths, "number", ' min="1" max="36"') +
      inp("f_headcount", "عدد الموظفين", o.headcount, "number", ' min="1"') +
      inp("f_dependentsCount", "عدد التابعين", o.dependentsCount, "number", ' min="0"') +
      inp("f_totalPremium", "إجمالي السعر (ريال)", o.totalPremium, "text", ' inputmode="decimal"') +
      '<div><label for="f_vatStatus">الضريبة</label><select id="f_vatStatus"' + (CAN_EDIT ? "" : " disabled") + ">" +
      Object.keys(VAT).map(function (k) { return '<option value="' + k + '"' + ((o.vatStatus || "unknown") === k ? " selected" : "") + ">" + VAT[k] + "</option>"; }).join("") +
      "</select></div></div>" +
      '<label for="f_notes">ملاحظات</label><textarea id="f_notes"' + (CAN_EDIT ? "" : " disabled") + ">" + esc(o.notes || "") + "</textarea>" +
      '<p class="small">الحقل الفارغ يُحفظ «غير معروف» — لا يتحوّل إلى صفر.</p>';
  }
  function readOfferFields() {
    var out = {};
    ["title", "reference", "submittedOn", "validUntil", "policyStart", "policyMonths", "headcount", "dependentsCount", "totalPremium", "vatStatus", "notes"]
      .forEach(function (k) { out[k] = blankToNull(val("f_" + k)); });
    return out;
  }
  function showNewOffer() {
    var box = el("newForm");
    box.classList.remove("hidden");
    loadInsurers(true).then(function (list) {
      if (!el("newForm")) return;
      var active = list.filter(function (i) { return !i.archived; });
      if (!active.length) { box.innerHTML = '<div class="empty">أضف شركة تأمين أولًا من «الإعدادات».</div>'; return; }
      box.innerHTML = '<h3>عرض جديد</h3><label for="f_insurer">الشركة *</label><select id="f_insurer">' +
        active.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.nameAr) + "</option>"; }).join("") +
        "</select>" + offerFields() + '<div class="row"><button id="saveNew">حفظ</button><button class="ghost" id="cancelNew">إلغاء</button></div><p class="note" id="newNote"></p>';
      el("cancelNew").addEventListener("click", function () { box.classList.add("hidden"); });
      el("saveNew").addEventListener("click", function () {
        var body = readOfferFields(); body.insurerId = val("f_insurer");
        guard("newNote", api("POST", "offers", body)).then(function (j) { state.offerId = j.offer.id; route(); });
      });
    });
  }

  /* ─── تفاصيل العرض ─── */
  function renderOffer(id) {
    var v = el("view");
    v.innerHTML = '<div class="card"><p class="small">جارٍ التحميل…</p></div>';
    Promise.all([api("GET", "offers/" + id), loadCatalog()]).then(function (res) {
      var d = res[0], catalog = res[1], o = d.offer;
      if (state.offerId !== id || !el("view")) return;
      var editable = CAN_EDIT && o.status !== "archived";
      v.innerHTML = '<div class="card"><div class="top"><div><button class="link" id="back">← العروض</button>' +
        "<h2>" + esc(o.insurerName) + " — " + esc(o.title) + ' <span class="pill ' + STATUS_PILL[o.status] + '">' + esc(STATUS_LABELS[o.status]) + "</span></h2>" +
        '<p class="small">السعر للموظف: ' + money(o.premiumPerHead) + " · " + esc(VAT[o.vatStatus]) + "</p></div>" +
        '<div class="row" id="statusBtns"></div></div><p class="note" id="offerNote"></p>' +
        '<div class="section"><h3>البيانات الأساسية</h3>' + offerFields(o) +
        (editable ? '<div class="row"><button id="saveOffer">حفظ</button>' + (o.status === "draft" ? '<button class="danger" id="delOffer">حذف المسودّة</button>' : "") + "</div>" : "") + "</div>" +
        '<div class="section"><h3>الفئات التأمينية</h3><div id="classes"></div></div>' +
        '<div class="section"><h3>قيم المنافع</h3><div id="benefits"></div></div>' +
        '<div class="section"><h3>الاستثناءات والشروط والمزايا</h3><div id="terms"></div></div>' +
        '<div class="section"><h3>الملفّات</h3><div id="files"></div></div></div>';
      el("back").addEventListener("click", function () { state.offerId = null; route(); });
      if (CAN_EDIT) {
        el("statusBtns").innerHTML = NEXT[o.status].map(function (s) {
          return '<button class="ghost" data-to="' + s + '">' + esc(ACTION_LABELS[s]) + "</button>";
        }).join("");
        el("statusBtns").querySelectorAll("[data-to]").forEach(function (b) {
          b.addEventListener("click", function () {
            guard("offerNote", api("POST", "offers/" + id + "/status", { to: b.getAttribute("data-to") })).then(function () { renderOffer(id); });
          });
        });
      }
      if (editable) {
        el("saveOffer").addEventListener("click", function () {
          guard("offerNote", api("PUT", "offers/" + id, readOfferFields())).then(function () { renderOffer(id); });
        });
        if (el("delOffer")) el("delOffer").addEventListener("click", function () {
          if (!confirm("حذف هذه المسودّة نهائيًا؟")) return;
          guard("offerNote", api("DELETE", "offers/" + id)).then(function () { state.offerId = null; route(); });
        });
      }
      renderClasses(d, editable);
      renderBenefits(d, catalog, editable);
      renderTerms(d, editable);
      renderFiles(d, editable);
    }).catch(function (e) { v.innerHTML = '<div class="card"><p class="note err">' + esc(e.message) + "</p></div>"; });
  }

  function renderClasses(d, editable) {
    var box = el("classes");
    box.innerHTML = (d.classes.length ? '<div class="scroll"><table><thead><tr><th>الرمز</th><th>الوصف</th><th class=num>المشمولون</th><th class=num>سعر الفئة</th>' +
      (editable ? "<th></th>" : "") + "</tr></thead><tbody>" + d.classes.map(function (c) {
        return "<tr><td>" + esc(c.classCode) + "</td><td>" + esc(c.label || "") + "</td><td class=num>" + num(c.memberCount) +
          "</td><td class=num>" + money(c.classPremium) + "</td>" +
          (editable ? '<td><button class="danger" data-del="' + esc(c.id) + '">حذف</button></td>' : "") + "</tr>";
      }).join("") + "</tbody></table></div>" : '<div class="empty">لا فئات بعد.</div>') +
      (editable ? '<div class="row"><div><label for="c_code">الرمز *</label><input id="c_code" placeholder="A"></div>' +
        '<div><label for="c_label">الوصف</label><input id="c_label"></div>' +
        '<div><label for="c_members">المشمولون</label><input id="c_members" type="number" min="0"></div>' +
        '<div><label for="c_premium">سعر الفئة</label><input id="c_premium" inputmode="decimal"></div>' +
        '<div><button id="addClass">إضافة فئة</button></div></div><p class="note" id="classNote"></p>' : "");
    if (!editable) return;
    el("addClass").addEventListener("click", function () {
      guard("classNote", api("POST", "offers/" + d.offer.id + "/classes", {
        classCode: val("c_code"), label: blankToNull(val("c_label")),
        memberCount: blankToNull(val("c_members")), classPremium: blankToNull(val("c_premium"))
      })).then(function () { renderOffer(d.offer.id); });
    });
    box.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("حذف الفئة وقيمها؟")) return;
        guard("classNote", api("DELETE", "classes/" + b.getAttribute("data-del"))).then(function () { renderOffer(d.offer.id); });
      });
    });
  }

  function valueInput(item, current, editable) {
    var dis = editable ? "" : " disabled";
    var v = current && current.status === "known" ? current.value : "";
    if (item.valueType === "boolean") {
      return '<select data-val' + dis + '><option value=""></option><option value="true"' + (v === true ? " selected" : "") +
        '>نعم</option><option value="false"' + (v === false ? " selected" : "") + ">لا</option></select>";
    }
    var type = item.valueType === "text" ? "text" : "text";
    return '<input data-val type="' + type + '" value="' + esc(v === "" || v == null ? "" : v) + '"' +
      (item.valueType === "text" ? "" : ' inputmode="decimal"') + dis + ">";
  }

  function renderBenefits(d, catalog, editable) {
    var box = el("benefits");
    if (!d.classes.length) { box.innerHTML = '<div class="empty">أضف فئة أولًا.</div>'; return; }
    var active = catalog.filter(function (c) { return c.active; });
    if (!active.length) { box.innerHTML = '<div class="empty">الكتالوج فارغ — أضف بنودًا من «الإعدادات».</div>'; return; }
    var options = d.classes.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.classCode + (c.label ? " — " + c.label : "")) + "</option>"; }).join("");
    box.innerHTML = '<div class="row"><div><label for="b_class">الفئة</label><select id="b_class">' + options + "</select></div></div>" +
      '<div id="bgrid" class="scroll"></div>' +
      (editable ? '<div class="row"><button id="saveVals">حفظ القيم المعدّلة</button><button class="ghost" id="verifyVals">اعتماد المحدَّد</button></div>' : "") +
      '<p class="note" id="valNote"></p><p class="small">«غير معروف» لا يُحسب صفرًا. وأيّ تعديل على قيمة يُسقط اعتمادها.</p>';
    var files = d.files.filter(function (f) { return f.status === "ready"; });
    function draw() {
      var classId = val("b_class");
      var byCode = {};
      d.values.filter(function (x) { return x.classId === classId; }).forEach(function (x) { byCode[x.code] = x; });
      el("bgrid").innerHTML = "<table><thead><tr>" + (editable ? "<th></th>" : "") + "<th>البند</th><th>النوع</th><th>الحالة</th><th>القيمة</th><th>المصدر</th><th>صفحة</th><th>معتمد</th></tr></thead><tbody>" +
        active.map(function (item) {
          var cur = byCode[item.code];
          var status = cur ? cur.status : "unknown";
          return '<tr data-code="' + esc(item.code) + '"' + (cur ? "" : ' data-missing="1"') + ">" +
            (editable ? '<td><input type="checkbox" data-pick class="auto"' + (cur ? "" : " disabled") + "></td>" : "") +
            "<td>" + esc(item.labelAr) + '<div class="small">' + esc(CATEGORY_LABELS[item.category] || item.category) + "</div></td>" +
            "<td>" + esc(TYPE_LABELS[item.valueType]) + (item.unit ? " (" + esc(item.unit) + ")" : "") + "</td>" +
            "<td><select data-status" + (editable ? "" : " disabled") + ">" + Object.keys(VSTATUS).map(function (k) {
              return '<option value="' + k + '"' + (status === k ? " selected" : "") + ">" + VSTATUS[k] + "</option>";
            }).join("") + "</select>" + (cur ? "" : '<div class="small">لم يُسجَّل</div>') + "</td>" +
            "<td>" + valueInput(item, cur, editable) + "</td>" +
            "<td><select data-src" + (editable ? "" : " disabled") + '><option value=""></option>' + files.map(function (f) {
              return '<option value="' + esc(f.id) + '"' + (cur && cur.sourceFileId === f.id ? " selected" : "") + ">" + esc(f.fileName) + "</option>";
            }).join("") + "</select></td>" +
            '<td><input data-page type="number" min="1" class="narrow" value="' + esc(cur && cur.sourcePage ? cur.sourcePage : "") + '"' + (editable ? "" : " disabled") + "></td>" +
            "<td>" + (cur && cur.verified ? '<span class="pill ok">نعم</span>' : '<span class="pill na">لا</span>') + "</td></tr>";
        }).join("") + "</tbody></table>";
      el("bgrid").querySelectorAll("tr[data-code]").forEach(function (tr) {
        tr.querySelectorAll("select,input").forEach(function (inp) {
          inp.addEventListener("change", function () { tr.setAttribute("data-dirty", "1"); });
        });
      });
    }
    el("b_class").addEventListener("change", draw);
    draw();
    if (!editable) return;
    el("saveVals").addEventListener("click", function () {
      var values = [];
      el("bgrid").querySelectorAll('tr[data-dirty="1"]').forEach(function (tr) {
        var status = tr.querySelector("[data-status]").value;
        var raw = tr.querySelector("[data-val]").value;
        var entry = { code: tr.getAttribute("data-code"), status: status,
          sourceFileId: blankToNull(tr.querySelector("[data-src]").value), sourcePage: blankToNull(tr.querySelector("[data-page]").value) };
        if (status === "known") entry.value = raw === "true" ? true : raw === "false" ? false : raw;
        values.push(entry);
      });
      if (!values.length) { note("valNote", "لا تعديلات.", true); return; }
      guard("valNote", api("PUT", "classes/" + val("b_class") + "/benefits", { values: values })).then(function (j) {
        note("valNote", "حُفظت " + j.saved + " قيمة.", true); renderOffer(d.offer.id);
      });
    });
    el("verifyVals").addEventListener("click", function () {
      var codes = [];
      el("bgrid").querySelectorAll("tr[data-code]").forEach(function (tr) {
        var pick = tr.querySelector("[data-pick]");
        if (pick && pick.checked) codes.push(tr.getAttribute("data-code"));
      });
      if (!codes.length) { note("valNote", "حدّد بنودًا أولًا.", false); return; }
      guard("valNote", api("POST", "classes/" + val("b_class") + "/benefits/verify", { codes: codes })).then(function () { renderOffer(d.offer.id); });
    });
  }

  function renderTerms(d, editable) {
    var box = el("terms");
    box.innerHTML = (d.terms.length ? '<div class="scroll"><table><thead><tr><th>النوع</th><th>النص</th><th>الفئة</th><th class=num>الخطورة</th>' +
      (editable ? "<th></th>" : "") + "</tr></thead><tbody>" + d.terms.map(function (t) {
        var cls = d.classes.filter(function (c) { return c.id === t.classId; })[0];
        return "<tr><td>" + esc(TERM_KINDS[t.kind]) + "</td><td>" + esc(t.body) + "</td><td>" + esc(cls ? cls.classCode : "كل الفئات") +
          "</td><td class=num>" + (t.severity == null ? "—" : esc(t.severity)) + "</td>" +
          (editable ? '<td><button class="danger" data-del="' + esc(t.id) + '">حذف</button></td>' : "") + "</tr>";
      }).join("") + "</tbody></table></div>" : '<div class="empty">لا بنود.</div>') +
      (editable ? '<div class="row"><div><label for="t_kind">النوع</label><select id="t_kind">' +
        Object.keys(TERM_KINDS).map(function (k) { return '<option value="' + k + '">' + TERM_KINDS[k] + "</option>"; }).join("") +
        '</select></div><div><label for="t_class">الفئة</label><select id="t_class"><option value="">كل الفئات</option>' +
        d.classes.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.classCode) + "</option>"; }).join("") +
        '</select></div><div><label for="t_sev">الخطورة (للاستثناء 0–3)</label><input id="t_sev" type="number" min="0" max="3"></div></div>' +
        '<label for="t_body">النص *</label><textarea id="t_body"></textarea><div class="row"><button id="addTerm">إضافة</button></div><p class="note" id="termNote"></p>' : "");
    if (!editable) return;
    el("addTerm").addEventListener("click", function () {
      var kind = val("t_kind");
      guard("termNote", api("POST", "offers/" + d.offer.id + "/terms", {
        kind: kind, classId: blankToNull(val("t_class")), body: val("t_body"),
        severity: kind === "exclusion" ? blankToNull(val("t_sev")) : null
      })).then(function () { renderOffer(d.offer.id); });
    });
    box.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        guard("termNote", api("DELETE", "terms/" + b.getAttribute("data-del"))).then(function () { renderOffer(d.offer.id); });
      });
    });
  }

  /* ─── الملفّات: رفعٌ وتنزيلٌ مُجزَّآن ─── */
  function toBase64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function renderFiles(d, editable) {
    var box = el("files");
    var live = d.files.filter(function (f) { return f.status === "ready"; });
    box.innerHTML = (live.length ? '<div class="scroll"><table><thead><tr><th>الملف</th><th>النوع</th><th class=num>الحجم</th><th>رُفع</th><th></th></tr></thead><tbody>' +
      live.map(function (f) {
        return "<tr><td>" + esc(f.fileName) + "</td><td>" + esc(FILE_KINDS[f.kind]) + "</td><td class=num>" + size(f.sizeBytes) +
          "</td><td>" + when(f.completedAt) + '</td><td><div class="row"><button class="ghost" data-dl="' + esc(f.id) + '">تنزيل</button>' +
          (editable ? '<button class="danger" data-del="' + esc(f.id) + '">حذف</button>' : "") + "</div></td></tr>";
      }).join("") + "</tbody></table></div>" : '<div class="empty">لا ملفّات.</div>') +
      (editable ? '<div class="row"><div><label for="u_kind">النوع</label><select id="u_kind">' +
        Object.keys(FILE_KINDS).map(function (k) { return '<option value="' + k + '">' + FILE_KINDS[k] + "</option>"; }).join("") +
        '</select></div><div><label for="u_file">الملف (PDF أو Excel أو CSV، حتى 20MB)</label><input id="u_file" type="file" accept=".pdf,.xlsx,.xls,.csv"></div>' +
        '<div><button id="upload">رفع</button></div></div><div class="bar hidden" id="u_bar"><span></span></div>' : "") +
      '<p class="note" id="fileNote"></p>';
    box.querySelectorAll("[data-dl]").forEach(function (b) {
      b.addEventListener("click", function () { download(b.getAttribute("data-dl"), b); });
    });
    if (!editable) return;
    box.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!confirm("حذف الملف؟")) return;
        guard("fileNote", api("DELETE", "files/" + b.getAttribute("data-del"))).then(function () { renderOffer(d.offer.id); });
      });
    });
    el("upload").addEventListener("click", function () { upload(d.offer.id); });
  }
  function progress(done, total) {
    var bar = el("u_bar"); if (!bar) return;
    bar.classList.remove("hidden"); bar.firstChild.style.width = Math.round((done / total) * 100) + "%";
  }
  function upload(offerId) {
    var input = el("u_file");
    var file = input.files && input.files[0];
    if (!file) { note("fileNote", "اختر ملفًا."); return; }
    var ext = (file.name.split(".").pop() || "").toLowerCase();
    if (file.size > 20 * 1024 * 1024) { note("fileNote", "الملف أكبر من 20MB."); return; }
    var btn = el("upload"); btn.disabled = true; note("fileNote", "جارٍ التحضير…", true);
    file.arrayBuffer().then(function (buf) {
      return crypto.subtle.digest("SHA-256", buf).then(function (digest) {
        return api("POST", "files/init", { offerId: offerId, kind: val("u_kind"), fileName: file.name, format: ext, sizeBytes: file.size, sha256: hex(digest) })
          .then(function (j) {
            var bytes = new Uint8Array(buf), count = j.partCount, i = 0;
            function next() {
              if (i >= count) return api("POST", "files/" + j.fileId + "/complete", {});
              var part = bytes.subarray(i * PART_SIZE, Math.min(bytes.length, (i + 1) * PART_SIZE));
              return api("POST", "files/" + j.fileId + "/parts/" + i, { data: toBase64(part) }).then(function () {
                i += 1; progress(i, count + 1); return next();
              });
            }
            return next();
          });
      });
    }).then(function () { progress(1, 1); renderOffer(offerId); })
      .catch(function (e) { note("fileNote", e.message); btn.disabled = false; });
  }
  function download(fileId, btn) {
    btn.disabled = true;
    api("GET", "files/" + fileId).then(function (j) {
      var f = j.file, parts = [], i = 0;
      function next() {
        if (i >= f.partCount) return Promise.resolve();
        return fetch(BASE + "files/" + fileId + "/parts/" + i, { credentials: "same-origin" }).then(function (r) {
          if (r.status === 401) { location.reload(); return new Promise(function () {}); }
          if (!r.ok) throw new Error("تعذّر تنزيل الجزء " + (i + 1));
          return r.arrayBuffer();
        }).then(function (b) { parts.push(b); i += 1; return next(); });
      }
      return next().then(function () {
        var blob = new Blob(parts, { type: "application/octet-stream" });
        return blob.arrayBuffer().then(function (all) { return crypto.subtle.digest("SHA-256", all); }).then(function (dg) {
          if (hex(dg) !== f.sha256) throw new Error("بصمة الملف المنزَّل لا تطابق — لم يُحفظ");
          var a = document.createElement("a");
          var url = URL.createObjectURL(blob);
          a.href = url; a.download = f.fileName; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
        });
      });
    }).catch(function (e) { note("fileNote", e.message); }).finally(function () { btn.disabled = false; });
  }

  /* ─── الإعدادات ─── */
  function renderSettings() {
    el("view").innerHTML = '<div class="card"><h2>الإعدادات</h2>' +
      '<div class="section"><h3>شركات التأمين</h3><div id="ins"></div></div>' +
      '<div class="section"><h3>مواقع الشركة (نقاط القياس)</h3><div id="locs"></div></div>' +
      '<div class="section"><h3>كتالوج بنود المنافع</h3><div id="cat"></div></div>' +
      (CAN_EDIT ? '<div class="section"><h3>سجل التدقيق</h3><div id="aud"></div></div>' : "") + "</div>";
    renderInsurers(); renderLocations(); renderCatalog();
    if (CAN_EDIT) renderAudit();
  }
  function renderInsurers() {
    loadInsurers(true).then(function (list) {
      var box = el("ins");
      if (!box) return;
      box.innerHTML = (list.length ? "<table><thead><tr><th>الاسم</th><th>بالإنجليزية</th><th class=num>العروض</th><th>الحالة</th>" + (CAN_EDIT ? "<th></th>" : "") +
        "</tr></thead><tbody>" + list.map(function (i) {
          return "<tr><td>" + esc(i.nameAr) + "</td><td>" + esc(i.nameEn || "") + "</td><td class=num>" + esc(i.offersCount) +
            "</td><td>" + (i.archived ? '<span class="pill na">مؤرشفة</span>' : '<span class="pill ok">نشطة</span>') + "</td>" +
            (CAN_EDIT ? '<td><button class="ghost" data-arch="' + esc(i.id) + '" data-on="' + (i.archived ? "0" : "1") + '">' + (i.archived ? "استعادة" : "أرشفة") + "</button></td>" : "") + "</tr>";
        }).join("") + "</tbody></table>" : '<div class="empty">لا شركات.</div>') +
        (CAN_EDIT ? '<div class="row"><div><label for="i_ar">الاسم *</label><input id="i_ar"></div><div><label for="i_en">بالإنجليزية</label><input id="i_en"></div>' +
          '<div><button id="addIns">إضافة</button></div></div><p class="note" id="insNote"></p>' : "");
      if (!CAN_EDIT) return;
      el("addIns").addEventListener("click", function () {
        guard("insNote", api("POST", "insurers", { nameAr: val("i_ar"), nameEn: blankToNull(val("i_en")) })).then(renderInsurers);
      });
      box.querySelectorAll("[data-arch]").forEach(function (b) {
        b.addEventListener("click", function () {
          guard("insNote", api("POST", "insurers/" + b.getAttribute("data-arch") + (b.getAttribute("data-on") === "1" ? "/archive" : "/unarchive"), {})).then(renderInsurers);
        });
      });
    }).catch(function (e) { if (el("ins")) el("ins").textContent = e.message; });
  }
  function renderLocations() {
    api("GET", "locations").then(function (j) {
      var box = el("locs");
      if (!box) return;
      box.innerHTML = (j.locations.length ? "<table><thead><tr><th>الاسم</th><th class=num>خط العرض</th><th class=num>خط الطول</th><th>الحالة</th>" +
        (CAN_EDIT ? "<th></th>" : "") + "</tr></thead><tbody>" + j.locations.map(function (l) {
          return "<tr><td>" + esc(l.label) + "</td><td class=num>" + esc(l.latitude) + "</td><td class=num>" + esc(l.longitude) + "</td><td>" +
            (l.isDefault ? '<span class="pill ok">افتراضي</span> ' : "") + (l.active ? "" : '<span class="pill na">معطّل</span>') + "</td>" +
            (CAN_EDIT ? '<td><div class="row">' + (l.active && !l.isDefault ? '<button class="ghost" data-def="' + esc(l.id) + '">اجعله افتراضيًا</button>' : "") +
              '<button class="ghost" data-act="' + esc(l.id) + '" data-on="' + (l.active ? "0" : "1") + '">' + (l.active ? "تعطيل" : "تفعيل") + "</button></div></td>" : "") + "</tr>";
        }).join("") + "</tbody></table>" : '<div class="empty">لا مواقع. أدخل مقر الشركة بإحداثياته.</div>') +
        (CAN_EDIT ? '<div class="row"><div><label for="l_label">الاسم *</label><input id="l_label" placeholder="المقر الرئيسي"></div>' +
          '<div><label for="l_lat">خط العرض *</label><input id="l_lat" inputmode="decimal"></div>' +
          '<div><label for="l_lng">خط الطول *</label><input id="l_lng" inputmode="decimal"></div>' +
          '<div><label class="small"><input type="checkbox" id="l_def" class="auto"> افتراضي</label></div>' +
          '<div><button id="addLoc">إضافة</button></div></div><p class="note" id="locNote"></p>' : "");
      if (!CAN_EDIT) return;
      el("addLoc").addEventListener("click", function () {
        guard("locNote", api("POST", "locations", { label: val("l_label"), latitude: val("l_lat"), longitude: val("l_lng"), isDefault: el("l_def").checked })).then(renderLocations);
      });
      box.querySelectorAll("[data-def]").forEach(function (b) {
        b.addEventListener("click", function () { guard("locNote", api("POST", "locations/" + b.getAttribute("data-def") + "/default", {})).then(renderLocations); });
      });
      box.querySelectorAll("[data-act]").forEach(function (b) {
        b.addEventListener("click", function () {
          guard("locNote", api("PUT", "locations/" + b.getAttribute("data-act"), { active: b.getAttribute("data-on") === "1" })).then(renderLocations);
        });
      });
    }).catch(function (e) { if (el("locs")) el("locs").textContent = e.message; });
  }
  function renderCatalog() {
    loadCatalog(true).then(function (list) {
      var box = el("cat");
      if (!box) return;
      box.innerHTML = (list.length ? '<div class="scroll"><table><thead><tr><th>الرمز</th><th>الاسم</th><th>بالإنجليزية</th><th>التصنيف</th><th>النوع</th><th>الأفضل</th><th class=num>الترتيب</th><th>الحالة</th>' +
        (CAN_EDIT ? "<th></th>" : "") + "</tr></thead><tbody>" + list.map(function (c) {
          return "<tr><td><code>" + esc(c.code) + "</code></td><td>" + esc(c.labelAr) + "</td><td>" + esc(c.labelEn || "") + "</td><td>" +
            esc(CATEGORY_LABELS[c.category] || c.category) + "</td><td>" + esc(TYPE_LABELS[c.valueType]) + (c.unit ? " (" + esc(c.unit) + ")" : "") +
            "</td><td>" + esc({ higher: "الأعلى", lower: "الأقل", none: "—" }[c.better]) + "</td><td class=num>" + esc(c.displayOrder) + "</td><td>" +
            (c.active ? '<span class="pill ok">نشط</span>' : '<span class="pill na">معطّل</span>') + "</td>" +
            (CAN_EDIT ? '<td><button class="ghost" data-tog="' + esc(c.code) + '" data-on="' + (c.active ? "0" : "1") + '">' + (c.active ? "تعطيل" : "تفعيل") + "</button></td>" : "") + "</tr>";
        }).join("") + "</tbody></table></div>" : '<div class="empty">الكتالوج فارغ. البنود بيانات تُضاف هنا — لا تحتاج تعديل النظام.</div>') +
        (CAN_EDIT ? '<h3>بند جديد</h3><div class="grid"><div><label for="k_code">الرمز * (ثابت)</label><input id="k_code" placeholder="annual_limit"></div>' +
          '<div><label for="k_ar">الاسم العربي *</label><input id="k_ar"></div><div><label for="k_en">الاسم الإنجليزي</label><input id="k_en"></div>' +
          '<div><label for="k_cat">التصنيف</label><select id="k_cat">' + Object.keys(CATEGORY_LABELS).map(function (k) { return '<option value="' + k + '">' + CATEGORY_LABELS[k] + "</option>"; }).join("") + "</select></div>" +
          '<div><label for="k_type">نوع القيمة</label><select id="k_type">' + Object.keys(TYPE_LABELS).map(function (k) { return '<option value="' + k + '">' + TYPE_LABELS[k] + "</option>"; }).join("") + "</select></div>" +
          '<div><label for="k_unit">الوحدة</label><select id="k_unit"><option value="">—</option><option>SAR</option><option>percent</option><option>visit</option><option>session</option><option>day</option><option>item</option></select></div>' +
          '<div><label for="k_better">الأفضل</label><select id="k_better"><option value="higher">الأعلى</option><option value="lower">الأقل</option><option value="none">—</option></select></div>' +
          '<div><label for="k_order">الترتيب</label><input id="k_order" type="number" min="0" value="0"></div></div>' +
          '<div class="row"><button id="addCat">إضافة البند</button></div><p class="note" id="catNote"></p>' : "");
      if (!CAN_EDIT) return;
      el("addCat").addEventListener("click", function () {
        guard("catNote", api("POST", "catalog", {
          code: val("k_code"), labelAr: val("k_ar"), labelEn: blankToNull(val("k_en")), category: val("k_cat"),
          valueType: val("k_type"), unit: blankToNull(val("k_unit")), better: val("k_better"), displayOrder: blankToNull(val("k_order"))
        })).then(renderCatalog);
      });
      box.querySelectorAll("[data-tog]").forEach(function (b) {
        b.addEventListener("click", function () {
          guard("catNote", api("PUT", "catalog/" + b.getAttribute("data-tog"), { active: b.getAttribute("data-on") === "1" })).then(renderCatalog);
        });
      });
    }).catch(function (e) { if (el("cat")) el("cat").textContent = e.message; });
  }
  function renderAudit() {
    api("GET", "audit?limit=50").then(function (j) {
      if (!el("aud")) return;
      el("aud").innerHTML = j.events.length ? '<div class="scroll"><table><thead><tr><th>الوقت</th><th>الحدث</th><th>المستخدم</th><th>الدور</th><th>تفاصيل</th></tr></thead><tbody>' +
        j.events.map(function (e) {
          return "<tr><td>" + when(e.ts) + "</td><td><code>" + esc(e.event) + "</code></td><td>" + esc(e.userName || e.userId || "—") +
            "</td><td>" + esc(e.role || "") + '</td><td class="small">' + esc(JSON.stringify(e.meta)) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<div class="empty">لا أحداث.</div>';
    }).catch(function (e) { if (el("aud")) el("aud").textContent = e.message; });
  }

  shell();
  route();
}

module.exports = { appClient };
