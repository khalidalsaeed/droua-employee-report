const { neon } = require("@neondatabase/serverless");

/* Lazy singleton — avoids throwing at module-load time (before DATABASE_URL
   exists) so files that require() this can still be imported/tested before
   the Neon database is provisioned. */
let sql = null;

function getSql() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL غير مُهيّأ على الخادم");
    sql = neon(url);
  }
  return sql;
}

module.exports = { getSql };
