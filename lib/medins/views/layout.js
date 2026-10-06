/* ─── هيكل صفحات الوحدة ────────────────────────────────────────────────
   =========================================================================
   الصفحة تُبنى نصًّا ولا ملفّ .html لها في المستودع: ملفّات الجذر تُقدَّم
   أصولًا ثابتة لأي مستخدم مسجَّل، فملفٌّ باسمٍ يخصّ الوحدة يكشف وجودها.
   والأنماط والشيفرة مضمَّنة بـnonce — لا ملفّ أصلٍ يظهر اسمه في لوجّات
   الخادم. ولا اسم للوحدة في عنوان صفحة البوابة. */

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#F5F2EC;--fg:#16283B;--muted:#5A6B7C;--line:#D8D2C6;--card:#FFFDF9;
  --bad:#8C2F2F;--ok:#2c6e49;--warn:#8a6d1f;--accent:#1f5c8a}
@media (prefers-color-scheme:dark){:root{--bg:#12181F;--fg:#E8EDF2;--muted:#93A2B1;--line:#26313D;--card:#18202A;
  --bad:#E08585;--ok:#6fbf95;--warn:#d9b544;--accent:#7fb8dd}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);
  font:400 15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
body.center{display:grid;place-items:center;padding:24px}
.card{width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
body.center .card{max-width:380px}
h1{margin:0 0 18px;font-size:1.15rem;font-weight:600}
h2{margin:0 0 12px;font-size:1.05rem;font-weight:600}
h3{margin:18px 0 8px;font-size:.95rem;font-weight:600}
label{display:block;margin:10px 0 6px;font-size:.85rem;color:var(--muted)}
input,select,textarea{width:100%;padding:9px 11px;font:inherit;color:inherit;background:var(--bg);
  border:1px solid var(--line);border-radius:8px}
textarea{min-height:64px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--fg);outline-offset:1px}
button{padding:9px 14px;font:inherit;font-weight:600;color:var(--card);background:var(--fg);
  border:0;border-radius:8px;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
button.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
button.link{background:none;border:0;color:var(--accent);padding:0;font-weight:500;text-decoration:underline}
.full{width:100%;margin-top:16px}
.msg{margin-top:12px;font-size:.88rem;color:var(--bad);min-height:1.4em}
.hint,.small{font-size:.82rem;color:var(--muted)}
.wrap{max-width:1180px;margin:0 auto;padding:18px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs button{background:transparent;color:var(--fg);border:1px solid var(--line)}
.tabs button[aria-selected="true"]{background:var(--fg);color:var(--card);border-color:var(--fg)}
.row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.row>div{flex:1 1 160px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 14px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{padding:8px 7px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:.8rem;white-space:nowrap}
td.num,th.num{text-align:left;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.click{cursor:pointer}
tr.click:hover{background:var(--bg)}
.pill{display:inline-block;padding:1px 9px;border-radius:99px;font-size:.76rem;border:1px solid var(--line);white-space:nowrap}
.pill::before{content:"● ";font-size:.7em;vertical-align:1px}
.pill.ok{color:var(--ok);border-color:var(--ok)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.pill.bad{color:var(--bad);border-color:var(--bad)}
.pill.info{color:var(--accent);border-color:var(--accent)}
.pill.na{color:var(--muted);border-style:dashed}
.pill.na::before{content:"○ "}
.section{border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0;background:var(--card)}
.note{margin-top:10px;padding:9px 12px;border-radius:8px;font-size:.88rem}
.note.err{color:var(--bad);border:1px solid var(--bad)}
.note.ok{border:1px solid var(--line)}
.note:empty{display:none}
.empty{padding:22px 12px;text-align:center;color:var(--muted);font-size:.9rem;border:1px dashed var(--line);border-radius:10px}
.hidden{display:none !important}
.bar{height:6px;border-radius:4px;background:var(--line);overflow:hidden;margin-top:8px}
.bar>span{display:block;height:100%;background:var(--fg);width:0}
.unknown{color:var(--muted);font-style:italic}
input.auto{width:auto}
input.narrow{width:5em}
@media (max-width:640px){.wrap{padding:10px}.card{padding:16px}th,td{padding:6px 4px;font-size:.84rem}
  table{min-width:600px}.row{flex-direction:column;align-items:stretch}}
`;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page({ nonce, title, body, script, center = false, attrs = "" }) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title>
<style nonce="${nonce}">${BASE_CSS}</style>
</head>
<body${center ? ' class="center"' : ""}${attrs}>
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

module.exports = { page, esc, BASE_CSS };
