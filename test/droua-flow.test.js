const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const runs = require("../lib/droua/runs");
const files = require("../lib/droua/files");
const findings = require("../lib/droua/findings");
const analyze = require("../lib/droua/analyze");
const api = require("../lib/droua/api");
const { withDroua, makeRes, b64 } = require("./helpers/droua-harness");
const fx = require("./helpers/payroll-fixtures");

/* ─── دورة العمل كاملة ──────────────────────────────────────────────────
   =========================================================================
   من إنشاء الشهر إلى الملاحظة المكتوبة بيد المستخدم، مرورًا بالرفع
   والتشفير والتحليل وإعادة الرفع.

   والسؤال الذي تُجيب عنه هذه الاختبارات قبل غيره: **ماذا يبقى من عمل
   المستخدم حين يعيد الرفع؟** فنظامٌ يمحو ملاحظاته مع كل تصحيح يعاقبه على
   التصحيح، ولن يستعمله مرّتين.

   ⛔ وكل عيّنة مصنوعة: أسماء مخترعة وحسابات لا تخصّ أحدًا. */

const upload = (sql, ctx, runId, kind, text, replace = false) =>
  (replace ? files.replaceFile : files.putFile)(sql, {
    runId, kind, fileName: `${kind}.csv`, format: "csv", bytes: Buffer.from(text, "utf8"),
  }, ctx);

/* يرفع ما توفّر في العيّنة فقط: خانة العمل الإضافي اختيارية، وأكثرُ
   العيّنات لا تحملها — ورفعُ `undefined` يُسقط الرفع لا الاختبار. */
async function seedMonth(sql, ctx, period, month) {
  const run = await runs.createRun(sql, period);
  for (const kind of files.KINDS) {
    if (typeof month[kind] !== "string") continue;
    await upload(sql, ctx, run.runId, kind, month[kind]);
  }
  return run;
}

/* نداءٌ على مداخل البيانات كما يناديها الموجّه — داخل السياق نفسه. */
async function callApi(sql, ctx, method, apiPath, body) {
  const { res, out } = makeRes();
  await api.handle({ method, body, headers: {} }, res, { sql, ctx, apiPath, query: {} });
  return out;
}

/* ══ الأشهر ═══════════════════════════════════════════════════════════ */

test("الشهر: يُنشأ مرّة واحدة، والصيغة مفروضة، والسابق يُحسب نصًّا", async () => {
  await withDroua(async ({ sql }) => {
    const run = await runs.createRun(sql, "2026-09");
    assert.equal(run.period, "2026-09");
    assert.equal(run.status, "draft");
    await assert.rejects(() => runs.createRun(sql, "2026-09"), /duplicate key/);
    for (const bad of ["2026-13", "2026-00", "26-09", "2026-9", "", "2026-09-01"]) {
      await assert.rejects(() => runs.createRun(sql, bad), (err) => err.code === "bad_period", bad);
    }
    assert.equal(runs.previousPeriod("2026-01"), "2025-12");
    assert.equal(runs.previousPeriod("2026-09"), "2026-08");
  });
});

test("الشهر: خاناته الخمس تُعرَض بحالتها، والاكتمال على اللازم وحده", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    let slots = await runs.fileSlots(sql, run.runId);
    assert.deepEqual(slots.map((s) => s.kind), ["full", "transfer", "cash", "employees", "overtime"]);
    assert.deepEqual(slots.filter((s) => !s.required).map((s) => s.kind), ["overtime"],
      "خانة العمل الإضافي وحدها اختيارية");
    assert.equal(slots.every((s) => !s.present), true);
    assert.equal(runs.isComplete(slots), false);
    assert.ok(slots[0].label.includes("كامل"));

    const month = fx.consistentMonth();
    for (const kind of files.REQUIRED_KINDS) await upload(sql, ctx, run.runId, kind, month[kind]);
    slots = await runs.fileSlots(sql, run.runId);
    assert.equal(runs.isComplete(slots), true);
    assert.equal(slots.find((s) => s.kind === "full").file.fileName, "full.csv");
  });
});

test("الشهر: حذفه يمحو بايتات ملفّاته أوّلًا — لا يتركها في المتجر", async () => {
  await withDroua(async ({ db, blob, sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());
    assert.equal(blob.objects.size, 4);

    const result = await runs.deleteRun(sql, run.runId, ctx);
    assert.deepEqual(result, { deleted: true, purged: 4, pending: 0 });
    assert.equal(blob.objects.size, 0, "لا بايتات باقية");
    assert.equal(db.rows.length, 0);
    assert.equal(db.runRows.length, 0);
  });
});

test("الشهر: لا يُحذف ما دامت بايتاتٌ لم تُمحَ — فالبقايا تبقى مرئيّة", async () => {
  await withDroua(async ({ db, blob, sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());
    blob.fail.del = true;
    const result = await runs.deleteRun(sql, run.runId, ctx);
    assert.equal(result.deleted, false);
    assert.equal(result.pending, 4);
    assert.equal(db.runRows.length, 1, "صفّ الشهر يبقى ليُبقي شواهد القبور مرئيّة");
    assert.equal((await files.findStale(sql)).length, 4);

    blob.fail.del = false;
    assert.deepEqual(await files.sweepStale(sql, ctx), { scanned: 4, purged: 4, remaining: 0 });
    assert.equal((await runs.deleteRun(sql, run.runId, ctx)).deleted, true);
    assert.equal(blob.objects.size, 0);
  });
});

/* ══ التحليل ══════════════════════════════════════════════════════════ */

test("التحليل: شهرٌ متّسق لا يُنتج إلا ما يخصّ الملفّات نفسها", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());
    const result = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.deepEqual(result.missing, ["overtime"], "الاختياريّ وحده ناقص");
    /* ملاحظةٌ واحدة: «ملفٌّ اختياريّ ناقص» — معلومةٌ لا خلل. وما عداها صفر. */
    const list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
    /* ملاحظتان اثنتان، كلتاهما **معلومة** وعن الخانة الاختيارية نفسها:
       «ملفٌّ ناقص»، و«قواعدُه لم تُقيَّم». ولا واحدةَ منهما تحذير: نقصُ
       ملفٍّ اختياريّ في الشهر الجاري ليس حدثًا يستدعي فعلًا. */
    assert.deepEqual(list.map((f) => `${f.rule}:${f.severity}`).sort(),
      ["file_missing:info", "not_evaluable:info"],
      JSON.stringify(list.map((f) => f.title)));
    assert.ok(list.every((f) => /overtime/.test(f.field)), "كلّها عن ملفّ العمل الإضافي");
    assert.equal(result.previousPeriod, null, "لا شهر سابق");
    assert.ok(result.rulesSkipped.includes("iban_changed"));
    assert.equal((await runs.getRun(sql, run.runId)).status, "analyzed");
  });
});

test("التحليل: ملفٌّ ناقص يصير ملاحظة لا استثناء — ويُحلّ برفعه", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    const run = await runs.createRun(sql, "2026-09");
    await upload(sql, ctx, run.runId, "full", month.full);

    const first = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.deepEqual(first.missing.sort(), ["cash", "employees", "overtime", "transfer"]);
    let open = await findings.listFindings(sql, run.runId);
    const missing = open.filter((f) => f.rule === "file_missing");
    /* أربعُ ملاحظات: ثلاثةٌ حرجة للازم، وواحدةٌ معلومة للاختياريّ. */
    assert.equal(missing.length, 4);
    assert.deepEqual(missing.filter((f) => f.severity === "critical").map((f) => f.field).sort(),
      ["cash", "employees", "transfer"]);
    assert.deepEqual(missing.filter((f) => f.severity === "info").map((f) => f.field), ["overtime"],
      "الاختياريّ لا يُنذَر به إنذارًا حرجًا");

    for (const kind of ["transfer", "cash", "employees"]) await upload(sql, ctx, run.runId, kind, month[kind]);
    const second = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.equal(second.resolved >= 3, true, "الناقص عولج برفعه");
    open = await findings.listFindings(sql, run.runId);
    assert.deepEqual(open.filter((f) => f.rule === "file_missing").map((f) => f.field), ["overtime"],
      "الاختياريّ يبقى معلومةً حتى يُرفع");
    /* ولا يُحذف: اختفاء الملاحظة حدثٌ يبقى. */
    const all = await findings.listFindings(sql, run.runId, { includeResolved: true });
    assert.equal(all.filter((f) => f.rule === "file_missing" && f.resolvedAt).length, 3);
  });
});

test("التحليل: صيغةٌ بلا قارئ تُرفع وتُحفظ وتُبلَّغ — ولا تُسقط الشهر", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    const run = await runs.createRun(sql, "2026-09");
    await upload(sql, ctx, run.runId, "full", month.full);
    await files.putFile(sql, {
      runId: run.runId, kind: "transfer", fileName: "t.pdf", format: "pdf",
      bytes: Buffer.from("%PDF-1.7 صناعيّ", "utf8"),
    }, ctx);

    const result = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.deepEqual(result.unreadable, [{ kind: "transfer", reason: "parser_unavailable" }]);
    const open = await findings.listFindings(sql, run.runId);
    const note = open.find((f) => f.rule === "file_unreadable");
    assert.ok(note);
    assert.equal(note.severity, "warn");
    /* والملفّ نفسه محفوظ ومقروء البايتات رغم غياب القارئ. */
    const back = await files.readFile(sql, (await runs.fileSlots(sql, run.runId))
      .find((s) => s.kind === "transfer").file.fileId, ctx);
    assert.ok(back.bytes.toString("utf8").includes("صناعيّ"));
  });
});

test("التحليل: المقارنة مع الشهر السابق تعمل عبر ملفّين مشفَّرين", async () => {
  await withDroua(async ({ sql, ctx }) => {
    await seedMonth(sql, ctx, "2026-08", fx.consistentMonth());
    const september = fx.consistentMonth({ ibans: { 1001: "SA9999999999999999991234" } });
    const run = await seedMonth(sql, ctx, "2026-09", september);

    const result = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.equal(result.previousPeriod, "2026-08");
    const open = await findings.listFindings(sql, run.runId);
    const changed = open.find((f) => f.rule === "iban_changed");
    assert.ok(changed, JSON.stringify(open.map((f) => f.rule)));
    assert.equal(changed.severity, "critical");
    assert.equal(changed.employeeRef, "1001");
    assert.equal(changed.currentValue, "****1234");
    /* ولا رقم حساب كامل في أي صفٍّ من صفوف الملاحظات. */
    assert.ok(!/SA\d{20,}/.test(JSON.stringify(db_findings(open))));
    function db_findings(list) { return list; }
  });
});

/* ══ إعادة الرفع وإعادة التحليل — قلب الدورة ══════════════════════════ */

test("الدورة: تصحيحُ ملفٍّ ثمّ إعادة التحليل يُبقي حالة المستخدم وملاحظته", async () => {
  await withDroua(async ({ blob, sql, ctx }) => {
    const month = fx.consistentMonth();
    /* عطلٌ مقصود: الكاش أعلى ممّا في الكامل. */
    month.cash = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6500 }]);
    const run = await seedMonth(sql, ctx, "2026-09", month);

    await analyze.analyzeRun(sql, run.runId, ctx);
    let open = await findings.listFindings(sql, run.runId);
    const mismatch = open.find((f) => f.rule === "net_mismatch");
    assert.ok(mismatch);
    assert.equal(mismatch.status, "needs_review");

    /* المستخدم يحكم ويكتب. */
    await findings.updateFinding(sql, mismatch.findingId, {
      status: "needs_fix", userNote: "راجعتُ الكشف: الكاش أُدخل خطأً.",
    });

    /* إعادة تحليل بلا تغيير: الملاحظة نفسها — بحالتها وتعليقها. */
    const again = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.equal(again.created, 0);
    assert.ok(again.updated > 0);
    open = await findings.listFindings(sql, run.runId);
    const same = open.find((f) => f.findingId === mismatch.findingId);
    assert.ok(same, "البصمة أبقت الملاحظة نفسها");
    assert.equal(same.status, "needs_fix", "حالة المستخدم لم تُمسح");
    assert.equal(same.userNote, "راجعتُ الكشف: الكاش أُدخل خطأً.");

    /* ثمّ يُصحَّح الملفّ ويُعاد رفعه. */
    const fixed = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6000 }]);
    await upload(sql, ctx, run.runId, "cash", fixed, true);
    const third = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.ok(third.resolved >= 1);

    open = await findings.listFindings(sql, run.runId);
    assert.equal(open.find((f) => f.rule === "net_mismatch"), undefined, "زالت من المفتوح");
    const all = await findings.listFindings(sql, run.runId, { includeResolved: true });
    const resolved = all.find((f) => f.findingId === mismatch.findingId);
    assert.ok(resolved.resolvedAt, "وبقيت في السجلّ معلَّمةً أنها عولجت");
    assert.equal(resolved.userNote, "راجعتُ الكشف: الكاش أُدخل خطأً.", "والتعليق باقٍ");

    /* والنسخة القديمة من الملفّ زالت بايتاتها. */
    const versions = await files.listVersions(sql, run.runId, "cash");
    assert.equal(versions.length, 2);
    assert.equal(blob.objects.size, 4, "أربعة ملفّات حالية لا خمسة");
  });
});

test("الدورة: عبارةُ المزامنة نفسها لا تذكر status ولا user_note", async () => {
  await withDroua(async ({ db, sql, ctx }) => {
    const month = fx.consistentMonth();
    month.cash = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6500 }]);
    const run = await seedMonth(sql, ctx, "2026-09", month);
    await analyze.analyzeRun(sql, run.runId, ctx);
    await analyze.analyzeRun(sql, run.runId, ctx);

    /* الفحص على نصّ الـSQL لا على أثره: أثرُ عمودٍ في قاعدةٍ مُزيَّفة قد
       يُتجاهل بصمت، والنصّ لا يُتجاهل. */
    const updates = db.calls.filter((c) => /^UPDATE droua_payroll_findings SET severity/.test(c.text));
    assert.ok(updates.length > 0, "لم تقع مزامنةُ تحديث أصلًا");
    for (const call of updates) {
      assert.ok(!/\bstatus\b/.test(call.text), "المزامنة تمسّ حالة المستخدم");
      assert.ok(!/user_note/.test(call.text), "المزامنة تمسّ تعليق المستخدم");
    }
  });
});

test("الدورة: المستخدم يملك الحالة والتعليق — لا القيم ولا الوصف", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    month.cash = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6500 }]);
    const run = await seedMonth(sql, ctx, "2026-09", month);
    await analyze.analyzeRun(sql, run.runId, ctx);
    const target = (await findings.listFindings(sql, run.runId))[0];

    for (const key of ["title", "severity", "currentValue", "delta", "rule", "employeeRef", "resolvedAt"]) {
      await assert.rejects(() => findings.updateFinding(sql, target.findingId, { [key]: "x" }),
        (err) => err.code === "forbidden_field", key);
    }
    await assert.rejects(() => findings.updateFinding(sql, target.findingId, { status: "مغلقة" }),
      (err) => err.code === "bad_status");
    /* وأي رقم حساب في تعليق المستخدم يُقنَّع قبل أن يُحفظ. */
    const saved = await findings.updateFinding(sql, target.findingId, {
      userNote: "الحساب SA0380000000608010167519 صحيح",
    });
    assert.ok(!/SA\d{20,}/.test(saved.userNote));
    assert.ok(saved.userNote.includes("****7519"));
  });
});

/* ══ مداخل البيانات ═══════════════════════════════════════════════════ */

test("المداخل: دورة كاملة عبر الـAPI — إنشاء ورفع وتحليل وتنزيل وحذف", async () => {
  await withDroua(async ({ blob, sql, ctx }) => {
    const created = await callApi(sql, ctx, "POST", "runs", { period: "2026-09" });
    assert.equal(created.statusCode, 200);
    const runId = created.body.run.runId;

    const month = fx.consistentMonth({ overtime: [{ empNo: "1001", m15: 120 }] });
    for (const kind of files.KINDS) {
      const res = await callApi(sql, ctx, "POST", `runs/${runId}/files`,
        { kind, fileName: `${kind}.csv`, format: "csv", data: b64(month[kind]) });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    }

    const detail = await callApi(sql, ctx, "GET", `runs/${runId}`);
    assert.equal(detail.body.complete, true);
    assert.equal(detail.body.previousPeriod, "2026-08");
    assert.equal(detail.body.statuses.length, 4);

    const analysis = await callApi(sql, ctx, "POST", `runs/${runId}/analyze`);
    assert.equal(analysis.statusCode, 200);
    /* رُفع ملفّ عملٍ إضافيّ ولا صفَّ قاسمٍ محفوظ — فيُطبَّق الافتراضيّ
       وتُعلَن شفافيّتُه. وقواعدُ المال تتوقّف لسببٍ آخر: الكشف نفسه لا
       يحمل عمود «وقت اضافي». علّتان مختلفتان تُعلَنان معًا. */
    const produced = (await callApi(sql, ctx, "GET", `runs/${runId}/findings`)).body.findings;
    assert.deepEqual(produced.map((f) => f.rule).sort(), ["not_evaluable", "ot_no_divisor"],
      JSON.stringify(produced.map((f) => f.title)));
    const note = produced.find((f) => f.rule === "ot_no_divisor");
    assert.equal(note.severity, "info", "الافتراضيّ شفافيّةٌ لا إنذار");
    assert.match(note.currentValue, /1 موظّفًا/, "ملاحظةٌ جامعة لا واحدةٌ لكلٍّ");
    assert.match(produced.find((f) => f.rule === "not_evaluable").field, /full\.otAmount/);

    const list = await callApi(sql, ctx, "GET", "runs");
    assert.equal(list.body.runs[0].filesPresent, 4);
    assert.equal(list.body.runs[0].filesExpected, 4);

    /* التنزيل: نوعٌ قسريّ ومرفقٌ دائمًا وبايتات مطابقة. */
    const fileId = detail.body.slots.find((s) => s.kind === "full").file.fileId;
    const dl = await callApi(sql, ctx, "GET", `files/${fileId}/download`);
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.headers["content-type"], "text/csv");
    assert.match(dl.headers["content-disposition"], /^attachment; /);
    assert.equal(dl.headers["x-content-type-options"], "nosniff");
    assert.equal(dl.body.toString("utf8"), month.full);

    const removed = await callApi(sql, ctx, "DELETE", `files/${fileId}`);
    assert.equal(removed.statusCode, 200);
    /* خمسةٌ رُفعت (بالعمل الإضافي) وواحدٌ حُذف. */
    assert.equal(blob.objects.size, 4);
  });
});

test("المداخل: الرفع الثاني على خانةٍ مشغولة يُردّ، والاستبدال صريح", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    const month = fx.consistentMonth();
    const body = { kind: "full", fileName: "f.csv", format: "csv", data: b64(month.full) };

    assert.equal((await callApi(sql, ctx, "POST", `runs/${run.runId}/files`, body)).statusCode, 200);
    const second = await callApi(sql, ctx, "POST", `runs/${run.runId}/files`, body);
    assert.equal(second.statusCode, 400);
    assert.match(second.body.error, /الاستبدال/);
    const replaced = await callApi(sql, ctx, "POST", `runs/${run.runId}/files`, { ...body, replace: true });
    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.body.replaced, true);
  });
});

test("المداخل: ما لا يُقبل من الطلب يُردّ قبل أن يبلغ التخزين", async () => {
  await withDroua(async ({ blob, sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    const base = { kind: "full", fileName: "f.csv", format: "csv", data: b64("a,b\n1,2\n") };
    const cases = [
      { ...base, fileId: crypto.randomUUID() },
      { ...base, blobPathname: "droua-payroll-audit/x/y" },
      { ...base, encKeyId: "k1" },
      { ...base, contentType: "text/html" },
      { ...base, format: "html" },
      { ...base, kind: "other" },
      { ...base, data: "@@@not-base64@@@" },
      { ...base, data: "" },
    ];
    for (const body of cases) {
      const res = await callApi(sql, ctx, "POST", `runs/${run.runId}/files`, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(blob.objects.size, 0, "لا بايتة بلغت المتجر");
  });
});

test("المداخل: حدّ الرفع مفروضٌ قبل فكّ الترميز", async () => {
  const big = "A".repeat(Math.ceil(api.MAX_UPLOAD_BYTES / 3) * 4 + 100);
  assert.throws(() => api.decodeUpload({ kind: "full", fileName: "f", format: "csv", data: big }), /أكبر من الحدّ/);
  assert.equal(api.MAX_UPLOAD_BYTES, 3 * 1024 * 1024);
  /* وحدّ النقل أضيق من حدّ التخزين لا مساوٍ له. */
  assert.ok(api.MAX_UPLOAD_BYTES < require("../lib/droua/storage").MAX_BYTES);
});

test("المداخل: اسم الملفّ في ترويسة التنزيل لا يحقن ترويسات", () => {
  const header = api.contentDisposition("مسير\r\nX-Evil: 1.csv");
  assert.ok(!/[\r\n]/.test(header));
  assert.match(header, /^attachment; filename="/);
  assert.match(header, /filename\*=UTF-8''/);
  assert.ok(!header.includes('"مسير'), "اسمٌ عربيّ لا يوضع خامًا في filename المقتبَس");
});

test("المداخل: المسار المجهول والفعل الخاطئ سواء — لا شيء", async () => {
  await withDroua(async ({ sql, ctx }) => {
    assert.equal(api.match("GET", "runs") !== null, true);
    for (const [method, path] of [
      ["GET", "nope"], ["PUT", "runs"], ["GET", "runs/not-a-uuid"],
      ["DELETE", "findings/" + crypto.randomUUID()], ["GET", "files/x/download"],
    ]) {
      assert.equal(api.match(method, path), null, `${method} ${path}`);
    }
    const out = await callApi(sql, ctx, "GET", "nope");
    assert.equal(out.statusCode, 404);
  });
});

test("المداخل: خارج سياق البوابة لا تعمل ولو نُودِيت مباشرة", async () => {
  await withDroua(async ({ db, blob, sql, ctx }) => {
    const { res } = makeRes();
    await assert.rejects(() => api.handle({ method: "GET", headers: {} }, res, {
      sql, ctx, apiPath: "runs", query: {},
    }), /لا سياق بوابة/);
    assert.equal(db.calls.length, 0);
    assert.equal(blob.calls.length, 0);
  }, { openGate: false });
});

test("المداخل: «كل الملاحظات» مقطعُ مسار لا معاملَ استعلام", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    month.cash = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6500 }]);
    const run = await seedMonth(sql, ctx, "2026-09", month);
    await analyze.analyzeRun(sql, run.runId, ctx);

    const target = (await findings.listFindings(sql, run.runId)).find((f) => f.rule === "net_mismatch");
    const fixed = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6000 }]);
    await upload(sql, ctx, run.runId, "cash", fixed, true);
    await analyze.analyzeRun(sql, run.runId, ctx);

    const open = await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`);
    assert.equal(open.body.findings.some((f) => f.findingId === target.findingId), false);

    /* إعادة الكتابة على المنصّة تُمرِّر المسار ولا ضمان لبقاء معاملات
       الاستعلام — فما يعتمد عليها يعمل محلّيًّا ويصمت في الإنتاج. */
    const all = await callApi(sql, ctx, "GET", `runs/${run.runId}/findings/all`);
    const resolved = all.body.findings.find((f) => f.findingId === target.findingId);
    assert.ok(resolved, "المُعالَجة تظهر في المسار الكامل");
    assert.ok(resolved.resolvedAt);
    assert.ok(all.body.findings.length > open.body.findings.length);
  });
});

test("المداخل: تعديل الملاحظة عبر الـAPI محصورٌ في الحالة والتعليق", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    month.cash = fx.cashCsv([{ empNo: "1003", name: "خالد الوهمي", net: 6500 }]);
    const run = await seedMonth(sql, ctx, "2026-09", month);
    await analyze.analyzeRun(sql, run.runId, ctx);

    const listed = await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`);
    assert.equal(listed.statusCode, 200);
    assert.ok(listed.body.findings.length > 0);
    assert.ok(listed.body.summary.open > 0);

    const target = listed.body.findings[0];
    const patched = await callApi(sql, ctx, "PATCH", `findings/${target.findingId}`,
      { status: "verified", userNote: "تأكّدتُ منها." });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.body.finding.status, "verified");
    assert.equal(patched.body.finding.statusLabel, "تم التحقق");

    /* حقلٌ خارج الاثنين يُتجاهل لا يُطبَّق. */
    const sneaky = await callApi(sql, ctx, "PATCH", `findings/${target.findingId}`,
      { status: "verified", title: "عنوان مزوَّر" });
    assert.equal(sneaky.statusCode, 200);
    assert.equal(sneaky.body.finding.title, target.title, "العنوان من التحليل وحده");

    const missing = await callApi(sql, ctx, "PATCH", `findings/${crypto.randomUUID()}`, { status: "verified" });
    assert.equal(missing.statusCode, 404);
  });
});

test("المداخل: تنزيل ملفٍّ عُبث بوصفه يُردّ 404 ويُسجَّل داخليًّا", async () => {
  await withDroua(async ({ db, sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    const { file } = await upload(sql, ctx, run.runId, "full", fx.consistentMonth().full);
    db.rows[0].enc_tag = "ff".repeat(16);

    const out = await callApi(sql, ctx, "GET", `files/${file.fileId}/download`);
    assert.equal(out.statusCode, 404);
    assert.equal(out.headers["content-type"], undefined, "ردٌّ لا يميّز نفسه عن مسارٍ غير موجود");
    assert.ok(db.events().includes("file_integrity_failure"));
    const entry = db.audit.find((a) => a.event === "file_integrity_failure");
    assert.equal(entry.meta.reason, "tag_mismatch");
    assert.ok(!("fileName" in entry.meta));
  });
});

/* ══ الشاشة ═══════════════════════════════════════════════════════════ */

test("الشاشة: حدودها وصيغها مطابقة للخادم — لا رقمان يفترقان", () => {
  /* حدٌّ في الواجهة أوسع من حدّ الخادم يجعل المستخدم ينتظر رفعًا سيُرفض؛
     وأضيقُ منه يمنعه من ملفٍّ مقبول. والصيغ كذلك. */
  const view = require("../lib/droua/views/open");
  const storage = require("../lib/droua/storage");
  assert.equal(view.MAX_UPLOAD_BYTES, api.MAX_UPLOAD_BYTES);
  assert.deepEqual(view.FORMATS.slice().sort(), Object.keys(storage.SAFE_CONTENT_TYPES).sort());
});

test("الشاشة: تعرض الحالات الثلاث — جارية وناجحة وفاشلة", () => {
  const html = require("../lib/droua/views/open")("n");
  const script = /<script nonce="n">([\s\S]*?)<\/script>/.exec(html)[1];
  /* عدّاد لا علمٌ ثنائيّ: نداءان متزامنان ينتهي أوّلهما فيرفع «جارٍ» عن
     الثاني، فيظنّ المستخدم أن كل شيء انتهى. */
  assert.match(script, /busy\s*=\s*Math\.max\(0,\s*busy\s*-\s*1\)/);
  assert.match(script, /aria-busy/);
  assert.match(script, /note err|'note '\+\(x\?'err'/, "الفشل يُعرض بإطارٍ يميّزه");
  assert.match(html, /class="empty"/, "حالة الفراغ معلنة");
  assert.match(html, /class="scroll"/, "الجداول تنزلق أفقيًّا على الشاشات الضيّقة");
  assert.match(html, /aria-live="polite"/);
  /* والتحقّق قبل الرفع: صيغة، وحجم، وفراغ. */
  assert.match(script, /صيغة غير مقبولة/);
  assert.match(script, /file\.size>MAX/);
  assert.match(script, /الملفّ فارغ/);
});

test("الشاشة: الشيفرة المضمَّنة تُحلَّل بلا خطأ نحويّ", () => {
  /* الصفحة تُبنى نصًّا، فخطأ نحويّ فيها لا يظهر في أي اختبار منطق — يظهر
     شاشةً بيضاء عند المستخدم. وهذا أرخص فحص يمنع ذلك. */
  const html = require("../lib/droua/views/open")("test-nonce");
  const scripts = [...html.matchAll(/<script nonce="test-nonce">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));

  const styles = [...html.matchAll(/<style nonce="test-nonce">/g)];
  assert.equal(styles.length, 1, "النمط مضمَّن بـnonce — لا ملفّ أصلٍ باسم يخصّ القسم");
  /* ولا اسم للقسم في أي نصّ ظاهر. */
  assert.ok(!/ذروة|رواتب|payroll|salary/i.test(html.replace(/<script[\s\S]*?<\/script>/g, "")),
    "لا اسم يكشف القسم في نصّ الصفحة");
  assert.match(html, /dir="rtl"/);
});

test("المداخل: فشلُ تنزيلٍ ليس فسادًا يُسجَّل — ولا يختفي وراء 404", async () => {
  await withDroua(async ({ db, sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    const { file } = await upload(sql, ctx, run.runId, "full", fx.consistentMonth().full);

    /* مفتاحٌ غائب: ليس فشل سلامة، فلا يُسجَّل في files.readFile — ولولا
       التسجيل هنا لاشتكى المستخدم أن الملفّ «غير موجود» بلا أثر يقول لماذا. */
    const keyring = require("../lib/droua/keyring");
    const saved = process.env[keyring.ENV_PREFIX + "K1"];
    delete process.env[keyring.ENV_PREFIX + "K1"];
    try {
      const out = await callApi(sql, ctx, "GET", `files/${file.fileId}/download`);
      assert.equal(out.statusCode, 404, "والرد يبقى غير مميّز");
      assert.ok(db.events().includes("file_download_failed"));
      const entry = db.audit.find((a) => a.event === "file_download_failed");
      assert.equal(entry.meta.fileId, file.fileId);
      assert.ok(!("fileName" in entry.meta));
    } finally {
      process.env[keyring.ENV_PREFIX + "K1"] = saved;
    }
  });
});

test("المداخل: التنزيل الناجح يحمل رؤوس منعِ التنفيذ", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    const { file } = await upload(sql, ctx, run.runId, "full", fx.consistentMonth().full);
    const out = await callApi(sql, ctx, "GET", `files/${file.fileId}/download`);
    assert.equal(out.statusCode, 200);
    assert.equal(out.headers["x-content-type-options"], "nosniff");
    assert.equal(out.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.match(out.headers["cache-control"], /no-store/);
    assert.equal(out.headers["content-length"], String(out.body.length));
  });
});

test("الملاحظات: الحرج أوّلًا — لا ترتيبًا أبجديًّا يدفنه", async () => {
  /* «ORDER BY severity DESC» ترتيبٌ أبجديّ: warn ثمّ info ثمّ critical —
     فيهبط الحرج إلى آخر القائمة. عطلٌ لا يُسقط شيئًا ولا يرمي استثناء،
     ويدفع ثمنَه المستخدم وحده حين يقرأ العشرين الأولى ولا يرى فيها ما يجب
     أن يراه أوّلًا. */
  await withDroua(async ({ sql, ctx }) => {
    const runId = (await runs.createRun(sql, "2026-09")).runId;
    await findings.sync(sql, runId, [
      { rule: "a", scope: "within_month", severity: "info", title: "معلومة", employeeRef: "1" },
      { rule: "b", scope: "within_month", severity: "warn", title: "تنبيه", employeeRef: "2" },
      { rule: "c", scope: "within_month", severity: "critical", title: "حرج", employeeRef: "3" },
      { rule: "d", scope: "within_month", severity: "critical", title: "حرج ثانٍ", employeeRef: "4" },
    ]);
    const list = await findings.listFindings(sql, runId);
    assert.deepEqual(list.map((f) => f.severity), ["critical", "critical", "warn", "info"]);
    assert.deepEqual(list.map((f) => f.employeeRef), ["3", "4", "2", "1"], "وترتيبٌ ثابت داخل الرتبة");

    const api = await callApi(sql, ctx, "GET", `runs/${runId}/findings`);
    assert.equal(api.body.findings[0].severity, "critical", "والـAPI يعطي الترتيب نفسه");
  });
});

/* ══ دورةُ «لم يُقيَّم» كاملةً ══════════════════════════════════════════
   =========================================================================
   الآليّة اختُبرت نقيّةً في droua-analysis. وهنا تُختبر **حيّةً**: من
   الملفّ المشفَّر إلى الصفّ في القاعدة إلى ردّ الـAPI. فبين الاثنين طبقاتٌ
   تُسقط الحقول بصمت — عمودٌ لا يُكتب، أو بصمةٌ تتغيّر فتتكرّر الملاحظة،
   أو حالةٌ يكتبها المستخدم ثمّ يمحوها التحليل التالي. */

async function seedPartial(sql, ctx, period, month, skip = []) {
  const run = await runs.createRun(sql, period);
  for (const kind of files.KINDS) {
    if (skip.includes(kind) || typeof month[kind] !== "string") continue;
    await upload(sql, ctx, run.runId, kind, month[kind]);
  }
  return run;
}

test("لم يُقيَّم: شهرٌ بلا كاش يُنتج ملاحظةً تصل القاعدة والـAPI", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedPartial(sql, ctx, "2026-03", fx.consistentMonth(), ["cash"]);
    const result = await analyze.analyzeRun(sql, run.runId, ctx);

    assert.ok(result.rulesNotEvaluable.length > 0, "التحليل يُعلن ما تعذّر");
    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`);
    const list = out.body.findings.filter((f) => f.rule === "not_evaluable"
      && f.field === "current:cash");
    assert.equal(list.length, 1, "ملاحظةٌ واحدة لمصدرٍ واحد ناقص");

    /* الحقول التي تعيش عليها الشاشة — أيّها يسقط يُعطّل شريط التغطية. */
    assert.equal(list[0].scope, "within_month");
    assert.equal(list[0].field, "current:cash");
    assert.ok(Number(list[0].delta) > 0, "العدد وصل رقمًا لا نصًّا");
    assert.match(list[0].currentValue, /missing_in_split/, "ومعرّفات القواعد وصلت");
    /* ولا يُقرأ صفرًا: «مستحقٌّ بلا صرف» لم يُخترع لمن صُرف له كاشًا. */
    assert.equal(out.body.findings.filter((f) => f.rule === "missing_in_split").length, 0);
  });
});

test("لم يُقيَّم: رفعُ الملفّ الناقص يُعالج الملاحظة تلقائيًّا", async () => {
  /* وهذا ما يجعلها ملاحظةً لا لافتة: تُحلّ بالفعل الذي يرفع سببها. */
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    const run = await seedPartial(sql, ctx, "2026-03", month, ["cash"]);
    await analyze.analyzeRun(sql, run.runId, ctx);

    await upload(sql, ctx, run.runId, "cash", month.cash);
    await analyze.analyzeRun(sql, run.runId, ctx);

    const open = await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`);
    assert.equal(open.body.findings.filter((f) => f.rule === "not_evaluable"
      && f.field === "current:cash").length, 0, "زال سببها فزالت من المفتوحة");
    const all = await callApi(sql, ctx, "GET", `runs/${run.runId}/findings/all`);
    const was = all.body.findings.find((f) => f.rule === "not_evaluable"
      && f.field === "current:cash");
    assert.ok(was && was.resolvedAt, "ولا تُحذف: اختفاؤها حدثٌ يبقى في السجلّ");
  });
});

test("لم يُقيَّم: إعادةُ التحليل لا تُكرّرها ولا تمحو قرار المستخدم", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedPartial(sql, ctx, "2026-03", fx.consistentMonth(), ["cash"]);
    await analyze.analyzeRun(sql, run.runId, ctx);

    const first = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`))
      .body.findings.find((f) => f.rule === "not_evaluable" && f.field === "current:cash");
    const saved = await callApi(sql, ctx, "PATCH", `findings/${first.findingId}`,
      { status: "verified", userNote: "راجعتُها يدويًّا — لا مسير كاش لهذا الشهر" });
    assert.equal(saved.statusCode, 200);

    /* وحقلٌ باسمٍ مقارب يُردّ بصوتٍ عالٍ لا يُبتلع: المدخل يُصفّي ما لا
       يعرفه، وطبقةُ البيانات ترفض التعديل الفارغ الناتج. فمن أخطأ اسم
       الحقل يرى خطأً — لا «حُفظت» وقد ضاع ما كتب. */
    const typo = await callApi(sql, ctx, "PATCH", `findings/${first.findingId}`,
      { note: "نصٌّ يضيع لو قُبل صامتًا" });
    assert.equal(typo.statusCode, 400, "تعديلٌ لا يكتب شيئًا لا يُردّ نجاحًا");

    await analyze.analyzeRun(sql, run.runId, ctx);
    await analyze.analyzeRun(sql, run.runId, ctx);

    const after = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings/all`))
      .body.findings.filter((f) => f.rule === "not_evaluable" && f.field === "current:cash");
    assert.equal(after.length, 1, "ثلاثةُ تحليلات وملاحظةٌ واحدة — البصمة على المصدر");
    assert.equal(after[0].findingId, first.findingId, "الصفّ نفسه حُدِّث");
    assert.equal(after[0].status, "verified", "وقرارُ المستخدم نجا");
    assert.match(after[0].userNote, /راجعتُها/);
  });
});

test("لم يُقيَّم: عمودٌ غائب في ملفٍّ موجود يُعلَن تحذيرًا لا معلومة", async () => {
  /* لا `file_missing` يغطّيه: الملفّ مرفوعٌ ومقروء. فلو صار «معلومة»
     لاختفى بين ملاحظاتٍ لا تستدعي فعلًا. */
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    month.transfer = fx.csv(["رقم الموظف", "الاسم", "الصافي"],
      [["1001", "أ", 9000], ["1002", "ب", 7500], ["1004", "د", 8200]]);
    const run = await seedMonth(sql, ctx, "2026-03", month);
    await analyze.analyzeRun(sql, run.runId, ctx);

    const list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`))
      .body.findings.filter((f) => f.rule === "not_evaluable");
    const gap = list.find((f) => f.field === "current:transfer.iban4");
    assert.ok(gap, "نقصُ العمود يُعلَن باسم الملفّ والحقل");
    assert.equal(gap.severity, "warn");
    assert.equal(list.filter((f) => f.field === "current:cash").length, 0,
      "ولا يُخلط بنقص ملفّ: الكاش مرفوع");
  });
});

test("لم يُقيَّم: أوّل شهرٍ لا سابق له لا يُنتج ملاحظةَ نقص", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-03", fx.consistentMonth());
    const result = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.equal(result.previousPeriod, null);
    assert.ok(result.rulesSkipped.length > 0, "قواعد المقارنة تُتخطّى");
    assert.deepEqual(result.rulesNotEvaluable.filter((e) => e.scope === "vs_previous"), [],
      "والتخطّي المتوقَّع لا يُبلَّغ نقصًا");
    const list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
    assert.equal(list.filter((f) => f.rule === "not_evaluable" && f.scope === "vs_previous").length, 0);
  });
});

test("لم يُقيَّم: شهرٌ سابقٌ ناقصُ الكاش لا يُفسد المقارنة", async () => {
  /* الحالة الواقعية: لا مسير كاش مستقلّ للشهر السابق. والمسير الكامل
     يحمل مبالغ الجميع — فلا قاعدةَ مقارنةٍ تتعطّل، ولا ملاحظةَ تُخترع. */
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    await seedPartial(sql, ctx, "2026-02", month, ["cash"]);
    const current = await seedMonth(sql, ctx, "2026-03", month);
    const result = await analyze.analyzeRun(sql, current.runId, ctx);

    assert.equal(result.previousPeriod, "2026-02");
    const list = (await callApi(sql, ctx, "GET", `runs/${current.runId}/findings`)).body.findings;
    /* الشهران متطابقان: أي ملاحظة مقارنةٍ هنا اختُرعت. */
    assert.deepEqual(list.filter((f) => f.scope === "vs_previous").map((f) => f.rule), []);
    assert.equal(list.filter((f) => f.rule === "not_evaluable"
      && f.field !== "current:overtime").length, 0);
  });
});

/* ══ زمن المزامنة ═══════════════════════════════════════════════════════
   الكتابة واحدةً بعد واحدة تدفع زمن الذهاب والإياب مرّة لكل ملاحظة. وشهرٌ
   كبير يُنتج ألوفًا منها — فتُقتل الدالّة قبل أن تُنهي، ويبقى التحليل
   نصفَ مكتوب. وهو عطلٌ لا يظهر على 68 موظّفًا ويظهر على 500. */

test("المزامنة: الكتابات متوازيةٌ بحدّ — لا متسلسلة ولا بلا سقف", async () => {
  const gateContext = require("../lib/droua/gateContext");
  let live = 0;
  let peak = 0;
  let writes = 0;
  const sql = async (strings) => {
    const text = strings.join("?");
    if (/^\s*SELECT id, fingerprint/.test(text)) return [];
    writes += 1;
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setImmediate(r));
    live -= 1;
    return [];
  };
  const produced = Array.from({ length: 60 }, (_, i) => ({
    rule: "net_changed", scope: "vs_previous", severity: "warn",
    employeeRef: String(1000 + i), field: "net", title: "t", description: "d",
  }));
  const runId = "11111111-2222-4333-8444-555555555555";
  const out = await gateContext.runWithGate({ userId: "u", sidHash: "s" },
    () => findings.sync(sql, runId, produced));

  assert.equal(out.created, 60, "كلّها كُتبت");
  assert.equal(writes, 61, "كتابةٌ لكل ملاحظة ثمّ عبارةُ المعالَجة");
  assert.ok(peak > 1, "متسلسلةٌ تمامًا — زمنُ السلك يُضرب في عدد الملاحظات");
  assert.ok(peak <= 8, `بلا سقف (${peak}) — ألف اتّصال دفعةً تخنق التجمّع`);
});

/* ══ الصيغة التي تُرفع فعلًا ═══════════════════════════════════════════
   =========================================================================
   القرّاء مُختبَرون بمصنّفات مبنيّة في الاختبار، والدورة مُختبَرة بـCSV.
   وبينهما الطريق الذي تسلكه الملفّات في الواقع ولم يُقطع كاملًا مرّة:
   مصنّفٌ ثنائيّ يُرمَّز، ويُشفَّر، ويُخزَّن، ويُفكّ، ويُقرأ، ثمّ يُقارَن.

   وأي بايتٍ يُبدَّل في هذا الطريق يُنتج إمّا فشلَ وسمٍ صريحًا وإمّا —
   وهو الأخطر — أرقامًا سليمةَ الشكل في أعمدةٍ خاطئة. */

const { buildXlsx, buildXls } = require("./helpers/workbook-builder");

const SHEET = {
  full: [["رقم الموظف", "الاسم", "الراتب الاساسي", "بدل سكن", "خصم تاخير", "صافي الراتب"],
    ["1001", "أ", 9000, 500, 200, 9300],
    ["1002", "ب", 7500, 300, 0, 7800]],
  transfer: [["رقم الموظف", "الاسم", "الصافي"], ["1001", "أ", 9300]],
  cash: [["رقم الموظف", "الاسم", "الصافي"], ["1002", "ب", 7800]],
  employees: [["الرقم الوظيفي", "الاسم", "الحالة", "طريقة التحويل"],
    ["1001", "أ", "نشط", "بنك"], ["1002", "ب", "نشط", "نقد"]],
};

async function uploadWorkbook(sql, ctx, runId, kind, bytes, format) {
  const out = await callApi(sql, ctx, "POST", `runs/${runId}/files`,
    { kind, fileName: `${kind}.${format}`, format, data: b64(bytes) });
  assert.equal(out.statusCode, 200, `رفع ${kind}.${format}: ${JSON.stringify(out.body)}`);
  return out;
}

for (const [label, build, format] of [["xlsx", buildXlsx, "xlsx"], ["xls", buildXls, "xls"]]) {
  test(`الصيغة الحقيقية: دورةُ ${label} كاملة — رفعٌ وتشفيرٌ وقراءةٌ وتحليل`, async () => {
    await withDroua(async ({ sql, ctx }) => {
      const run = await runs.createRun(sql, "2026-05");
      for (const kind of files.REQUIRED_KINDS) {
        await uploadWorkbook(sql, ctx, run.runId, kind, build(SHEET[kind]), format);
      }

      const result = await analyze.analyzeRun(sql, run.runId, ctx);
      assert.deepEqual(result.missing, ["overtime"], "الأربعة اللازمة وصلت، والاختياريّ لم يُرفع");
      assert.equal(result.unreadable.length, 0, "وقُرئت كلّها");

      const list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
      /* الشهر متّسق تمامًا: كامل = تحويل + كاش، والقائمة تطابق، والقنوات
         مطابقة. فأي ملاحظةٍ هنا تعني أن الطريق شوّه البيانات. */
      /* «ملفّ اختياريّ ناقص» متوقَّعة: العيّنة أربعةُ ملفّات. وما عداها صفر. */
      const noise = list.filter((f) => f.rule !== "not_evaluable"
        && !(f.rule === "file_missing" && f.field === "overtime"));
      assert.deepEqual(noise.map((f) => `${f.rule}:${f.employeeRef || ""}`), [],
        `${label}: ملاحظاتٌ اختُرعت في الطريق`);

      /* والقراءة صحيحةٌ لا فارغة: الأرقام وصلت بقيمها. */
      const docs = (await analyze.loadDocs(sql, run.runId, ctx)).docs;
      assert.equal(docs.full.rows.length, 2);
      assert.equal(docs.full.rows[0].net, 9300, `${label}: الصافي تشوّه`);
      assert.equal(docs.full.rows[0].allowances, 500, `${label}: البدل تشوّه`);
      assert.equal(docs.full.rows[0].deductions, 200, `${label}: الخصم تشوّه`);
      assert.equal(docs.employees.rows[1].method, "نقد", `${label}: النصّ العربيّ تشوّه`);
    });
  });
}

test("الصيغة الحقيقية: مصنّفٌ تالفٌ يُرفع ويُبلَّغ ولا يُسقط الشهر", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-05");
    for (const kind of ["full", "transfer", "cash"]) {
      await uploadWorkbook(sql, ctx, run.runId, kind, buildXlsx(SHEET[kind]), "xlsx");
    }
    /* بايتاتٌ ليست مصنّفًا أصلًا — كما لو رُفع ملفٌّ خطأ أو انقطع النقل. */
    await uploadWorkbook(sql, ctx, run.runId, "employees", Buffer.from("ليست مصنّفًا"), "xlsx");

    const result = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.equal(result.unreadable.length, 1, "يُبلَّغ عنه");
    assert.equal(result.unreadable[0].kind, "employees");

    const list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
    assert.ok(list.some((f) => f.rule === "file_unreadable"), "ملاحظةٌ مرئيّة لا استثناء صامت");
    /* وما لا يعتمد على القائمة يُفحص رغم ذلك: ملفٌّ واحد لا يُعطّل الشهر. */
    assert.equal(list.filter((f) => f.rule === "net_mismatch").length, 0);
    /* وما يعتمد عليها يُعلَن أنه لم يُقيَّم لا أنه سليم. */
    assert.ok(list.some((f) => f.rule === "not_evaluable" && /employees/.test(f.field)));
  });
});

test("الصيغة الحقيقية: فسادُ أي ملفّ لا يُسقط الشهر ولا يُسرّب نصّ الخطأ", async () => {
  /* أخطرُها فسادُ «الكامل» نفسه: هو محورُ كل قاعدة تقريبًا. */
  for (const broken of files.REQUIRED_KINDS) {
    await withDroua(async ({ sql, ctx }) => {
      const run = await runs.createRun(sql, "2026-05");
      for (const kind of files.REQUIRED_KINDS) {
        const bytes = kind === broken ? Buffer.from("بايتاتٌ ليست مصنّفًا") : buildXlsx(SHEET[kind]);
        await uploadWorkbook(sql, ctx, run.runId, kind, bytes, "xlsx");
      }
      const result = await analyze.analyzeRun(sql, run.runId, ctx);
      assert.deepEqual(result.unreadable.map((u) => u.kind), [broken], broken);
      assert.equal(result.unreadable[0].reason, "parse_failed", "رمزٌ ثابت لا رسالةُ مكتبة");

      const list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
      const note = list.find((f) => f.rule === "file_unreadable");
      assert.ok(note, `${broken}: لا ملاحظة`);
      /* ولا نصّ الخطأ الأصليّ في شيءٍ يُعرض: قد يحمل فُتاتًا من المحتوى. */
      const shown = JSON.stringify(note);
      assert.ok(!/ZIP|OLE2|BIFF|Unexpected|Error:/i.test(shown), `${broken}: تسرّب نصّ عطلٍ داخليّ`);
    });
  }
});

test("الصيغة الحقيقية: «حلّل الشهر» على ملفٍّ تالف يردّ نتيجةً لا «غير موجود»", async () => {
  /* الموجّه يُحوّل كل استثناءٍ متسرّب إلى 404 حفاظًا على الإخفاء، ولا
     يُسجّل رسالته. فعطلٌ يصعد من التحليل يصل المستخدم «غير موجود» —
     يظنّ القسم اختفى — ويترك في السجلّ سطرًا بلا سببٍ ولا اسم ملفّ.
     ولذلك يُختبر من المدخل: ما يراه المستخدم، لا ما تُرجعه الدالّة. */
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-05");
    for (const kind of files.REQUIRED_KINDS) {
      const bytes = kind === "full" ? Buffer.from("ملفٌّ خطأ") : buildXlsx(SHEET[kind]);
      await uploadWorkbook(sql, ctx, run.runId, kind, bytes, "xlsx");
    }
    const out = await callApi(sql, ctx, "POST", `runs/${run.runId}/analyze`);
    assert.equal(out.statusCode, 200, "التحليل يُنهي عمله ويردّ");
    assert.ok(out.body.ok);
    assert.equal(out.body.analysis.unreadable[0].kind, "full");
  });
});

/* ══ نصوصُ الشاشة ══════════════════════════════════════════════════════
   الشيفرة المضمَّنة لا يبلغها اختبارٌ عاديّ، فتُستخرَج دالّتها وتُشغَّل. */

const pageSource = () => require("../lib/droua/views/open")("nonce");

test("الشاشة: تمييزُ العدد بالعربية سليمٌ عند الحدود", () => {
  /* «20 قواعد» خطأٌ يقرؤه المستخدم فيشكّ فيما يقرأ كلَّه — وفي شاشةٍ
     تقول له ما لم يُفحص، الشكُّ في النصّ شكٌّ في النتيجة. */
  const body = pageSource().match(/function countRules\(n\)\{[\s\S]*?\n\}/);
  assert.ok(body, "countRules غير موجودة في الصفحة");
  const countRules = new Function(`${body[0]}; return countRules;`)();
  assert.match(countRules(1), /^قاعدة واحدة/);
  assert.match(countRules(2), /^قاعدتان/);
  for (const n of [3, 7, 10]) assert.match(countRules(n), new RegExp(`^${n} قواعد`), `${n}: جمعُ قلّة`);
  for (const n of [11, 15, 20]) assert.match(countRules(n), new RegExp(`^${n} قاعدة`), `${n}: مفردٌ منصوب`);
});

test("الشاشة: الفراغ بعد فحصٍ تامّ نتيجةٌ لا دعوةٌ للرفع", () => {
  /* «ارفع الملفّات ثمّ شغّل التحليل» تُقال لمن رفع وحلّل بالفعل فتُشكّكه
     في نتيجته — وأن يُفحص شهرٌ كاملًا فلا يُوجد فيه شيء خبرٌ يُقال. */
  const src = pageSource();
  assert.match(src, /اكتمل الفحص ولم يُعثر على ملاحظة واحدة/, "لا رسالةَ «فُحص ونظيف»");
  assert.match(src, /لم يُشغَّل التحليل بعد/, "ولا رسالةَ «لم يُحلَّل بعد»");
  /* والقديمةُ المضلّلة لم تعد تُعرض بلا شرط. */
  assert.ok(!/'لا ملاحظات مفتوحة\. ارفع الملفّات/.test(src),
    "الرسالة التي تُقال لمن رفع بالفعل ما زالت بلا شرط");
  /* وحين يبقى نقصُ تغطية لا يُقال «نظيف»: يُحال إلى الشريط. */
  assert.match(src, /راجع شريط التغطية أعلاه/);
});

test("الشاشة: حالُ الشهر يُعرض بالعربية لا بمفاتيح التخزين", () => {
  const src = pageSource();
  for (const [key, label] of [["draft", "مسوّدة"], ["analyzed", "حُلِّل"], ["closed", "مُغلَق"]]) {
    assert.match(src, new RegExp(`${key}:'${label}'`), `${key} بلا اسمٍ عربيّ`);
  }
  /* ولا يُعرض المفتاح خامًا في أي خليّة. */
  assert.ok(!/esc\(r\.status\)/.test(src) && !/\+j\.run\.status\+/.test(src),
    "ما زال حالُ الشهر يُعرض خامًا");
});

/* ══ إعدادات الشهر: القاسم والإجازات ═══════════════════════════════════
   =========================================================================
   بيانان يُدخلهما المستخدم بيده — وهما المدخل الوحيد الذي يُغيّر حكمًا
   ماليًّا في هذا النظام. فيُختبران من المدخل لا من الدالّة.

   ⛔ أرقامٌ وظيفية مصنوعة، بلا اسمٍ ولا مبلغٍ حقيقيّ. */

const settingsLib = require("../lib/droua/settings");

test("الإعدادات: القاسم يُحفظ ويُقرأ ويُحذف — و8 أو 10 لا ثالث لهما", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());

    const saved = await callApi(sql, ctx, "PUT", "settings/divisors",
      { empNo: "1001", overtimeDivisor: 10 });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.divisor.overtimeDivisor, 10);

    /* ما عدا الاثنين يُردّ — لا يُقرَّب ولا يُصحَّح. */
    for (const bad of [9, 0, -8, "ثمانية", null]) {
      const out = await callApi(sql, ctx, "PUT", "settings/divisors",
        { empNo: "1002", overtimeDivisor: bad });
      assert.equal(out.statusCode, 400, `القاسم ${JSON.stringify(bad)} قُبل`);
    }

    /* والكتابة الثانية تُحدِّث ولا تُضاعف. */
    await callApi(sql, ctx, "PUT", "settings/divisors", { empNo: "1001", overtimeDivisor: 8 });
    let view = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.deepEqual(view.body.divisors.map((d) => `${d.empNo}:${d.overtimeDivisor}`), ["1001:8"]);
    assert.deepEqual(view.body.allowedDivisors, [8, 10]);

    const gone = await callApi(sql, ctx, "DELETE", "settings/divisors/1001");
    assert.equal(gone.statusCode, 200);
    view = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.deepEqual(view.body.divisors, []);
  });
});

test("الإعدادات: القاسم يعيش خارج الشهر — يبقى للشهر التالي", async () => {
  /* سياسةٌ تثبت للموظّف حتى تُغيَّر، فلا تُعاد كتابتها كل شهر. */
  await withDroua(async ({ sql, ctx }) => {
    const first = await seedMonth(sql, ctx, "2026-08", fx.consistentMonth());
    await callApi(sql, ctx, "PUT", "settings/divisors", { empNo: "1001", overtimeDivisor: 10 });
    const next = await runs.createRun(sql, "2026-09");
    const view = await callApi(sql, ctx, "GET", `runs/${next.runId}/settings`);
    assert.deepEqual(view.body.divisors.map((d) => d.empNo), ["1001"], "لم ينتقل إلى الشهر الجديد");
    assert.ok(first.runId !== next.runId);
  });
});

test("الإعدادات: الإجازة تعيش داخل الشهر — ولا تتسرّب إلى غيره", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const aug = await seedMonth(sql, ctx, "2026-08", fx.consistentMonth());
    const sep = await runs.createRun(sql, "2026-09");
    const added = await callApi(sql, ctx, "POST", `runs/${aug.runId}/leaves`,
      { empNo: "1004", startDate: "2026-08-01", endDate: "2026-08-31" });
    assert.equal(added.statusCode, 200);

    const inAug = await callApi(sql, ctx, "GET", `runs/${aug.runId}/settings`);
    assert.deepEqual(inAug.body.leaves.map((l) => l.empNo), ["1004"]);
    const inSep = await callApi(sql, ctx, "GET", `runs/${sep.runId}/settings`);
    assert.deepEqual(inSep.body.leaves, [], "إجازةُ شهرٍ لا تُسكت غيابًا في شهرٍ آخر");
  });
});

test("الإعدادات: فترةٌ مقلوبة تُردّ — لا تُسكت غيابًا لا تفسّره", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());
    for (const [from, to] of [["2026-09-20", "2026-09-05"], ["2026-09-01", "ليس تاريخًا"], ["", "2026-09-05"]]) {
      const out = await callApi(sql, ctx, "POST", `runs/${run.runId}/leaves`,
        { empNo: "1004", startDate: from, endDate: to });
      assert.equal(out.statusCode, 400, `${from} → ${to} قُبلت`);
    }
    const view = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.deepEqual(view.body.leaves, [], "ولا صفَّ كُتب");
  });
});

test("الإعدادات: الإجازة تُغيّر نتيجة التحليل فعلًا — من المدخل إلى الملاحظة", async () => {
  /* الاختبار الذي يهمّ: أن يصل أثرُ ما أدخله المستخدم إلى الملاحظات. */
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth({ salaries: { 1001: 9000, 1002: 7500, 1003: 6000 }, keepAll: true });
    const run = await seedMonth(sql, ctx, "2026-09", month);

    await analyze.analyzeRun(sql, run.runId, ctx);
    let list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
    assert.ok(list.some((f) => f.rule === "not_in_payroll" && f.employeeRef === "1004"),
      "بلا إجازةٍ يُبلَّغ عنه");

    await callApi(sql, ctx, "POST", `runs/${run.runId}/leaves`,
      { empNo: "1004", startDate: "2026-09-01", endDate: "2026-09-30" });
    await analyze.analyzeRun(sql, run.runId, ctx);

    list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
    assert.equal(list.filter((f) => f.rule === "not_in_payroll" && f.employeeRef === "1004").length, 0,
      "الإجازة الكاملة فسّرت الغياب");
    /* ولا تُحذف الملاحظة: تُعلَّم معالَجة، فيبقى أثرُ القرار. */
    const all = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings/all`)).body.findings;
    assert.ok(all.some((f) => f.rule === "not_in_payroll" && f.employeeRef === "1004" && f.resolvedAt));
  });
});

test("الإعدادات: الافتراضيّ يُحسب تلقائيًّا، والمحفوظ يتقدّم عليه", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth({ overtime: [{ empNo: "1001", m15: 120 }] });
    /* مسيرٌ بعمود عملٍ إضافيّ ومعه الأساسيّ والإجمالي. */
    month.full = fx.csv(["رقم الموظف", "الاسم", "الراتب الاساسي", "اجمالي الراتب", "وقت اضافي", "صافي الراتب"],
      [["1001", "أ", 9000, 12000, 999, 12999]]);
    month.transfer = fx.csv(["رقم الموظف", "الاسم", "الصافي"], [["1001", "أ", 12999]]);
    month.cash = fx.cashCsv([]);
    const run = await seedMonth(sql, ctx, "2026-09", month);

    await analyze.analyzeRun(sql, run.runId, ctx);
    let list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
    /* بلا صفٍّ محفوظ: يُحسب بالافتراضيّ ويُعلَن أنه افتراضيّ. */
    assert.ok(list.some((f) => f.rule === "ot_no_divisor"), "تُعلَن شفافيّةُ الافتراضيّ");
    const byDefault = list.find((f) => f.rule === "ot_amount_mismatch");
    assert.ok(byDefault, "والمبلغ يُقارَن — لا ينتظر أحدًا");
    assert.match(byDefault.description, /قاسم 10/);

    /* والـoverride اليدويّ يتقدّم عليه. */
    await callApi(sql, ctx, "PUT", "settings/divisors", { empNo: "1001", overtimeDivisor: 8 });
    await analyze.analyzeRun(sql, run.runId, ctx);
    list = (await callApi(sql, ctx, "GET", `runs/${run.runId}/findings`)).body.findings;
    assert.equal(list.filter((f) => f.rule === "ot_no_divisor").length, 0, "زالت ملاحظة الافتراضيّ");
    const money = list.find((f) => f.rule === "ot_amount_mismatch");
    assert.ok(money, "وصار المبلغ يُقارَن بالثمانية");
    assert.match(money.description, /قاسم 8/);
    assert.notEqual(money.delta, byDefault.delta, "والمبلغ المتوقَّع تغيّر فعلًا");
  });
});

test("الإعدادات: خارج سياق البوابة لا تعمل ولو نُودِيت مباشرة", async () => {
  /* الحارس نفسه الذي يحمي الملفّات يحمي الإعدادات: مدخلٌ جديد بلا حارس
     بابٌ خلفيّ إلى بيانات القسم. */
  for (const call of [
    () => settingsLib.listDivisors({}),
    () => settingsLib.setDivisor({}, { empNo: "1", overtimeDivisor: 8 }),
    () => settingsLib.listLeaves({}, "11111111-2222-4333-8444-555555555555"),
    () => settingsLib.addLeave({}, { runId: "11111111-2222-4333-8444-555555555555", empNo: "1", startDate: "2026-09-01", endDate: "2026-09-02" }),
    () => settingsLib.removeLeave({}, "11111111-2222-4333-8444-555555555555"),
    () => settingsLib.clearDivisor({}, "1"),
  ]) {
    await assert.rejects(call, /بوابة|gate/i);
  }
});

/* ══ اختيارُ الموظّف بالاسم — لا كتابةَ رقمٍ يدويًّا ═══════════════════════
   =========================================================================
   الرقم الوظيفيّ يبقى **المفتاح** في القاعدة وفي المحرّك؛ والاسمُ للعرض
   والبحث وحده. فالشاشة تعرض الأسماء وتُرسل الأرقام. */

test("الإعدادات: المدخل يعرض قائمة موظفي الشهر بأسمائهم وأرقامهم", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());
    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.rosterLoaded, true, "القائمة حُمِّلت");
    assert.ok(out.body.employees.length >= 4);
    const one = out.body.employees.find((e) => e.empNo === "1001");
    assert.ok(one && one.name, "لكل موظّفٍ اسمٌ يُعرض");
    /* ولا تسريبَ لما لا يلزم الاختيار: رقمٌ واسمٌ لا غير. */
    assert.deepEqual(Object.keys(one).sort(), ["empNo", "name"]);
  });
});

test("الإعدادات: موظفو العمل الإضافي وحدهم — ومعهم دقائقُهم وقاسمُهم", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth({ overtime: [
      { empNo: "1001", m15: 120 },
      { empNo: "1002", m15: 0 },            // بلا دقائق ⇒ لا يظهر
      { empNo: "1003", m15: 30, m2: 60 },
    ] });
    const run = await seedMonth(sql, ctx, "2026-09", month);
    await callApi(sql, ctx, "PUT", "settings/divisors", { empNo: "1001", overtimeDivisor: 10 });

    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    const rows = out.body.overtimeEmployees;
    assert.equal(out.body.overtimeLoaded, true);
    assert.deepEqual(rows.map((r) => r.empNo).sort(), ["1001", "1003"],
      "من له دقائق فعلًا وحده");
    const first = rows.find((r) => r.empNo === "1001");
    assert.equal(first.minutes, 120);
    assert.ok(first.name, "الاسم يُعرض");
    assert.equal(first.overtimeDivisor, 10, "المحفوظ يُعرض ولا يُسأل عنه ثانيةً");
    assert.equal(first.isDefault, false, "ويُميَّز أنه قرارٌ محفوظ");
    const second = rows.find((r) => r.empNo === "1003");
    assert.equal(second.minutes, 90, "دقائق المعاملات تُجمع للعرض");
    /* ولا صفَّ محفوظ له ⇒ الافتراضيّ جاهزٌ مختار، لا فراغٌ يُسأل عنه. */
    assert.equal(second.overtimeDivisor, 10, "الافتراضيّ يُعرض قيمةً لا null");
    assert.equal(second.isDefault, true, "ويُميَّز أنه سياسةٌ لا قرار");
    assert.equal(out.body.defaultDivisor, 10);
  });
});

test("الإعدادات: حفظُ الكل يكتب دفعةً — ويرفضها كاملةً إن اختلّ واحد", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());

    const saved = await callApi(sql, ctx, "PUT", "settings/divisors/bulk", {
      divisors: [{ empNo: "1001", overtimeDivisor: 8 }, { empNo: "1002", overtimeDivisor: 10 }],
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.saved, 2);

    /* دفعةٌ فيها قيمةٌ مرفوضة لا تُكتب **جزئيًّا**: من يرى نجاحًا جزئيًّا
       لا يدري ما حُفظ. */
    const bad = await callApi(sql, ctx, "PUT", "settings/divisors/bulk", {
      divisors: [{ empNo: "1003", overtimeDivisor: 8 }, { empNo: "1004", overtimeDivisor: 9 }],
    });
    assert.equal(bad.statusCode, 400);
    const after = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.deepEqual(after.body.divisors.map((d) => d.empNo).sort(), ["1001", "1002"],
      "ولا صفَّ من الدفعة المرفوضة كُتب");

    for (const body of [{}, { divisors: [] }, { divisors: [{ empNo: "", overtimeDivisor: 8 }] }]) {
      const out = await callApi(sql, ctx, "PUT", "settings/divisors/bulk", body);
      assert.equal(out.statusCode, 400, JSON.stringify(body));
    }
  });
});

test("الإعدادات: تعديلُ فترة الإجازة يُبقي معرّفها ولا يُنشئ صفًّا", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedMonth(sql, ctx, "2026-09", fx.consistentMonth());
    const added = await callApi(sql, ctx, "POST", `runs/${run.runId}/leaves`,
      { empNo: "1004", startDate: "2026-09-01", endDate: "2026-09-10" });
    const id = added.body.leave.leaveId;

    const edited = await callApi(sql, ctx, "PATCH", `leaves/${id}`,
      { startDate: "2026-09-01", endDate: "2026-09-30" });
    assert.equal(edited.statusCode, 200);

    const view = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.equal(view.body.leaves.length, 1, "صفٌّ واحد لا اثنان");
    assert.equal(view.body.leaves[0].leaveId, id, "المعرّف نفسه — فيبقى أثرُ من أضافها");
    assert.equal(view.body.leaves[0].endDate, "2026-09-30");

    /* والمقلوبة تُردّ ولا تُكتب. */
    const bad = await callApi(sql, ctx, "PATCH", `leaves/${id}`,
      { startDate: "2026-09-20", endDate: "2026-09-05" });
    assert.equal(bad.statusCode, 400);
    const still = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.equal(still.body.leaves[0].endDate, "2026-09-30", "بقيت كما كانت");
  });
});

test("الإعدادات: تعذُّرُ قراءة الملفّات لا يُسقط الشاشة", async () => {
  /* شاشةٌ لا تفتح أسوأ من شاشةٍ بلا رفاهية بحث. */
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");   // بلا أي ملفّ
    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/settings`);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body.employees, []);
    assert.deepEqual(out.body.overtimeEmployees, []);
    assert.equal(out.body.rosterLoaded, false, "العلم يقول إنها لم تُحمَّل");
    assert.equal(out.body.overtimeLoaded, false);
  });
});

test("الشاشة: كل معرّفٍ تناديه الشيفرة له عنصرٌ في الصفحة", () => {
  /* `show(el)` تقرأ `el.hidden` — فمعرّفٌ بلا عنصر يرمي ويُسقط اللوحة
     كلَّها. وقد وقع فعلًا أثناء بناء هذه الشاشة. */
  const page = pageSource();
  const used = [...page.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const defined = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...new Set(used)].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `معرّفات بلا عنصر: ${missing.join(", ")}`);
});

test("الشاشة: الإدخال اليدويّ للرقم بديلٌ لا أصل", () => {
  const page = pageSource();
  /* الاختيار بالاسم هو الأصل، واليدويّ مخفيٌّ حتى تتعذّر القائمة. */
  assert.match(page, /id="lv-emp"/, "قائمةُ اختيار الموظّف");
  assert.match(page, /id="lv-find"[^>]*type="search"/, "حقلُ بحث");
  assert.match(page, /id="lv-no"[^>]*hidden/, "واليدويّ مخفيٌّ ابتداءً");
  assert.match(page, /id="lv-fallback"[^>]*hidden/, "ورسالةُ التعذّر مخفيّة");
  assert.match(page, /id="dv-save"/, "زرُّ حفظ الكل");
  assert.match(page, /divisors\/bulk/, "ويُرسل دفعةً واحدة");
  /* ولا يُطلب الرقم يدويًّا في جدول العمل الإضافي: حقلُه داخل قسمٍ مطويّ
     صراحةً، لا في مسار الاستعمال العاديّ. */
  const manual = page.match(/<details id="dv-manual">[\s\S]*?<\/details>/);
  assert.ok(manual, "قسم الإدخال اليدويّ غير موجود");
  assert.match(manual[0], /id="dv-no"/, "حقلُ الرقم يجب أن يكون داخله");
  assert.match(manual[0], /summary/, "ومطويًّا خلف عنوان");
});

/* ══ إجماليّا الصرف ═════════════════════════════════════════════════════
   =========================================================================
   يُجمعان من **صفوف الموظفين بعد القراءة** لا من صفّ المجاميع في الملفّ:
   صفُّ المجاميع قد يكون قديمًا أو محسوبًا بصيغةٍ لم تُحدَّث، ومجموعُ ما
   قرأناه فعلًا هو ما تقوم عليه بقيّةُ الملاحظات — فيتّفق المعروض مع
   المفحوص. */

test("الإجماليّات: تُجمع من الصفوف، ولا يُحتسب صفّ المجاميع", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    /* ملفٌّ فيه صفُّ مجاميع صريح — لو حُسب لتضاعف المجموع. */
    month.transfer = fx.csv(["رقم الموظف", "الاسم", "الصافي"],
      [["1001", "أ", 9000], ["1002", "ب", 7500], ["", "", 16500]]);
    month.cash = fx.csv(["رقم الموظف", "الاسم", "الصافي"],
      [["1003", "ج", 6000], ["", "", 6000]]);
    const run = await seedMonth(sql, ctx, "2026-09", month);

    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/totals`);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.transfer.available, true);
    assert.equal(out.body.transfer.total, 16500, "9000+7500 — لا 33000");
    assert.equal(out.body.transfer.count, 2, "ولا يُعدّ صفّ المجاميع موظّفًا");
    assert.equal(out.body.cash.total, 6000);
    assert.equal(out.body.cash.count, 1);
  });
});

test("الإجماليّات: الملفّ الغائب «غير متاح» لا صفرٌ مضلّل", async () => {
  /* صفرٌ هنا يُقرأ «لم يُصرف نقدًا شيء» — وهو استنتاجٌ لم يُثبته شيء. */
  await withDroua(async ({ sql, ctx }) => {
    const run = await seedPartial(sql, ctx, "2026-09", fx.consistentMonth(), ["cash"]);
    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/totals`);
    assert.equal(out.body.transfer.available, true);
    assert.equal(out.body.cash.available, false, "الغائب غيرُ متاح");
    assert.equal(out.body.cash.count, 0);
  });
});

test("الإجماليّات: الملفّ غير المقروء «غير متاح» أيضًا", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    const month = fx.consistentMonth();
    for (const kind of ["full", "transfer", "employees"]) {
      await upload(sql, ctx, run.runId, kind, month[kind]);
    }
    /* بايتاتٌ ليست مصنّفًا في خانة الكاش. */
    await callApi(sql, ctx, "POST", `runs/${run.runId}/files`,
      { kind: "cash", fileName: "cash.xlsx", format: "xlsx", data: b64(Buffer.from("تالف")) });

    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/totals`);
    assert.equal(out.body.transfer.available, true);
    assert.equal(out.body.cash.available, false);
    assert.equal(out.body.cash.total, 0, "ولا يُخترع مبلغ");
  });
});

test("الإجماليّات: كسورُ الهللات تُجمع ثمّ تُقرَّب مرّةً واحدة", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    month.transfer = fx.csv(["رقم الموظف", "الاسم", "الصافي"],
      [["1001", "أ", 0.105], ["1002", "ب", 0.105], ["1004", "د", 0.105]]);
    const run = await seedMonth(sql, ctx, "2026-09", month);
    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/totals`);
    /* 0.315 ← 0.32. ولو قُرِّب كل صفّ لصار 0.33. */
    assert.equal(out.body.transfer.total, 0.32, "التقريب في النتيجة لا في كل صفّ");
  });
});

/* ملفّاتُ الشركة تُذيَّل بصفّ «الإجمالي» بلا رقمٍ وظيفيّ. واحتسابُه يضاعف
   المبلغ المعروض — رقمٌ خاطئ يبدو معقولًا، وهو أسوأ ما يُعرض. */
test("الإجماليّات: صفُّ المجاميع في الملفّ لا يُحتسب مرّةً ثانية", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const month = fx.consistentMonth();
    month.transfer = fx.csv(["رقم الموظف", "الاسم", "الصافي"],
      [["1001", "أ", 100], ["1002", "ب", 200], ["", "الإجمالي", 300]]);
    const run = await seedMonth(sql, ctx, "2026-09", month);
    const out = await callApi(sql, ctx, "GET", `runs/${run.runId}/totals`);
    assert.equal(out.body.transfer.total, 300, "المجموعُ من الموظفين لا من صفّ الملفّ");
    assert.equal(out.body.transfer.count, 2, "وعددُهم اثنان لا ثلاثة");
  });
});

test("الشاشة: الإجماليّات في كتلةٍ مستقلّة لا في جدول الملاحظات", () => {
  const page = pageSource();
  assert.match(page, /id="totals"/, "كتلةُ الإجماليّات");
  assert.match(page, /id="t-bank"/);
  assert.match(page, /id="t-cash"/);
  /* رقمٌ إخباريّ لا يُخلط بملاحظةٍ تستدعي فعلًا. */
  assert.ok(page.indexOf('id="fnd"') < page.indexOf('id="totals"'),
    "الإجماليّات أسفل جدول الملاحظات لا داخله");
  assert.match(page, /غير متاح/, "وما لم يُقرأ يُقال غير متاح");
  /* والتنسيق: فاصلٌ ألفيّ ومنزلتان و«ر.س». */
  const fn = page.match(/function money\(n\)\{[\s\S]*?\n\}/);
  assert.ok(fn, "دالّةُ التنسيق غير موجودة");
  const money = new Function(`${fn[0]}; return money;`)();
  assert.equal(money(123456.78), "123,456.78 ر.س");
  assert.equal(money(0), "0.00 ر.س");
  assert.equal(money(1000), "1,000.00 ر.س");
  assert.equal(money(196340.935), "196,340.94 ر.س");
});

/* الخطأُ الذي وقع فعلًا: النصُّ المرسَل للمتصفّح يُبنى داخل template literal،
   وفيه تُبتلع `\d` فتصير `d` — فينجح التحليل ويعمل النظام ويخرج الرقمُ بلا
   فاصلٍ ألفيّ ولا خطأ يدلّ عليه. فكلُّ شرطةٍ مائلة في نصّ الصفحة تُضاعَف. */
test("الشاشة: لا شرطةَ مائلة مفردة داخل النصّ المرسَل للمتصفّح", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "lib", "droua", "views", "open.js"), "utf8");
  const script = src.slice(src.indexOf("const SCRIPT = `"));
  const lone = script.split("\n")
    .map((line, i) => [i, line])
    .filter(([, line]) => /(^|[^\\])\\[a-zA-Z]/.test(line));
  assert.deepEqual(lone, [], "شرطةٌ مفردة تُبتلع قبل أن تصل المتصفّح");
});

/* «6 موظّفًا» من جنس «20 قواعد»: خطأٌ صغير يجعل القارئ يشكّ فيما يقرأ كلَّه. */
test("الشاشة: عددُ الموظفين تحت الإجماليّ يوافق العربية", () => {
  const src = pageSource().match(/function countEmp\(n\)\{[\s\S]*?\n\}/);
  assert.ok(src, "دالّةُ العدّ غير موجودة");
  const countEmp = new Function(`${src[0]}; return countEmp;`)();
  assert.equal(countEmp(0), "لا أحد");
  assert.equal(countEmp(1), "موظّفٌ واحد");
  assert.equal(countEmp(2), "موظّفان");
  assert.equal(countEmp(6), "6 موظّفين");
  assert.equal(countEmp(10), "10 موظّفين");
  assert.equal(countEmp(62), "62 موظّفًا");
});
