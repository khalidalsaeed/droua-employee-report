/* ─── مُشغّل SQL حقيقيّ للاختبار عبر psql — بلا اعتماد جديد ─────────────
   =========================================================================
   اختبارات التكامل تحتاج Postgres حقيقيًا: القيود (known/unknown، الفهرس
   الفريد الجزئيّ، المفتاح المركّب، chr(92)) لا يمتحنها مُزيَّف. والمشروع لا
   يحمل مشغّل pg، وPhase 1 لا تُضيف اعتمادًا — فهذا الملفّ يحاكي واجهة neon
   (قالب موسوم، و`unsafe`، و`transaction`، و`query`) فوق أداة psql.

   يُفعَّل بـ MEDINS_TEST_PG_URL (قاعدة اختبار محلّية مؤقتة، **لا إنتاج**).
   وبدونه تُتخطّى اختبارات التكامل ولا تفشل.

   كل استعلام يُحوَّل ليطبع سطرًا واحدًا: مصفوفة JSON بصفوفه. والقيم تُضمَّن
   محارف مقتبسة (standard_conforming_strings مفعَّل افتراضيًا في PG ≥ 9.1).
   الأنواع تخرج من JSON لا من neon: الأرقام أرقامٌ لا نصوص — والشيفرة تمرّ
   كلّها عبر Number()/new Date() فلا تعتمد على أيٍّ من الشكلين. */

const { execFile } = require("node:child_process");

class Unsafe {
  constructor(text) { this.text = String(text); }
}

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Unsafe) return v.text;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("رقم غير منتهٍ");
    return String(v);
  }
  if (typeof v === "bigint") return String(v);
  if (v instanceof Date) return quote(v.toISOString());
  if (Array.isArray(v)) {
    return quote("{" + v.map((x) => (x === null ? "NULL" : '"' + String(x).replace(/["\\]/g, "\\$&") + '"')).join(",") + "}");
  }
  if (Buffer.isBuffer(v)) throw new Error("لا بايتات خام في الاستعلام");
  if (typeof v === "object") return quote(JSON.stringify(v));
  return quote(String(v));
}
function quote(s) {
  if (s.includes("\u0000")) throw new Error("NUL في نصّ");
  return "'" + s.replace(/'/g, "''") + "'";
}

/* أول SELECT في المستوى الأعلى بعد قائمة CTE. */
function splitWith(text) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) { if (c === "'") inStr = false; continue; }
    if (c === "'") { inStr = true; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && /^SELECT\b/i.test(text.slice(i)) && i > 4) {
      return { head: text.slice(0, i).trim(), main: text.slice(i).trim() };
    }
  }
  return null;
}

const AGG = (name) => `SELECT coalesce(jsonb_agg(${name}), '[]'::jsonb) FROM ${name}`;

function wrap(text) {
  const t = text.trim().replace(/;\s*$/, "");
  if (/^SELECT\b/i.test(t)) return `SELECT coalesce(jsonb_agg(__r), '[]'::jsonb) FROM (${t}) __r;`;
  if (/^WITH\b/i.test(t)) {
    if (/\b(INSERT|UPDATE|DELETE)\b/i.test(t)) {
      const parts = splitWith(t);
      if (!parts) throw new Error("تعذّر تحليل WITH");
      return `${parts.head}, __r AS (${parts.main}) ${AGG("__r")};`;
    }
    return `SELECT coalesce(jsonb_agg(__r), '[]'::jsonb) FROM (${t}) __r;`;
  }
  if (/\bRETURNING\b/i.test(t)) return `WITH __r AS (${t}) ${AGG("__r")};`;
  return `${t}; SELECT '[]'::json;`;
}

function runPsql(url, script) {
  return new Promise((resolve, reject) => {
    execFile("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", script],
      { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const m = /ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/.exec(stderr || "");
          const e = new Error(m ? m[2] : (stderr || err.message).trim());
          if (m) e.code = m[1];
          return reject(e);
        }
        resolve(String(stdout).split("\n").filter((l) => l.startsWith("[")).map((l) => JSON.parse(l)));
      });
  });
}

function makePsqlSql(url) {
  const calls = [];
  function render(strings, values) {
    let text = "";
    strings.forEach((chunk, i) => {
      text += chunk;
      if (i < values.length) text += lit(values[i]);
    });
    return text;
  }
  function sql(strings, ...values) {
    const text = render(strings, values);
    const q = {
      text,
      then(resolve, reject) {
        calls.push(text.replace(/\s+/g, " ").trim());
        return runPsql(url, wrap(text)).then((out) => out[0], null).then(resolve, reject);
      },
    };
    return q;
  }
  sql.unsafe = (text) => new Unsafe(text);
  sql.query = (text) => runPsql(url, `${text}; SELECT '[]'::json;`).then(() => []);
  sql.transaction = async (queries) => {
    const list = typeof queries === "function" ? queries(sql) : queries;
    for (const q of list) calls.push(q.text.replace(/\s+/g, " ").trim());
    return runPsql(url, list.map((q) => wrap(q.text)).join("\n"));
  };
  sql.calls = calls;
  sql.raw = (text) => runPsql(url, text);
  return sql;
}

module.exports = { makePsqlSql, lit, wrap, splitWith };
