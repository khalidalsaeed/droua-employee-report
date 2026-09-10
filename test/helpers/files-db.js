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
  const runRows = [];
  const findingRows = [];
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

  /* ── جدولا المسيرات والملاحظات ──
     أبسط من جدول الملفّات: القيود التي يقوم عليها المنطق هنا اثنان —
     التفرّد على `period`، والتفرّد على (run_id, fingerprint). وما عداهما
     تفاصيل تفرضها القاعدة الحقيقية ولا يبني عليها كود التطبيق قرارًا. */
  function runsExec(t, values) {
    if (/^INSERT INTO droua_payroll_runs/.test(t)) {
      if (runRows.some((r) => r.period === values[1])) {
        throw new Error('duplicate key value violates unique constraint "droua_payroll_runs_period_key"');
      }
      const row = {
        id: values[0], period: values[1], status: "draft",
        created_at: new Date().toISOString(), analyzed_at: null, closed_at: null,
      };
      runRows.push(row);
      return [clone(row)];
    }
    if (/^SELECT \* FROM droua_payroll_runs WHERE id/.test(t)) {
      return runRows.filter((r) => r.id === values[0]).map(clone);
    }
    if (/^SELECT \* FROM droua_payroll_runs WHERE period/.test(t)) {
      return runRows.filter((r) => r.period === values[0]).map(clone);
    }
    if (/^SELECT \* FROM droua_payroll_runs ORDER BY period DESC/.test(t)) {
      return runRows.slice().sort((a, b) => b.period.localeCompare(a.period))
        .slice(0, Number(values[0]) || 36).map(clone);
    }
    if (/^UPDATE droua_payroll_runs SET status/.test(t)) {
      const row = runRows.find((r) => r.id === values[3]);
      if (!row) return [];
      row.status = values[0];
      if (values[1] === "analyzed") row.analyzed_at = new Date().toISOString();
      if (values[2] === "closed") row.closed_at = new Date().toISOString();
      return [clone(row)];
    }
    if (/^DELETE FROM droua_payroll_runs/.test(t)) {
      const at = runRows.findIndex((r) => r.id === values[0]);
      if (at >= 0) runRows.splice(at, 1);
      return [];
    }
    throw new Error("استعلام مسيرات غير معروف: " + t);
  }

  function findingsExec(t, values) {
    if (/^SELECT id, fingerprint FROM droua_payroll_findings/.test(t)) {
      return findingRows.filter((r) => r.run_id === values[0]).map((r) => ({ id: r.id, fingerprint: r.fingerprint }));
    }
    if (/^INSERT INTO droua_payroll_findings/.test(t)) {
      const [id, runId, fingerprint, rule, scope, severity, title, employeeRef,
        employeeName, field, previousValue, currentValue, delta, description, firstSeen, lastSeen] = values;
      if (findingRows.some((r) => r.run_id === runId && r.fingerprint === fingerprint)) {
        throw new Error('duplicate key value violates unique constraint "droua_payroll_findings_run_id_fingerprint_key"');
      }
      const row = {
        id, run_id: runId, fingerprint, rule, scope, severity, title,
        employee_ref: employeeRef, employee_name: employeeName, field,
        previous_value: previousValue, current_value: currentValue, delta,
        description, status: "needs_review", user_note: null,
        first_seen_at: firstSeen, last_seen_at: lastSeen, resolved_at: null,
      };
      findingRows.push(row);
      return [];
    }
    if (/^UPDATE droua_payroll_findings SET severity/.test(t)) {
      /* ⚠️ عمودٌ لا تُمثّله هذه القاعدة يجب أن **يصرخ** لا أن يُتجاهل: تجاهله
         يجعل الاختبار يمرّ على شيفرةٍ تمسّ حالة المستخدم — وهو بالضبط ما
         بُنيت المزامنة لمنعه. اختبارٌ يكذب أخطر من اختبار ساقط. */
      if (/\bstatus\b|user_note|first_seen_at/.test(t)) {
        throw new Error("عمودٌ لا تُمثّله القاعدة المُزيَّفة في تحديث المزامنة: " + t);
      }
      const row = findingRows.find((r) => r.id === values[8]);
      if (!row) return [];
      row.severity = values[0]; row.title = values[1]; row.employee_name = values[2];
      row.previous_value = values[3]; row.current_value = values[4]; row.delta = values[5];
      row.description = values[6]; row.last_seen_at = values[7]; row.resolved_at = null;
      return [];
    }
    if (/^UPDATE droua_payroll_findings SET resolved_at/.test(t)) {
      const out = [];
      for (const row of findingRows) {
        if (row.run_id !== values[1] || row.resolved_at) continue;
        if (!(String(row.last_seen_at) < String(values[2]))) continue;
        row.resolved_at = values[0];
        out.push({ id: row.id });
      }
      return out;
    }
    if (/^UPDATE droua_payroll_findings SET status/.test(t)) {
      const row = findingRows.find((r) => r.id === values[2]);
      if (!row) return [];
      row.status = values[0]; row.user_note = values[1];
      return [clone(row)];
    }
    if (/^SELECT \* FROM droua_payroll_findings WHERE id/.test(t)) {
      return findingRows.filter((r) => r.id === values[0]).map(clone);
    }
    if (/^SELECT \* FROM droua_payroll_findings WHERE run_id/.test(t)) {
      const open = /resolved_at IS NULL/.test(t);
      /* الترتيب يُقرأ من نصّ الاستعلام نفسه لا يُعاد كتابته هنا: قاعدةٌ
         مُزيَّفة ترتّب بطريقتها تُخفي عطلًا في ترتيب القاعدة الحقيقية —
         وهو بالضبط ما أخفى «الحرج في آخر القائمة». */
      const ranks = [...t.matchAll(/WHEN '(\w+)' THEN (\d+)/g)]
        .reduce((acc, m) => ({ ...acc, [m[1]]: Number(m[2]) }), {});
      const fallback = /ELSE (\d+)/.exec(t);
      const rank = (r) => (r.severity in ranks ? ranks[r.severity]
        : (fallback ? Number(fallback[1]) : 0));
      return findingRows
        .filter((r) => r.run_id === values[0] && (!open || !r.resolved_at))
        .sort((a, b) => rank(a) - rank(b)
          || String(a.employee_ref || "").localeCompare(String(b.employee_ref || ""))
          || String(a.first_seen_at).localeCompare(String(b.first_seen_at)))
        .map(clone);
    }
    if (/^SELECT run_id,/.test(t)) {
      const byRun = new Map();
      for (const r of findingRows) {
        const acc = byRun.get(r.run_id) || { run_id: r.run_id, total: 0, open: 0, critical: 0, needs_review: 0 };
        acc.total += 1;
        if (!r.resolved_at) {
          acc.open += 1;
          if (r.severity === "critical") acc.critical += 1;
          if (r.status === "needs_review") acc.needs_review += 1;
        }
        byRun.set(r.run_id, acc);
      }
      return [...byRun.values()];
    }
    throw new Error("استعلام ملاحظات غير معروف: " + t);
  }

  /* إعداداتُ الموظّف وإجازاتُ الشهر: تخزينٌ حقيقيّ لا صمت. ومُزيَّفٌ
     يُرجع فراغًا لكل استعلام يجعل اختبارَ الإجازات مسرحيّة. */
  const settingRows = [];
  const leaveRows = [];

  function settingsExec(t, values) {
    if (/^SELECT emp_no, overtime_divisor/.test(t)) {
      return settingRows.slice().sort((a, b) => (a.emp_no < b.emp_no ? -1 : 1));
    }
    if (/^INSERT INTO droua_employee_settings/.test(t)) {
      const [empNo, divisor] = values;
      const found = settingRows.find((r) => r.emp_no === empNo);
      if (found) found.overtime_divisor = divisor;
      else settingRows.push({ emp_no: empNo, overtime_divisor: divisor, updated_at: new Date().toISOString() });
      return [{ emp_no: empNo, overtime_divisor: divisor }];
    }
    if (/^DELETE FROM droua_employee_settings/.test(t)) {
      const i = settingRows.findIndex((r) => r.emp_no === values[0]);
      if (i < 0) return [];
      return settingRows.splice(i, 1).map((r) => ({ emp_no: r.emp_no }));
    }
    throw new Error("استعلام إعدادات غير معروف: " + t);
  }

  function leavesExec(t, values) {
    if (/^SELECT id, emp_no, start_date/.test(t)) {
      return leaveRows.filter((r) => r.run_id === values[0])
        .sort((a, b) => (a.emp_no + a.start_date < b.emp_no + b.start_date ? -1 : 1));
    }
    if (/^INSERT INTO droua_run_leaves/.test(t)) {
      const [id, runId, empNo, start, end, note] = values;
      /* القيد الحقيقيّ في القاعدة — والمُزيَّف يفرضه كي لا ينجح ما يفشل. */
      if (end < start) throw new Error('new row violates check constraint "droua_run_leaves_check"');
      leaveRows.push({ id, run_id: runId, emp_no: empNo, start_date: start, end_date: end, note: note || null });
      return [{ id }];
    }
    if (/^UPDATE droua_run_leaves/.test(t)) {
      const [start, end, id] = values;
      const row = leaveRows.find((r) => r.id === id);
      if (!row) return [];
      /* القيد الحقيقيّ يُفرَض هنا أيضًا: مُزيَّفٌ يقبل ما ترفضه القاعدة
         يجعل اختبار «المقلوبة تُردّ» مسرحية. */
      if (end < start) throw new Error('new row violates check constraint "droua_run_leaves_check"');
      row.start_date = start; row.end_date = end;
      return [{ id }];
    }
    if (/^DELETE FROM droua_run_leaves/.test(t)) {
      const i = leaveRows.findIndex((r) => r.id === values[0]);
      if (i < 0) return [];
      return leaveRows.splice(i, 1).map((r) => ({ id: r.id }));
    }
    throw new Error("استعلام إجازات غير معروف: " + t);
  }

  function exec(text, values) {
    const t = norm(text);
    calls.push({ text: t, values });

    if (/droua_employee_settings/.test(t)) return settingsExec(t, values);
    if (/droua_run_leaves/.test(t)) return leavesExec(t, values);
    if (/droua_payroll_runs/.test(t)) return runsExec(t, values);
    if (/droua_payroll_findings/.test(t)) return findingsExec(t, values);
    if (/^SELECT run_id, count\(\*\)::int AS present/.test(t)) {
      const byRun = new Map();
      /* المُزيَّف يحاكي `kind = ANY(...)`: العدّ على اللازم وحده. وبلا ذلك
         يُخفي فرقًا بين ما يعدّه الخادم وما يعدّه الاختبار. */
      const only = (values[0] && Array.isArray(values[0])) ? values[0] : null;
      for (const r of rows) {
        if (r.superseded_at) continue;
        if (only && !only.includes(r.kind)) continue;
        byRun.set(r.run_id, (byRun.get(r.run_id) || 0) + 1);
      }
      return [...byRun].map(([run_id, present]) => ({ run_id, present }));
    }

    if (/^INSERT INTO droua_gate_audit/.test(t)) {
      auditRows.push({ event: values[0], userId: values[1], meta: JSON.parse(values[2] || "{}") });
      return [];
    }
    if (/^INSERT INTO droua_payroll_files/.test(t)) return insert(values);

    if (/^SELECT \* FROM droua_payroll_files/.test(t)) {
      const armedFailure = takeArmed("select");
      if (armedFailure) throw new Error(armedFailure);
      if (/WHERE id = \?::uuid/.test(t)) return rows.filter((r) => r.id === values[0]).map(clone);
      if (/WHERE run_id = \?::uuid$/.test(t)) return rows.filter((r) => r.run_id === values[0]).map(clone);
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
    sql, exec, rows, runRows, findingRows, audit: auditRows, calls, armed,
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
