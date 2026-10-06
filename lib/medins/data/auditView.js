/* قراءة سجلّ تدقيق الوحدة — للمحرّر وحده. صفحاتٌ بالمؤشّر (id) لا بالإزاحة. */

const V = require("../validate");
const { LIST } = require("../limits");

function view(row) {
  return {
    id: Number(row.id),
    ts: V.iso(row.ts),
    event: row.event,
    userId: row.user_id || null,
    userName: row.user_name || null,
    role: row.role || null,
    meta: typeof row.meta === "string" ? JSON.parse(row.meta) : (row.meta || {}),
  };
}

async function list({ sql, query }) {
  const before = V.int(query && query.before, { label: "المؤشّر", min: 1, max: Number.MAX_SAFE_INTEGER });
  const limit = V.int(query && query.limit, { label: "العدد", min: 1, max: LIST.AUDIT_PAGE }) || 50;
  /* الاسم يُقرأ من جدول المستخدمين للعرض فقط؛ لا يُكتب في التدقيق. */
  const rows = before
    ? await sql`SELECT a.*, u.name AS user_name FROM medins_audit a LEFT JOIN users u ON u.id::text = a.user_id
        WHERE a.id < ${before} ORDER BY a.id DESC LIMIT ${limit}`
    : await sql`SELECT a.*, u.name AS user_name FROM medins_audit a LEFT JOIN users u ON u.id::text = a.user_id
        ORDER BY a.id DESC LIMIT ${limit}`;
  const events = rows.map(view);
  return { body: { events, next: events.length === limit ? events[events.length - 1].id : null } };
}

module.exports = { list, view };
