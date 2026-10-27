/* sick-leave.js — صفحة التحقق من الإجازات المرضية.
   =========================================================================
   ثلاث خطوات: رفع الملف (يُقرأ على الخادم في الذاكرة ولا يُحفظ)، ثم
   الاستعلام في صفحة «صحة» الرسمية بيد المستخدم، ثم تسجيل ما أظهرته صحة
   فيقارنه الخادم حرفيًا بما في الملف.

   لا شيء يُحفظ في المتصفّح: لا localStorage ولا sessionStorage. سجلّ
   «تحققات هذه الجلسة» في الذاكرة فقط ويختفي بإغلاق الصفحة. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const MAX_BYTES = 4 * 1024 * 1024;
  const TYPES = ["application/pdf", "image/png", "image/jpeg"];

  const STATES = {
    idle: ["جاهز للتحقق", "idle"],
    reading: ["جاري قراءة الملف", "busy"],
    verifying: ["جاري التحقق من صحة", "busy"],
    verified: ["تم التحقق", "ok"],
    mismatch: ["غير مطابق", "bad"],
    not_found: ["غير مطابق", "bad"],
    unavailable: ["تعذر التحقق حاليًا", "warn"],
  };

  const FIELD_LABELS = {
    leaveId: "رقم الإجازة", idNumber: "رقم الهوية / الإقامة", name: "اسم المستفيد",
    startDate: "من تاريخ", endDate: "إلى تاريخ", days: "عدد الأيام",
    issueDate: "تاريخ الإصدار", facility: "المنشأة الصحية", practitioner: "الطبيب",
    position: "المسمى", employer: "جهة العمل", nationality: "الجنسية",
  };

  const READ_ERRORS = {
    scanned: "الملف ممسوح ضوئيًا ولا يحتوي نصًّا قابلًا للقراءة. أدخل البيانات المطبوعة فيه يدويًا.",
    image: "الصور لا تُقرأ آليًا (لا نستخدم OCR خارجيًا لبيانات صحية). أدخل البيانات المطبوعة في الإجازة يدويًا.",
  };

  const WARNINGS = {
    leave_id_ambiguous: "يظهر في الملف أكثر من رمز إجازة مختلف — لم يُعتمد أيّ منها.",
    id_ambiguous: "يظهر في الملف أكثر من رقم هوية مختلف — لم يُعتمد أيّ منها.",
    days_inconsistent: "عدد الأيام المطبوع لا يساوي الفرق بين تاريخي البداية والنهاية.",
    start_date_inconsistent: "تاريخ البداية في سطر المدة يختلف عن تاريخ الدخول في الملف.",
    end_date_inconsistent: "تاريخ النهاية في سطر المدة يختلف عن تاريخ الخروج في الملف.",
    end_before_start: "تاريخ النهاية في الملف يسبق تاريخ البداية.",
    start_date_ambiguous: "يظهر في الملف أكثر من تاريخ بداية.",
    end_date_ambiguous: "يظهر في الملف أكثر من تاريخ نهاية.",
  };

  const DIFFS = {
    leave_not_found: "رقم الإجازة غير موجود في صحة، أو غير مرتبط برقم الهوية هذا",
    leave_id_mismatch: "رقم الإجازة غير مطابق",
    id_mismatch: "رقم الهوية غير مطابق",
    start_date_mismatch: "تاريخ البداية مختلف",
    end_date_mismatch: "تاريخ النهاية مختلف",
    days_mismatch: "عدد الأيام مختلف",
    name_mismatch: "الاسم مختلف",
    missing_in_file: "حقل غير موجود في الملف",
    missing_in_official: "حقل لم يُسجَّل من نتيجة صحة",
    name_minor_difference: "اختلاف بسيط في كتابة الاسم — لا يؤثر على النتيجة",
    name_not_comparable: "الاسم في صحة بلغة غير لغة الملف — راجعه بنفسك",
  };

  const UNAVAILABLE = {
    service_unavailable: "خدمة الاستعلام في منصة صحة غير متاحة حاليًا.",
    timeout: "انتهت مهلة الاستعلام من منصة صحة.",
    rate_limited: "منصة صحة رفضت الاستعلام مؤقتًا بسبب كثرة الطلبات.",
  };

  let S = null; // حالة الملف الحالي
  const history = [];

  /* ---------- تنسيق ---------- */
  const dateFmt = (() => {
    try { return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); } catch { return null; }
  })();
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00Z");
    if (isNaN(d)) return iso;
    return dateFmt ? dateFmt.format(d) : iso;
  }
  function fmtTime(iso) {
    try {
      return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    } catch { return iso; }
  }
  function fmtSize(n) { return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
  const daysLabel = (n) => (n == null ? "" : n === 1 ? "يوم واحد" : n === 2 ? "يومان" : n <= 10 ? `${n} أيام` : `${n} يومًا`);
  const maskId = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length > 4 ? "•".repeat(d.length - 4) + d.slice(-4) : d; };

  function setState(key) {
    const [label, tone] = STATES[key] || STATES.idle;
    const el = $("slState");
    el.textContent = label;
    el.dataset.tone = tone;
  }

  function msg(id, html, tone) {
    const el = $(id);
    if (!html) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.dataset.tone = tone || "info";
    el.innerHTML = html;
  }

  /* ---------- الخطوة ١: الملف ---------- */
  function pickFile(file) {
    if (!file) return;
    reset({ keepHistory: true });
    $("slFileChip").hidden = false;
    $("slFileName").textContent = file.name || "ملف";
    $("slFileSize").textContent = fmtSize(file.size);
    if (file.size > MAX_BYTES) return fileError("حجم الملف أكبر من 4 ميغابايت.");
    if (file.type && !TYPES.includes(file.type)) return fileError("نوع الملف غير مدعوم. ارفع PDF أو صورة PNG/JPEG.");
    $("slDrop").hidden = true;
    readFile(file);
  }

  function fileError(text) {
    setRead("", "");
    msg("slFileMsg", esc(text), "bad");
    setState("idle");
    $("slDrop").hidden = false;
  }

  function setRead(text, tone) {
    const el = $("slFileRead");
    el.textContent = text;
    el.dataset.tone = tone || "";
  }

  async function readFile(file) {
    setState("reading");
    setRead("جاري القراءة…", "busy");
    let r, j;
    try {
      r = await fetch("/api/sick-leave/extract", {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name || "file") },
        body: file,
      });
      j = await r.json();
    } catch {
      return fileError("تعذّر الاتصال بالخادم. تحقّق من الاتصال وأعد المحاولة.");
    }
    if (r.status === 401) { location.href = "/login.html"; return; }
    if (!j.ok) return fileError(j.error || "تعذّر قراءة الملف.");

    S = { token: j.token, fields: j.fields || {}, missing: j.missing || [], status: j.status, reason: j.reason, kind: j.kind };
    setRead(j.status === "extracted" ? "تمت القراءة" : j.status === "partial" ? "قُرئ جزئيًا" : "إدخال يدوي", j.status === "extracted" ? "ok" : "warn");
    setState("idle");

    const notes = [];
    if (j.duplicate) notes.push(`رُفع هذا الملف نفسه للتحقق قبل قليل (${esc(fmtTime(j.duplicate.at))}).`);
    if (j.status === "needs_manual") notes.push(esc(READ_ERRORS[j.reason] || READ_ERRORS.scanned));
    if (j.status === "partial") notes.push("لم تُقرأ كل البيانات الأساسية من الملف — أكمل الناقص يدويًا كما هو مطبوع.");
    (j.warnings || []).forEach((w) => WARNINGS[w] && notes.push(esc(WARNINGS[w])));
    if (j.qr && j.qr.found) {
      notes.push(j.qr.officialHost
        ? "يحتوي الملف رمز QR يشير إلى منصة صحة. هذا وحده ليس دليل صحة — النتيجة من الاستعلام الرسمي."
        : "رمز QR في الملف لا يشير إلى منصة صحة.");
    }
    const warn = j.status !== "extracted" || (j.warnings || []).length || (j.qr && j.qr.found && !j.qr.officialHost);
    msg("slDataMsg", notes.length ? (notes.length === 1 ? notes[0] : `<ul>${notes.map((n) => `<li>${n}</li>`).join("")}</ul>`) : "", warn ? "warn" : "info");

    renderFields();
    $("slDataCard").hidden = false;
    $("slSehaCard").hidden = false;
    updateVerifyButton();
  }

  function renderFields() {
    const f = S.fields;
    const cell = (key, valueHtml, opts) => `<div${opts && opts.wide ? ' class="sl-wide"' : ""}><dt>${FIELD_LABELS[key]}</dt><dd${valueHtml ? "" : ' class="is-missing"'}>${valueHtml || "لم يُقرأ"}</dd></div>`;
    const copyBtn = (key) => `<button type="button" class="sl-copy" data-copy="${key}">نسخ</button>`;
    $("slFields").innerHTML = [
      cell("leaveId", f.leaveId ? `<span class="sl-mono">${esc(f.leaveId)}</span>${copyBtn("leaveId")}` : ""),
      cell("idNumber", f.idNumber ? `<span class="sl-mono">${esc(f.idMasked)}</span>${copyBtn("idNumber")}` : ""),
      cell("days", f.days != null ? esc(daysLabel(f.days)) : ""),
      cell("startDate", f.startDate ? esc(fmtDate(f.startDate)) : ""),
      cell("endDate", f.endDate ? esc(fmtDate(f.endDate)) : ""),
      cell("name", f.name ? esc(f.name) : "", { wide: false }),
    ].join("");

    const extras = ["issueDate", "facility", "practitioner", "position", "employer", "nationality"].filter((k) => f[k]);
    $("slExtraWrap").hidden = !extras.length;
    $("slExtra").innerHTML = extras.map((k) => `<div><dt>${FIELD_LABELS[k]}</dt><dd>${esc(k === "issueDate" ? fmtDate(f[k]) : f[k])}</dd></div>`).join("");

    const need = ["leaveId", "idNumber", "startDate", "endDate"].filter((k) => !f[k]);
    if (!f.name) need.push("name");
    if (f.days == null && need.length) need.push("days");
    $("slManual").hidden = !need.length;
    $("slManualForm").innerHTML = need.map(manualInput).join("");
  }

  function manualInput(key) {
    const optional = key === "name" || key === "days";
    const label = `${FIELD_LABELS[key]}${optional ? " <i>(اختياري)</i>" : ""}`;
    const attrs = {
      leaveId: 'type="text" dir="ltr" maxlength="24" autocomplete="off" autocapitalize="characters" placeholder="GSL…"',
      idNumber: 'type="text" dir="ltr" inputmode="numeric" maxlength="10" autocomplete="off" pattern="[0-9]{10}"',
      startDate: 'type="date"', endDate: 'type="date"',
      days: 'type="number" inputmode="numeric" min="1" max="365"',
      name: 'type="text" maxlength="120" autocomplete="off"',
    }[key];
    return `<div class="field${key === "name" ? " sl-wide" : ""}"><label for="slM_${key}">${label}</label><input class="in" id="slM_${key}" data-manual="${key}" ${attrs}${optional ? "" : " required"}></div>`;
  }

  function manualValues() {
    const out = {};
    document.querySelectorAll("[data-manual]").forEach((el) => { if (el.value.trim()) out[el.dataset.manual] = el.value.trim(); });
    return out;
  }

  function valueFor(key) {
    if (!S) return "";
    if (S.fields[key]) return S.fields[key];
    const el = document.querySelector(`[data-manual="${key}"]`);
    return el ? el.value.trim() : "";
  }

  async function copy(key) {
    const v = valueFor(key);
    if (!v) { AdminUI.toastError(`${FIELD_LABELS[key]} غير متوفر بعد`); return; }
    try {
      await navigator.clipboard.writeText(String(v));
      AdminUI.toastOk(`نُسخ ${FIELD_LABELS[key]}`);
    } catch {
      AdminUI.toastError("تعذّر النسخ — انسخه يدويًا");
    }
  }

  /* ---------- الخطوة ٣: نتيجة صحة ---------- */
  function outcome() {
    const el = document.querySelector('input[name="slOutcome"]:checked');
    return el ? el.value : "";
  }

  function updateVerifyButton() {
    const o = outcome();
    $("slOfficialForm").hidden = o !== "found";
    const manualOk = [...document.querySelectorAll("[data-manual][required]")].every((el) => el.value.trim());
    const officialOk = o !== "found" || ($("slOffStart").value && $("slOffEnd").value);
    $("slVerify").disabled = !S || !o || !manualOk || !officialOk;
  }

  async function verify() {
    if (!S) return;
    const btn = $("slVerify");
    btn.disabled = true;
    btn.classList.add("is-busy");
    $("slVerify").querySelector(".sl-verify-t").textContent = "جاري التحقق…";
    setState("verifying");
    msg("slVerifyMsg", "");
    const o = outcome();
    const official = { outcome: o };
    if (o === "found") {
      official.startDate = $("slOffStart").value;
      official.endDate = $("slOffEnd").value;
      if ($("slOffDays").value) official.days = $("slOffDays").value;
      if ($("slOffName").value.trim()) official.name = $("slOffName").value.trim();
    }
    let r, j;
    try {
      r = await fetch("/api/sick-leave/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: S.token, file: manualValues(), official }),
      });
      j = await r.json();
    } catch {
      j = { ok: false, error: "تعذّر الاتصال بالخادم. أعد المحاولة." };
    } finally {
      btn.classList.remove("is-busy");
      btn.querySelector(".sl-verify-t").textContent = "تحقق من الإجازة";
      updateVerifyButton();
    }
    if (r && r.status === 401) { location.href = "/login.html"; return; }
    if (!j.ok) {
      setState("idle");
      document.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));
      const map = { leaveId: "slM_leaveId", idNumber: "slM_idNumber", startDate: "slM_startDate", endDate: "slM_endDate", days: "slM_days", officialStartDate: "slOffStart", officialEndDate: "slOffEnd", officialDays: "slOffDays" };
      Object.keys(j.fields || {}).forEach((k) => { const el = $(map[k]); if (el) el.classList.add("is-invalid"); });
      msg("slVerifyMsg", esc(j.error || "تعذّر التحقق."), "bad");
      return;
    }
    renderResult(j);
  }

  /* ---------- النتيجة ---------- */
  const ICONS = {
    ok: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    bad: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 6.5v7"/><path d="M12 17.5h.01"/></svg>',
  };

  function renderResult(j) {
    const L = j.leave || {};
    const tone = j.status === "verified" ? "ok" : j.status === "unavailable" ? "warn" : "bad";
    const title = {
      verified: "تم التحقق من الإجازة",
      mismatch: "الإجازة غير صحيحة — البيانات غير مطابقة",
      not_found: "الإجازة غير صحيحة — لا توجد في صحة",
      unavailable: "تعذّر التحقق حاليًا",
    }[j.status];
    const sub = {
      verified: "مطابقة لنتيجة الاستعلام الرسمي في منصة صحة",
      mismatch: "الإجازة موجودة في صحة لكن بيانات الملف تختلف عنها",
      not_found: "صحة لم تُرجع إجازة بهذا الرمز وهذه الهوية",
      unavailable: "تعطّل الخدمة ليس دليلًا على أن الإجازة غير صحيحة. أعد المحاولة لاحقًا.",
    }[j.status];

    const fieldCell = (k, v, wide) => `<div${wide ? ' class="sl-wide"' : ""}><dt>${FIELD_LABELS[k]}</dt><dd>${v || "—"}</dd></div>`;
    const grid = `<dl class="sl-grid">
      ${fieldCell("name", esc(L.name || L.officialName || ""), true)}
      ${fieldCell("leaveId", `<span class="sl-mono">${esc(L.leaveId)}</span>`)}
      ${fieldCell("idNumber", `<span class="sl-mono">${esc(L.idMasked)}</span>`)}
      ${fieldCell("days", esc(daysLabel(L.days != null ? L.days : L.officialDays)))}
      ${fieldCell("startDate", esc(fmtDate(L.startDate)))}
      ${fieldCell("endDate", esc(fmtDate(L.endDate)))}
      <div><dt>وقت التحقق</dt><dd>${esc(fmtTime(j.checkedAt))}</dd></div>
    </dl>`;

    const valueOf = (d, side) => {
      const v = d[side];
      if (v == null) return "—";
      if (d.field === "startDate" || d.field === "endDate") return esc(fmtDate(v));
      if (d.field === "days") return esc(daysLabel(Number(v)));
      return `<span class="sl-mono">${esc(v)}</span>`;
    };
    const diffs = (j.differences || []).map((d) => `<li><b>${esc(DIFFS[d.code] || d.code)}${d.code.startsWith("missing") ? ` — ${esc(FIELD_LABELS[d.field] || d.field)}` : ""}</b>${
      d.file != null || d.official != null ? `<div class="sl-vs"><span>في الملف: <b>${valueOf(d, "file")}</b></span><span>في صحة: <b>${valueOf(d, "official")}</b></span></div>` : ""}</li>`);
    const notes = (j.notes || []).map((n) => `<li class="note"><b>${esc(DIFFS[n.code] || n.code)}</b>${
      n.field === "name" && (L.name || L.officialName) ? `<div class="sl-vs"><span>في الملف: <b>${esc(L.name || "—")}</b></span><span>في صحة: <b>${esc(L.officialName || "—")}</b></span></div>` : ""}</li>`);
    const unavailable = j.status === "unavailable" ? `<li class="note"><b>${esc(UNAVAILABLE[j.reason] || UNAVAILABLE.service_unavailable)}</b></li>` : "";
    const list = diffs.length || notes.length || unavailable ? `<ul class="sl-diff">${unavailable}${diffs.join("")}${notes.join("")}</ul>` : "";

    const src = j.fileSource === "pdf_text" ? "قراءة آلية من ملف PDF" : j.fileSource === "manual_entry" ? "إدخال يدوي من الملف" : "قراءة آلية مع إكمال يدوي";
    const emp = j.employee ? `<div class="sl-emp">مطابق لسجل موظف في المنصة: ${esc(j.employee.name || "")} — الرقم الوظيفي ${esc(j.employee.eid)}</div>` : "";

    const el = $("slResult");
    el.dataset.status = j.status;
    el.innerHTML = `
      <div class="sl-res-top">
        <div class="sl-mark ${tone}"><div class="sl-mark-in">${ICONS[tone]}</div></div>
        <div><div class="sl-res-title">${esc(title)}</div><div class="sl-res-sub">${esc(sub)}</div></div>
      </div>
      ${j.status === "unavailable" ? list : j.status === "verified" ? grid + list : list + grid}
      ${emp}
      <div class="sl-res-meta">
        <span>رقم التحقق: <b class="sl-mono">${esc(j.verificationId)}</b></span>
        <span>مصدر النتيجة: <b>استعلام صحة الرسمي (أُدخل يدويًا)</b></span>
        <span>بيانات الملف: <b>${esc(src)}</b></span>
      </div>
      <div class="sl-res-actions">
        ${j.status === "unavailable" ? '<button type="button" class="admin-mini-btn sl-btn" id="slRetry">إعادة المحاولة</button>' : ""}
        <button type="button" class="admin-btn-primary sl-btn" id="slAgain">تحقق من إجازة أخرى</button>
      </div>`;
    el.hidden = false;
    setState(j.status);
    $("slAgain").addEventListener("click", () => { reset({ keepHistory: true }); window.scrollTo({ top: 0, behavior: "smooth" }); });
    const retry = $("slRetry");
    if (retry) retry.addEventListener("click", () => { el.hidden = true; setState("idle"); $("slSehaCard").scrollIntoView({ behavior: "smooth", block: "start" }); });
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });

    history.unshift({ status: j.status, leaveId: L.leaveId, idMasked: L.idMasked, at: j.checkedAt });
    renderHistory();
  }

  function renderHistory() {
    $("slHistory").hidden = !history.length;
    $("slHistoryList").innerHTML = history.slice(0, 20).map((h) => {
      const [label, tone] = STATES[h.status] || STATES.idle;
      return `<li><span class="sl-state" data-tone="${tone}">${esc(label)}</span><span class="sl-mono">${esc(h.leaveId)}</span><span class="sl-mono">${esc(h.idMasked)}</span><time>${esc(fmtTime(h.at))}</time></li>`;
    }).join("");
  }

  function reset(opts) {
    S = null;
    $("slFile").value = "";
    $("slDrop").hidden = false;
    $("slFileChip").hidden = true;
    setRead("", "");
    ["slFileMsg", "slDataMsg", "slVerifyMsg"].forEach((id) => msg(id, ""));
    $("slDataCard").hidden = true;
    $("slSehaCard").hidden = true;
    $("slResult").hidden = true;
    $("slResult").innerHTML = "";
    document.querySelectorAll('input[name="slOutcome"]').forEach((el) => (el.checked = false));
    ["slOffStart", "slOffEnd", "slOffDays", "slOffName"].forEach((id) => { $(id).value = ""; $(id).classList.remove("is-invalid"); });
    $("slOfficialForm").hidden = true;
    $("slVerify").disabled = true;
    setState("idle");
    if (!opts || !opts.keepHistory) { history.length = 0; renderHistory(); }
  }

  /* ---------- التهيئة ---------- */
  function wire() {
    const drop = $("slDrop");
    $("slFile").addEventListener("change", (e) => pickFile(e.target.files && e.target.files[0]));
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("is-over")));
    drop.addEventListener("drop", (e) => { e.preventDefault(); pickFile(e.dataTransfer.files && e.dataTransfer.files[0]); });
    $("slChange").addEventListener("click", () => { reset({ keepHistory: true }); $("slFile").click(); });
    document.addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) copy(b.dataset.copy); });
    document.addEventListener("input", (e) => { if (e.target.closest("#slSehaCard, #slManual")) { e.target.classList.remove("is-invalid"); updateVerifyButton(); } });
    document.addEventListener("change", (e) => { if (e.target.name === "slOutcome") updateVerifyButton(); });
    $("slVerify").addEventListener("click", verify);
  }

  async function init() {
    let user;
    try {
      const r = await fetch("/api/auth/me");
      if (!r.ok) { location.href = "/login.html"; return; }
      user = AdminUI.setUser((await r.json()).user);
      AppNav.setUser();
    } catch { location.href = "/login.html"; return; }
    if (!user || !AdminUI.can("sick_leave", "view")) { $("slDenied").hidden = false; return; }
    $("slApp").hidden = false;
    wire();
    if (!AdminUI.can("sick_leave", "verify")) {
      $("slDrop").hidden = true;
      msg("slFileMsg", "تملك صلاحية عرض هذا القسم فقط. رفع الملفات والتحقق يحتاجان صلاحية «رفع وتحقق».", "warn");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
