/* ─── ملفّ التحويل: بايتات ⇄ تحويلات ───
   detect → read → extract، بحدود حجم صريحة. يرمي TransferFileError بكود
   ثابت تفهمه الواجهة؛ ولا يُسجّل محتوى الملفّ في أي مكان. */

const { TransferFileError, detectFormat, readCsv, readXlsx, readPdf } = require("./readers");
const { extract, detectPeriod } = require("./extract");

const MAX_BYTES = 4 * 1024 * 1024; // دون حدّ جسم الطلب في Vercel (4.5MB)
const MAX_TRANSFERS = 2000;

async function parseTransferFile(bytes, fileName) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buf.length) throw new TransferFileError("empty_file", "الملفّ فارغ");
  if (buf.length > MAX_BYTES) throw new TransferFileError("too_large", "حجم ملفّ التحويل يتجاوز 4MB");
  const format = detectFormat(buf, fileName);
  if (format === "xls") throw new TransferFileError("unsupported_format", "صيغة Excel القديمة (xls) غير مدعومة — احفظ الملفّ بصيغة XLSX أو CSV");
  if (!format) throw new TransferFileError("unsupported_format", "صيغة غير مدعومة — المسموح PDF أو XLSX أو CSV");

  const read = format === "pdf" ? await readPdf(buf) : format === "xlsx" ? readXlsx(buf) : readCsv(buf);
  const out = extract(format, read);
  if (!out.transfers.length) {
    throw new TransferFileError("no_transfers", "لم يُعثر على أي تحويل في الملفّ — تأكّد أنه ملفّ تحويل الرواتب (يحوي المبلغ والآيبان أو رقم الحساب)");
  }
  if (out.transfers.length > MAX_TRANSFERS) throw new TransferFileError("too_many", "عدد التحويلات في الملفّ أكبر من المتوقّع");
  return { format, transfers: out.transfers, mode: out.mode, columns: out.columns, warnings: out.warnings, period: detectPeriod(out.transfers) };
}

module.exports = { parseTransferFile, MAX_BYTES, TransferFileError };
