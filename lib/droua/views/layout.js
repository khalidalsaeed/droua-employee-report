/* ─── هيكل صفحات القسم ────────────────────────────────────────────────
   =========================================================================
   الصفحة تُبنى نصًّا هنا ولا يوجد لها ملفّ .html في المستودع.

   السبب موثَّق في سجلّ المخاطر (R-2): ملفّات جذر المستودع تُقدَّم أصولًا
   ثابتة لأي مستخدم مسجَّل — يقرّ بذلك تعليق middleware.mjs نفسه حين استثنى
   /permits/ و /payroll/ من الأصول العامة. فملفٌّ باسم يخصّ القسم كان
   سيصير رابطًا يكشف وجوده لكل مستخدم في المنصّة، وهو بالضبط ما بُني
   القسم لمنعه.

   ولذلك أيضًا: الأنماط والشيفرة **مضمَّنة** لا في ملفّين منفصلين. ملفّ
   أصلٍ باسمٍ خاصّ بالقسم كان سيُظهر الاسم في لوجّات الخادم من رابط الأصل،
   فيُبطل حياد المسار من الباب الخلفي. والـnonce هو ما يجعل التضمين ممكنًا
   دون فتح CSP لكل سكربت.

   ولا اسم للقسم في أي نصّ ظاهر: لا «ذروة»، ولا «رواتب»، ولا «مسير». من
   يبلغ هذه الصفحة هو صاحب الحساب وحده، ومن سواه لا يبلغها أصلًا — لكن
   الحياد يبقى مجّانيًا فلا سبب للتخلّي عنه. */

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#F5F2EC;--fg:#16283B;--muted:#5A6B7C;--line:#D8D2C6;--card:#FFFDF9;--bad:#8C2F2F}
@media (prefers-color-scheme:dark){:root{--bg:#12181F;--fg:#E8EDF2;--muted:#93A2B1;--line:#26313D;--card:#18202A;--bad:#E08585}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  background:var(--bg);color:var(--fg);
  font:400 16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);
  border-radius:14px;padding:28px}
h1{margin:0 0 20px;font-size:1.15rem;font-weight:600}
label{display:block;margin-bottom:8px;font-size:.9rem;color:var(--muted)}
input{width:100%;padding:11px 13px;font:inherit;color:inherit;background:var(--bg);
  border:1px solid var(--line);border-radius:9px}
input:focus{outline:2px solid var(--fg);outline-offset:1px}
button{width:100%;margin-top:16px;padding:11px;font:inherit;font-weight:600;
  color:var(--card);background:var(--fg);border:0;border-radius:9px;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.msg{margin-top:14px;font-size:.88rem;color:var(--bad);min-height:1.5em}
.hint{margin-top:14px;font-size:.82rem;color:var(--muted)}
.meta{margin:0 0 20px;font-size:.9rem;color:var(--muted)}
.lock{background:transparent;color:var(--fg);border:1px solid var(--line)}
`;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page({ nonce, title, body, script }) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title>
<style nonce="${nonce}">${BASE_CSS}</style>
</head>
<body>
<main class="card">${body}</main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

module.exports = { page, esc };
