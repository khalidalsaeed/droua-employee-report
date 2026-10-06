#!/usr/bin/env node
/* تهيئة جداول الوصول إلى وحدة /secure-benefits: العضويّة والجلسات والمحاولات
   والتدقيق.
   =========================================================================
   على نمط scripts/setup-droua-gate.js حرفيًا: كل عبارة IF NOT EXISTS، ولا
   يحذف شيئًا ولا يعدّل جدولًا قائمًا ولا يمسّ جدولًا خارج medins_*.
   تشغيله مرّتين لا يفعل شيئًا في الثانية.

   التشغيل:   node scripts/setup-medins-gate.js
   المعاينة:  node scripts/setup-medins-gate.js --dry-run   (بلا اتّصال إطلاقًا)
   التراجع:   scripts/teardown-medins.js (لا يُشغَّل إلا بأمر صريح) */

const { runStatements } = require("./lib/medins-migrate");

const STATEMENTS = [
  {
    label: "جدول medins_members — عضويّة الوحدة ودور العضو",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_members (
        -- users.id. بلا مفتاح أجنبيّ عمدًا: جدول المستخدمين للمنصّة، والوحدة
        -- لا تُضيف قيدًا عليه ولا تمنع حذف حساب. والحساب المحذوف لا يدخل
        -- أصلًا (requireUser يُرجع null)، فالصفّ اليتيم خامل.
        user_id            text PRIMARY KEY CHECK (user_id ~ '^[A-Za-z0-9-]{1,64}$'),
        -- البريد المتوقَّع — شرطٌ ثانٍ للهويّة. صغيرُ الأحرف دائمًا.
        email              text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
        role               text NOT NULL CHECK (role IN ('editor', 'viewer')),
        active             boolean NOT NULL DEFAULT true,
        -- كلمة مرور البوابة **لهذا العضو**: هاش scrypt بفلفلٍ في البيئة،
        -- فتسريب القاعدة وحده لا يُهاجَم offline. NULL = لم تُضبط بعد،
        -- والبوابة لا تُفتح له.
        gate_password_hash text CHECK (gate_password_hash IS NULL
                             OR gate_password_hash ~ '^scrypt[$][0-9]{2}[$][0-9]{1,2}[$][0-9]{1,2}[$][0-9a-f]{16,}[$][0-9a-f]{32,}$'),
        password_set_at    timestamptz,
        granted_by         text NOT NULL,
        granted_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        disabled_at        timestamptz,
        disabled_reason    text CHECK (disabled_reason IS NULL OR char_length(disabled_reason) <= 200),
        CHECK ((gate_password_hash IS NULL) = (password_set_at IS NULL)),
        CHECK (disabled_at IS NULL OR active = false)
      )`,
  },
  {
    label: "جدول medins_gate_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_gate_sessions (
        -- sha256 لمعرّف الجلسة. التوكن والمعرّف الخام لا يُخزَّنان.
        sid_hash      text PRIMARY KEY,
        user_id       text NOT NULL,
        issued_at     timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz NOT NULL DEFAULT now(),
        idle_exp      timestamptz NOT NULL,
        absolute_exp  timestamptz NOT NULL,
        revoked_at    timestamptz
      )`,
  },
  {
    label: "فهرس medins_gate_sessions(user_id) — للإبطال الجماعي",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_gate_sessions_user ON medins_gate_sessions (user_id)`,
  },
  {
    label: "فهرس medins_gate_sessions(absolute_exp) — للتقليم",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_gate_sessions_abs ON medins_gate_sessions (absolute_exp)`,
  },
  {
    label: "جدول medins_gate_attempts",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_gate_attempts (
        id       bigserial PRIMARY KEY,
        user_id  text NOT NULL,
        outcome  text NOT NULL CHECK (outcome IN ('fail', 'success')),
        ts       timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    label: "فهرس medins_gate_attempts(user_id, outcome, ts) — لعدّ الإخفاقات",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_gate_attempts_lookup
            ON medins_gate_attempts (user_id, outcome, ts DESC)`,
  },
  {
    label: "فهرس medins_gate_attempts(ts) — للتقليم",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_gate_attempts_ts ON medins_gate_attempts (ts)`,
  },
  {
    label: "جدول medins_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_audit (
        id       bigserial PRIMARY KEY,
        ts       timestamptz NOT NULL DEFAULT now(),
        event    text NOT NULL CHECK (event ~ '^[a-z_]{3,48}$'),
        user_id  text,
        role     text CHECK (role IS NULL OR role IN ('editor', 'viewer')),
        -- عبر مُنقٍّ بقائمة مسموحة (lib/medins/security.js: AUDIT_META).
        meta     jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip_hash  text
      )`,
  },
  {
    label: "فهرس medins_audit(ts)",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_audit_ts ON medins_audit (ts DESC)`,
  },
  {
    label: "فهرس medins_audit(event, ip_hash, ts) — لكتم تكرار الاستكشاف",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_audit_dedup ON medins_audit (event, ip_hash, ts DESC)`,
  },
  {
    label: "فهرس medins_audit(user_id, ts)",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_audit_user ON medins_audit (user_id, ts DESC)`,
  },
];

if (require.main === module) runStatements(STATEMENTS, { name: "الوصول إلى الوحدة" });

module.exports = { STATEMENTS };
