#!/usr/bin/env node
/* ─── إدارة أعضاء وحدة /secure-benefits — من سطر الأوامر ─────────────────
   =========================================================================
   العضويّة صفوفٌ في medins_members — لا متغيّرات Vercel. فمنحُ شخصٍ الوصول،
   أو تغيير دوره، أو تعطيله، أو ضبط كلمة مرور بوابته **لا يحتاج إعادة نشر**،
   ولا يمسّ حسابه في المنصّة ولا كلمة مروره فيها.

   الشرط الدائم خارج هذا السكربت: العضو يجب أن يكون **حسابًا محميًّا**
   (PROTECTED_USER_IDS) — وإلّا أُخفيت عنه الوحدة ولو كان صفّه نشطًا.

   كل تغيير يُكتب في medins_audit (بلا كلمات مرور ولا هاشات).
   وشاشة إدارة داخل الوحدة لاحقًا تستعمل الجدول نفسه بلا أي تغيير في المخطّط.

   الأوامر:
     list
     grant        --user <users.id> --email <email> --role editor|viewer --by <اسمك>
     set-role     --user <id> --role editor|viewer --by <اسمك>
     disable      --user <id> --by <اسمك> [--reason "..."]
     enable       --user <id> --by <اسمك>
     set-password --user <id> --by <اسمك> [--password-stdin]
                  (تُطلب كلمة المرور مرّتين بلا عرض؛ يتطلّب MEDINS_GATE_PEPPER
                   وهو نفسه المضبوط على الخادم، وإلّا لن تطابق أبدًا)
     revoke-sessions --user <id> --by <اسمك>

   --dry-run: يطبع ما سيُنفَّذ ولا يتّصل بالقاعدة. */

const readline = require("readline");
const password = require("../lib/secure-kit/password");
const members = require("../lib/medins/members");

const USER_RE = /^[A-Za-z0-9-]{1,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const LOG_N = 17;
const MIN_PASSWORD = 12;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) throw new Error(`وسيط غير متوقَّع: ${key}`);
    const name = key.slice(2);
    if (["dry-run", "password-stdin"].includes(name)) { opts[name] = true; continue; }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} يحتاج قيمة`);
    opts[name] = value;
    i += 1;
  }
  return { command, opts };
}

function need(opts, name, re) {
  const v = opts[name];
  if (!v) throw new Error(`--${name} مطلوب`);
  if (re && !re.test(v)) throw new Error(`--${name} بصيغة غير صالحة`);
  return v;
}
const actorOf = (opts) => `cli:${need(opts, "by", /^[\p{L}\p{N} ._@-]{2,60}$/u)}`;

function auditQuery(sql, { event, userId, role, meta }) {
  return sql`
    INSERT INTO medins_audit (event, user_id, role, meta, ip_hash)
    VALUES (${event}, ${userId}, ${role || null}, ${JSON.stringify(meta || {})}::jsonb, NULL)`;
}

/* كل أمر يبني قائمة استعلامات تُنفَّذ في معاملة واحدة — الصفّ وتدقيقه معًا
   أو لا شيء. يُصدَّر للاختبار. */
function build(sql, command, opts, extra = {}) {
  switch (command) {
    case "grant": {
      const user = need(opts, "user", USER_RE);
      const email = members.normEmail(need(opts, "email", EMAIL_RE));
      const role = need(opts, "role");
      if (!members.ROLES.includes(role)) throw new Error("--role: editor أو viewer");
      const by = actorOf(opts);
      return [
        sql`INSERT INTO medins_members (user_id, email, role, granted_by) VALUES (${user}, ${email}, ${role}, ${by})`,
        auditQuery(sql, { event: "member_granted", userId: user, role, meta: { action: "grant", by } }),
      ];
    }
    case "set-role": {
      const user = need(opts, "user", USER_RE);
      const role = need(opts, "role");
      if (!members.ROLES.includes(role)) throw new Error("--role: editor أو viewer");
      const by = actorOf(opts);
      return [
        sql`UPDATE medins_members SET role = ${role}, updated_at = now() WHERE user_id = ${user}`,
        auditQuery(sql, { event: "member_role_changed", userId: user, role, meta: { action: "set_role", by } }),
      ];
    }
    case "disable": {
      const user = need(opts, "user", USER_RE);
      const by = actorOf(opts);
      const reason = opts.reason ? String(opts.reason).slice(0, 200) : null;
      return [
        sql`UPDATE medins_members SET active = false, disabled_at = now(), disabled_reason = ${reason}, updated_at = now() WHERE user_id = ${user}`,
        sql`UPDATE medins_gate_sessions SET revoked_at = now() WHERE user_id = ${user} AND revoked_at IS NULL`,
        auditQuery(sql, { event: "member_disabled", userId: user, meta: { action: "disable", by } }),
      ];
    }
    case "enable": {
      const user = need(opts, "user", USER_RE);
      const by = actorOf(opts);
      return [
        sql`UPDATE medins_members SET active = true, disabled_at = NULL, disabled_reason = NULL, updated_at = now() WHERE user_id = ${user}`,
        auditQuery(sql, { event: "member_enabled", userId: user, meta: { action: "enable", by } }),
      ];
    }
    case "set-password": {
      const user = need(opts, "user", USER_RE);
      const by = actorOf(opts);
      if (!extra.hash) throw new Error("لا هاش");
      return [
        sql`UPDATE medins_members SET gate_password_hash = ${extra.hash}, password_set_at = now(), updated_at = now() WHERE user_id = ${user}`,
        /* كلمة جديدة تُبطل الجلسات القائمة: من فتح بالقديمة يُعاد إلى البوابة. */
        sql`UPDATE medins_gate_sessions SET revoked_at = now() WHERE user_id = ${user} AND revoked_at IS NULL`,
        auditQuery(sql, { event: "member_password_set", userId: user, meta: { action: "set_password", by } }),
      ];
    }
    case "revoke-sessions": {
      const user = need(opts, "user", USER_RE);
      const by = actorOf(opts);
      return [
        sql`UPDATE medins_gate_sessions SET revoked_at = now() WHERE user_id = ${user} AND revoked_at IS NULL`,
        auditQuery(sql, { event: "member_sessions_revoked", userId: user, meta: { action: "revoke_sessions", by } }),
      ];
    }
    default:
      throw new Error(`أمر غير معروف: ${command}`);
  }
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function newHash(opts) {
  const pepper = process.env.MEDINS_GATE_PEPPER;
  if (!pepper || pepper.length < 32) throw new Error("MEDINS_GATE_PEPPER مطلوب (نفس قيمة الخادم)");
  let pw;
  if (opts["password-stdin"]) pw = await readStdin();
  else {
    pw = await askHidden("كلمة مرور البوابة: ");
    const again = await askHidden("أعدها: ");
    if (pw !== again) throw new Error("الكلمتان مختلفتان");
  }
  if (pw.length < MIN_PASSWORD) throw new Error(`كلمة المرور أقصر من ${MIN_PASSWORD} حرفًا`);
  if (pw.length > password.MAX_INPUT_LENGTH) throw new Error("كلمة المرور أطول من المسموح");
  return password.derive(pw, { logN: LOG_N, pepper });
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") { console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0]); return; }

  if (command === "list") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL غير مُهيّأ");
    const sql = require("../lib/db").getSql();
    const protectedUsers = require("../lib/auth/protectedUsers");
    const rows = await sql`SELECT user_id, email, role, active, disabled_at, password_set_at, granted_at FROM medins_members ORDER BY granted_at`;
    for (const r of rows) {
      const flags = [r.active ? "نشط" : "معطّل", r.password_set_at ? "كلمة مضبوطة" : "بلا كلمة",
        protectedUsers.isConfigured() ? (protectedUsers.isProtected(r.user_id) ? "محمي" : "⚠️ غير محمي في هذه البيئة") : "(الحماية غير مضبوطة محليًا)"];
      console.log(`${r.user_id}  ${r.email}  ${r.role}  ${flags.join(" · ")}`);
    }
    if (!rows.length) console.log("لا أعضاء.");
    return;
  }

  const extra = command === "set-password" && !opts["dry-run"] ? { hash: await newHash(opts) } : { hash: "scrypt$17$8$1$<salt>$<hash>" };
  const fake = (strings, ...values) => ({ text: strings.reduce((t, s, i) => t + s + (i < values.length ? `$${i + 1}` : ""), ""), values });
  if (opts["dry-run"]) {
    for (const q of build(fake, command, opts, extra)) console.log(q.text.replace(/\s+/g, " ").trim(), "\n  ←", JSON.stringify(q.values.map((v) => (String(v).startsWith("scrypt$") ? "<hash>" : v))));
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL غير مُهيّأ. استعمل --dry-run للمعاينة.");
  const sql = require("../lib/db").getSql();
  await sql.transaction(build(sql, command, opts, extra));
  console.log("تم.");
  if (command === "grant") console.log("تذكير: العضو يجب أن يكون ضمن PROTECTED_USER_IDS، ثم اضبط كلمة بوابته بـ set-password.");
}

if (require.main === module) {
  main().catch((err) => { console.error("فشل:", (err && err.message) || err); process.exitCode = 1; });
}

module.exports = { build, parseArgs };
