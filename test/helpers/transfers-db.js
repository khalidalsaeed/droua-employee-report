/* قاعدة في الذاكرة لجدولي مطابقة ملفّ التحويل — تكفي لاختبار الخدمة
   والموجّه بلا Postgres. ⛔ بيانات مصنوعة فقط. */
const { makeFakeSql } = require("./fake-sql");

function transfersDb({ missing = false } = {}) {
  const db = { files: [], matches: [], seq: 0 };
  const sql = makeFakeSql(({ text, values: v }) => {
    if (missing && /payroll_transfer_(files|matches)/.test(text)) {
      const err = new Error('relation "payroll_transfer_files" does not exist');
      err.code = "42P01";
      throw err;
    }
    if (/SELECT id, file_name FROM payroll_transfer_files WHERE run_id = \? AND superseded_at IS NULL/.test(text)) {
      return db.files.filter((f) => f.run_id === v[0] && !f.superseded_at).map((f) => ({ id: f.id, file_name: f.file_name }));
    }
    if (/nextval/.test(text)) return [{ id: ++db.seq }];
    if (/^UPDATE payroll_transfer_files SET superseded_at/.test(text)) {
      for (const f of db.files) if (f.run_id === v[1] && !f.superseded_at) { f.superseded_at = "2026-11-15T10:00:00Z"; f.superseded_by = v[0]; }
      return [];
    }
    if (/^INSERT INTO payroll_transfer_files/.test(text)) {
      const [id, run_id, file_name, file_format, file_size, file_sha256, detected_period, uploaded_by, transfers, summary] = v;
      if (db.files.some((f) => f.run_id === run_id && !f.superseded_at)) throw new Error("duplicate current file");
      db.files.push({ id, run_id, file_name, file_format, file_size, file_sha256, detected_period, uploaded_by,
        uploaded_at: "2026-11-15T09:00:00Z", superseded_at: null, superseded_by: null,
        transfers: JSON.parse(transfers), summary: JSON.parse(summary) });
      return [];
    }
    if (/^INSERT INTO payroll_transfer_matches/.test(text)) {
      for (const m of JSON.parse(v[2])) db.matches.push({ file_id: v[0], run_id: v[1], ...m });
      return [];
    }
    if (/FROM payroll_transfer_files WHERE run_id = \? ORDER BY id DESC/.test(text)) {
      return db.files.filter((f) => f.run_id === v[0]).sort((a, b) => b.id - a.id);
    }
    if (/FROM payroll_transfer_matches WHERE file_id = \?/.test(text)) {
      return db.matches.filter((m) => m.file_id === v[0]);
    }
    throw new Error("unexpected SQL: " + text);
  });
  return { db, sql };
}

module.exports = { transfersDb };
