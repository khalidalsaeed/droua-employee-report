/* يحاكي بيئة Vercel: @napi-rs/canvas غير موجود في حزمة الدالّة (pdfjs يحمّله
   ديناميكيًا فلا يتتبّعه المجمِّع). يُحمَّل بـ--require في عملية فرعية. */
const Module = require("node:module");
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@napi-rs/canvas" || request.startsWith("@napi-rs/canvas-")) {
    const err = new Error(`Cannot find module '${request}'`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }
  return original.call(this, request, ...rest);
};
