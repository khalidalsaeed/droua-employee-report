/* ─── مداخل بيانات القسم ───────────────────────────────────────────────
   =========================================================================
   كلّها تحت `/secure-audit/api/…` وكلّها **داخل سياق البوابة**: الموجّه لا
   يبلغ هذه الوحدة إلا بعد `requireDrouaAccess(..., { needGate: true })`،
   ويشغّلها داخل `run()`. فدالّةٌ هنا تنسى الحارس لا تعمل أصلًا.

   ── الرفع عبر JSON بترميز base64، لا multipart ──
   ثلاثة أسباب: لا اعتماد جديد لتفكيك multipart؛ وحدُّ جسم الطلب على
   Vercel أقلّ من 4.5 ميغابايت فالمكسب من الرفع الثنائيّ الخام محدود أصلًا؛
   والأهمّ أن البايتات تصل الخادم **قبل** أن تُشفَّر — فالمسار كلّه يبقى في
   يدنا بلا رفعٍ مباشر إلى المتجر يلتفّ على التشفير.

   وحدّ الرفع هنا (3 ميغابايت) أضيق من حدّ التخزين (10) عمدًا: الأول قيد
   نقلٍ يفرضه المنصّة، والثاني قيد تشفيرٍ وذاكرة. وخلطهما كان سيجعل ملفًّا
   مقبولًا في الطبقة يُرفض في الشبكة بلا رسالة مفهومة. */

const files = require("./files");
const storage = require("./storage");
const runs = require("./runs");
const findings = require("./findings");
const analyze = require("./analyze");
const audit = require("./audit");
const H = require("./headers");
const gateContext = require("./gateContext");

/* 3 MiB بعد فكّ الترميز ≈ 4 MiB نصًّا — دون حدّ المنصّة بهامش. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const UPLOAD_KEYS = ["kind", "fileName", "format", "data", "replace"];

const UUID_SEG = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";

function ok(res, body) {
  H.secureApi(res);
  return res.status(200).json({ ok: true, ...body });
}

/* رسالة الخطأ نصٌّ مقنَّن من الخادم — لا صدى لما أرسله العميل، ولا تفصيل
   يكشف بنية داخلية. والحالة 400 لكل خطأ مدخلات: تمييزُ «غير موجود» عن
   «غير مسموح» داخل القسم لا يفيد أحدًا هنا وقد يفيد من يستكشف. */
function bad(res, message, status = 400) {
  H.secureApi(res);
  return res.status(status).json({ ok: false, error: message });
}

function decodeUpload(body) {
  if (!body || typeof body !== "object") throw new Error("طلبٌ غير صالح");
  for (const key of Object.keys(body)) {
    if (!UPLOAD_KEYS.includes(key)) throw new Error(`حقل غير معروف: ${key}`);
  }
  const data = String(body.data || "");
  if (!data) throw new Error("لا ملفّ في الطلب");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("ترميز غير صالح");
  /* الحدّ يُقاس على النصّ **قبل** فكّ الترميز: فكُّ عشرين ميغابايت لنكتشف
     أنها ممنوعة إنفاقُ ذاكرةٍ على ما سيُرفض. */
  if (data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 8) throw new Error("الملفّ أكبر من الحدّ");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new Error("ملفّ فارغ");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("الملفّ أكبر من الحدّ");
  return {
    bytes,
    kind: String(body.kind || ""),
    fileName: String(body.fileName || ""),
    format: String(body.format || ""),
    replace: body.replace === true,
  };
}

/* اسم الملفّ في ترويسة التنزيل: RFC 5987، ومحارف التحكّم منزوعة قبلها.
   وسطرٌ جديد في اسمٍ يمرّ إلى الترويسة يصير حقن ترويسات — والطبقات ثلاث:
   تنقيةٌ في files.js، وقيدٌ في القاعدة، وهذه. */
function contentDisposition(fileName) {
  const clean = String(fileName || "file").replace(/[\u0000-\u001f\u007f"\\]/g, "");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_") || "file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/* ─── المعالجات ──────────────────────────────────────────────────────── */

async function listRuns(req, res, { sql }) {
  const rows = await runs.listRuns(sql);
  const [fileCounts, findingCounts] = await Promise.all([
    files.countsByRun(sql),
    findings.summaryByRun(sql),
  ]);
  return ok(res, {
    kinds: files.KINDS.map((kind) => ({ kind, label: files.KIND_LABELS[kind] })),
    runs: rows.map((run) => ({
      ...run,
      filesPresent: fileCounts.get(run.runId) || 0,
      filesExpected: files.KINDS.length,
      findings: findingCounts.get(run.runId) || { total: 0, open: 0, critical: 0, needsReview: 0 },
    })),
  });
}

async function createRun(req, res, { sql, ctx }) {
  const period = String((req.body || {}).period || "");
  let run;
  try {
    run = await runs.createRun(sql, period);
  } catch (err) {
    if (err.code === "bad_period") return bad(res, "الشهر بصيغة غير صالحة");
    /* التفرّد على period: الشهر موجود سلفًا. */
    if (/duplicate key/i.test(err.message || "")) return bad(res, "هذا الشهر موجود بالفعل");
    throw err;
  }
  await audit.log(sql, { event: "run_created", userId: ctx.actorId, meta: { runId: run.runId } });
  return ok(res, { run });
}

async function getRun(req, res, { sql, params }) {
  const run = await runs.getRun(sql, params[0]);
  if (!run) return bad(res, "شهرٌ غير موجود", 404);
  const [slots, summary] = await Promise.all([
    runs.fileSlots(sql, run.runId),
    findings.summary(sql, run.runId),
  ]);
  return ok(res, {
    run,
    slots,
    complete: runs.isComplete(slots),
    previousPeriod: runs.previousPeriod(run.period),
    findings: summary,
    statuses: findings.STATUSES.map((s) => ({ value: s, label: findings.STATUS_LABELS[s] })),
  });
}

async function deleteRun(req, res, { sql, ctx, params }) {
  const result = await runs.deleteRun(sql, params[0], ctx);
  await audit.log(sql, {
    event: "run_deleted", userId: ctx.actorId,
    meta: { runId: params[0], reason: result.deleted ? "done" : "purge_failed" },
  });
  if (!result.deleted) return bad(res, "تعذّر محو بايتات بعض الملفّات — أعد المحاولة");
  return ok(res, result);
}

async function uploadFile(req, res, { sql, ctx, params }) {
  let upload;
  try {
    upload = decodeUpload(req.body);
  } catch (err) {
    return bad(res, err.message);
  }
  const input = {
    runId: params[0], kind: upload.kind, fileName: upload.fileName,
    format: upload.format, bytes: upload.bytes,
  };
  try {
    const result = upload.replace
      ? await files.replaceFile(sql, input, ctx)
      : await files.putFile(sql, input, ctx);
    await audit.log(sql, {
      event: upload.replace ? "file_replaced" : "file_uploaded", userId: ctx.actorId,
      meta: { runId: input.runId, kind: input.kind, fileId: result.file.fileId },
    });
    return ok(res, result);
  } catch (err) {
    if (err.code === "already_current") return bad(res, "لهذا النوع ملفٌّ في الشهر — استعمل الاستبدال");
    if (err.code) return bad(res, "بيانات الرفع غير صالحة");
    throw err;
  }
}

async function downloadFile(req, res, { sql, ctx, params }) {
  let result;
  try {
    result = await files.readFile(sql, params[0], ctx);
  } catch (err) {
    /* فشل السلامة سُجّل داخليًّا في files.readFile بسببه المحدَّد. أمّا ما
       ليس فشل سلامة — مفتاح غائب، أو توكن، أو عطل شبكة — فلا يُسجَّل هناك،
       وردُّ 404 وحده يجعله يختفي تمامًا: يشتكي المستخدم أن الملفّ «غير
       موجود» ولا شيء في السجلّ يقول لماذا. فيُسجَّل هنا باسم الصنف وحده. */
    if (!err || !err.reason) {
      await audit.log(sql, {
        event: "file_download_failed", userId: ctx.actorId,
        meta: { fileId: params[0], reason: (err && err.code) || (err && err.name) || "error" },
      });
    }
    return H.notFoundApi(res);
  }
  await audit.log(sql, {
    event: "file_downloaded", userId: ctx.actorId,
    meta: { fileId: result.file.fileId, runId: result.file.runId, kind: result.file.kind },
  });
  H.secureApi(res);
  /* النوع قسريّ من القائمة المغلقة — لا من الصفّ ولا من العميل. */
  res.setHeader("Content-Type", storage.safeContentType(result.file.format));
  res.setHeader("Content-Disposition", contentDisposition(result.file.fileName));
  res.setHeader("Content-Length", String(result.bytes.length));
  /* مرفقٌ دائمًا ونوعٌ قسريّ — وهذه طبقةٌ ثالثة: لو فُتح الملفّ في سياقنا
     يومًا بخطأ، فلا شيء فيه ينفّذ ولا يجلب. */
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  return res.status(200).end(result.bytes);
}

async function deleteFile(req, res, { sql, ctx, params }) {
  const result = await files.deleteFile(sql, params[0], ctx);
  await audit.log(sql, {
    event: "file_deleted", userId: ctx.actorId,
    meta: { fileId: params[0], reason: result.purged ? "done" : "purge_failed" },
  });
  if (!result.deleted) return bad(res, "غير موجود", 404);
  return ok(res, result);
}

async function analyzeRun(req, res, { sql, ctx, params }) {
  let result;
  try {
    result = await analyze.analyzeRun(sql, params[0], ctx);
  } catch (err) {
    if (err.code === "not_found") return bad(res, "شهرٌ غير موجود", 404);
    throw err;
  }
  await audit.log(sql, {
    event: "run_analyzed", userId: ctx.actorId,
    meta: { runId: params[0], attempts: result.total },
  });
  return ok(res, { analysis: result });
}

async function listFindings(req, res, { sql, params, apiPath }) {
  /* «كل الملاحظات» مقطعُ مسار لا معاملَ استعلام: إعادة الكتابة على المنصّة
     تُمرِّر المسار في `apiPath` ولا ضمان لبقاء معاملات الاستعلام الأصلية
     معه — فما يعتمد عليها يعمل محلّيًّا ويصمت في الإنتاج. */
  const includeResolved = /\/findings\/all$/.test(String(apiPath || ""));
  const [list, summary] = await Promise.all([
    findings.listFindings(sql, params[0], { includeResolved }),
    findings.summary(sql, params[0]),
  ]);
  return ok(res, { findings: list, summary });
}

async function patchFinding(req, res, { sql, ctx, params }) {
  const body = req.body || {};
  const patch = {};
  if ("status" in body) patch.status = body.status;
  if ("userNote" in body) patch.userNote = body.userNote;
  try {
    const finding = await findings.updateFinding(sql, params[0], patch);
    await audit.log(sql, {
      event: "finding_updated", userId: ctx.actorId,
      meta: { findingId: params[0], runId: finding.runId, reason: finding.status },
    });
    return ok(res, { finding });
  } catch (err) {
    if (err.code === "not_found") return bad(res, "غير موجودة", 404);
    if (err.code) return bad(res, "تعديلٌ غير مقبول");
    throw err;
  }
}

/* ─── جدول التوزيع ───────────────────────────────────────────────────── */

const ROUTES = [
  ["GET", /^runs$/, listRuns],
  ["POST", /^runs$/, createRun],
  ["GET", new RegExp(`^runs/${UUID_SEG}$`), getRun],
  ["DELETE", new RegExp(`^runs/${UUID_SEG}$`), deleteRun],
  ["POST", new RegExp(`^runs/${UUID_SEG}/files$`), uploadFile],
  ["POST", new RegExp(`^runs/${UUID_SEG}/analyze$`), analyzeRun],
  ["GET", new RegExp(`^runs/${UUID_SEG}/findings$`), listFindings],
  ["GET", new RegExp(`^runs/${UUID_SEG}/findings/all$`), listFindings],
  ["GET", new RegExp(`^files/${UUID_SEG}/download$`), downloadFile],
  ["DELETE", new RegExp(`^files/${UUID_SEG}$`), deleteFile],
  ["PATCH", new RegExp(`^findings/${UUID_SEG}$`), patchFinding],
];

/* مسارٌ معروف بفعلٍ خاطئ يُردّ 404 كالمجهول تمامًا: 405 يؤكّد وجود المسار،
   وهو تأكيدٌ لا يحتاجه إلا من يستكشف. */
function match(method, apiPath) {
  for (const [verb, pattern, handler] of ROUTES) {
    if (verb !== method) continue;
    const found = pattern.exec(apiPath);
    if (found) return { handler, params: found.slice(1) };
  }
  return null;
}

async function handle(req, res, context) {
  /* تأكيدٌ ثانٍ للسياق. الموجّه يفتحه قبل النداء، وهذا السطر يجعل الوحدة
     لا تعتمد على أن كل مُنادٍ مستقبليّ سيتذكّر. */
  gateContext.requireGate();
  const found = match(req.method, context.apiPath);
  if (!found) return H.notFoundApi(res);
  return found.handler(req, res, { ...context, params: found.params });
}

module.exports = { handle, match, ROUTES, MAX_UPLOAD_BYTES, decodeUpload, contentDisposition };
