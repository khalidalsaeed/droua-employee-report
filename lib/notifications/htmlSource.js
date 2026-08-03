const fs = require("fs");
const path = require("path");

/* app-shell.html (formerly index.html — renamed to avoid Vercel's static-file-
   beats-rewrite conflict, see api/pages/home.js) is the single source of
   truth for both employee and Ajeer-permit data — this reads the deployed
   file instead of keeping a second copy that could drift out of sync. */
function loadHtml() {
  return fs.readFileSync(path.join(process.cwd(), "app-shell.html"), "utf8");
}

module.exports = { loadHtml };
