const fs = require("fs");
const path = require("path");

/* index.html is the single source of truth for both employee and Ajeer-permit
   data — this reads the deployed file instead of keeping a second copy that
   could drift out of sync. */
function loadHtml() {
  return fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
}

module.exports = { loadHtml };
