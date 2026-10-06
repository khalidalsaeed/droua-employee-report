/* ─── ملفّات العروض: رفعٌ وتنزيلٌ مُجزَّآن، مشفَّران، خلف البوابة ──────────
   =========================================================================
   الطبقة الوحيدة التي تعرف القاعدة والمتجر معًا. ثلاث قواعد تحكم كل دالّة:

   ① **لا شيء يبلغ هذه الوحدة إلا من بوابةٍ مفتوحة.** أوّل سطر في كل دالّة
     مُصدَّرة `context.requireGate()` — واختبارٌ يعدّ الحرّاس.

   ② **لا يُوثق بشيءٍ من العميل عن الملفّ.** الاسم يُنقّى، والصيغة من قائمة
     مغلقة، وعدد الأجزاء يحسبه الخادم من الحجم، وحجم كل جزء يُفرض بالضبط،
     والتوقيع الحقيقيّ للصيغة يُفحص على البايتات، والبصمة النهائية تُحسب من
     البايتات المفكوكة لا تُقرأ من الطلب. المعلَن يُقارن بالفعليّ، ولا يحلّ
     محلّه.

   ③ **لا رابط.** المتجر خاصّ، والمسار عشوائيّ ويُقرأ من صفّ القاعدة، ولا
     يغادر هذه الوحدة. التنزيل يمرّ بالبوابة وبالصلاحية في كل جزء، ويُدقَّق
     كل جزء: المستخدم، والملفّ، والعرض، والوقت، و action = download.

   لماذا الأجزاء؟ حدّ جسم الطلب **والردّ** على Vercel 4.5MB. فالملفّ حتى
   20MB يُنقل أجزاءً، وكل جزء يُشفَّر كائنًا مستقلًّا برقمه وعدد الأجزاء
   داخل الـAAD — فلا تبديل ولا اقتطاع ولا نقل جزءٍ إلى ملفٍّ آخر. والواجهة
   تجمع الأجزاء في المتصفّح بعد أن يكون كلٌّ منها قد تُحقِّق من وسمه على
   الخادم قبل أن يُرسَل منه بايت. */

const crypto = require("crypto");
const security = require("./security");
const limits = require("./limits");
const V = require("./validate");

const { FILES } = limits;
const requireGate = () => security.context.requireGate();

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_PART_B64 = Math.ceil(FILES.PART_BYTES / 3) * 4 + 8;

/* ─── التوقيعات الحقيقية للصيغ ─── */
const SIGNATURES = Object.freeze({
  pdf: (b) => b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-",
  xlsx: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  xls: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  csv: (b) => !b.includes(0),
});

/* فحص الملفّ كاملًا عند الإكمال. CSV يُفكّ UTF-8 صارمًا هنا لا في الجزء
   الأوّل: حدّ الجزء قد يقطع محرفًا متعدّد البايتات. */
function fullSignatureOk(format, buf) {
  if (!SIGNATURES[format] || !SIGNATURES[format](buf)) return false;
  if (format === "csv") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (err) {
      return false;
    }
  }
  return true;
}

/* اسم العرض: يُنقّى ولا يُرفض — إلا إن لم يبقَ منه شيء. */
function normalizeFileName(raw) {
  const value = String(raw == null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  if (!value || value.length > FILES.MAX_FILE_NAME) throw V.bad("اسم ملفّ غير صالح");
  return value;
}

const partCountFor = (size) => Math.ceil(size / FILES.PART_BYTES);
const expectedPartSize = (size, count, index) =>
  index < count - 1 ? FILES.PART_BYTES : size - FILES.PART_BYTES * (count - 1);

function publicView(row) {
  if (!row) return null;
  return {
    id: row.id,
    offerId: row.offer_id,
    kind: row.kind,
    fileName: row.file_name,
    format: row.format,
    sizeBytes: Number(row.size_bytes),
    partCount: Number(row.part_count),
    sha256: row.plaintext_sha256,
    status: row.status,
    createdAt: V.iso(row.created_at),
    completedAt: V.iso(row.completed_at),
  };
}

const identityOf = (row, partIndex) => ({
  fileId: row.id, offerId: row.offer_id, kind: row.kind,
  partIndex: String(partIndex), partCount: String(Number(row.part_count)),
});

function storageGuard() {
  if (!security.storageReady()) throw new V.ApiError(503, "التخزين الخاصّ غير مُهيّأ");
}

async function fileRow(sql, id) {
  const rows = await sql`SELECT * FROM medins_files WHERE id = ${id}::uuid`;
  if (!rows[0]) throw new V.ApiError(404, "الملفّ غير موجود");
  return rows[0];
}

/* ─── التطهير ───
   حذف بايتات الأجزاء أفضل جهد: الكائن اليتيم مشفَّر وبلا رابط. وما يفشل
   حذفه يبقى صفّه، فيُلتقط في تطهيرٍ لاحق، ويُسجَّل بمساره (العشوائيّ). */
async function purgeParts(sql, row, log) {
  const parts = await sql`SELECT part_index, blob_pathname FROM medins_file_parts WHERE file_id = ${row.id}::uuid`;
  let left = 0;
  for (const p of parts) {
    const { removed } = await security.store.remove(p.blob_pathname);
    if (removed) {
      await sql`DELETE FROM medins_file_parts WHERE file_id = ${row.id}::uuid AND part_index = ${p.part_index}`;
    } else {
      left += 1;
      if (log) await log("blob_stale", { fileId: row.id, offerId: row.offer_id, partIndex: Number(p.part_index), pathname: p.blob_pathname, reason: "purge_failed" });
    }
  }
  if (!left) await sql`UPDATE medins_files SET purged_at = coalesce(purged_at, now()) WHERE id = ${row.id}::uuid AND status = 'deleted'`;
  return left;
}

async function markDeleted(sql, row) {
  await sql.transaction([
    sql`UPDATE medins_files SET status = 'deleted', deleted_at = now() WHERE id = ${row.id}::uuid AND status <> 'deleted'`,
    /* إشارات المصدر لا تبقى معلّقة بملفٍّ محذوف. */
    sql`UPDATE medins_class_benefits SET source_file_id = NULL WHERE source_file_id = ${row.id}::uuid`,
    sql`UPDATE medins_offer_terms SET source_file_id = NULL WHERE source_file_id = ${row.id}::uuid`,
  ]);
}

/* رفوعٌ انتهت مهلتها: تُحذف وتُطهَّر. انتهازيّ — يركب على بدء رفعٍ جديد. */
async function sweep(sql, log) {
  requireGate();
  const stale = await sql`SELECT * FROM medins_files WHERE status = 'uploading' AND upload_expires_at < now()
    ORDER BY upload_expires_at LIMIT 20`;
  for (const row of stale) {
    await markDeleted(sql, row);
    await purgeParts(sql, row, log);
    if (log) await log("file_upload_expired", { fileId: row.id, offerId: row.offer_id });
  }
  return stale.length;
}

/* بقايا ملفّاتٍ محذوفة لعرضٍ يُحذف: تُطهَّر ثم تُمحى صفوفها. يُرجع ما تعذّر. */
async function purgeTombstones(sql, offerId) {
  requireGate();
  const rows = await sql`SELECT * FROM medins_files WHERE offer_id = ${offerId}::uuid AND status = 'deleted'`;
  let left = 0;
  for (const row of rows) {
    if (row.purged_at === null || row.purged_at === undefined) {
      storageGuard();
      if (await purgeParts(sql, row, null)) { left += 1; continue; }
    }
    await sql`DELETE FROM medins_files WHERE id = ${row.id}::uuid AND status = 'deleted'`;
  }
  return left;
}

async function listRows(sql, offerId) {
  requireGate();
  return sql`SELECT * FROM medins_files WHERE offer_id = ${offerId}::uuid AND status <> 'deleted' ORDER BY created_at DESC`;
}

async function listForOffer({ sql, params }) {
  requireGate();
  const offerId = V.uuid(params.id, { label: "العرض" });
  const rows = await listRows(sql, offerId);
  return { body: { files: rows.map(publicView) } };
}

async function meta({ sql, params }) {
  requireGate();
  const id = V.uuid(params.id, { label: "الملفّ" });
  const row = await fileRow(sql, id);
  if (row.status === "deleted") throw new V.ApiError(404, "الملفّ غير موجود");
  return { body: { file: publicView(row) } };
}

/* ─── الرفع: ١) البدء ─── */
async function init({ sql, body, actor, log }) {
  requireGate();
  storageGuard();
  V.pick(body, ["offerId", "kind", "fileName", "format", "sizeBytes", "sha256"]);
  const offerId = V.uuid(body.offerId, { label: "العرض" });
  const kind = V.oneOf(body.kind, FILES.KINDS, { label: "نوع الملفّ" });
  const format = V.oneOf(body.format, Object.keys(FILES.FORMATS), { label: "الصيغة" });
  const fileName = normalizeFileName(body.fileName);
  const ext = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
  if (!Object.keys(FILES.FORMATS).includes(ext)) throw V.bad("امتداد الملفّ غير مسموح (pdf, xlsx, xls, csv)");
  if (ext !== format) throw V.bad("امتداد الملفّ لا يطابق صيغته");
  const sizeBytes = V.int(body.sizeBytes, { label: "الحجم", min: 1, max: FILES.MAX_FILE_BYTES });
  if (sizeBytes === null) throw V.bad("الحجم مطلوب");
  const sha256 = String(body.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw V.bad("بصمة الملفّ غير صالحة");

  const offer = await sql`SELECT status FROM medins_offers WHERE id = ${offerId}::uuid`;
  if (!offer[0]) throw new V.ApiError(404, "العرض غير موجود");
  if (offer[0].status === "archived") throw new V.ApiError(409, "العرض مؤرشف");

  await sweep(sql, log);

  const dup = await sql`SELECT id, status FROM medins_files WHERE offer_id = ${offerId}::uuid
    AND plaintext_sha256 = ${sha256} AND status IN ('uploading', 'ready')`;
  if (dup[0]) {
    await log("file_upload_rejected", { offerId, fileId: dup[0].id, reason: "duplicate" });
    throw new V.ApiError(409, dup[0].status === "ready" ? "الملفّ مرفوعٌ مسبقًا لهذا العرض" : "رفع الملفّ نفسه جارٍ", { fileId: dup[0].id });
  }

  const id = crypto.randomUUID();
  const partCount = partCountFor(sizeBytes);
  const expires = new Date(Date.now() + FILES.UPLOAD_TTL_MS).toISOString();
  await sql`
    INSERT INTO medins_files (id, offer_id, kind, file_name, format, content_type, size_bytes, part_count,
      plaintext_sha256, status, enc_algo, enc_key_id, created_by, upload_expires_at)
    VALUES (${id}::uuid, ${offerId}::uuid, ${kind}, ${fileName}, ${format}, ${FILES.FORMATS[format]}, ${sizeBytes},
      ${partCount}, ${sha256}, 'uploading', 'aes-256-gcm', ${security.keyring.activeKeyId()}, ${actor.id}, ${expires}::timestamptz)`;
  await log("file_upload_started", { offerId, fileId: id, kind, format, sizeBytes, partCount });
  return { status: 201, body: { fileId: id, partCount, partSize: FILES.PART_BYTES, expiresAt: expires } };
}

async function uploadingRow(sql, id, actor) {
  const row = await fileRow(sql, id);
  if (row.status !== "uploading") throw new V.ApiError(409, "لا رفع جارٍ لهذا الملفّ");
  if (String(row.created_by) !== String(actor.id)) throw new V.ApiError(403, "الرفع لمن بدأه");
  if (new Date(row.upload_expires_at).getTime() <= Date.now()) throw new V.ApiError(409, "انتهت مهلة الرفع — ابدأ من جديد");
  return row;
}

/* ─── الرفع: ٢) جزء ─── */
async function putPart({ sql, body, params, actor, log }) {
  requireGate();
  storageGuard();
  const id = V.uuid(params.id, { label: "الملفّ" });
  const index = Number(params.n);
  V.pick(body, ["data"]);
  const data = typeof body.data === "string" ? body.data : "";
  /* الطول قبل فكّ الترميز: لا ذاكرة تُنفق على ما سيُرفض. */
  if (!data || data.length > MAX_PART_B64 || !B64_RE.test(data)) throw V.bad("جزءٌ غير صالح");

  const row = await uploadingRow(sql, id, actor);
  const count = Number(row.part_count);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw V.bad("رقم جزء غير صالح");

  const bytes = Buffer.from(data, "base64");
  const expected = expectedPartSize(Number(row.size_bytes), count, index);
  if (bytes.length !== expected) throw V.bad(`حجم الجزء ${index + 1} لا يطابق المتوقَّع`);
  if (index === 0 && !SIGNATURES[row.format](bytes)) {
    await log("file_upload_rejected", { offerId: row.offer_id, fileId: id, reason: "signature", format: row.format });
    throw V.bad("محتوى الملفّ لا يطابق صيغته المعلنة");
  }

  const exists = await sql`SELECT 1 FROM medins_file_parts WHERE file_id = ${id}::uuid AND part_index = ${index}`;
  if (exists[0]) throw new V.ApiError(409, "الجزء مرفوعٌ مسبقًا");

  const desc = await security.store.putEncrypted({ identity: identityOf(row, index), bytes });
  try {
    await sql`
      INSERT INTO medins_file_parts (file_id, part_index, blob_pathname, size_bytes, part_sha256, enc_key_id, enc_iv, enc_tag)
      VALUES (${id}::uuid, ${index}, ${desc.pathname}, ${desc.sizeBytes}, ${desc.plaintextSha256},
              ${desc.encKeyId}, ${desc.encIv}, ${desc.encTag})`;
  } catch (err) {
    /* كائنٌ بلا صفّ لا يعرفه شيء — يُحذف، وإن فشل يُسجَّل مساره للكنس. */
    const { removed } = await security.store.remove(desc.pathname);
    if (!removed) await log("blob_orphan", { fileId: id, offerId: row.offer_id, partIndex: index, pathname: desc.pathname, reason: "insert_failed" });
    throw err;
  }
  return { body: { partIndex: index, received: true } };
}

/* ─── الرفع: ٣) الإكمال — الحكم على البايتات الفعلية ─── */
async function complete({ sql, params, actor, log }) {
  requireGate();
  storageGuard();
  const id = V.uuid(params.id, { label: "الملفّ" });
  const row = await uploadingRow(sql, id, actor);
  const count = Number(row.part_count);
  const parts = await sql`SELECT * FROM medins_file_parts WHERE file_id = ${id}::uuid ORDER BY part_index`;

  const reject = async (reason, message) => {
    await markDeleted(sql, row);
    await purgeParts(sql, row, log);
    await log("file_upload_rejected", { offerId: row.offer_id, fileId: id, reason });
    throw new V.ApiError(422, message);
  };

  if (parts.length !== count || parts.some((p, i) => Number(p.part_index) !== i)) {
    throw new V.ApiError(409, `الأجزاء غير مكتملة (${parts.length} من ${count})`);
  }
  const total = parts.reduce((s, p) => s + Number(p.size_bytes), 0);
  if (total !== Number(row.size_bytes)) return reject("size_mismatch", "الحجم الفعليّ لا يطابق المعلن");

  const hash = crypto.createHash("sha256");
  const buffers = [];
  for (const p of parts) {
    let plain;
    try {
      plain = await security.store.getDecrypted({
        identity: identityOf(row, Number(p.part_index)), pathname: p.blob_pathname,
        encIv: p.enc_iv, encTag: p.enc_tag, encKeyId: p.enc_key_id, plaintextSha256: p.part_sha256,
      });
    } catch (err) {
      return reject(err && err.reason ? err.reason : "decrypt_error", "تعذّر التحقّق من سلامة الملفّ");
    }
    hash.update(plain);
    buffers.push(plain);
  }
  if (hash.digest("hex") !== row.plaintext_sha256) return reject("sha_mismatch", "بصمة الملفّ لا تطابق المعلنة");
  if (!fullSignatureOk(row.format, Buffer.concat(buffers))) return reject("signature", "محتوى الملفّ لا يطابق صيغته");

  const done = await sql`UPDATE medins_files SET status = 'ready', completed_at = now()
    WHERE id = ${id}::uuid AND status = 'uploading' RETURNING *`;
  if (!done[0]) throw new V.ApiError(409, "تغيّرت حالة الرفع أثناء الإكمال");
  await log("file_upload_completed", { offerId: row.offer_id, fileId: id, kind: row.kind, format: row.format, sizeBytes: Number(row.size_bytes), partCount: count });
  return { body: { file: publicView(done[0]) } };
}

/* ─── التنزيل: جزءًا جزءًا، وكل جزء يُدقَّق ─── */
async function downloadPart({ sql, params, log }) {
  requireGate();
  storageGuard();
  const id = V.uuid(params.id, { label: "الملفّ" });
  const index = Number(params.n);
  const row = await fileRow(sql, id);
  if (row.status !== "ready") throw new V.ApiError(404, "الملفّ غير موجود");
  const count = Number(row.part_count);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new V.ApiError(404, "الجزء غير موجود");
  const parts = await sql`SELECT * FROM medins_file_parts WHERE file_id = ${id}::uuid AND part_index = ${index}`;
  if (!parts[0]) throw new V.ApiError(404, "الجزء غير موجود");
  const p = parts[0];
  const plain = await security.store.getDecrypted({
    identity: identityOf(row, index), pathname: p.blob_pathname,
    encIv: p.enc_iv, encTag: p.enc_tag, encKeyId: p.enc_key_id, plaintextSha256: p.part_sha256,
  });
  await log("file_downloaded", { action: "download", offerId: row.offer_id, fileId: id, partIndex: index, partCount: count });
  return {
    binary: plain,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="part-${index}.bin"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Part-Index": String(index),
      "X-Part-Count": String(count),
    },
  };
}

/* ─── الحذف ─── */
async function remove({ sql, params, log }) {
  requireGate();
  storageGuard();
  const id = V.uuid(params.id, { label: "الملفّ" });
  const row = await fileRow(sql, id);
  if (row.status === "deleted") throw new V.ApiError(404, "الملفّ غير موجود");
  await markDeleted(sql, row);
  const left = await purgeParts(sql, row, log);
  await log("file_deleted", { offerId: row.offer_id, fileId: id, kind: row.kind, count: left });
  return { body: { deleted: true, pendingPurge: left } };
}

/* كل دالّة في المستوى الأوّل محروسة (عدا publicView: تحويلٌ خالص لصفٍّ مقروء
   أصلًا). والأدوات الخالصة تحت `pure` كي يبقى عدُّ الحرّاس مطابقًا. */
module.exports = {
  init, putPart, complete, downloadPart, remove, meta, listForOffer, listRows, sweep, purgeTombstones,
  publicView,
  pure: { normalizeFileName, fullSignatureOk, partCountFor, expectedPartSize, SIGNATURES },
};
