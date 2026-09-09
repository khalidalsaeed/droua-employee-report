/* ─── ملفّات القسم: التنسيق بين القاعدة والتخزين ───────────────────────
   =========================================================================
   الطبقة الوحيدة التي تعرف الاثنين معًا: `storage.js` يعرف البايتات ولا
   يعرف Neon، والموجّه يعرف HTTP ولا يعرف أيًّا منهما. وهنا يلتقيان.

   ── ثلاث قواعد تحكم كل دالّة هنا ──

   ① **لا شيء يبلغ هذه الوحدة إلا من بوابةٍ مفتوحة.** أول سطر في كل دالّة
     `gateContext.requireGate()` — فمسارٌ مستقبليّ يُنسى فيه الحارس يأخذ
     استثناءً في CI بدل أن يقدّم ملفًّا في الإنتاج.

   ② **المسار يأتي من الصفّ، لا من الطلب.** كل قراءة تبدأ بـfileId وتنتهي
     بمسارٍ قرأته القاعدة. ولا دالّة هنا تقبل `blob_pathname` مدخلًا.

   ③ **ترتيب الفشل مقصود في كل مسار.** والقاعدة الحاكمة: لا تُحذف بايتاتُ
     الملفّ المعتمد قبل أن تصير القاعدة قد اعتمدت بديله. */

const crypto = require("crypto");
const storage = require("./storage");
const gateContext = require("./gateContext");
const audit = require("./audit");

const KINDS = Object.freeze(["cash", "full", "transfer", "employees"]);

/* ما يُقبل من الطلب — لا أكثر. */
const INPUT_KEYS = Object.freeze(["runId", "kind", "fileName", "format", "bytes"]);

/* وما لا يُقبل منه أبدًا، مذكورًا بالاسم. القائمة الضيّقة أعلاه تكفي
   لردّها، لكن الرفض بالاسم يُنتج رسالة تقول ما الخطأ، ويُنتج اختبارًا
   يفشل بوضوح يوم يوسّع أحدهم المدخلات بلا انتباه. */
const CLIENT_FORBIDDEN = Object.freeze([
  "fileId", "id",
  "blobPathname", "blob_pathname", "pathname",
  "encIv", "enc_iv", "encTag", "enc_tag", "encKeyId", "enc_key_id", "encAlgo", "enc_algo",
  "contentType", "content_type",
  "plaintextSha256", "plaintext_sha256", "sizeBytes", "size_bytes",
  "createdAt", "created_at", "supersededAt", "superseded_at",
  "deletedAt", "deleted_at", "purgedAt", "purged_at",
]);

const MAX_FILE_NAME = 255;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ما يخرج من هذه الوحدة إلى ما فوقها. المسار والـIV والوسم **لا تغادرها**:
   موجّهٌ يُرجع الصفّ كما هو يومًا لن يسرّبها، لأنها ليست فيه أصلًا. */
function publicView(row) {
  if (!row) return null;
  return {
    fileId: row.id,
    runId: row.run_id,
    kind: row.kind,
    fileName: row.file_name,
    format: row.format,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    isCurrent: !row.superseded_at,
    supersededAt: row.superseded_at || null,
  };
}

/* اسم العرض: يُنقّى ولا يُرفض — إلا إن لم يبقَ منه شيء.
     • محارف التحكّم: سطرٌ جديد في اسم ملفّ = حقن ترويسات في
       Content-Disposition عند التنزيل.
     • فواصل المسارات: الاسم لا يبلغ المتجر أصلًا، لكن بقاءه نظيفًا يمنع
       أن يصير مسارًا يوم يُستعمل في تنزيل أو أرشفة.
     • محارف قلب الاتجاه: تجعل «fdp.exe» يُعرض «exe.pdf». والملفّ يُقدَّم
       مرفقًا بنوعٍ قسريّ، فالخداع بصريّ لا تنفيذيّ — ويُنزع مع ذلك. */
function normalizeFileName(raw) {
  const value = String(raw == null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  if (!value || value.length > MAX_FILE_NAME) throw fail("اسم ملفّ غير صالح", "bad_file_name");
  return value;
}

function assertFileId(fileId) {
  if (typeof fileId !== "string" || !UUID_RE.test(fileId)) throw fail("fileId غير صالح", "bad_file_id");
  return fileId;
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("مدخل غير صالح", "bad_input");
  for (const key of Object.keys(input)) {
    if (CLIENT_FORBIDDEN.includes(key)) throw fail(`حقل لا يُقبل من الطلب: ${key}`, "forbidden_field");
    if (!INPUT_KEYS.includes(key)) throw fail(`حقل غير معروف: ${key}`, "unknown_field");
  }
  const runId = String(input.runId || "");
  if (!UUID_RE.test(runId)) throw fail("runId غير صالح", "bad_run_id");
  const kind = String(input.kind || "");
  if (!KINDS.includes(kind)) throw fail("kind غير مسموح", "bad_kind");
  const format = String(input.format || "");
  /* يرمي على ما ليس في القائمة المغلقة — ونوع المحتوى يُشتقّ هنا ولا
     يُقبل من أحد. */
  const contentType = storage.safeContentType(format);
  return { runId, kind, format, contentType, fileName: normalizeFileName(input.fileName), bytes: input.bytes };
}

/* ─── استعلامات ──────────────────────────────────────────────────────── */

async function currentRow(sql, runId, kind) {
  const rows = await sql`SELECT * FROM droua_payroll_files
    WHERE run_id = ${runId}::uuid AND kind = ${kind} AND superseded_at IS NULL`;
  return (rows && rows[0]) || null;
}

async function rowById(sql, fileId) {
  const rows = await sql`SELECT * FROM droua_payroll_files WHERE id = ${fileId}::uuid`;
  return (rows && rows[0]) || null;
}

/* تُبنى ولا تُنتظر: تُنتظر وحدها أو تُمرَّر إلى sql.transaction. */
function insertQuery(sql, d) {
  return sql`INSERT INTO droua_payroll_files
    (id, run_id, kind, blob_pathname, file_name, format, content_type,
     size_bytes, plaintext_sha256, enc_algo, enc_key_id, enc_iv, enc_tag)
    VALUES (${d.fileId}::uuid, ${d.runId}::uuid, ${d.kind}, ${d.pathname}, ${d.fileName},
            ${d.format}, ${d.contentType}, ${d.sizeBytes}, ${d.plaintextSha256},
            ${d.encAlgo}, ${d.encKeyId}, ${d.encIv}, ${d.encTag})
    RETURNING *`;
}

/* ─── التراجع والكنس ─────────────────────────────────────────────────── */

/* نجح الرفع وفشلت القاعدة: كائنٌ **بلا صفّ**. ولا شيء في النظام يعرف
   بوجوده — لا واجهة ولا استعلام — فإن فشل حذفه أيضًا لم يبقَ من يذكره إلا
   سطر التدقيق هذا. ولذلك يُسجَّل بمساره: هو الوحيد القابل للكنس يدويًّا. */
async function rollbackObject(sql, pathname, ctx, meta) {
  let removed = false;
  try { removed = (await storage.remove(pathname)).removed; } catch (err) { removed = false; }
  if (!removed) {
    await audit.log(sql, {
      event: "blob_orphan", userId: (ctx && ctx.actorId) || null,
      meta: { ...meta, pathname, reason: "insert_failed" },
    });
  }
  return removed;
}

/* كائنٌ **له صفّ** لم يعد حاليًّا. حذفه أفضل جهد: إن فشل بقي الصفّ بـ
   purged_at فارغًا، فيلتقطه المسح لاحقًا. ولا يضيع أثره كما يضيع اليتيم. */
async function purgeObject(sql, row, ctx) {
  let removed = false;
  try { removed = (await storage.remove(row.blob_pathname)).removed; } catch (err) { removed = false; }
  if (removed) {
    /* لو فشل هذا التحديث بعد نجاح الحذف لبقي الصفّ يبدو غير مطهَّر؛ ومسحٌ
       تالٍ يعيد حذف كائن غير موجود — وحذف المتجر عمليّة خاملة تنجح — فيُضبط
       العمود حينها. أي أن الحالة تُصلح نفسها. */
    await sql`UPDATE droua_payroll_files SET purged_at = now() WHERE id = ${row.id}::uuid`;
    return true;
  }
  await audit.log(sql, {
    event: "blob_stale", userId: (ctx && ctx.actorId) || null,
    meta: { fileId: row.id, runId: row.run_id, kind: row.kind, pathname: row.blob_pathname, reason: "purge_failed" },
  });
  return false;
}

/* ─── الرفع ──────────────────────────────────────────────────────────── */

async function uploadAndInsert(sql, v, ctx, oldRow) {
  /* الهويّة تُولَّد على الخادم. ولا تُقبل من الطلب بحال — انظر
     CLIENT_FORBIDDEN: هي أول ما يُردّ. */
  const fileId = crypto.randomUUID();

  const desc = await storage.putEncrypted({
    fileId, runId: v.runId, kind: v.kind, bytes: v.bytes, format: v.format,
  });
  const d = { fileId, ...v, ...desc };

  let inserted = null;
  try {
    if (oldRow) {
      /* الرفع ثمّ **معاملة واحدة**: يُرفع وصف «الحاليّ» عن القديم ويُكتب
         الجديد معًا أو لا يقع أيّهما. فلا لحظةَ لا حاليَّ فيها، ولا لحظةَ
         حاليّان. واستبدالان متزامنان: أحدهما يصطدم بالفهرس الفريد الجزئيّ
         ويتراجع كاملًا — القاعدة تحسم لا ترتيبُ الوصول. */
      const results = await sql.transaction([
        sql`UPDATE droua_payroll_files SET superseded_at = now()
              WHERE id = ${oldRow.id}::uuid AND superseded_at IS NULL RETURNING id`,
        insertQuery(sql, d),
      ]);
      inserted = results && results[1] && results[1][0];
    } else {
      const rows = await insertQuery(sql, d);
      inserted = rows && rows[0];
    }
    if (!inserted) throw fail("لم يُكتب صفّ الملفّ", "insert_failed");
  } catch (err) {
    /* التراجع يحذف **الكائن الجديد وحده**. والقديم لم يُمسّ بعد — وهذا هو
       ما يمنع أن ينتهي فشلُ الكتابة بضياع الملفّ المعتمد. */
    await rollbackObject(sql, desc.pathname, ctx, { fileId, runId: v.runId, kind: v.kind });
    throw err;
  }
  return inserted;
}

async function putFile(sql, input, ctx = {}) {
  gateContext.requireGate();
  const v = validateInput(input);
  /* الفحص **قبل** الرفع: لولاه لرُفع كائن ثمّ اصطدم بالفهرس الفريد، فيصير
     كل خطأ عاديّ يخلّف يتيمًا يحتاج تراجعًا. */
  if (await currentRow(sql, v.runId, v.kind)) {
    throw fail("لهذا الشهر ونوعه ملفٌّ حاليّ — الاستبدال عمليّة صريحة", "already_current");
  }
  return { file: publicView(await uploadAndInsert(sql, v, ctx, null)), replaced: false, oldPurged: false };
}

async function replaceFile(sql, input, ctx = {}) {
  gateContext.requireGate();
  const v = validateInput(input);
  const oldRow = await currentRow(sql, v.runId, v.kind);
  const inserted = await uploadAndInsert(sql, v, ctx, oldRow);
  /* بعد أن اعتمدت القاعدة البديل — لا قبله. */
  const oldPurged = oldRow ? await purgeObject(sql, oldRow, ctx) : false;
  return { file: publicView(inserted), replaced: Boolean(oldRow), oldPurged };
}

/* ─── القراءة ────────────────────────────────────────────────────────── */

async function listCurrent(sql, runId) {
  gateContext.requireGate();
  if (!UUID_RE.test(String(runId || ""))) throw fail("runId غير صالح", "bad_run_id");
  const rows = await sql`SELECT * FROM droua_payroll_files
    WHERE run_id = ${runId}::uuid AND superseded_at IS NULL ORDER BY kind`;
  return (rows || []).map(publicView);
}

async function listVersions(sql, runId, kind) {
  gateContext.requireGate();
  if (!UUID_RE.test(String(runId || ""))) throw fail("runId غير صالح", "bad_run_id");
  if (!KINDS.includes(String(kind || ""))) throw fail("kind غير مسموح", "bad_kind");
  const rows = await sql`SELECT * FROM droua_payroll_files
    WHERE run_id = ${runId}::uuid AND kind = ${kind} ORDER BY created_at DESC`;
  return (rows || []).map(publicView);
}

async function getFile(sql, fileId) {
  gateContext.requireGate();
  return publicView(await rowById(sql, assertFileId(fileId)));
}

/* fileId وحده مدخلًا — **لا مسار**. وما يُسلَّم إلى فكّ التشفير كلّه من
   الصفّ: المسار والـIV والوسم ومعرّف المفتاح وهويّة الـAAD. */
async function readFile(sql, fileId, ctx = {}) {
  gateContext.requireGate();
  const row = await rowById(sql, assertFileId(fileId));
  if (!row) throw fail("غير موجود", "not_found");
  if (row.purged_at) throw fail("غير موجود", "not_found");

  try {
    const bytes = await storage.getDecrypted({
      fileId: row.id, runId: row.run_id, kind: row.kind,
      pathname: row.blob_pathname,
      encIv: row.enc_iv, encTag: row.enc_tag, encKeyId: row.enc_key_id,
      plaintextSha256: row.plaintext_sha256,
    });
    return { file: publicView(row), bytes };
  } catch (err) {
    /* الفساد الصامت أسوأ من المعلن: ما يخرج إلى الأعلى ردٌّ عامّ، وما
       يُسجَّل هنا يقول بالضبط أيّ ملفّ وأيّ سبب. وبلا اسم الملفّ. */
    if (err && err.reason) {
      await audit.log(sql, {
        event: "file_integrity_failure", userId: ctx.actorId || null,
        meta: {
          fileId: row.id, runId: row.run_id, kind: row.kind,
          encKeyId: row.enc_key_id, pathname: row.blob_pathname, reason: err.reason,
        },
      });
    }
    throw err;
  }
}

/* ─── الحذف ──────────────────────────────────────────────────────────── */

/* الترتيب: يُرفع عنه وصف «الحاليّ» أوّلًا فيختفي من النظام فورًا، ثمّ
   يُحذف الكائن، ثمّ يُشطب الصفّ. وفشل حذف الكائن يترك شاهد قبرٍ يلتقطه
   المسح — بدل يتيمٍ لا يعرف به أحد، وهو ما كان يقع لو شُطب الصفّ أوّلًا. */
async function deleteFile(sql, fileId, ctx = {}) {
  gateContext.requireGate();
  assertFileId(fileId);
  const rows = await sql`UPDATE droua_payroll_files
      SET superseded_at = COALESCE(superseded_at, now()),
          deleted_at    = COALESCE(deleted_at, now())
      WHERE id = ${fileId}::uuid RETURNING *`;
  const row = rows && rows[0];
  if (!row) return { deleted: false, purged: false };

  const purged = await purgeObject(sql, row, ctx);
  if (purged) await sql`DELETE FROM droua_payroll_files WHERE id = ${fileId}::uuid`;
  return { deleted: true, purged };
}

/* ─── الكنس ──────────────────────────────────────────────────────────── */

async function findStale(sql, limit = 50) {
  gateContext.requireGate();
  const rows = await sql`SELECT * FROM droua_payroll_files
    WHERE superseded_at IS NOT NULL AND purged_at IS NULL
    ORDER BY superseded_at LIMIT ${Math.max(1, Math.min(500, Number(limit) || 50))}`;
  return rows || [];
}

async function sweepStale(sql, ctx = {}, limit = 50) {
  gateContext.requireGate();
  const rows = await findStale(sql, limit);
  let purged = 0;
  for (const row of rows) {
    if (await purgeObject(sql, row, ctx)) {
      purged += 1;
      /* شاهد القبر يُزال بعد أن تُصبح بايتاته معدومة فعلًا. أمّا نسخةٌ
         استُبدلت فيبقى صفّها تاريخًا — وهو مقصود في نظامٍ وظيفته التدقيق. */
      if (row.deleted_at) await sql`DELETE FROM droua_payroll_files WHERE id = ${row.id}::uuid`;
    }
  }
  return { scanned: rows.length, purged, remaining: rows.length - purged };
}

module.exports = {
  putFile, replaceFile, readFile, getFile, listCurrent, listVersions,
  deleteFile, findStale, sweepStale,
  KINDS, INPUT_KEYS, CLIENT_FORBIDDEN, MAX_FILE_NAME, publicView,
};
