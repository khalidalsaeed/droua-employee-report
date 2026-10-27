/* يحاكي Vercel قبل الإصلاح: استيراد pdfjs الديناميكي لملفّ عامله يفشل
   (لم يُضمَّن في الحزمة). الاستيراد من غير pdf.mjs يُسمح به. يُحمَّل بـ--import. */
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (/pdf\\.worker\\.mjs$/.test(specifier) && /pdfjs-dist\\/legacy\\/build\\/pdf\\.mjs$/.test(context.parentURL || "")) {
      const err = new Error("Cannot find module '" + specifier + "' (simulated: not traced into the function bundle)");
      err.code = "ERR_MODULE_NOT_FOUND";
      throw err;
    }
    return next(specifier, context);
  }
`));
