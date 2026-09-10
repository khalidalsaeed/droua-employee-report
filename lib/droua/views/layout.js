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
/* ── الشاشة الواسعة: جداول الأشهر والملاحظات ── */
body.wide{display:block;padding:20px}
.wide .card{max-width:1100px;margin:0 auto}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.row>*{width:auto}
.row input{flex:1 1 140px}
.row button{margin-top:0;width:auto;padding:9px 14px}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:.92rem}
th,td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:.82rem}
tr.clickable{cursor:pointer}
tr.clickable:hover{background:var(--bg)}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:.76rem;border:1px solid var(--line)}
/* ــ النقطة قبل النصّ: اللون وحده لا يكفي ــ
   ثُمن الرجال لا يميّز الأحمر من الأخضر، وطابعةُ التقرير لا تطبع لونًا.
   فلكل حالٍ **نقطتُها ونصُّها** معًا، واللون ثالثٌ يُسرّع لا يحمل المعنى. */
.pill::before{content:"● ";font-size:.7em;vertical-align:1px}
.pill.critical{color:var(--bad);border-color:var(--bad)}
.pill.warn{color:#8a6d1f;border-color:#c9a227}
.pill.info{color:#1f5c8a;border-color:#3d7ea6}
.pill.ok{color:#2c6e49;border-color:#2c6e49}
/* ⚪ لم يُقيَّم: بلا لون بقصد — ليس نتيجةً حسنة ولا سيّئة، بل لا نتيجة.
   وتلوينُه كالمعلومة كان يُقرأ «فُحص ولا شيء»، وهو عكس معناه. */
.pill.na{color:var(--muted);border-color:var(--muted);border-style:dashed}
.pill.na::before{content:"○ "}
@media (prefers-color-scheme:dark){.pill.warn{color:#d9b544}.pill.ok{color:#6fbf95}
  .pill.info{color:#7fb8dd;border-color:#5f93b3}}
/* صفٌّ لم يُقيَّم: مشطوبُ الخلفية كي يُميَّز في الجدول من بعيد. */
tr.na>td:first-child{border-inline-start:3px solid var(--muted)}
/* ── شريط التغطية: ما فُحص وما لم يُفحص، قبل أي ملاحظة ── */
.cov{margin:14px 0 0;padding:10px 12px;border-radius:9px;font-size:.88rem;
  border:1px solid var(--line);background:var(--bg)}
.cov.gap{border-color:#c9a227;color:#8a6d1f}
@media (prefers-color-scheme:dark){.cov.gap{color:#d9b544}}
.cov:empty{display:none}
/* لوحةُ إعدادات الشهر: مطويّةٌ افتراضًا — لا تزاحم الملفّات ولا الملاحظات،
   وتُفتح حين يحتاجها من يُغلق شهرًا. */
.cfgbox{border:1px solid var(--line);border-radius:11px;margin:12px 0;background:var(--card)}
.cfgbox>summary{padding:12px 14px;cursor:pointer;font-weight:600;font-size:.95rem}
.cfgbox[open]>summary{border-bottom:1px solid var(--line)}
.cfgbody{padding:6px 14px 14px}
.cfgbody h4{margin:16px 0 4px;font-size:.9rem;font-weight:600}
.cfgbody h4:first-child{margin-top:8px}
.cfgbody .row{margin:8px 0}
.cfgbody input,.cfgbody select{flex:0 1 auto;width:auto;min-width:9rem}
.slot{border:1px solid var(--line);border-radius:11px;padding:14px;margin-bottom:10px}
.slot h3{margin:0 0 6px;font-size:.95rem;font-weight:600}
.small{font-size:.8rem;color:var(--muted)}
.muted{color:var(--muted)}
textarea{width:100%;min-height:56px;padding:8px;font:inherit;color:inherit;
  background:var(--bg);border:1px solid var(--line);border-radius:8px}
select{padding:7px;font:inherit;color:inherit;background:var(--bg);
  border:1px solid var(--line);border-radius:8px}
.hidden{display:none}
.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
/* ── حالات: تحميل، خطأ، فراغ ── */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.note{margin-top:14px;padding:10px 12px;border-radius:9px;font-size:.88rem;min-height:1.2em}
.note.err{color:var(--bad);border:1px solid var(--bad);background:transparent}
.note.ok{color:var(--fg);border:1px solid var(--line)}
.note:empty{display:none}
.empty{padding:28px 12px;text-align:center;color:var(--muted);font-size:.9rem;
  border:1px dashed var(--line);border-radius:11px;margin-top:14px}
.spin{display:inline-block;width:13px;height:13px;vertical-align:-2px;
  border:2px solid var(--line);border-top-color:var(--fg);border-radius:50%;
  animation:sp .7s linear infinite;margin-inline-end:6px}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
[aria-busy="true"]{opacity:.6;pointer-events:none}
.skel{height:14px;border-radius:6px;background:var(--line);opacity:.5;margin:8px 0}
/* ── الشاشات الضيّقة ── */
@media (max-width:640px){
  body.wide{padding:12px}
  .card{padding:16px;border-radius:11px}
  .bar{flex-direction:column;align-items:stretch}
  .row{flex-direction:column;align-items:stretch}
  .row button,.row input{width:100%}
  th,td{padding:7px 5px;font-size:.85rem}
  table{min-width:560px}
}
.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
`;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page({ nonce, title, body, script, wide = false }) {
  const BODY_CLASS = wide ? ' class="wide"' : "";
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title>
<style nonce="${nonce}">${BASE_CSS}</style>
</head>
<body${BODY_CLASS}>
<main class="card">${body}</main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

module.exports = { page, esc };
