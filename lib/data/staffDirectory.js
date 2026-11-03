/* دليل الموظفين الموحَّد لميزات المتابعة — staff_directory.
   =========================================================================
   مصدران، وكل شخص يظهر مرّة واحدة:

     أجير  — سجلّ employees القائم. لا يُنسخ ولا يُزامَن: الدليل يقرؤه حيًّا
             (استعلام موحَّد)، فلا مهمّة مزامنة تتقادم ولا إدخال يدوي.
             صفّ staff_directory لموظف أجير يُنشأ تلقائيًا أوّل مرّة تُسجَّل
             له رحلة فقط («تجسيد كسول»)، لتشير إليه الرحلة بمعرّف ثابت.
             الاسم والمهنة يُعرضان حيّين من employees؛ نسختهما في الصفّ
             لقطةٌ تحفظ السجلّ التاريخي إن حُذف الموظف لاحقًا (SET NULL).
     ذروة  — صفوف staff_directory بمصدر droua، تُستورد مرّة واحدة من تقرير
             قائمة الموظفين (scripts/import-staff-directory.js) ثم تبقى
             محفوظة في النظام.

   مفتاح الشخص في الواجهة: "ajeer:<eid>" أو "staff:<id>". الخادم يحوّله إلى
   staff_directory.id قبل أي كتابة (resolvePerson).

   منع التكرار (classifyImport): الهوية/الإقامة مفتاح المطابقة القويّ. صفّ في
   تقرير ذروة تطابق هويّته موظف أجير واحدًا لا يُنشأ (يبقى الشخص «أجير»)،
   وأي التباس — تطابق متعدّد، أو اسم مطابق بلا هوية، أو تكرار داخل الملف —
   يُعرض للمراجعة ولا يُخمَّن. */

const F_NAME = "اسم العامل";
const F_JOB = "المهنة";
const F_IQAMA = "رقم الإقامة";
const F_PASSPORT = "رقم الجواز";

const SOURCES = { droua: "ذروة", ajeer: "أجير" };

/* أرقام فقط، بالأرقام اللاتينية. الهوية السعودية والإقامة 10 أرقام؛ يُقبل
   6–15 لاحتمال صيغ أخرى، وما عداه = لا هوية (لا مطابقة على قيمة مشوّهة). */
function normalizeIdentity(v) {
  const s = String(v == null ? "" : v)
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/\D/g, "");
  return s.length >= 6 && s.length <= 15 ? s : null;
}

/* رقم جسر بصورة المقارنة: بلا أصفار بادئة — كـnormalizeJisr في employees.js. */
function normalizeJisr(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  return s.replace(/^0+(?=\d)/, "") || null;
}

/* تطبيع الاسم للمقارنة فقط (لا للتخزين). */
function normalizeName(v) {
  return String(v == null ? "" : v)
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

/* تقارب اسمين عربيين (0–1): معامل Dice على ثنائيات الحروف، بعد حذف «ال»
   البادئة والمسافات. يقيس اختلاف الإملاء بين جسر وأجير لا الهوية: على
   أزواج تقرير ذروة الفعلي كانت الأزواج الحقيقية كلها ≥ 0.50 وغير
   المترابطة ≤ 0.14، فالعتبة 0.4 بينهما. (أمثلة مُختلَقة في الاختبارات.) */
function nameSimilarity(a, b) {
  const key = (s) => normalizeName(s).split(" ").map((t) => t.replace(/^ال(?=..)/, "")).join("");
  const grams = (s) => { const g = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g; };
  const x = grams(key(a)), y = grams(key(b));
  if (!x.length || !y.length) return 0;
  const bag = new Map();
  for (const t of x) bag.set(t, (bag.get(t) || 0) + 1);
  let hit = 0;
  for (const t of y) if (bag.get(t) > 0) { hit++; bag.set(t, bag.get(t) - 1); }
  return (2 * hit) / (x.length + y.length);
}
const SIMILAR_NAME = 0.4;

const clean = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

/* الدليل الموحَّد كما تراه الواجهة. includeIdentity: الهوية والجواز يُرسلان
   لمن يملك employees:view فقط (هي بيانات ذلك القسم). */
async function listPeople(sql, { includeIdentity = false } = {}) {
  const [ajeer, dir] = await Promise.all([
    sql`SELECT e.eid, e.data FROM employees e ORDER BY e.id`,
    sql`SELECT id, source_type, source_employee_eid, employee_number, name, job_title, department, identity_number, active
          FROM staff_directory ORDER BY id`,
  ]);
  const byEid = new Map();
  for (const d of dir) if (d.source_employee_eid) byEid.set(String(d.source_employee_eid), d);
  const out = [];
  for (const r of ajeer) {
    const eid = String(r.eid);
    const d = byEid.get(eid);
    const data = r.data || {};
    out.push(person({
      key: `ajeer:${eid}`, staffId: d ? String(d.id) : null, source: "ajeer", number: eid,
      name: data[F_NAME] || (d && d.name) || "", job: data[F_JOB] || "", department: "",
      identity: data[F_IQAMA] ? String(data[F_IQAMA]) : "", passport: data[F_PASSPORT] ? String(data[F_PASSPORT]) : "",
      active: true, missing: false,
    }, includeIdentity));
  }
  const liveEids = new Set(ajeer.map((r) => String(r.eid)));
  for (const d of dir) {
    /* صفّ أجير لموظف ما زال في السجلّ ظهر أعلاه — لا يُكرَّر. */
    if (d.source_type === "ajeer" && d.source_employee_eid && liveEids.has(String(d.source_employee_eid))) continue;
    out.push(person({
      key: `staff:${d.id}`, staffId: String(d.id), source: d.source_type,
      number: d.source_type === "droua" ? d.employee_number || "" : d.source_employee_eid || "",
      name: d.name || "", job: d.job_title || "", department: d.department || "",
      identity: d.identity_number || "", passport: "",
      active: !!d.active,
      /* موظف أجير حُذف من السجلّ بعد أن سُجّلت له رحلات: يبقى سجلّه بلقطته. */
      missing: d.source_type === "ajeer",
    }, includeIdentity));
  }
  return out;
}

function person(p, includeIdentity) {
  if (!includeIdentity) { p.identity = ""; p.passport = ""; }
  return p;
}

/* مفتاح الواجهة → staff_directory.id. موظف أجير يُجسَّد صفّه عند أوّل رحلة
   (ON CONFLICT: نداءان متزامنان لا يُنشئان صفّين)، وتُحدَّث لقطة اسمه. */
async function resolvePerson(sql, key) {
  const m = /^(ajeer|staff):(.+)$/.exec(String(key || ""));
  if (!m) throw new Error("اختر الموظف");
  if (m[1] === "staff") {
    if (!/^\d{1,18}$/.test(m[2])) throw new Error("اختر الموظف");
    const rows = await sql`SELECT id, active FROM staff_directory WHERE id = ${m[2]}`;
    if (!rows[0]) throw new Error("الموظف غير موجود في الدليل");
    return String(rows[0].id);
  }
  const eid = m[2];
  const emp = await sql`SELECT eid, name, data FROM employees WHERE eid = ${eid}`;
  if (!emp[0]) throw new Error("الموظف غير موجود في سجلّ الموظفين");
  const job = clean(emp[0].data && emp[0].data[F_JOB]);
  const name = clean((emp[0].data && emp[0].data[F_NAME]) || emp[0].name) || `موظف ${eid}`;
  const rows = await sql`
    INSERT INTO staff_directory (source_type, source_employee_eid, name, job_title)
    VALUES ('ajeer', ${eid}, ${name}, ${job})
    ON CONFLICT (source_employee_eid) WHERE source_employee_eid IS NOT NULL
    DO UPDATE SET name = EXCLUDED.name, job_title = EXCLUDED.job_title, updated_at = now()
    RETURNING id`;
  return String(rows[0].id);
}

/* ─── الاستيراد: تصنيف صفوف تقرير ذروة قبل أي كتابة ───
   rows:     [{row, number, name, job, department, identity}] من التقرير
   ajeer:    [{eid, name, identity, jisr}] من employees (jisr = «رقم جسر»)
   existing: [{id, employeeNumber, identity}] صفوف ذروة الموجودة في الدليل
   assign:   تجاوزات بشرية بعد المراجعة: { "<رقم الموظف>": "new" | "skip" | "ajeer:<eid>" }

   النتيجة لكل صفّ واحدة من:
     new        يُنشأ صفّ ذروة
     update     صفّ ذروة موجود (بالهوية أو الرقم) — تُحدَّث الحقول
     unchanged  موجود ومطابق
     ajeer      الهوية تطابق موظف أجير واحدًا، أو رقم الموظف في التقرير يطابق
                «رقم جسر» لموظف أجير واحد والاسمان متقاربان — لا يُنشأ (يظهر
                مرّة واحدة كأجير). تقرير قائمة الموظفين يُصدَّر من جسر، فرقمه
                الوظيفي هو رقم جسر نفسه الذي يربط به النظام كشوف الرواتب.
     review     ملتبس — لا يُكتب شيء حتى يُحسم بـ--assign
     invalid    ناقص الاسم أو الرقم */
function classifyImport(rows, { ajeer = [], existing = [], assign = {}, jisrMatch = true } = {}) {
  const ajeerById = new Map(), ajeerByName = new Map(), ajeerByJisr = new Map();
  for (const a of ajeer) {
    const j = normalizeJisr(a.jisr);
    if (j) ajeerByJisr.set(j, [...(ajeerByJisr.get(j) || []), a]);
    const id = normalizeIdentity(a.identity);
    if (id) ajeerById.set(id, [...(ajeerById.get(id) || []), a]);
    const n = normalizeName(a.name);
    if (n) ajeerByName.set(n, [...(ajeerByName.get(n) || []), a]);
  }
  const exById = new Map(), exByNo = new Map();
  for (const e of existing) {
    if (e.identity) exById.set(normalizeIdentity(e.identity), e);
    if (e.employeeNumber) exByNo.set(String(e.employeeNumber).trim(), e);
  }
  /* التكرار داخل الملف نفسه: رقم أو هوية يتكرّران = التباس للطرفين. */
  const seenNo = new Map(), seenId = new Map();
  for (const r of rows) {
    const no = clean(r.number), id = normalizeIdentity(r.identity);
    if (no) seenNo.set(no, (seenNo.get(no) || 0) + 1);
    if (id) seenId.set(id, (seenId.get(id) || 0) + 1);
  }

  return rows.map((r) => {
    const rec = {
      row: r.row, number: clean(r.number), name: clean(r.name), job: clean(r.job),
      department: clean(r.department), identity: normalizeIdentity(r.identity),
    };
    const out = (status, reason, extra) => ({ ...rec, status, reason, ...(extra || {}) });
    if (!rec.name || !rec.number) return out("invalid", "الاسم أو رقم الموظف ناقص");
    if (seenNo.get(rec.number) > 1) return out("review", "رقم الموظف مكرّر داخل التقرير");
    if (rec.identity && seenId.get(rec.identity) > 1) return out("review", "الهوية مكرّرة داخل التقرير");

    const forced = assign[rec.number];
    if (forced === "skip") return out("skip", "تجاوز بقرار المراجعة");
    if (forced && forced.startsWith("ajeer:")) return out("ajeer", "ربط بقرار المراجعة", { ajeerEid: forced.slice(6) });

    /* موجود مسبقًا في الدليل (إعادة استيراد): لا صفّ ثانٍ أبدًا. */
    const exI = rec.identity ? exById.get(rec.identity) : null;
    const exN = exByNo.get(rec.number);
    if (exI && exN && exI.id !== exN.id) return out("review", "الهوية ورقم الموظف يشيران إلى صفّين مختلفين في الدليل");
    const ex = exI || exN;
    if (ex) {
      const same = ex.name === rec.name && (ex.job || null) === rec.job && (ex.department || null) === rec.department
        && (!rec.identity || rec.identity === normalizeIdentity(ex.identity));
      return out(same ? "unchanged" : "update", same ? "موجود ومطابق" : "موجود — تُحدَّث بياناته", { staffId: ex.id });
    }

    if (forced === "new") return out("new", "إنشاء بقرار المراجعة");

    if (rec.identity) {
      const hits = ajeerById.get(rec.identity) || [];
      if (hits.length === 1) return out("ajeer", "الهوية تطابق موظف أجير — يظهر مرّة واحدة كأجير", { ajeerEid: String(hits[0].eid) });
      if (hits.length > 1) return out("review", "الهوية تطابق أكثر من موظف أجير");
    }
    /* رقم جسر: مفتاح قويّ، مع حارس تقارب الاسم — تطابق رقم باسم بعيد التباسٌ. */
    if (jisrMatch) {
      const hits = ajeerByJisr.get(normalizeJisr(rec.number)) || [];
      if (hits.length > 1) return out("review", "رقم الموظف يطابق «رقم جسر» لأكثر من موظف أجير", { candidates: hits.map((a) => String(a.eid)) });
      if (hits.length === 1) {
        const sim = nameSimilarity(rec.name, hits[0].name);
        const extra = { ajeerEid: String(hits[0].eid), ajeerName: hits[0].name, similarity: Math.round(sim * 100) / 100 };
        if (sim >= SIMILAR_NAME) {
          return out("ajeer", normalizeName(rec.name) === normalizeName(hits[0].name)
            ? "رقم جسر يطابق موظف أجير والاسم مطابق — يظهر مرّة واحدة كأجير"
            : "رقم جسر يطابق موظف أجير والاسم متقارب (اختلاف إملاء) — يظهر مرّة واحدة كأجير", extra);
        }
        return out("review", "رقم الموظف يطابق «رقم جسر» لموظف أجير لكن الاسم مختلف", { ...extra, candidates: [extra.ajeerEid] });
      }
    }
    if (rec.identity) return out("new", "جديد");
    /* بلا هوية: الاسم وحده لا يقرّر — تطابقه مع أجير التباسٌ يُراجَع. */
    const byName = ajeerByName.get(normalizeName(rec.name)) || [];
    if (byName.length) return out("review", "بلا هوية والاسم يطابق موظف أجير — يحتاج تأكيدًا", { candidates: byName.map((a) => String(a.eid)) });
    return out("new", "جديد (بلا هوية)");
  });
}

function mask(v) {
  const s = String(v || "");
  return s.length <= 4 ? s : "•".repeat(Math.min(6, s.length - 4)) + s.slice(-4);
}

module.exports = { SOURCES, SIMILAR_NAME, normalizeIdentity, normalizeJisr, normalizeName, nameSimilarity, listPeople, resolvePerson, classifyImport, mask };
