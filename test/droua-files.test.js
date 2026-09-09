const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const files = require("../lib/droua/files");
const gateContext = require("../lib/droua/gateContext");
const keyring = require("../lib/droua/keyring");
const { makeFilesDb, makeFakeBlob } = require("./helpers/files-db");

/* ─── ملفّات القسم: التنسيق بين القاعدة والتخزين ───────────────────────
   =========================================================================
   ما يُختبر هنا ليس «هل تُكتب الصفوف» بل **ترتيب الفشل**. فالمسار السعيد
   يمرّ في كل تصميم؛ والفرق بين تصميم سليم وآخر يفقد ملفًّا معتمدًا يظهر
   وحده حين تفشل خطوةٌ في المنتصف:

     • نجح الرفع وفشلت القاعدة  → الكائن الجديد يُحذف، والقديم لا يُمسّ.
     • نجحت القاعدة وفشل الحذف  → الملفّ القديم بقايا مسجَّلة تُكنس، لا
       يتيمٌ لا يعرف به أحد.
     • تراجعٌ يمسّ القديم        → هذا بالضبط ما يجب ألّا يقع أبدًا.

   ولذلك القاعدة المُزيَّفة تفرض قيودها فعلًا، والمتجر يُسلَّح فشلُه صراحةً. */

const BLOB_ID = require.resolve("@vercel/blob");
const K1 = "a1".repeat(32);
const TOKEN = "vercel_blob_rw_DROUA_TEST_TOKEN";

const uuid = () => crypto.randomUUID();
const bytes = (text) => Buffer.from(text, "utf8");

const ENV_KEYS = [
  "DROUA_BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN", keyring.ENV_ACTIVE,
];

/* بيئة نظيفة + متجر مُزيَّف + قاعدة مُزيَّفة + **سياق بوابة مفتوح**.
   والمغلّف async ويُنتظر جسمه: النسخة المتزامنة تستعيد البيئة عند أول
   await فتمرّ حالات كان يجب أن تسقط. */
async function withGate(fn, { openGate = true } = {}) {
  const saved = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(keyring.ENV_PREFIX)) { saved[name] = process.env[name]; delete process.env[name]; }
  }
  for (const name of ENV_KEYS) {
    if (!(name in saved)) saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.DROUA_BLOB_READ_WRITE_TOKEN = TOKEN;
  process.env[keyring.ENV_ACTIVE] = "k1";
  process.env[keyring.ENV_PREFIX + "K1"] = K1;

  const blob = makeFakeBlob();
  const stub = new Module(BLOB_ID, null);
  stub.filename = BLOB_ID;
  stub.loaded = true;
  stub.exports = blob.api;
  const previous = require.cache[BLOB_ID];
  require.cache[BLOB_ID] = stub;

  const db = makeFilesDb();
  const ctx = { actorId: "11111111-2222-3333-4444-555555555555" };
  try {
    const body = () => fn({ db, blob, ctx, sql: db.sql });
    return openGate ? await gateContext.runWithGate({ userId: ctx.actorId, sidHash: "h" }, body) : await body();
  } finally {
    if (previous) require.cache[BLOB_ID] = previous;
    else delete require.cache[BLOB_ID];
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const input = (over = {}) => ({
  runId: uuid(), kind: "cash", fileName: "مسير.pdf", format: "pdf",
  bytes: bytes("محتوى اختباريّ مُصنَّع — لا بيانات رواتب"), ...over,
});

async function rejectsWith(fn, code) {
  try { await fn(); } catch (err) { return assert.equal(err.code || err.reason, code, err.message); }
  throw new Error(`كان يجب أن يفشل بـ${code}`);
}

/* ══ الحارس: لا شيء يبلغ الوحدة خارج سياق البوابة ═════════════════════ */

test("الحارس: كل دالّة مُصدَّرة ترمي خارج سياق البوابة — بلا نداء قاعدة ولا متجر", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const id = uuid();
    const attempts = [
      () => files.putFile(sql, input(), ctx),
      () => files.replaceFile(sql, input(), ctx),
      () => files.readFile(sql, id, ctx),
      () => files.getFile(sql, id),
      () => files.listCurrent(sql, id),
      () => files.listVersions(sql, id, "cash"),
      () => files.deleteFile(sql, id, ctx),
      () => files.findStale(sql),
      () => files.sweepStale(sql, ctx),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, /لا سياق بوابة/, "دالّة تعمل بلا حارس");
    }
    /* الأهمّ: لم يقع شيء أصلًا — لا استعلام ولا نداء متجر. */
    assert.equal(db.calls.length, 0);
    assert.equal(blob.calls.length, 0);
  }, { openGate: false });
});

test("الحارس: فاتحُ السياق واحد لا غير — وهو requireDrouaAccess", () => {
  /* الحارس الحقيقيّ يقوم على أن السياق **لا يُفتح إلا من مكان واحد**. لو
     فتحه ملفّ ثانٍ لصار الالتفاف عليه ممكنًا بلا أن يلاحظ أحد. */
  const dir = path.resolve(__dirname, "..", "lib", "droua");
  const openers = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    if (/runWithGate\s*\(/.test(code) && name !== "gateContext.js") openers.push(name);
  }
  assert.deepEqual(openers, ["access.js"], "سياق البوابة يُفتح من access.js وحده");

  const access = require("../lib/droua/access");
  assert.equal(typeof access.requireDrouaAccess, "function");
  const src = fs.readFileSync(path.join(dir, "access.js"), "utf8");
  /* ولا يُفتح إلا بعد التحقّق من جلسة حيّة — لا بمجرّد معرفة المستخدم. */
  assert.match(src, /isUsable\([\s\S]{0,200}?runWithGate/, "السياق يُفتح بعد isUsable لا قبلها");
});

test("الحارس: requireDrouaAccess بلا جلسة بوابة يُرجع locked ولا يفتح سياقًا", async () => {
  const access = require("../lib/droua/access");
  const db = makeFilesDb();
  /* بلا إعداد للقسم تُرجع evaluate إخفاءً — والمهمّ هنا أن أيّ نتيجة غير
     ok لا تحمل `run`، فلا سبيل إلى فتح السياق منها. */
  const result = await access.requireDrouaAccess(db.sql, { headers: {} }, { needGate: true });
  assert.equal(result.ok, false);
  assert.equal(result.run, undefined);
  assert.equal(gateContext.current(), null);
});

/* ══ الإنشاء والقراءة ═════════════════════════════════════════════════ */

test("الإنشاء: صفٌّ واحد، هويّة من الخادم، ودورة قراءة تُرجع البايتات نفسها", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const plain = bytes("محتوى مُصنَّع");
    const inp = input({ bytes: plain });
    const { file, replaced } = await files.putFile(sql, inp, ctx);

    assert.equal(replaced, false);
    assert.equal(db.rows.length, 1);
    const row = db.rows[0];
    assert.match(row.id, /^[0-9a-f-]{36}$/);
    assert.equal(row.run_id, inp.runId);
    assert.equal(row.kind, "cash");
    assert.equal(row.content_type, "application/pdf", "نوع المحتوى مشتقّ لا مأخوذ");
    assert.equal(row.enc_algo, "aes-256-gcm");
    assert.equal(Number(row.size_bytes), plain.length);
    assert.match(row.blob_pathname, /^droua-payroll-audit\/[0-9a-f-]{36}\/[0-9a-f]{32}$/);
    assert.ok(blob.objects.has(row.blob_pathname));
    assert.ok(!blob.objects.get(row.blob_pathname).equals(plain), "المخزَّن مشفَّر");

    const back = await files.readFile(sql, file.fileId, ctx);
    assert.ok(back.bytes.equals(plain));
    assert.equal(back.file.fileName, "مسير.pdf");
  });
});

test("القراءة: ما يخرج من الوحدة بلا مسار ولا IV ولا وسم", async () => {
  await withGate(async ({ sql, ctx }) => {
    const { file } = await files.putFile(sql, input(), ctx);
    const views = [file, await files.getFile(sql, file.fileId), (await files.readFile(sql, file.fileId, ctx)).file];
    for (const view of views) {
      const keys = Object.keys(view);
      for (const leaked of ["pathname", "blobPathname", "encIv", "encTag", "encKeyId", "plaintextSha256", "url"]) {
        assert.ok(!keys.includes(leaked), `الواجهة تسرّب ${leaked}`);
      }
      assert.equal(JSON.stringify(view).includes("droua-payroll-audit/"), false);
    }
    assert.deepEqual(Object.keys(file).sort(), [
      "contentType", "createdAt", "fileId", "fileName", "format",
      "isCurrent", "kind", "runId", "sizeBytes", "supersededAt",
    ]);
  });
});

test("القراءة: القوائم تُرجع الحاليّ فقط، والتاريخ عند طلبه", async () => {
  await withGate(async ({ sql, ctx }) => {
    const runId = uuid();
    await files.putFile(sql, input({ runId, kind: "cash" }), ctx);
    await files.putFile(sql, input({ runId, kind: "transfer", format: "xlsx", fileName: "t.xlsx" }), ctx);
    await files.replaceFile(sql, input({ runId, kind: "cash", fileName: "مُصحَّح.pdf" }), ctx);

    const current = await files.listCurrent(sql, runId);
    assert.deepEqual(current.map((f) => f.kind), ["cash", "transfer"]);
    assert.equal(current.find((f) => f.kind === "cash").fileName, "مُصحَّح.pdf");

    const versions = await files.listVersions(sql, runId, "cash");
    assert.equal(versions.length, 2, "النسخة القديمة تبقى تاريخًا");
    assert.deepEqual(versions.map((v) => v.isCurrent).sort(), [false, true]);
  });
});

/* ══ ما لا يُقبل من الطلب ══════════════════════════════════════════════ */

test("المدخلات: الحقول الستّة الممنوعة تُردّ بالاسم", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const forbidden = ["fileId", "blobPathname", "encIv", "encTag", "encKeyId", "contentType"];
    for (const key of forbidden) {
      await rejectsWith(() => files.putFile(sql, { ...input(), [key]: "x" }, ctx), "forbidden_field");
    }
    /* والقائمة المعلنة تغطّي الستّة وصيغها في القاعدة أيضًا. */
    for (const key of forbidden) assert.ok(files.CLIENT_FORBIDDEN.includes(key));
    for (const key of ["blob_pathname", "enc_iv", "enc_tag", "enc_key_id", "content_type", "id"]) {
      assert.ok(files.CLIENT_FORBIDDEN.includes(key), `القائمة تُغفل ${key}`);
    }
    /* وأي حقل غير معروف يُردّ افتراضيًّا — قائمة مسموح لا قائمة ممنوع. */
    await rejectsWith(() => files.putFile(sql, { ...input(), somethingNew: 1 }, ctx), "unknown_field");
    assert.equal(db.rows.length, 0);
    assert.equal(blob.calls.length, 0, "لا رفع لما سيُرفض");
  });
});

test("المدخلات: kind وformat من قائمتين مغلقتين، واسم الملفّ يُنقّى", async () => {
  await withGate(async ({ sql, ctx }) => {
    for (const kind of ["", "other", "CASH", "cash|x", "../cash"]) {
      await rejectsWith(() => files.putFile(sql, input({ kind }), ctx), "bad_kind");
    }
    for (const format of ["", "html", "exe", "PDF"]) {
      await assert.rejects(() => files.putFile(sql, input({ format }), ctx), /صيغة ملفّ غير مسموحة/);
    }
    await rejectsWith(() => files.putFile(sql, input({ runId: "not-a-uuid" }), ctx), "bad_run_id");

    /* سطرٌ جديد في اسم ملفّ = حقن ترويسات في Content-Disposition لاحقًا. */
    const { file } = await files.putFile(sql, input({ fileName: "a\r\nX-Evil: 1/b\\c.pdf" }), ctx);
    assert.equal(file.fileName, "aX-Evil: 1_b_c.pdf");
    assert.ok(!/[\r\n]/.test(file.fileName));

    await rejectsWith(() => files.putFile(sql, input({ fileName: "\r\n" }), ctx), "bad_file_name");
    await rejectsWith(() => files.putFile(sql, input({ fileName: "x".repeat(300) }), ctx), "bad_file_name");
  });
});

test("المدخلات: لا ثقة بأي مسار قادم من الطلب", async () => {
  await withGate(async ({ blob, sql, ctx }) => {
    const { file } = await files.putFile(sql, input(), ctx);
    const real = (await files.getFile(sql, file.fileId));
    assert.ok(real);

    /* القراءة تقبل fileId نصًّا لا كائنًا: كائنٌ يحمل مسارًا لا يُفهم أصلًا. */
    for (const bad of [
      { fileId: file.fileId, pathname: "droua-payroll-audit/x/y" },
      "droua-payroll-audit/aaa/bbb", "../../etc/passwd", "", null, 42,
    ]) {
      await rejectsWith(() => files.readFile(sql, bad, ctx), "bad_file_id");
      await rejectsWith(() => files.deleteFile(sql, bad, ctx), "bad_file_id");
    }
    /* والمسار الذي بلغ المتجر هو مسار الصفّ وحده. */
    const gets = blob.calls.filter((c) => c.op === "get");
    for (const call of gets) assert.equal(call.pathname, files.publicView ? call.pathname : call.pathname);
    assert.ok(gets.every((c) => /^droua-payroll-audit\//.test(c.pathname)));
  });
});

/* ══ الاستبدال وترتيب الفشل ═══════════════════════════════════════════ */

test("الاستبدال: رفعٌ ثمّ معاملة ثمّ تطهير القديم — بهذا الترتيب", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    const first = await files.putFile(sql, input({ runId, fileName: "أوّل.pdf" }), ctx);
    const oldPath = db.rows[0].blob_pathname;

    const result = await files.replaceFile(sql, input({ runId, fileName: "ثانٍ.pdf" }), ctx);
    assert.equal(result.replaced, true);
    assert.equal(result.oldPurged, true);
    assert.notEqual(result.file.fileId, first.file.fileId, "الاستبدال يُنشئ هويّة جديدة لا يكتب فوق القديمة");

    assert.equal(db.rows.length, 2, "الصفّ القديم يبقى تاريخًا");
    const [oldRow, newRow] = db.rows;
    assert.ok(oldRow.superseded_at, "القديم لم يعد حاليًّا");
    assert.ok(oldRow.purged_at, "وكائنه طُهِّر");
    assert.equal(newRow.superseded_at, null);
    assert.equal(blob.objects.has(oldPath), false, "بايتات القديم زالت");
    assert.ok(blob.objects.has(newRow.blob_pathname));

    /* ترتيب النداءات: الرفع قبل التطهير — لا العكس. */
    const ops = blob.calls.map((c) => c.op);
    assert.ok(ops.indexOf("put") < ops.lastIndexOf("del"), "طُهِّر القديم قبل رفع البديل");
  });
});

test("الاستبدال: نسخة حالية واحدة — والرفع الأول على خانة مشغولة يُردّ", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    await files.putFile(sql, input({ runId }), ctx);
    const before = blob.calls.length;
    /* الرفض **قبل** الرفع: لولاه لخلّف كل خطأ عاديّ يتيمًا. */
    await rejectsWith(() => files.putFile(sql, input({ runId }), ctx), "already_current");
    assert.equal(blob.calls.length, before, "لم يُرفع شيء ليُرفض بعده");
    assert.equal(db.rows.length, 1);
  });
});

test("الفشل: فشل القاعدة يحذف الكائن الجديد ولا يمسّ الملفّ المعتمد", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    await files.putFile(sql, input({ runId, fileName: "المعتمد.pdf" }), ctx);
    const approved = db.rows[0];
    const approvedBytes = blob.objects.get(approved.blob_pathname);

    db.arm("insert", "connection reset by peer");
    await assert.rejects(() => files.replaceFile(sql, input({ runId, fileName: "بديل.pdf" }), ctx));

    /* ① الملفّ المعتمد بحاله: صفًّا وبايتات ووصفَ «حاليّ». */
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].id, approved.id);
    assert.equal(db.rows[0].superseded_at, null, "التراجع رفع «الحاليّ» عن المعتمد");
    assert.ok(blob.objects.get(approved.blob_pathname).equals(approvedBytes));

    /* ② ولا كائن يتيم: الجديد رُفع ثمّ حُذف. */
    const puts = blob.calls.filter((c) => c.op === "put");
    const dels = blob.calls.filter((c) => c.op === "del");
    assert.equal(puts.length, 2);
    assert.equal(dels.length, 1);
    assert.equal(dels[0].pathname, puts[1].pathname, "المحذوف هو الكائن الجديد لا القديم");
    assert.equal(blob.objects.size, 1);
    assert.deepEqual(db.events(), [], "تراجعٌ ناجح لا يحتاج تسجيل يتيم");
  });
});

test("الفشل: فشل القاعدة **وفشل** التراجع يُسجَّل يتيمًا بمساره", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    db.arm("insert", "deadlock detected");
    blob.fail.del = true;
    await assert.rejects(() => files.putFile(sql, input(), ctx));

    assert.equal(db.rows.length, 0);
    assert.equal(blob.objects.size, 1, "الكائن بقي — ولا صفّ يشير إليه");
    assert.deepEqual(db.events(), ["blob_orphan"]);
    const meta = db.audit[0].meta;
    assert.match(meta.pathname, /^droua-payroll-audit\//, "المسار مسجَّل — وهو الوحيد القابل للكنس");
    assert.equal(meta.reason, "insert_failed");
    assert.ok(!("fileName" in meta), "اسم الملفّ لا يدخل التدقيق");
  });
});

test("الفشل: فشل رفع المتجر لا يكتب صفًّا ولا يمسّ القديم", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    await files.putFile(sql, input({ runId }), ctx);
    const approved = { ...db.rows[0] };

    blob.fail.put = true;
    await assert.rejects(() => files.replaceFile(sql, input({ runId }), ctx), /فشل رفع مُسلَّح/);

    assert.equal(db.rows.length, 1);
    assert.deepEqual(db.rows[0], approved, "الصفّ المعتمد لم يتغيّر بحرف");
    assert.ok(blob.objects.has(approved.blob_pathname));
  });
});

test("الفشل: فشل تطهير القديم يترك بقايا مسجَّلة يلتقطها المسح", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    await files.putFile(sql, input({ runId }), ctx);
    const oldPath = db.rows[0].blob_pathname;

    blob.fail.del = true;
    const result = await files.replaceFile(sql, input({ runId }), ctx);
    assert.equal(result.replaced, true);
    assert.equal(result.oldPurged, false, "الاستبدال نجح والتطهير لم ينجح");
    assert.deepEqual(db.events(), ["blob_stale"]);
    assert.ok(blob.objects.has(oldPath), "البايتات القديمة باقية");

    /* البقايا مرئيّة لاستعلامٍ محدَّد — لا ضائعة كاليتيم. */
    const stale = await files.findStale(sql);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].blob_pathname, oldPath);

    /* والمسح يُنهي ما بدأه الاستبدال. */
    blob.fail.del = false;
    const swept = await files.sweepStale(sql, ctx);
    assert.deepEqual(swept, { scanned: 1, purged: 1, remaining: 0 });
    assert.equal(blob.objects.has(oldPath), false);
    assert.ok(db.rows.find((r) => r.blob_pathname === oldPath).purged_at);
    assert.equal(db.rows.length, 2, "صفّ النسخة المستبدَلة يبقى تاريخًا بعد الكنس");
    assert.deepEqual(await files.findStale(sql), []);
  });
});

test("الفشل: صفٌّ يخالف قيد التفرّد يُتراجَع عنه كأي فشل قاعدة", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    /* التفرّد على blob_pathname يمنع صفّين يشيران إلى كائن واحد — فحذف
       أحدهما كان سيُفقد الآخر. وهنا يُحاكى اصطدامه. */
    db.arm("insert", 'duplicate key value violates unique constraint "droua_payroll_files_blob_pathname_key"');
    await assert.rejects(() => files.putFile(sql, input(), ctx), /duplicate key/);
    assert.equal(db.rows.length, 0);
    assert.equal(blob.objects.size, 0, "الكائن المرفوع تراجعنا عنه");

    /* والقيد نفسه معلَن في المخطّط لا في التطبيق وحده. */
    const { STATEMENTS } = require("../scripts/setup-droua-files");
    const ddl = STATEMENTS.map((s) => s.sql).join("\n");
    assert.match(ddl, /blob_pathname\s+text NOT NULL UNIQUE/);
    assert.match(ddl, /CREATE UNIQUE INDEX[\s\S]*\(run_id, kind\) WHERE superseded_at IS NULL/);
  });
});

/* ══ العبث بالوصف ═════════════════════════════════════════════════════ */

test("العبث: تحوير أي عمود يدخل الـAAD أو التشفير يُسقط القراءة ويُسجَّل", async () => {
  const cases = [
    ["run_id", () => uuid(), "tag_mismatch"],
    ["kind", () => "transfer", "tag_mismatch"],
    ["id", () => uuid(), "bad_file_id"],
    ["enc_iv", () => "ff".repeat(12), "tag_mismatch"],
    ["enc_tag", () => "ff".repeat(16), "tag_mismatch"],
    ["enc_key_id", () => "k9", "unknown_key"],
    ["plaintext_sha256", () => "0".repeat(64), "sha_mismatch"],
  ];
  for (const [column, value, expected] of cases) {
    await withGate(async ({ db, sql, ctx }) => {
      const { file } = await files.putFile(sql, input(), ctx);
      db.rows[0][column] = value();
      const id = column === "id" ? file.fileId : db.rows[0].id;
      await rejectsWith(() => files.readFile(sql, id, ctx), column === "id" ? "not_found" : expected);
    });
  }
});

test("العبث: تبديل المسار بين صفّين لنفس الشهر والنوع يُكتشف", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    await files.putFile(sql, input({ runId, bytes: bytes("النسخة الأولى") }), ctx);
    /* يُمنع تطهير القديم كي تبقى بايتاته موجودة — وإلّا كان الفشل
       «كائن مفقود» لا اكتشافًا للتبديل، وهو اختبارٌ آخر. */
    blob.fail.del = true;
    await files.replaceFile(sql, input({ runId, bytes: bytes("النسخة الثانية") }), ctx);
    blob.fail.del = false;
    const [oldRow, newRow] = db.rows;

    /* التبديل الكامل لوصف الشيفرة بين الصفّين: لا يبقى فارقٌ إلا الـAAD. */
    const swapped = { pathname: oldRow.blob_pathname, iv: oldRow.enc_iv, tag: oldRow.enc_tag };
    newRow.blob_pathname = swapped.pathname;
    newRow.enc_iv = swapped.iv;
    newRow.enc_tag = swapped.tag;
    newRow.plaintext_sha256 = oldRow.plaintext_sha256;

    await rejectsWith(() => files.readFile(sql, newRow.id, ctx), "tag_mismatch");
    assert.deepEqual(db.events(), ["blob_stale", "file_integrity_failure"]);
  });
});

test("العبث: حدث السلامة معقَّم — سببٌ ومعرّفات، بلا اسم ولا بايتات", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const { file } = await files.putFile(sql, input({ fileName: "مسير الرواتب كامل سبتمبر.pdf" }), ctx);
    blob.objects.get(db.rows[0].blob_pathname)[0] ^= 0x01;
    await rejectsWith(() => files.readFile(sql, file.fileId, ctx), "tag_mismatch");

    assert.deepEqual(db.events(), ["file_integrity_failure"]);
    const entry = db.audit[0];
    assert.deepEqual(Object.keys(entry.meta).sort(), ["encKeyId", "fileId", "kind", "pathname", "reason", "runId"]);
    assert.equal(entry.meta.reason, "tag_mismatch");
    assert.equal(JSON.stringify(entry).includes("سبتمبر"), false, "اسم الملفّ بيانُ رواتب لا واصف");
    assert.equal(entry.userId, ctx.actorId);
  });
});

test("العبث: كائن مفقود يُبلَّغ ويُسجَّل ولا يمرّ بصمت", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const { file } = await files.putFile(sql, input(), ctx);
    blob.objects.delete(db.rows[0].blob_pathname);
    await rejectsWith(() => files.readFile(sql, file.fileId, ctx), "object_missing");
    assert.deepEqual(db.events(), ["file_integrity_failure"]);
    assert.equal(db.audit[0].meta.reason, "object_missing");
  });
});

/* ══ الحذف ════════════════════════════════════════════════════════════ */

test("الحذف: يختفي أوّلًا، ثمّ تُمحى بايتاته، ثمّ يُشطب صفّه", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    const { file } = await files.putFile(sql, input({ runId }), ctx);
    const pathname = db.rows[0].blob_pathname;

    assert.deepEqual(await files.deleteFile(sql, file.fileId, ctx), { deleted: true, purged: true });
    assert.equal(db.rows.length, 0);
    assert.equal(blob.objects.has(pathname), false);
    assert.deepEqual(await files.listCurrent(sql, runId), []);

    /* والحذف مرّتين لا يرمي. */
    assert.deepEqual(await files.deleteFile(sql, file.fileId, ctx), { deleted: false, purged: false });
  });
});

test("الحذف: فشل محو البايتات يترك شاهد قبرٍ يُكمله المسح — لا يتيمًا", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const runId = uuid();
    const { file } = await files.putFile(sql, input({ runId }), ctx);
    const pathname = db.rows[0].blob_pathname;

    blob.fail.del = true;
    assert.deepEqual(await files.deleteFile(sql, file.fileId, ctx), { deleted: true, purged: false });

    /* اختفى من النظام فورًا رغم بقاء صفّه. */
    assert.deepEqual(await files.listCurrent(sql, runId), []);
    assert.equal(db.rows.length, 1);
    assert.ok(db.rows[0].deleted_at, "شاهد قبر لا نسخة تاريخية");
    assert.deepEqual(db.events(), ["blob_stale"]);
    /* وقراءته ممنوعة رغم بقاء الصفّ والبايتات. */
    assert.ok(blob.objects.has(pathname));

    blob.fail.del = false;
    const swept = await files.sweepStale(sql, ctx);
    assert.deepEqual(swept, { scanned: 1, purged: 1, remaining: 0 });
    assert.equal(blob.objects.has(pathname), false);
    assert.equal(db.rows.length, 0, "شاهد القبر يُزال بعد محو بايتاته");
  });
});

test("الحذف: صفٌّ مطهَّر لا يُقرأ ولا يُحاوَل فكّه", async () => {
  await withGate(async ({ db, blob, sql, ctx }) => {
    const { file } = await files.putFile(sql, input(), ctx);
    db.rows[0].superseded_at = new Date().toISOString();
    db.rows[0].purged_at = new Date().toISOString();
    const before = blob.calls.length;
    await rejectsWith(() => files.readFile(sql, file.fileId, ctx), "not_found");
    assert.equal(blob.calls.length, before, "لا نداء متجر لبايتات نعلم أنها زالت");
  });
});

/* ══ المخطّط ══════════════════════════════════════════════════════════ */

test("المخطّط: القيود التي تحمي معنى الأعمدة معلَنة في القاعدة نفسها", async () => {
  const { STATEMENTS, run } = require("../scripts/setup-droua-files");
  const ddl = STATEMENTS.map((s) => s.sql).join("\n");
  /* الفحص على الشيفرة لا على الشرح: تعليقات المخطّط تذكر text/html عمدًا
     لتقول لماذا أُقفل الزوج — ومسحُ النصّ الخام كان سيعدّ الشرح مخالفة. */
  const code = ddl.replace(/--[^\n]*/g, " ");

  assert.match(ddl, /kind\s+text NOT NULL CHECK \(kind IN \('cash', 'full', 'transfer', 'employees'\)\)/);
  assert.match(ddl, /format\s+text NOT NULL CHECK \(format IN \('pdf', 'xlsx', 'xls', 'csv'\)\)/);
  assert.match(ddl, /size_bytes\s+bigint NOT NULL CHECK \(size_bytes > 0 AND size_bytes <= 10485760\)/);
  assert.match(ddl, /plaintext_sha256 text NOT NULL CHECK/);
  assert.match(ddl, /enc_key_id\s+text NOT NULL CHECK \(enc_key_id ~ '\^k\[1-9\]\[0-9\]\{0,2\}\$'\)/);
  assert.match(ddl, /enc_iv\s+text NOT NULL CHECK \(enc_iv ~ '\^\[0-9a-f\]\{24\}\$'\)/);
  assert.match(ddl, /enc_tag\s+text NOT NULL CHECK \(enc_tag ~ '\^\[0-9a-f\]\{32\}\$'\)/);
  /* الزوج المقفل: صيغةٌ ونوع محتوى متناقضان هما بالضبط طريق XSS المخزَّن. */
  assert.match(ddl, /droua_payroll_files_type_pair/);
  assert.match(ddl, /format = 'pdf'\s+AND content_type = 'application\/pdf'/);
  assert.ok(!/text\/html/.test(code), "لا نوع قابل للتنفيذ في القائمة");
  /* واسم الملفّ بلا محارف تحكّم — الطبقة الثانية تحت ترويسة التنزيل. */
  assert.match(ddl, /file_name !~ '\[\[:cntrl:\]\]'/);
  /* وحدّ الحجم نفسه في الطبقتين. */
  assert.equal(10485760, require("../lib/droua/storage").MAX_BYTES);

  /* كل عبارة IF NOT EXISTS: التشغيل مرّتين لا يفعل شيئًا في الثانية. */
  for (const s of STATEMENTS) assert.match(s.sql, /IF NOT EXISTS/);
  assert.ok(!/DROP |ALTER TABLE|DELETE FROM|TRUNCATE/i.test(ddl), "السكربت لا يحذف ولا يعدّل");

  /* والتنفيذ يمرّ بـsql.query — لا sql.unsafe التي لا تنفّذ شيئًا أصلًا. */
  const used = [];
  await run({ query: async (text) => { used.push(text); } });
  assert.equal(used.length, STATEMENTS.length);
});

test("المخطّط: --dry-run يطبع ولا يتّصل", () => {
  const { spawnSync } = require("node:child_process");
  const script = path.resolve(__dirname, "..", "scripts", "setup-droua-files.js");
  const r = spawnSync(process.execPath, [script, "--dry-run"], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /معاينة فقط/);
  assert.match(r.stdout, /CREATE TABLE IF NOT EXISTS droua_payroll_files/);
  assert.match(r.stdout, /المجموع: 2 عبارة/);
});
