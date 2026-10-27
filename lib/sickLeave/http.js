const crypto = require("crypto");

const { validateUpload, displayName, LIMITS: FILE_LIMITS } = require("./validate");
const { extractSickLeave } = require("./extract");
const { compareWithOfficial, normLeaveId, normId, normDate } = require("./compare");
const { runLookup, manualProvider } = require("./provider");

/* ─── التحقق من الإجازات المرضية — مسارات /api/sick-leave/* ───
   =========================================================================
   وحدة مستقلّة: لا تعرف أجير ولا تصاريحه، ولا تشترط أن يكون صاحب الإجازة
   موظفًا في المنصّة. الربط بسجلّ موظف تحسينٌ اختياري بعد التحقّق.

   الخصوصية:
     • الملفّ يُقرأ في الذاكرة ثم يُترك — لا Blob، لا قرص، لا Git، لا قاعدة.
     • لا يُسجَّل رقم الهوية كاملًا، ولا الاسم، ولا محتوى الملفّ — لا في
       audit_log ولا في console. السجلّ يحمل الهوية مقنَّعة وبصمات HMAC.
     • الحقول المستخرجة تعود إلى المتصفّح نفسه الذي رفع الملفّ (يحتاجها
       لنسخها في استعلام «صحة»)، داخل توكن موقَّع يمنع تعديلها بين الخطوتين.

   الحدّ من الاستخدام يُعدّ في audit_log (Neon) لا في الذاكرة: كل طلب على
   Vercel قد يقع على نسخة دالّة مختلفة، فعدّاد الذاكرة ضابطٌ وهمي. */

const OFFICIAL_URL = "https://www.seha.sa/ui#/inquiries/slenquiry";

const RATE = {
  windowMinutes: 10,
  maxExtracts: 20,
  maxVerifications: 30,
  duplicateWindowMinutes: 30,
};
const TOKEN_TTL_MS = 30 * 60 * 1000;

const EV_EXTRACT = "sick_leave_extract";
const EV_VERIFY = "sick_leave_verification";

const MESSAGES = {
  empty: "الملف فارغ.",
  too_large: `حجم الملف أكبر من الحدّ المسموح (${Math.round(FILE_LIMITS.maxBytes / 1024 / 1024)} ميغابايت).`,
  too_small: "الملف صغير جدًا ولا يمكن أن يكون تقرير إجازة.",
  unsupported_type: "نوع الملف غير مدعوم. ارفع PDF أو صورة PNG/JPEG.",
  type_mismatch: "محتوى الملف لا يطابق نوعه المُعلَن.",
  malformed: "تعذّر قراءة الملف: ملف PDF تالف أو غير مكتمل.",
  encrypted: "الملف محمي بكلمة مرور ولا يمكن قراءته.",
  too_many_pages: "عدد صفحات الملف أكبر من تقرير إجازة مرضية.",
  too_complex: "الملف معقّد بشكل غير معتاد لتقرير إجازة ولم يُقرأ.",
  timeout: "استغرقت قراءة الملف وقتًا أطول من المسموح.",
  not_sick_leave: "الملف لا يبدو تقرير إجازة مرضية: لم يُعثر فيه على رمز إجازة ولا على عنوان «إجازة مرضية».",
  rate_limited: "تجاوزت عدد المحاولات المسموح خلال 10 دقائق. حاول بعد قليل.",
  bad_token: "انتهت صلاحية جلسة التحقق لهذا الملف. ارفع الملف من جديد.",
};

/* ---------- أدوات ---------- */

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET غير مُهيّأ على الخادم");
  return s;
}

const hmacHex = (label, value) => crypto.createHmac("sha256", secret()).update(`sick-leave:${label}:${value}`).digest("hex").slice(0, 32);

function maskId(id) {
  const d = normId(id);
  if (!d) return null;
  if (d.length <= 4) return "•".repeat(d.length);
  return "•".repeat(d.length - 4) + d.slice(-4);
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret()).update(`sick-leave-token:${body}`).digest("base64url");
  return `${body}.${sig}`;
}

function readToken(token, actorId, now) {
  if (typeof token !== "string" || token.length > 8192) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret()).update(`sick-leave-token:${body}`).digest();
  let given;
  try { given = Buffer.from(sig, "base64url"); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || p.v !== 1 || p.sub !== String(actorId) || !(p.exp > now)) return null;
  return p;
}

/* الحقول التي تُرى في الواجهة: الهوية مقنَّعة، والكاملة تبقى في التوكن
   وفي idNumber لزرّ «نسخ» وحده. */
function publicFields(fields) {
  const f = fields || {};
  return {
    leaveId: f.leaveId || null,
    idNumber: f.idNumber || null,
    idMasked: maskId(f.idNumber),
    name: f.name || null,
    startDate: f.startDate || null,
    endDate: f.endDate || null,
    days: f.days != null ? f.days : null,
    issueDate: f.issueDate || null,
    nationality: f.nationality || null,
    employer: f.employer || null,
    practitioner: f.practitioner || null,
    position: f.position || null,
    facility: f.facility || null,
  };
}

function tokenFields(fields) {
  const f = fields || {};
  const keep = ["leaveId", "idNumber", "name", "startDate", "endDate", "days", "issueDate", "practitioner", "facility"];
  return Object.fromEntries(keep.filter((k) => f[k] != null && f[k] !== "").map((k) => [k, f[k]]));
}

/* ---------- الحدّ من الاستخدام وكشف التكرار ---------- */

async function usage(deps, actorId, type, fileRef) {
  try {
    const sql = deps.getSql();
    const rows = await sql`
      SELECT
        count(*) FILTER (WHERE ts > now() - make_interval(mins => ${RATE.windowMinutes}))::int AS recent,
        max(ts) FILTER (WHERE ${fileRef || null}::text IS NOT NULL AND meta->>'fileRef' = ${fileRef || null}::text) AS dup_ts
      FROM audit_log
      WHERE type = ${type} AND actor_id = ${String(actorId)}
        AND ts > now() - make_interval(mins => ${Math.max(RATE.windowMinutes, RATE.duplicateWindowMinutes)})`;
    const r = rows[0] || {};
    return { recent: Number(r.recent) || 0, duplicateAt: r.dup_ts || null };
  } catch (err) {
    /* القاعدة غير متاحة: لا نحجب الأداة على عطل في العدّاد (الجلسة نفسها
       تستلزم القاعدة، فهذا عطل عابر)، ونُبلغ في السجلّ بلا أي بيانات. */
    console.error("sick-leave usage check failed:", err && err.message);
    return { recent: 0, duplicateAt: null, unchecked: true };
  }
}

/* ---------- المسارات ---------- */

async function handle(req, res, actor, action, deps) {
  const can = (a) => deps.hasPermission(actor, "sick_leave", a);
  if (!can("view")) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });

  if (action === "config") {
    return res.status(200).json({
      ok: true,
      directIntegration: false,
      officialUrl: OFFICIAL_URL,
      canVerify: can("verify"),
      maxBytes: FILE_LIMITS.maxBytes,
      accept: ["application/pdf", "image/png", "image/jpeg"],
    });
  }
  if (action !== "extract" && action !== "verify") return res.status(404).json({ ok: false, error: "Not found" });
  if (!can("verify")) return res.status(403).json({ ok: false, error: "صلاحيات غير كافية" });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  return action === "extract" ? extract(req, res, actor, deps) : verify(req, res, actor, deps);
}

async function extract(req, res, actor, deps) {
  const now = deps.now();
  let body;
  try {
    body = await deps.readBody(req);
  } catch {
    return res.status(413).json({ ok: false, reason: "too_large", error: MESSAGES.too_large });
  }
  const fileName = displayName(req.headers["x-filename"]);
  const check = validateUpload(body, req.headers["content-type"]);
  if (!check.ok) return res.status(check.reason === "too_large" ? 413 : 415).json({ ok: false, reason: check.reason, error: MESSAGES[check.reason] });

  const fileRef = hmacHex("file", crypto.createHash("sha256").update(body).digest("hex"));
  const use = await usage(deps, actor.id, EV_EXTRACT, fileRef);
  if (use.recent >= RATE.maxExtracts) {
    res.setHeader("Retry-After", String(RATE.windowMinutes * 60));
    return res.status(429).json({ ok: false, reason: "rate_limited", error: MESSAGES.rate_limited });
  }

  let result;
  if (check.kind === "pdf") {
    result = await extractSickLeave(body, { timeoutMs: deps.parseTimeoutMs });
  } else {
    /* لا OCR: لا مكتبة محلية في المنصّة، والخدمات الخارجية ممنوعة لهذه
       البيانات. الصورة تُقبل والحقول تُدخل يدويًا من المستخدم. */
    result = { ok: false, reason: "image" };
  }
  body = null; // لا مرجع يبقى للبايتات بعد القراءة

  const manualReasons = new Set(["scanned", "image"]);
  const status = result.ok ? result.status : manualReasons.has(result.reason) ? "needs_manual" : "unreadable";
  await deps.logEvent({
    type: EV_EXTRACT,
    actorEmail: actor.email,
    actorId: actor.id,
    meta: { fileRef, kind: check.kind, status, reason: result.ok ? null : result.reason, missing: result.ok ? result.missing : undefined },
  });

  if (status === "unreadable") {
    return res.status(422).json({ ok: false, reason: result.reason, error: MESSAGES[result.reason] || MESSAGES.malformed, fileName });
  }

  const fields = result.ok ? result.fields : {};
  const token = signToken({
    v: 1,
    sub: String(actor.id),
    exp: now + TOKEN_TTL_MS,
    ref: fileRef,
    src: result.ok ? "pdf_text" : "manual_entry",
    f: tokenFields(fields),
  });
  return res.status(200).json({
    ok: true,
    status,                       // extracted | partial | needs_manual
    reason: result.ok ? null : result.reason, // scanned | image
    fileName,
    kind: check.kind,
    fields: publicFields(fields),
    missing: result.ok ? result.missing : ["leaveId", "idNumber", "startDate", "endDate"],
    warnings: result.ok ? result.warnings : [],
    qr: result.ok ? result.qr : { found: false },
    duplicate: use.duplicateAt ? { at: use.duplicateAt } : null,
    token,
    officialUrl: OFFICIAL_URL,
  });
}

/* ---------- التحقّق ---------- */

const LEAVE_ID_OK = /^[A-Z0-9]{6,24}$/;

function cleanFileOverrides(input) {
  const o = input && typeof input === "object" ? input : {};
  const out = {};
  if (o.leaveId != null && o.leaveId !== "") out.leaveId = normLeaveId(o.leaveId);
  if (o.idNumber != null && o.idNumber !== "") out.idNumber = normId(o.idNumber);
  if (o.name != null && o.name !== "") out.name = String(o.name).replace(/\s+/g, " ").trim().slice(0, 120);
  if (o.startDate) out.startDate = normDate(o.startDate) || "invalid";
  if (o.endDate) out.endDate = normDate(o.endDate) || "invalid";
  if (o.days != null && o.days !== "") out.days = Number(o.days);
  return out;
}

function validateFile(f) {
  const errors = {};
  if (!f.leaveId) errors.leaveId = "required";
  else if (!LEAVE_ID_OK.test(f.leaveId)) errors.leaveId = "format";
  if (!f.idNumber) errors.idNumber = "required";
  else if (!/^\d{10}$/.test(f.idNumber)) errors.idNumber = "format";
  if (!f.startDate) errors.startDate = "required";
  else if (f.startDate === "invalid") errors.startDate = "format";
  if (!f.endDate) errors.endDate = "required";
  else if (f.endDate === "invalid") errors.endDate = "format";
  if (f.startDate && f.endDate && f.startDate !== "invalid" && f.endDate !== "invalid" && f.endDate < f.startDate) errors.endDate = "before_start";
  if (f.days != null && !(Number.isInteger(f.days) && f.days >= 1 && f.days <= 365)) errors.days = "format";
  return errors;
}

const OUTCOMES = new Set(["found", "not_found", "unavailable"]);

function validateOfficial(o, file) {
  const errors = {};
  const off = o && typeof o === "object" ? o : {};
  if (!OUTCOMES.has(off.outcome)) errors.outcome = "required";
  const entry = { outcome: off.outcome };
  if (off.outcome === "found") {
    /* «صحة» لا تُرجع نتيجة إلا لرمز الإجازة ورقم الهوية اللذين استُعلم بهما؛
       فإن لم يُذكرا فهما ما في الملفّ. */
    entry.leaveId = normLeaveId(off.leaveId) || file.leaveId;
    entry.idNumber = normId(off.idNumber) || file.idNumber;
    entry.startDate = normDate(off.startDate);
    entry.endDate = normDate(off.endDate);
    if (!off.startDate) errors.officialStartDate = "required"; else if (!entry.startDate) errors.officialStartDate = "format";
    if (!off.endDate) errors.officialEndDate = "required"; else if (!entry.endDate) errors.officialEndDate = "format";
    if (entry.idNumber && !/^\d{10}$/.test(entry.idNumber)) errors.officialIdNumber = "format";
    if (off.name) entry.name = String(off.name);
    if (off.days != null && off.days !== "") {
      entry.days = Number(off.days);
      if (!(Number.isInteger(entry.days) && entry.days >= 1 && entry.days <= 365)) errors.officialDays = "format";
    }
    if (off.practitioner) entry.practitioner = String(off.practitioner);
  }
  return { entry, errors };
}

/* ربط اختياري بموظف قائم — رقم الهوية حرفيًا (أرقامًا فقط)، سجلّ واحد فقط.
   لا يُكتب شيء. أي عطل يُتجاهل: التحقّق لا يتوقّف على وجود موظف. */
async function findEmployee(deps, actor, idNumber) {
  if (!idNumber || !deps.hasPermission(actor, "employees", "view")) return null;
  try {
    const sql = deps.getSql();
    const rows = await sql`
      SELECT eid, data->>'اسم العامل' AS name FROM employees
      WHERE regexp_replace(coalesce(iqama, ''), '[^0-9]', '', 'g') = ${idNumber}
      LIMIT 2`;
    return rows.length === 1 && rows[0].eid != null ? { eid: String(rows[0].eid), name: rows[0].name || null } : null;
  } catch {
    return null;
  }
}

function maskDiff(d) {
  if (d.field !== "idNumber") return d;
  return { ...d, file: maskId(d.file), official: maskId(d.official) };
}

async function verify(req, res, actor, deps) {
  const now = deps.now();
  const body = deps.parseBody(req) || {};
  const tok = readToken(body.token, actor.id, now);
  if (!tok) return res.status(400).json({ ok: false, reason: "bad_token", error: MESSAGES.bad_token });

  const use = await usage(deps, actor.id, EV_VERIFY, null);
  if (use.recent >= RATE.maxVerifications) {
    res.setHeader("Retry-After", String(RATE.windowMinutes * 60));
    return res.status(429).json({ ok: false, reason: "rate_limited", error: MESSAGES.rate_limited });
  }

  /* الحقول المقروءة من الملفّ موقَّعة ولا تُعدَّل. ما لم يُقرأ (ملفّ ممسوح،
     صورة، أو حقل ناقص) يُكمله المستخدم، ويُوسَم التحقّق بذلك. */
  const overrides = cleanFileOverrides(body.file);
  const signed = tok.f || {};
  const file = { ...signed };
  const manualFields = [];
  for (const [k, v] of Object.entries(overrides)) {
    if (signed[k] == null || signed[k] === "") { file[k] = v; manualFields.push(k); }
  }
  const fileErrors = validateFile(file);
  const { entry, errors: officialErrors } = validateOfficial(body.official, file);
  const errors = { ...fileErrors, ...officialErrors };
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, reason: "invalid_input", error: "أكمل الحقول المطلوبة بصيغة صحيحة.", fields: errors });

  const lookup = await runLookup(manualProvider(entry), { leaveId: file.leaveId, idNumber: file.idNumber }, { timeoutMs: deps.lookupTimeoutMs });
  const result = compareWithOfficial(file, lookup);
  const verificationId = "slv_" + crypto.randomBytes(8).toString("hex");
  const checkedAt = new Date(now).toISOString();
  const employee = result.status === "verified" || result.status === "mismatch" ? await findEmployee(deps, actor, file.idNumber) : null;

  const fileSource = manualFields.length === 0 ? tok.src : tok.src === "pdf_text" ? "pdf_text_completed_manually" : "manual_entry";
  await deps.logEvent({
    type: EV_VERIFY,
    actorEmail: actor.email,
    actorId: actor.id,
    targetId: verificationId,
    meta: {
      verificationId,
      status: result.status,
      reason: result.reason,
      source: lookup.source || "seha_manual",
      fileSource,
      maskedId: maskId(file.idNumber),
      leaveRef: hmacHex("leave", file.leaveId),
      fileRef: tok.ref,
      differences: result.differences.map((d) => d.code),
      notes: result.notes.map((n) => n.code),
      employeeEid: employee ? employee.eid : null,
    },
  });

  return res.status(200).json({
    ok: true,
    verificationId,
    checkedAt,
    status: result.status,
    reason: result.reason,
    source: lookup.source || "seha_manual",
    fileSource,
    manualFields,
    leave: {
      leaveId: file.leaveId,
      idMasked: maskId(file.idNumber),
      name: file.name || null,
      officialName: entry.name || null,
      startDate: file.startDate,
      endDate: file.endDate,
      days: file.days != null ? file.days : null,
      officialDays: entry.days != null ? entry.days : null,
      practitioner: file.practitioner || entry.practitioner || null,
      facility: file.facility || null,
    },
    checks: result.checks,
    differences: result.differences.map(maskDiff),
    notes: result.notes,
    employee,
  });
}

module.exports = { handle, maskId, signToken, readToken, OFFICIAL_URL, RATE, MESSAGES, EV_EXTRACT, EV_VERIFY };
