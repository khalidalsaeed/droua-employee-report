const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/* ─── سلامة نصّ الهجرة ──────────────────────────────────────────────────
   =========================================================================
   السبب الذي أوجد هذا الملفّ عطلٌ حقيقيّ كاد يمرّ:

       AND strpos(file_name, '\')  ←  مكتوبة في المصدر
       AND strpos(file_name, '')   ←  الواصلة إلى القاعدة

   لأن نصّ الـSQL يعيش داخل template literal في JavaScript، وفيه تُعدّ
   «شرطةٌ عكسية ثمّ علامة اقتباس» محرفَ هروب: الشرطة تُبتلع قبل أن يُنشأ
   النصّ أصلًا. والنتيجة على PostgreSQL أن strpos(x, '') تُرجع 1 لكل نصّ،
   فينقلب الشرط إلى «1 = 0» ويفشل **كل إدخال ملفّ** — بلا أن يكون في اسم
   الملفّ شيء، وبرسالةٍ تشير إلى العمود الخطأ.

   وصنف الخطأ هذا لا يُمسك بقراءة المصدر: المصدر يبدو سليمًا تمامًا. يُمسك
   بفحص **ما يخرج** — ولذلك تفحص هذه الاختبارات النصّ المُصدَّر لا المكتوب،
   وتُقيّم القيد بدلالة PostgreSQL لا بدلالة JavaScript. */

const MIGRATIONS = ["setup-droua-files", "setup-droua-gate", "setup-payroll-monthly"]
  .map((name) => ({ name, file: path.resolve(__dirname, "..", "scripts", `${name}.js`) }))
  .filter((m) => fs.existsSync(m.file));

const ddlOf = (m) => (require(m.file).STATEMENTS || []).map((s) => s.sql).join("\n");

/* الشيفرة مجرّدةً من الشرح: تعليقات المخطّط تذكر عمدًا الصورة المعطوبة
   لتقول ما الذي حدث — وفحصُ النصّ الخام كان سيعدّ الشرحَ مخالفة. */
const codeOf = (ddl) => ddl.replace(/--[^\n]*/g, " ");

/* ─── مُقيّم القيد بدلالة PostgreSQL ────────────────────────────────────
   يقرأ تعبير CHECK من نصّ الهجرة نفسه ويُطبّقه. فما يُختبَر هنا هو القيد
   الذي سيُنشأ فعلًا، لا نسخةٌ منه مكتوبة بيد كاتب الاختبار. */

function checkExpression(ddl, column) {
  const at = ddl.indexOf(`${column} `);
  assert.notEqual(at, -1, `لا عمود باسم ${column}`);
  const open = ddl.indexOf("CHECK (", at);
  assert.notEqual(open, -1, `لا CHECK على ${column}`);
  let depth = 0;
  for (let i = open + 6; i < ddl.length; i += 1) {
    if (ddl[i] === "(") depth += 1;
    else if (ddl[i] === ")") {
      depth -= 1;
      if (depth === 0) return ddl.slice(open + 7, i);
    }
  }
  throw new Error("أقواس غير متوازنة في CHECK");
}

/* دلالات PostgreSQL المستعملة في هذا القيد — وأهمّها الأولى:
     strpos(str, '')  →  1   (لا 0)
   وهي بالضبط ما يجعل الصورة المعطوبة تردّ كل اسم. */
const pg = {
  strpos: (haystack, needle) => (needle === "" ? 1 : haystack.indexOf(needle) + 1),
  charLength: (s) => [...s].length,
  cntrl: /[\u0000-\u001f\u007f]/,
};

function compileFileNameCheck(expr) {
  /* BETWEEN تحمل AND داخلها — تُطوى قبل التقسيم وإلّا انشطر الشرط نصفين. */
  const folded = expr.replace(/BETWEEN\s+(\d+)\s+AND\s+(\d+)/gi, "BETWEEN $1~$2");
  const conjuncts = folded.split(/\s+AND\s+/i).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

  const tests = conjuncts.map((clause) => {
    let m = /^char_length\(file_name\) BETWEEN (\d+)~(\d+)$/.exec(clause);
    if (m) {
      const [min, max] = [Number(m[1]), Number(m[2])];
      return { clause, run: (name) => pg.charLength(name) >= min && pg.charLength(name) <= max };
    }
    m = /^file_name !~ '\[\[:cntrl:\]\]'$/.exec(clause);
    if (m) return { clause, run: (name) => !pg.cntrl.test(name) };

    m = /^strpos\(file_name, (.+)\) = 0$/.exec(clause);
    if (m) {
      const arg = m[1].trim();
      let needle = null;
      const chr = /^chr\((\d+)\)$/.exec(arg);
      if (chr) needle = String.fromCharCode(Number(chr[1]));
      else {
        const lit = /^'(.*)'$/.exec(arg);
        assert.ok(lit, `وسيطُ strpos غير مفهوم: ${arg}`);
        /* '' في SQL يعني علامة اقتباس واحدة — والفارغ فارغٌ فعلًا. */
        needle = lit[1].replace(/''/g, "'");
      }
      return { clause, run: (name) => pg.strpos(name, needle) === 0 };
    }

    /* شرطٌ لا يعرفه المُقيّم يُسقط الاختبار بدل أن يُتخطّى بصمت: تعديلٌ
       مستقبليّ على القيد يجب أن يُجبر على تحديث هذا الفحص معه. */
    throw new Error(`شرطٌ لا يفهمه المُقيّم — حدّثه: ${clause}`);
  });

  return (name) => tests.every((t) => t.run(name));
}

/* ══ القيد نفسه ═══════════════════════════════════════════════════════ */

const FILE_NAME_CASES = [
  ["مسير الرواتب كامل سبتمبر.pdf", true, "اسم عربيّ طبيعيّ"],
  ["payroll-full-2026-09.csv", true, "اسم إنجليزيّ طبيعيّ"],
  ["تقرير (نسخة 2).xlsx", true, "أقواس ومسافات وأرقام"],
  ["a", true, "أقصر اسم مقبول"],
  ["x".repeat(255), true, "الحدّ الأعلى نفسه"],

  ["", false, "فارغ"],
  ["x".repeat(256), false, "أطول من الحدّ"],
  ["dir/file.pdf", false, "شرطة مائلة"],
  ["/file.pdf", false, "شرطة مائلة في الأول"],
  [`dir${String.fromCharCode(92)}file.pdf`, false, "شرطة عكسية"],
  [`..${String.fromCharCode(92)}..${String.fromCharCode(92)}etc`, false, "انتقال أدلّة بالعكسية"],
  ["a\r\nX-Evil: 1.pdf", false, "CR/LF — حقن ترويسات"],
  ["a\nb.pdf", false, "سطر جديد"],
  ["a\rb.pdf", false, "إرجاع أول السطر"],
  ["a\tb.pdf", false, "جدولة"],
  ["a\u0000b.pdf", false, "بايت صفر"],
  ["a\u007fb.pdf", false, "DEL"],
];

test("الهجرة: قيد file_name يقبل الطبيعيّ ويردّ المسارات ومحارف التحكّم", () => {
  const ddl = ddlOf(MIGRATIONS.find((m) => m.name === "setup-droua-files"));
  const passes = compileFileNameCheck(checkExpression(ddl, "file_name"));

  for (const [name, expected, label] of FILE_NAME_CASES) {
    assert.equal(passes(name), expected,
      `${label}: ${JSON.stringify(name)} كان يجب أن ${expected ? "يمرّ" : "يُردّ"}`);
  }
});

test("الهجرة: المُقيّم يمسك الصورة المعطوبة — وإلّا لم يكن يمسك شيئًا", () => {
  /* الصورة التي كانت ستُنشأ فعلًا لو بقي '\\' في template literal.
     ولو مرّت هنا لكان الاختبار أعلاه زينةً لا حارسًا. */
  const broken = "char_length(file_name) BETWEEN 1 AND 255"
    + " AND file_name !~ '[[:cntrl:]]'"
    + " AND strpos(file_name, '/') = 0"
    + " AND strpos(file_name, '') = 0";
  const passes = compileFileNameCheck(broken);
  assert.equal(passes("مسير الرواتب كامل سبتمبر.pdf"), false,
    "النصّ الفارغ في strpos يردّ كل اسم — وهذا هو العطل الذي أوقفناه");
  assert.equal(passes("anything"), false);
});

test("الهجرة: العكسية تُكتب chr(92) لا حرفًا يمرّ بمحرِّف", () => {
  const ddl = ddlOf(MIGRATIONS.find((m) => m.name === "setup-droua-files"));
  const expr = checkExpression(ddl, "file_name");
  assert.match(expr, /strpos\(file_name, chr\(92\)\) = 0/);
  assert.ok(!/strpos\(file_name, ''\)/.test(expr), "نصٌّ فارغ في strpos = كل إدخال يفشل");
});

/* ══ تدقيق عامّ على كل نصوص الهجرة ════════════════════════════════════ */

test("الهجرة: لا نصٌّ فارغ ولا شرطة عكسية في أي عبارة", () => {
  const EMPTY_LITERAL = new RegExp(String.fromCharCode(39, 39), "g");
  for (const migration of MIGRATIONS) {
    const code = codeOf(ddlOf(migration));

    /* النصّ الفارغ في SQL شبه دائمًا أثرُ محرفٍ ابتُلع. وإن أُريد يومًا
       عمدًا فليُكتب صراحةً باستثناءٍ هنا — لا بمرورٍ صامت. */
    assert.equal((code.match(EMPTY_LITERAL) || []).length, 0,
      `${migration.name}: نصٌّ فارغ في SQL — غالبًا محرفٌ ابتُلع`);

    /* وشرطةٌ عكسية باقية في المخرَج تعني أنها نجت من محرِّف JavaScript
       بالصدفة — ودلالتها في SQL تتغيّر بتغيّر standard_conforming_strings.
       فلا تُترك: chr(92) لا لبس فيها. */
    assert.equal((code.match(/\\/g) || []).length, 0,
      `${migration.name}: شرطة عكسية في SQL — استعمل chr(92)`);
  }
});

test("الهجرة: لا تعبير نمطيّ يعتمد على مختصرات ابتلعها المحرِّف", () => {
  /* «\\d» و«\\s» و«\\w» داخل template literal تفقد شرطتها بصمت فتصير
     «d» و«s» و«w» — فتُطابق الحرف نفسه لا الصنف. وأنماط هذا المخطّط تستعمل
     [0-9] و[[:cntrl:]] عمدًا لهذا السبب. */
  for (const migration of MIGRATIONS) {
    const code = codeOf(ddlOf(migration));
    for (const literal of code.match(/'[^']*'/g) || []) {
      if (!/[~]/.test(code.slice(Math.max(0, code.indexOf(literal) - 12), code.indexOf(literal)))) continue;
      assert.ok(!/\[[a-z]\]|\{,|\(\)/i.test(literal) || /\[\[:/.test(literal),
        `${migration.name}: نمطٌ مشبوه ${literal}`);
      assert.ok(!/(^|[^[])[dswDSW]\{/.test(literal),
        `${migration.name}: يبدو أن مختصرًا فقد شرطته في ${literal}`);
    }
  }
});

test("الهجرة: كل عبارة IF NOT EXISTS، ولا حذف ولا تعديل", () => {
  for (const migration of MIGRATIONS) {
    const statements = require(migration.file).STATEMENTS || [];
    assert.ok(statements.length > 0, migration.name);
    for (const s of statements) {
      assert.match(s.sql, /IF NOT EXISTS/, `${migration.name}: ${s.label}`);
    }
    /* الإضافة مسموحة، والهدم لا. و«ALTER TABLE … ADD COLUMN IF NOT EXISTS»
       عمليّةٌ إضافية لا تمسّ بيانًا قائمًا — بخلاف DROP وRENAME وALTER
       COLUMN التي تُغيّر ما هو موجود أو تمحوه. */
    const code = codeOf(ddlOf(migration));
    assert.ok(!/\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b|\bUPDATE\s+\w+\s+SET\b/i.test(code),
      `${migration.name}: عمليّة هدمٍ في سكربت تهيئة`);
    for (const alter of code.match(/ALTER TABLE[\s\S]*?(?=\n|$)/gi) || []) {
      assert.match(alter, /ADD COLUMN IF NOT EXISTS/i,
        `${migration.name}: ALTER غير إضافيّ — ${alter.trim()}`);
    }
  }
});

/* ══ اتّفاق الطبقتين ══════════════════════════════════════════════════ */

test("الهجرة: ما تردّه القاعدة تردّه الطبقة أو تنقّيه — لا خلاف بينهما", async () => {
  /* قيدٌ في القاعدة يرفض ما تقبله الطبقة يعني فشلًا في الإدخال بدل رسالة
     مفهومة. فيُقاس الاثنان على الحالات نفسها. */
  const { withDroua } = require("./helpers/droua-harness");
  const files = require("../lib/droua/files");
  const runs = require("../lib/droua/runs");
  const ddl = ddlOf(MIGRATIONS.find((m) => m.name === "setup-droua-files"));
  const passes = compileFileNameCheck(checkExpression(ddl, "file_name"));

  await withDroua(async ({ sql, ctx }) => {
    const run = await runs.createRun(sql, "2026-09");
    for (const [name, allowedByDb] of FILE_NAME_CASES) {
      let stored = null;
      try {
        const result = await files.putFile(sql, {
          runId: run.runId, kind: "full", fileName: name, format: "csv",
          bytes: Buffer.from("a,b\n1,2\n", "utf8"),
        }, ctx);
        stored = result.file.fileName;
      } catch (err) {
        assert.equal(err.code, "bad_file_name", `${JSON.stringify(name)}: ${err.message}`);
      }
      if (stored === null) {
        assert.equal(allowedByDb, false, `${JSON.stringify(name)}: الطبقة ردّته والقاعدة تقبله`);
        continue;
      }
      /* ما تقبله الطبقة يجب أن يجتاز القيد **بعد التنقية** — فالتنقية هي
         ما يجعل اسمًا فيه سطرٌ جديد يُخزَّن نظيفًا بدل أن يُرفض إدخاله. */
      assert.equal(passes(stored), true,
        `${JSON.stringify(name)} خُزّن ${JSON.stringify(stored)} والقاعدة سترفضه`);
      /* ولا يُترك في الجدول لتصطدم الحالة التالية بقيد التفرّد. */
      const slot = (await runs.fileSlots(sql, run.runId)).find((s) => s.kind === "full");
      await files.deleteFile(sql, slot.file.fileId, ctx);
    }
  });
});
