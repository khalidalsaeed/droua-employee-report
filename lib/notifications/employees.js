const fs = require("fs");
const path = require("path");

/* index.html's inline `const DATA = [...]` array is the single source of truth
   for employee records; this reads it instead of keeping a second copy that
   could drift out of sync. */
const F = {
  eid: "الرقم الوظيفي",
  name: "اسم العامل",
  iqExp: "تاريخ انتهاء الإقامة",
  licExp: "تاريخ انتهاء رخصة العمل",
};

function extractDataArray(html) {
  const m = html.match(/const DATA\s*=\s*(\[[\s\S]*\]);\s*\nconst FIN/);
  if (!m) throw new Error("تعذر العثور على DATA داخل index.html");
  return JSON.parse(m[1]);
}

async function loadHtml() {
  return fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
}

async function loadEmployees() {
  const html = await loadHtml();
  const raw = extractDataArray(html);
  return raw.map((e) => ({
    eid: e[F.eid],
    name: e[F.name],
    iqExp: e[F.iqExp],
    licExp: e[F.licExp],
  }));
}

module.exports = { loadEmployees };
