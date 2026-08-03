const { loadHtml } = require("./htmlSource");

const F = {
  eid: "الرقم الوظيفي",
  name: "اسم العامل",
  iqama: "رقم الإقامة",
  iqExp: "تاريخ انتهاء الإقامة",
  licExp: "تاريخ انتهاء رخصة العمل",
};

function extractDataArray(html) {
  const m = html.match(/const DATA\s*=\s*(\[[\s\S]*\]);\s*\nconst FIN/);
  if (!m) throw new Error("تعذر العثور على DATA داخل app-shell.html");
  return JSON.parse(m[1]);
}

async function loadEmployees() {
  const html = loadHtml();
  const raw = extractDataArray(html);
  return raw.map((e) => ({
    eid: e[F.eid],
    name: e[F.name],
    iqama: e[F.iqama],
    iqExp: e[F.iqExp],
    licExp: e[F.licExp],
  }));
}

module.exports = { loadEmployees };
