/* قاعدة ومتجرٌ مُزيَّفان لاختبار lib/droua/files.js
   =========================================================================
   ليس محاكيًا عامًّا لـPostgres، بل جدولٌ واحد بالقيود الثلاثة التي يقوم
   عليها منطق الاستبدال: الفريد على blob_pathname، والفريد **الجزئيّ** على
   (run_id, kind) بين الصفوف الحاليّة، وnot-null على ما يجب.

   وبدون هذه القيود يصير اختبار «الاستبدال» مسرحية: كل شيء ينجح لأن لا شيء
   يمنع. فما يُختبر هنا هو ترتيب الفشل حين **ترفض** القاعدة فعلًا.

   `arm` يسلّح فشلًا واحدًا في العملية التالية — فتُختبر مسارات التراجع
   بلا انتظار عطلٍ حقيقيّ. */

const REQUIRED = [
  "id", "run_id", "kind", "blob_pathname", "file_name", "format",
  "content_type", "size_bytes", "plaintext_sha256", "enc_algo",
  "enc_key_id", "enc_iv", "enc_tag",
];

const norm = (s) => s.replace(/\s+/g, " ").trim();

function makeFilesDb() {
  const rows = [];
  const auditRows = [];
  const calls = [];
  const armed = { insert: null, update: null, select: null, delete: null };

  const clone = (r) => ({ ...r });
  const snapshot = () => rows.map(clone);
  const restore = (snap) => { rows.length = 0; rows.push(...snap); };

  function takeArmed(kind) {
    const message = armed[kind];
    if (!message) return null;
    armed[kind] = null;
    return message;
  }

  function insert(values) {
    const armedFailure = takeArmed("insert");
    if (armedFailure) throw new Error(armedFailure);

    const [id, runId, kind, pathname, fileName, format, contentType,
      sizeBytes, sha, encAlgo, encKeyId, encIv, encTag] = values;
    const row = {
      id, run_id: runId, kind, blob_pathname: pathname, file_name: fileName,
      format, content_type: contentType, size_bytes: sizeBytes,
      plaintext_sha256: sha, enc_algo: encAlgo, enc_key_id: encKeyId,
      enc_iv: encIv, enc_tag: encTag,
      created_at: new Date().toISOString(),
      superseded_at: null, deleted_at: null, purged_at: null,
    };
    for (const col of REQUIRED) {
      if (row[col] === null || row[col] === undefined || row[col] === "") {
        throw new Error(`null value in column "${col}" violates not-null constraint`);
      }
    }
    if (rows.some((r) => r.blob_pathname === row.blob_pathname)) {
      throw new Error('duplicate key value violates unique constraint "droua_payroll_files_blob_pathname_key"');
    }
    if (rows.some((r) => r.run_id === row.run_id && r.kind === row.kind && !r.superseded_at)) {
      throw new Error('duplicate key value violates unique constraint "idx_droua_payroll_files_current"');
    }
    rows.push(row);
    return [clone(row)];
  }

  function exec(text, values) {
    const t = norm(text);
    calls.push({ text: t, values });

    if (/^INSERT INTO droua_gate_audit/.test(t)) {
      auditRows.push({ event: values[0], userId: values[1], meta: JSON.parse(values[2] || "{}") });
      return [];
    }
    if (/^INSERT INTO droua_payroll_files/.test(t)) return insert(values);

    if (/^SELECT \* FROM droua_payroll_files/.test(t)) {
      const armedFailure = takeArmed("select");
      if (armedFailure) throw new Error(armedFailure);
      if (/WHERE id = \?::uuid/.test(t)) return rows.filter((r) => r.id === values[0]).map(clone);
      if (/superseded_at IS NOT NULL AND purged_at IS NULL/.test(t)) {
        return rows.filter((r) => r.superseded_at && !r.purged_at)
          .sort((a, b) => String(a.superseded_at).localeCompare(String(b.superseded_at)))
          .slice(0, Number(values[0]) || 50).map(clone);
      }
      if (/AND kind = \? AND superseded_at IS NULL/.test(t)) {
        return rows.filter((r) => r.run_id === values[0] && r.kind === values[1] && !r.superseded_at).map(clone);
      }
      if (/AND superseded_at IS NULL ORDER BY kind/.test(t)) {
        return rows.filter((r) => r.run_id === values[0] && !r.superseded_at)
          .sort((a, b) => a.kind.localeCompare(b.kind)).map(clone);
      }
      if (/AND kind = \? ORDER BY created_at DESC/.test(t)) {
        return rows.filter((r) => r.run_id === values[0] && r.kind === values[1])
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(clone);
      }
      throw new Error("استعلام SELECT غير معروف في القاعدة المُزيَّفة: " + t);
    }

    if (/^UPDATE droua_payroll_files/.test(t)) {
      const armedFailure = takeArmed("update");
      if (armedFailure) throw new Error(armedFailure);
      const row = rows.find((r) => r.id === values[0]);
      if (/SET superseded_at = now\(\) WHERE id = \?::uuid AND superseded_at IS NULL/.test(t)) {
        if (!row || row.superseded_at) return [];
        row.superseded_at = new Date().toISOString();
        return [{ id: row.id }];
      }
      if (/SET purged_at = now\(\)/.test(t)) {
        if (!row) return [];
        row.purged_at = new Date().toISOString();
        return [];
      }
      if (/deleted_at = COALESCE/.test(t)) {
        if (!row) return [];
        row.superseded_at = row.superseded_at || new Date().toISOString();
        row.deleted_at = row.deleted_at || new Date().toISOString();
        return [clone(row)];
      }
      throw new Error("استعلام UPDATE غير معروف في القاعدة المُزيَّفة: " + t);
    }

    if (/^DELETE FROM droua_payroll_files/.test(t)) {
      const armedFailure = takeArmed("delete");
      if (armedFailure) throw new Error(armedFailure);
      const at = rows.findIndex((r) => r.id === values[0]);
      if (at >= 0) rows.splice(at, 1);
      return [];
    }

    throw new Error("استعلام غير معروف في القاعدة المُزيَّفة: " + t);
  }

  /* استعلامٌ كسول: لا يُنفَّذ إلا عند await أو داخل transaction — وهو ما
     يجعل بناء المعاملة من قوالب غير منتظَرة ممكنًا، كما في neon. */
  function makeQuery(text, values) {
    return {
      text, values,
      run: () => exec(text, values),
      then(resolve, reject) {
        return Promise.resolve().then(() => exec(text, values)).then(resolve, reject);
      },
      catch(reject) { return this.then(undefined, reject); },
    };
  }

  const sql = (strings, ...values) => {
    let text = "";
    strings.raw.forEach((chunk, i) => {
      text += chunk;
      if (i < values.length) text += "?";
    });
    return makeQuery(text, values);
  };

  /* كل شيء أو لا شيء: لقطةٌ قبل، واستعادةٌ عند أي فشل. */
  sql.transaction = async (queries) => {
    const before = snapshot();
    try {
      const out = [];
      for (const q of queries) out.push(q.run());
      return out;
    } catch (err) {
      restore(before);
      throw err;
    }
  };
  sql.query = async (text, values = []) => exec(text, values);

  return {
    sql, rows, audit: auditRows, calls, armed,
    arm: (kind, message) => { armed[kind] = message || "فشل مُسلَّح"; },
    seed: (row) => { rows.push({ superseded_at: null, deleted_at: null, purged_at: null, ...row }); },
    events: () => auditRows.map((a) => a.event),
  };
}

/* متجر Blob مُزيَّف على سلوك @vercel/blob الحقيقيّ: الحذف عمليّة خاملة
   تنجح على كائن غير موجود. ولذلك يُسلَّح الفشل صراحةً حين يُراد اختباره. */
function makeFakeBlob() {
  const objects = new Map();
  const calls = [];
  const fail = { put: false, get: false, del: false };
  const api = {
    async put(pathname, body, opts) {
      calls.push({ op: "put", pathname, opts });
      if (fail.put) throw new Error("فشل رفع مُسلَّح");
      objects.set(pathname, Buffer.from(body));
      return { pathname, url: `https://example.invalid/${pathname}` };
    },
    async get(pathname, opts) {
      calls.push({ op: "get", pathname, opts });
      if (fail.get) throw new Error("فشل قراءة مُسلَّح");
      if (!objects.has(pathname)) return null;
      const buf = objects.get(pathname);
      return {
        statusCode: 200,
        stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } }),
        blob: { pathname },
      };
    },
    async del(pathname, opts) {
      calls.push({ op: "del", pathname, opts });
      if (fail.del) throw new Error("فشل حذف مُسلَّح");
      objects.delete(pathname);
    },
  };
  return { api, objects, calls, fail };
}

module.exports = { makeFilesDb, makeFakeBlob };
