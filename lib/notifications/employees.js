const employeesData = require("../data/employees");

const F = {
  eid: "الرقم الوظيفي",
  name: "اسم العامل",
  iqama: "رقم الإقامة",
  iqExp: "تاريخ انتهاء الإقامة",
  licExp: "تاريخ انتهاء رخصة العمل",
};

/* Reads from Neon (via lib/data/employees.js) instead of parsing
   app-shell.html — same simplified {eid,name,iqama,iqExp,licExp} shape the
   cron job has always consumed. */
async function loadEmployees() {
  const raw = await employeesData.list();
  return raw.map((e) => ({
    eid: e[F.eid],
    name: e[F.name],
    iqama: e[F.iqama],
    iqExp: e[F.iqExp],
    licExp: e[F.licExp],
  }));
}

module.exports = { loadEmployees };
