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

async function seedMonth(sql, ctx, period, month) {
  const run = await runs.createRun(sql, period);
  for (const kind of files.KINDS) await upload(sql, ctx, run.runId, kind, month[kind]);
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

test("الشهر: خاناته الأربع تُعرَض بحالتها ناقصةً وممتلئة", async () => {
  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    let slots = await runs.fileSlots(sql, run.runId);
    assert.deepEqual(slots.map((s) => s.kind), ["full", "transfer", "cash", "employees"]);
    assert.equal(slots.every((s) => !s.present), true);
    assert.equal(runs.isComplete(slots), false);
    assert.ok(slots[0].label.includes("كامل"));

    const month = fx.consistentMonth();
    for (const kind of files.KINDS) await upload(sql, ctx, run.runId, kind, month[kind]);
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
    assert.equal(result.created, 0, JSON.stringify(result));
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
    assert.deepEqual(first.missing.sort(), ["cash", "employees", "transfer"]);
    let open = await findings.listFindings(sql, run.runId);
    const missing = open.filter((f) => f.rule === "file_missing");
    assert.equal(missing.length, 3);
    assert.equal(missing[0].severity, "critical");

    for (const kind of ["transfer", "cash", "employees"]) await upload(sql, ctx, run.runId, kind, month[kind]);
    const second = await analyze.analyzeRun(sql, run.runId, ctx);
    assert.equal(second.resolved >= 3, true, "الناقص عولج برفعه");
    open = await findings.listFindings(sql, run.runId);
    assert.equal(open.filter((f) => f.rule === "file_missing").length, 0);
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

    const month = fx.consistentMonth();
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
    assert.equal(analysis.body.analysis.created, 0);

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
    assert.equal(blob.objects.size, 3);
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
