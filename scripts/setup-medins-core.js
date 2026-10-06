#!/usr/bin/env node
/* تهيئة جداول بيانات وحدة /secure-benefits — Phase 1.
   =========================================================================
   الشركات، والعروض، والفئات، وكتالوج المنافع، وقيمها، والشروط، والملفّات
   وأجزاؤها، ومواقع الشركة.

   ⛔ لا زرع للكتالوج هنا: بنود المنافع **بيانات** تُضاف من الواجهة بلا هجرة،
   والقائمة المقترحة (lib/medins/catalogProposal.js) لا تُزرع قبل اعتمادها —
   بسكربت مستقلّ: scripts/seed-medins-catalog.js.

   كل عبارة IF NOT EXISTS، ولا DROP ولا ALTER، ولا مساس بجدولٍ خارج
   medins_*. تشغيله مرّتين لا يفعل شيئًا في الثانية.

   الأرقام في قيود CHECK هي حدود lib/medins/limits.js نفسها، نصًّا —
   test/medins-migration-sql.test.js يقارن الاثنين.

   ⚠️ chr(92) هو الشرطة المائلة العكسية — **ولا تُكتب حرفيًّا هنا**: داخل
   template literal يبتلعها المحرِّف فيصير الشرط strpos(x,'')=0 الذي يرفض
   كل إدخال (درسٌ وقع في Droua، موثَّق في scripts/setup-droua-files.js).

   التشغيل:   node scripts/setup-medins-core.js
   المعاينة:  node scripts/setup-medins-core.js --dry-run */

const { runStatements } = require("./lib/medins-migrate");

const STATEMENTS = [
  {
    label: "جدول medins_insurers",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_insurers (
        id           uuid PRIMARY KEY,
        name_ar      text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 1 AND 120),
        name_en      text CHECK (name_en IS NULL OR char_length(btrim(name_en)) BETWEEN 1 AND 120),
        created_by   text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        archived_at  timestamptz
      )`,
  },
  {
    label: "فهرس فريد medins_insurers(lower(name_ar)) — لا شركة مكرّرة",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_medins_insurers_name
            ON medins_insurers (lower(btrim(name_ar)))`,
  },
  {
    label: "جدول medins_offers",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_offers (
        id                uuid PRIMARY KEY,
        insurer_id        uuid NOT NULL REFERENCES medins_insurers (id) ON DELETE RESTRICT,
        title             text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
        reference         text CHECK (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 100),
        submitted_on      date,
        valid_until       date,
        policy_start      date,
        -- NULL = غير معروف. لا قيمة افتراضية تُخترع.
        policy_months     smallint CHECK (policy_months IS NULL OR policy_months BETWEEN 1 AND 36),
        headcount         integer CHECK (headcount IS NULL OR headcount BETWEEN 1 AND 100000),
        dependents_count  integer CHECK (dependents_count IS NULL OR dependents_count BETWEEN 0 AND 100000),
        currency          text NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
        total_premium     numeric(14,2) CHECK (total_premium IS NULL OR total_premium >= 0),
        -- ثلاثيّ عمدًا: «لا نعرف إن كان شاملًا للضريبة» حالةٌ لا تُفترض.
        vat_status        text NOT NULL DEFAULT 'unknown' CHECK (vat_status IN ('included', 'excluded', 'unknown')),
        -- مشتقّ لا يُدخل: لا يُكتب من الطلب ولا يختلف عن مصدره.
        premium_per_head  numeric(14,2) GENERATED ALWAYS AS (
                            CASE WHEN headcount > 0 AND total_premium IS NOT NULL
                                 THEN round(total_premium / headcount, 2) END) STORED,
        status            text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'in_review', 'approved', 'archived')),
        approved_at       timestamptz,
        approved_by       text,
        notes             text CHECK (notes IS NULL OR char_length(notes) <= 4000),
        created_by        text NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text,
        CHECK (valid_until IS NULL OR submitted_on IS NULL OR valid_until >= submitted_on),
        CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL))
      )`,
  },
  {
    label: "فهرس medins_offers(insurer_id)",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_offers_insurer ON medins_offers (insurer_id)`,
  },
  {
    label: "فهرس medins_offers(status, updated_at)",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_offers_status ON medins_offers (status, updated_at DESC)`,
  },
  {
    label: "فهرس فريد medins_offers(insurer_id, lower(reference)) — العرض نفسه لا يُدخل مرّتين",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_medins_offers_reference
            ON medins_offers (insurer_id, lower(btrim(reference))) WHERE reference IS NOT NULL`,
  },
  {
    label: "جدول medins_offer_classes",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_offer_classes (
        id             uuid PRIMARY KEY,
        offer_id       uuid NOT NULL REFERENCES medins_offers (id) ON DELETE CASCADE,
        class_code     text NOT NULL CHECK (class_code ~ '^[A-Za-z0-9+_-]{1,12}$'),
        label          text CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 80),
        member_count   integer CHECK (member_count IS NULL OR member_count BETWEEN 0 AND 100000),
        class_premium  numeric(14,2) CHECK (class_premium IS NULL OR class_premium >= 0),
        sort_order     smallint NOT NULL DEFAULT 0,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (offer_id, class_code),
        -- يخدم المفتاح المركّب في medins_offer_terms: الفئة من العرض نفسه.
        UNIQUE (id, offer_id)
        -- Phase 2 يضيف network_version_id (إضافةٌ بحتة).
      )`,
  },
  {
    label: "جدول medins_benefit_catalog — بنود بياناتٌ لا أعمدة",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_benefit_catalog (
        -- رمزٌ ثابت: يُكتب مرّة ولا يتغيّر (الواجهة لا تقبل تغييره، والقيم
        -- تشير إليه بمفتاح أجنبيّ).
        code           text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$'),
        label_ar       text NOT NULL CHECK (char_length(btrim(label_ar)) BETWEEN 1 AND 120),
        label_en       text CHECK (label_en IS NULL OR char_length(btrim(label_en)) BETWEEN 1 AND 120),
        category       text NOT NULL CHECK (category IN ('limits', 'inpatient', 'outpatient', 'cost_sharing',
                         'emergency', 'dental', 'optical', 'maternity', 'chronic', 'pharmacy',
                         'therapy', 'mental_health', 'evacuation', 'network', 'other')),
        -- نوع القيمة يحدّد العمود الذي يحملها في medins_class_benefits.
        value_type     text NOT NULL CHECK (value_type IN ('amount', 'percent', 'boolean', 'count', 'text')),
        unit           text CHECK (unit IS NULL OR unit IN ('SAR', 'percent', 'visit', 'session', 'day', 'item')),
        -- اتّجاه الأفضلية للمقارنة في Phase 2: لا يُخمَّن من الاسم.
        better         text NOT NULL CHECK (better IN ('higher', 'lower', 'none')),
        display_order  integer NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 100000),
        active         boolean NOT NULL DEFAULT true,
        created_by     text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        CHECK (value_type <> 'percent' OR unit IS NULL OR unit = 'percent'),
        CHECK (value_type <> 'boolean' OR unit IS NULL),
        CHECK (value_type <> 'text' OR unit IS NULL)
      )`,
  },
  {
    label: "جدول medins_files",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_files (
        -- يُولَّد على الخادم قبل التشفير ويدخل الـAAD.
        id                 uuid PRIMARY KEY,
        offer_id           uuid NOT NULL REFERENCES medins_offers (id) ON DELETE RESTRICT,
        kind               text NOT NULL CHECK (kind IN ('quote', 'benefits', 'policy', 'other')),
        -- للعرض والتنزيل فقط؛ لا يدخل المسار ولا الـAAD ولا التدقيق.
        file_name          text NOT NULL CHECK (
                             char_length(file_name) BETWEEN 1 AND 255
                             AND file_name !~ '[[:cntrl:]]'
                             AND strpos(file_name, '/') = 0
                             AND strpos(file_name, chr(92)) = 0),
        format             text NOT NULL CHECK (format IN ('pdf', 'xlsx', 'xls', 'csv')),
        content_type       text NOT NULL,
        -- الحجم المعلَن عند البدء، ويُتحقَّق منه عند الإكمال.
        size_bytes         bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
        part_count         smallint NOT NULL CHECK (part_count BETWEEN 1 AND 8),
        plaintext_sha256   text NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
        status             text NOT NULL CHECK (status IN ('uploading', 'ready', 'deleted')),
        enc_algo           text NOT NULL CHECK (enc_algo = 'aes-256-gcm'),
        enc_key_id         text NOT NULL CHECK (enc_key_id ~ '^k[1-9][0-9]{0,2}$'),
        created_by         text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        upload_expires_at  timestamptz,
        completed_at       timestamptz,
        deleted_at         timestamptz,
        purged_at          timestamptz,
        CHECK (status <> 'uploading' OR (upload_expires_at IS NOT NULL AND completed_at IS NULL AND deleted_at IS NULL)),
        CHECK (status <> 'ready' OR (completed_at IS NOT NULL AND deleted_at IS NULL)),
        CHECK (status <> 'deleted' OR deleted_at IS NOT NULL),
        CHECK (purged_at IS NULL OR status = 'deleted')
      )`,
  },
  {
    label: "فهرس medins_files(offer_id)",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_files_offer ON medins_files (offer_id)`,
  },
  {
    label: "فهرس medins_files(status, upload_expires_at) — للكنس",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_files_sweep ON medins_files (status, upload_expires_at)`,
  },
  {
    label: "فهرس فريد medins_files(offer_id, sha256) — منع التكرار، حتى المتزامن",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_medins_files_dedup
            ON medins_files (offer_id, plaintext_sha256) WHERE status IN ('uploading', 'ready')`,
  },
  {
    label: "جدول medins_file_parts",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_file_parts (
        file_id        uuid NOT NULL REFERENCES medins_files (id) ON DELETE CASCADE,
        part_index     smallint NOT NULL CHECK (part_index BETWEEN 0 AND 7),
        -- موضعٌ عشوائيّ لا هويّة؛ لا اسم ولا صيغة ولا تاريخ فيه.
        blob_pathname  text NOT NULL UNIQUE CHECK (blob_pathname ~ '^medins/[0-9a-f-]{36}/[0-9a-f]{32}$'),
        size_bytes     integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2621440),
        part_sha256    text NOT NULL CHECK (part_sha256 ~ '^[0-9a-f]{64}$'),
        enc_key_id     text NOT NULL CHECK (enc_key_id ~ '^k[1-9][0-9]{0,2}$'),
        enc_iv         text NOT NULL CHECK (enc_iv ~ '^[0-9a-f]{24}$'),
        enc_tag        text NOT NULL CHECK (enc_tag ~ '^[0-9a-f]{32}$'),
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (file_id, part_index)
      )`,
  },
  {
    label: "جدول medins_class_benefits — known / unknown / not_applicable",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_class_benefits (
        class_id         uuid NOT NULL REFERENCES medins_offer_classes (id) ON DELETE CASCADE,
        benefit_code     text NOT NULL REFERENCES medins_benefit_catalog (code) ON DELETE RESTRICT,
        -- غياب الصفّ = unknown. والصفّ الموجود يعلن حاله صراحةً.
        value_status     text NOT NULL CHECK (value_status IN ('known', 'unknown', 'not_applicable')),
        -- عمودٌ لكل نوع: النوع في الكتالوج يحدّد أيّها يُملأ (يفرضه التطبيق).
        amount_value     numeric(14,2) CHECK (amount_value IS NULL OR amount_value >= 0),
        percent_value    numeric(5,2) CHECK (percent_value IS NULL OR percent_value BETWEEN 0 AND 100),
        bool_value       boolean,
        count_value      integer CHECK (count_value IS NULL OR count_value BETWEEN 0 AND 100000),
        text_value       text CHECK (text_value IS NULL OR char_length(btrim(text_value)) BETWEEN 1 AND 500),
        note             text CHECK (note IS NULL OR char_length(note) <= 500),
        source_file_id   uuid REFERENCES medins_files (id) ON DELETE SET NULL,
        source_page      smallint CHECK (source_page IS NULL OR source_page BETWEEN 1 AND 2000),
        source_excerpt   text CHECK (source_excerpt IS NULL OR char_length(source_excerpt) <= 500),
        entry_method     text NOT NULL DEFAULT 'manual' CHECK (entry_method IN ('manual', 'template', 'ai')),
        verified_at      timestamptz,
        verified_by      text,
        updated_by       text NOT NULL,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (class_id, benefit_code),
        -- القاعدة الحاكمة: Missing ≠ Zero.
        -- known يحمل قيمةً واحدة بالضبط؛ unknown و not_applicable لا يحملان
        -- أي قيمة — فلا «صفر خفيّ» يبدو معلومةً وهو غياب.
        CHECK (num_nonnulls(amount_value, percent_value, bool_value, count_value, text_value)
               = CASE WHEN value_status = 'known' THEN 1 ELSE 0 END),
        CHECK ((verified_at IS NULL) = (verified_by IS NULL))
      )`,
  },
  {
    label: "فهرس medins_class_benefits(benefit_code) — للمقارنة بندًا ببند",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_class_benefits_code ON medins_class_benefits (benefit_code)`,
  },
  {
    label: "جدول medins_offer_terms — الاستثناءات والشروط والمزايا",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_offer_terms (
        id              uuid PRIMARY KEY,
        offer_id        uuid NOT NULL REFERENCES medins_offers (id) ON DELETE CASCADE,
        -- NULL = يسري على كل فئات العرض.
        class_id        uuid,
        kind            text NOT NULL CHECK (kind IN ('exclusion', 'condition', 'extra')),
        body            text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
        severity        smallint CHECK (severity IS NULL OR severity BETWEEN 0 AND 3),
        source_file_id  uuid REFERENCES medins_files (id) ON DELETE SET NULL,
        source_page     smallint CHECK (source_page IS NULL OR source_page BETWEEN 1 AND 2000),
        source_excerpt  text CHECK (source_excerpt IS NULL OR char_length(source_excerpt) <= 500),
        verified_at     timestamptz,
        verified_by     text,
        created_by      text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CHECK (kind = 'exclusion' OR severity IS NULL),
        CHECK ((verified_at IS NULL) = (verified_by IS NULL)),
        -- الفئة من العرض نفسه — مفروضًا في القاعدة لا في التطبيق وحده.
        FOREIGN KEY (class_id, offer_id) REFERENCES medins_offer_classes (id, offer_id) ON DELETE CASCADE
      )`,
  },
  {
    label: "فهرس medins_offer_terms(offer_id, kind)",
    sql: `CREATE INDEX IF NOT EXISTS idx_medins_offer_terms_offer ON medins_offer_terms (offer_id, kind)`,
  },
  {
    label: "جدول medins_company_locations — نقاط القياس",
    sql: `
      CREATE TABLE IF NOT EXISTS medins_company_locations (
        id          uuid PRIMARY KEY,
        label       text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
        latitude    numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
        longitude   numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
        is_default  boolean NOT NULL DEFAULT false,
        active      boolean NOT NULL DEFAULT true,
        created_by  text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        -- الافتراضيّ نشطٌ دائمًا.
        CHECK (NOT is_default OR active)
      )`,
  },
  {
    label: "فهرس فريد جزئيّ — موقع افتراضيّ واحد في كل لحظة",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_medins_locations_default
            ON medins_company_locations (is_default) WHERE is_default`,
  },
];

if (require.main === module) runStatements(STATEMENTS, { name: "بيانات الوحدة" });

module.exports = { STATEMENTS };
