const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { withMedins, sha256 } = require("./helpers/medins-harness");
const { makePsqlSql } = require("./helpers/psql-sql");

/* ─── تكامل كامل على Postgres حقيقيّ ───────────────────────────────────
   =========================================================================
   يُفعَّل بـ MEDINS_TEST_PG_URL: قاعدة اختبار محلّية مؤقّتة **تُمحى جداول
   medins_* فيها في كل تشغيل** — لا تُوجَّه إلى أي قاعدة فيها بيانات.
   وبدونه يُتخطّى الملفّ كلّه (الاختبارات بالمُزيَّف في medins-gate و
   medins-authz تبقى تعمل).

   ما يمتحنه هذا الملفّ ولا يمتحنه مُزيَّف: قيود القاعدة نفسها، ونصوص SQL
   كما تُنفَّذ فعلًا، ودورة الرفع والتنزيل المشفَّرة كاملةً عبر api/app.js. */

const URL = process.env.MEDINS_TEST_PG_URL;
const SKIP = URL ? false : "MEDINS_TEST_PG_URL غير مضبوط — تكامل Postgres متخطّى";

async function freshSchema(sql) {
  const teardown = require("../scripts/teardown-medins");
  const { run } = require("../scripts/lib/medins-migrate");
  await run(sql, teardown.STATEMENTS);
  await run(sql, require("../scripts/setup-medins-gate").STATEMENTS);
  await run(sql, require("../scripts/setup-medins-core").STATEMENTS);
  /* جدول users أدنى لعرض الأسماء في سجلّ التدقيق (قاعدة الاختبار فقط). */
  await sql.query("CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, name text)");
}

async function setup(env, sql) {
  await freshSchema(sql);
  const { IDS, hashes, USERS } = env;
  for (const [id, role] of [[IDS.editor, "editor"], [IDS.viewer, "viewer"]]) {
    await sql`INSERT INTO medins_members (user_id, email, role, gate_password_hash, password_set_at, granted_by)
      VALUES (${id}, ${USERS[id].email}, ${role}, ${hashes[role]}, now(), 'test')`;
    await sql`INSERT INTO users (id, name) VALUES (${id}, ${USERS[id].name}) ON CONFLICT DO NOTHING`;
  }
  const e = env.client(IDS.editor);
  const v = env.client(IDS.viewer);
  assert.equal((await e.call("POST", "gate/unlock", { body: { password: env.PASSWORDS.editor } })).statusCode, 200);
  assert.equal((await v.call("POST", "gate/unlock", { body: { password: env.PASSWORDS.viewer } })).statusCode, 200);
  return { e, v };
}

const ok = (out, status = 200) => {
  assert.equal(out.statusCode, status, JSON.stringify(out.body));
  return out.body;
};

test("تكامل: الهجرة مكرّرة لا تفعل شيئًا، والجداول والفهارس كاملة", { skip: SKIP }, async () => {
  const sql = makePsqlSql(URL);
  await freshSchema(sql);
  const { run } = require("../scripts/lib/medins-migrate");
  await run(sql, require("../scripts/setup-medins-gate").STATEMENTS);
  await run(sql, require("../scripts/setup-medins-core").STATEMENTS);
  const want = require("../scripts/verify-medins-schema").expected();
  const tables = (await sql`SELECT tablename FROM pg_tables WHERE tablename LIKE 'medins%'`).map((r) => r.tablename);
  const indexes = (await sql`SELECT indexname FROM pg_indexes WHERE tablename LIKE 'medins%'`).map((r) => r.indexname);
  for (const t of want.tables) assert.ok(tables.includes(t), t);
  for (const i of want.indexes) assert.ok(indexes.includes(i), i);
  assert.equal(want.tables.length, 13);
});

test("تكامل: القاعدة نفسها ترفض «الصفر الخفيّ» وتفرض بقيّة القيود", { skip: SKIP }, async () => {
  const sql = makePsqlSql(URL);
  await freshSchema(sql);
  const ins = crypto.randomUUID(), off = crypto.randomUUID(), cls = crypto.randomUUID(), other = crypto.randomUUID();
  await sql`INSERT INTO medins_insurers (id, name_ar, created_by) VALUES (${ins}::uuid, 'ش', 't')`;
  await sql`INSERT INTO medins_offers (id, insurer_id, title, created_by, headcount, total_premium) VALUES (${off}::uuid, ${ins}::uuid, 'ع', 't', 4, 1000)`;
  await sql`INSERT INTO medins_offers (id, insurer_id, title, created_by) VALUES (${other}::uuid, ${ins}::uuid, 'ع2', 't')`;
  await sql`INSERT INTO medins_offer_classes (id, offer_id, class_code) VALUES (${cls}::uuid, ${off}::uuid, 'A')`;
  await sql`INSERT INTO medins_benefit_catalog (code, label_ar, category, value_type, better, created_by) VALUES ('dental_limit', 'أسنان', 'dental', 'amount', 'higher', 't')`;
  const per = await sql`SELECT premium_per_head FROM medins_offers WHERE id = ${off}::uuid`;
  assert.equal(Number(per[0].premium_per_head), 250);

  const reject = async (p, code) => {
    await assert.rejects(Promise.resolve(p), (err) => err.code === code, `توقّعتُ ${code}`);
  };
  /* unknown بقيمة مخفيّة */
  await reject(sql`INSERT INTO medins_class_benefits (class_id, benefit_code, value_status, amount_value, updated_by)
    VALUES (${cls}::uuid, 'dental_limit', 'unknown', 0, 't')`, "23514");
  /* known بلا قيمة */
  await reject(sql`INSERT INTO medins_class_benefits (class_id, benefit_code, value_status, updated_by)
    VALUES (${cls}::uuid, 'dental_limit', 'known', 't')`, "23514");
  /* known بقيمتين */
  await reject(sql`INSERT INTO medins_class_benefits (class_id, benefit_code, value_status, amount_value, bool_value, updated_by)
    VALUES (${cls}::uuid, 'dental_limit', 'known', 1, true, 't')`, "23514");
  /* الصفر المعروف مقبول */
  await sql`INSERT INTO medins_class_benefits (class_id, benefit_code, value_status, amount_value, updated_by)
    VALUES (${cls}::uuid, 'dental_limit', 'known', 0, 't')`;
  /* شرطٌ بفئةٍ من عرضٍ آخر — المفتاح المركّب */
  await reject(sql`INSERT INTO medins_offer_terms (id, offer_id, class_id, kind, body, created_by)
    VALUES (${crypto.randomUUID()}::uuid, ${other}::uuid, ${cls}::uuid, 'condition', 'x', 't')`, "23503");
  /* خطورة لغير الاستثناء */
  await reject(sql`INSERT INTO medins_offer_terms (id, offer_id, kind, body, severity, created_by)
    VALUES (${crypto.randomUUID()}::uuid, ${off}::uuid, 'extra', 'x', 2, 't')`, "23514");
  /* اسم ملفّ بشرطة عكسية — chr(92) يعمل والاسم السليم يمرّ */
  const fileRow = (name) => sql`INSERT INTO medins_files (id, offer_id, kind, file_name, format, content_type, size_bytes, part_count,
    plaintext_sha256, status, enc_algo, enc_key_id, created_by, upload_expires_at)
    VALUES (${crypto.randomUUID()}::uuid, ${off}::uuid, 'quote', ${name}, 'pdf', 'application/pdf', 10, 1,
    ${crypto.randomBytes(32).toString("hex")}, 'uploading', 'aes-256-gcm', 'k1', 't', now())`;
  await reject(fileRow("a\\b.pdf"), "23514");
  await reject(fileRow("a/b.pdf"), "23514");
  await reject(fileRow("a\nb.pdf"), "23514");
  await fileRow("عرض بوبا 2026.pdf");
  /* موقعان افتراضيّان */
  await sql`INSERT INTO medins_company_locations (id, label, latitude, longitude, is_default, created_by) VALUES (${crypto.randomUUID()}::uuid, 'أ', 24.7, 46.6, true, 't')`;
  await reject(sql`INSERT INTO medins_company_locations (id, label, latitude, longitude, is_default, created_by) VALUES (${crypto.randomUUID()}::uuid, 'ب', 24.7, 46.6, true, 't')`, "23505");
  await reject(sql`INSERT INTO medins_company_locations (id, label, latitude, longitude, is_default, active, created_by) VALUES (${crypto.randomUUID()}::uuid, 'ج', 24.7, 46.6, false, false, 't'), (${crypto.randomUUID()}::uuid, 'د', 91, 46.6, false, true, 't')`, "23514");
  /* عضو بدور مجهول، وكلمة بلا تاريخ */
  await reject(sql`INSERT INTO medins_members (user_id, email, role, granted_by) VALUES ('u1', 'a@b.c', 'owner', 't')`, "23514");
  const hashOnly = `scrypt$17$8$1$00112233445566778899aabbccddeeff$${"ab".repeat(32)}`;
  await reject(sql`INSERT INTO medins_members (user_id, email, role, gate_password_hash, granted_by) VALUES ('u2', 'a@b.c', 'viewer', ${hashOnly}, 't')`, "23514");
  await reject(sql`INSERT INTO medins_members (user_id, email, role, granted_by) VALUES ('u3', 'A@B.c', 'viewer', 't')`, "23514");
});

test("تكامل: دورة العرض كاملة عبر الموجّه — CRUD، والصلاحيات، والحالات", { skip: SKIP }, async () => {
  const sql = makePsqlSql(URL);
  await withMedins(async (env) => {
    const { e, v } = await setup(env, sql);

    const ins = ok(await e.call("POST", "insurers", { body: { nameAr: "بوبا العربية", nameEn: "Bupa Arabia" } }), 201).insurer;
    assert.equal(ok(await e.call("POST", "insurers", { body: { nameAr: "  بوبا العربية " } }), 409).ok, false);

    /* حقلٌ ممنوع بالاسم، وحقلٌ مجهول، وتاريخان متعاكسان */
    assert.match((await e.call("POST", "offers", { body: { insurerId: ins.id, title: "x", premiumPerHead: 1 } })).body.error, /premiumPerHead/);
    assert.match((await e.call("POST", "offers", { body: { insurerId: ins.id, title: "x", foo: 1 } })).body.error, /foo/);
    assert.equal((await e.call("POST", "offers", { body: { insurerId: ins.id, title: "x", submittedOn: "2026-05-01", validUntil: "2026-04-01" } })).statusCode, 400);
    assert.equal((await e.call("POST", "offers", { body: { insurerId: ins.id, title: "x", submittedOn: "2026-02-30" } })).statusCode, 400);

    const offer = ok(await e.call("POST", "offers", { body: {
      insurerId: ins.id, title: "عرض 2027", reference: "Q-1", headcount: 40, totalPremium: "480000", vatStatus: "excluded",
      submittedOn: "2026-10-01", validUntil: "2026-12-31", policyMonths: 12,
    } }), 201).offer;
    assert.equal(offer.premiumPerHead, 12000);
    assert.equal(offer.submittedOn, "2026-10-01");
    assert.equal(offer.dependentsCount, null, "الفارغ صار صفرًا");
    assert.equal((await e.call("POST", "offers", { body: { insurerId: ins.id, title: "مكرّر", reference: "q-1" } })).statusCode, 409);

    /* المشاهد يقرأ ولا يكتب */
    assert.equal(ok(await v.call("GET", "offers")).offers.length, 1);
    assert.equal((await v.call("PUT", `offers/${offer.id}`, { body: { title: "x" } })).statusCode, 403);

    /* التعديل الجزئيّ لا يمسح ما لم يُرسل، والإفراغ الصريح يعيد «غير معروف» لا صفرًا */
    const upd = ok(await e.call("PUT", `offers/${offer.id}`, { body: { notes: "سعرٌ قابل للتفاوض", dependentsCount: 0 } })).offer;
    assert.deepEqual([upd.headcount, upd.totalPremium, upd.dependentsCount, upd.notes], [40, 480000, 0, "سعرٌ قابل للتفاوض"]);
    const cleared = ok(await e.call("PUT", `offers/${offer.id}`, { body: { dependentsCount: "" } })).offer;
    assert.equal(cleared.dependentsCount, null);

    const clsA = ok(await e.call("POST", `offers/${offer.id}/classes`, { body: { classCode: "A", memberCount: 30, classPremium: "390000" } }), 201).class;
    const clsB = ok(await e.call("POST", `offers/${offer.id}/classes`, { body: { classCode: "B", memberCount: 10 } }), 201).class;
    assert.equal((await e.call("POST", `offers/${offer.id}/classes`, { body: { classCode: "A" } })).statusCode, 409);
    assert.equal((await e.call("POST", `offers/${offer.id}/classes`, { body: { classCode: "فئة" } })).statusCode, 400);

    /* الكتالوج بيانات: بنودٌ تُضاف من الواجهة بلا هجرة */
    for (const item of [
      { code: "annual_limit", labelAr: "الحد السنوي", category: "limits", valueType: "amount", unit: "SAR", better: "higher" },
      { code: "op_copay_pct", labelAr: "نسبة التحمّل", category: "cost_sharing", valueType: "percent", unit: "percent", better: "lower" },
      { code: "dental_covered", labelAr: "الأسنان", category: "dental", valueType: "boolean", better: "higher" },
      { code: "room_type", labelAr: "الغرفة", category: "inpatient", valueType: "text", better: "none" },
      { code: "physio_sessions", labelAr: "علاج طبيعي", category: "therapy", valueType: "count", unit: "session", better: "higher" },
    ]) ok(await e.call("POST", "catalog", { body: item }), 201);
    assert.equal((await e.call("POST", "catalog", { body: { code: "Bad Code", labelAr: "x", category: "other", valueType: "text", better: "none" } })).statusCode, 400);
    assert.equal((await e.call("POST", "catalog", { body: { code: "x_amount", labelAr: "x", category: "other", valueType: "amount", unit: "percent", better: "none" } })).statusCode, 400);

    /* القيم: known / unknown / not_applicable */
    const save = (classId, values) => e.call("PUT", `classes/${classId}/benefits`, { body: { values } });
    assert.match((await save(clsA.id, [{ code: "annual_limit", status: "unknown", value: 0 }])).body.error, /لا تُرسل قيمة/);
    assert.match((await save(clsA.id, [{ code: "annual_limit", status: "known" }])).body.error, /تحتاج قيمة/);
    assert.equal((await save(clsA.id, [{ code: "op_copay_pct", status: "known", value: 120 }])).statusCode, 400);
    assert.equal((await save(clsA.id, [{ code: "dental_covered", status: "known", value: "نعم" }])).statusCode, 400);
    assert.equal((await save(clsA.id, [{ code: "physio_sessions", status: "known", value: 2.5 }])).statusCode, 400);
    assert.equal((await save(clsA.id, [{ code: "nope", status: "unknown" }])).statusCode, 400);
    assert.equal((await save(clsA.id, [{ code: "room_type", status: "unknown" }, { code: "room_type", status: "unknown" }])).statusCode, 400);

    const saved = ok(await save(clsA.id, [
      { code: "annual_limit", status: "known", value: "500000" },
      { code: "op_copay_pct", status: "known", value: 0 },
      { code: "dental_covered", status: "known", value: false },
      { code: "room_type", status: "not_applicable" },
      { code: "physio_sessions", status: "unknown", note: "غير مذكور في العرض" },
    ]));
    assert.equal(saved.saved, 5);
    assert.equal(ok(await save(clsA.id, [{ code: "annual_limit", status: "known", value: "500000.00" }])).saved, 0, "قيمة مطابقة عُدّت تغييرًا");

    const detail = ok(await v.call("GET", `offers/${offer.id}`));
    const byCode = Object.fromEntries(detail.values.filter((x) => x.classId === clsA.id).map((x) => [x.code, x]));
    assert.deepEqual([byCode.op_copay_pct.status, byCode.op_copay_pct.value], ["known", 0], "الصفر المعروف ضاع");
    assert.equal(byCode.dental_covered.value, false);
    assert.deepEqual([byCode.room_type.status, byCode.room_type.value], ["not_applicable", null]);
    assert.deepEqual([byCode.physio_sessions.status, byCode.physio_sessions.value], ["unknown", null]);
    assert.equal(detail.values.filter((x) => x.classId === clsB.id).length, 0, "قيمٌ اختُرعت لفئة لم تُدخل");

    /* الاعتماد ثم التعديل يعيده إلى المراجعة */
    ok(await e.call("POST", `classes/${clsA.id}/benefits/verify`, { body: { codes: ["annual_limit", "op_copay_pct"] } }));
    ok(await e.call("POST", `offers/${offer.id}/status`, { body: { to: "in_review" } }));
    assert.equal((await e.call("POST", `offers/${offer.id}/status`, { body: { to: "draft" } })).statusCode, 200);
    assert.equal((await e.call("POST", `offers/${offer.id}/status`, { body: { to: "approved" } })).statusCode, 409, "draft → approved مباشرةً");
    ok(await e.call("POST", `offers/${offer.id}/status`, { body: { to: "in_review" } }));
    assert.equal(ok(await e.call("POST", `offers/${offer.id}/status`, { body: { to: "approved" } })).offer.status, "approved");
    ok(await save(clsA.id, [{ code: "annual_limit", status: "known", value: "750000" }]));
    const after = ok(await v.call("GET", `offers/${offer.id}`));
    assert.equal(after.offer.status, "in_review", "تعديلٌ على معتمد أبقاه معتمدًا");
    const al = after.values.find((x) => x.classId === clsA.id && x.code === "annual_limit");
    assert.equal(al.verified, false, "القيمة المعدّلة احتفظت باعتمادها");
    assert.equal(after.values.find((x) => x.classId === clsA.id && x.code === "op_copay_pct").verified, true, "قيمةٌ لم تتغيّر فقدت اعتمادها");

    /* الشروط: فئةٌ من عرضٍ آخر مرفوضة */
    const offer2 = ok(await e.call("POST", "offers", { body: { insurerId: ins.id, title: "عرض آخر" } }), 201).offer;
    const term = ok(await e.call("POST", `offers/${offer.id}/terms`, { body: { kind: "exclusion", body: "علاج العقم", severity: 2, classId: clsA.id } }), 201).term;
    assert.equal(term.severity, 2);
    assert.equal((await e.call("POST", `offers/${offer2.id}/terms`, { body: { kind: "condition", body: "x", classId: clsA.id } })).statusCode, 400);
    assert.equal((await e.call("POST", `offers/${offer.id}/terms`, { body: { kind: "extra", body: "x", severity: 1 } })).statusCode, 400);

    /* الأرشفة تمنع التعديل حتى الإعادة */
    ok(await e.call("POST", `offers/${offer2.id}/status`, { body: { to: "archived" } }));
    assert.equal((await e.call("PUT", `offers/${offer2.id}`, { body: { title: "y" } })).statusCode, 409);
    assert.equal(ok(await e.call("GET", "offers")).offers.length, 1);
    assert.equal(ok(await e.call("GET", "offers?archived=1")).offers.length, 2);
    ok(await e.call("POST", `offers/${offer2.id}/status`, { body: { to: "draft" } }));
    ok(await e.call("DELETE", `offers/${offer2.id}`));
    assert.equal((await e.call("DELETE", `offers/${offer.id}`)).statusCode, 409, "حُذف عرضٌ غير مسودّة");

    /* سجلّ التدقيق: للمحرّر وحده، وبلا مبالغ ولا نصوص */
    assert.equal((await v.call("GET", "audit")).statusCode, 403);
    const events = ok(await e.call("GET", "audit?limit=100")).events;
    const names = new Set(events.map((x) => x.event));
    for (const ev of ["gate_unlock_success", "insurer_created", "offer_created", "offer_updated", "offer_deleted",
      "offer_status_changed", "class_created", "catalog_item_created", "benefit_value_changed", "benefit_values_verified",
      "term_created", "forbidden_action"]) assert.ok(names.has(ev), `لا حدث ${ev}`);
    const dump = JSON.stringify(events.map((x) => x.meta));
    for (const secret of ["480000", "500000", "750000", "علاج العقم", "بوبا", "عرض 2027", "Q-1"]) assert.ok(!dump.includes(secret), `«${secret}» في التدقيق`);
    const change = events.find((x) => x.event === "benefit_value_changed" && x.meta.code === "physio_sessions");
    assert.deepEqual([change.meta.fromStatus, change.meta.toStatus], ["missing", "unknown"]);
    assert.ok(events.some((x) => x.event === "offer_status_changed" && x.meta.reason === "edited_after_approval"));
  }, { sql });
});

test("تكامل: مواقع الشركة — افتراضيّ واحد في كل لحظة، والتعطيل يُسقط الافتراض", { skip: SKIP }, async () => {
  const sql = makePsqlSql(URL);
  await withMedins(async (env) => {
    const { e, v } = await setup(env, sql);
    assert.equal((await e.call("POST", "locations", { body: { label: "خطأ", latitude: "95", longitude: "46" } })).statusCode, 400);
    const a = ok(await e.call("POST", "locations", { body: { label: "المقر", latitude: "24.713552", longitude: "46.675297", isDefault: true } }), 201).location;
    const b = ok(await e.call("POST", "locations", { body: { label: "فرع", latitude: 24.8, longitude: 46.7, isDefault: true } }), 201).location;
    let list = ok(await v.call("GET", "locations")).locations;
    assert.deepEqual(list.filter((l) => l.isDefault).map((l) => l.id), [b.id]);
    assert.equal(list.find((l) => l.id === a.id).latitude, 24.713552);
    ok(await e.call("POST", `locations/${a.id}/default`, {}));
    list = ok(await v.call("GET", "locations")).locations;
    assert.deepEqual(list.filter((l) => l.isDefault).map((l) => l.id), [a.id]);
    ok(await e.call("PUT", `locations/${a.id}`, { body: { active: false } }));
    list = ok(await v.call("GET", "locations")).locations;
    assert.equal(list.filter((l) => l.isDefault).length, 0);
    assert.equal((await e.call("POST", `locations/${a.id}/default`, {})).statusCode, 409);
    assert.equal((await v.call("POST", "locations", { body: { label: "x", latitude: 1, longitude: 1 } })).statusCode, 403);
    const events = ok(await e.call("GET", "audit")).events;
    assert.ok(events.filter((x) => /^location_/.test(x.event)).length >= 4);
  }, { sql });
});

/* ─── الملفّات ─── */

function fakePdf(bytes) {
  const body = Buffer.alloc(bytes);
  crypto.randomFillSync(body);
  Buffer.from("%PDF-1.7\n").copy(body, 0);
  return body;
}
const PART = 2.5 * 1024 * 1024;

async function uploadAll(c, offerId, buf, { fileName = "عرض.pdf", format = "pdf", kind = "quote", sha = sha256(buf) } = {}) {
  const init = await c.call("POST", "files/init", { body: { offerId, kind, fileName, format, sizeBytes: buf.length, sha256: sha } });
  if (init.statusCode !== 201) return { init };
  const { fileId, partCount } = init.body;
  for (let i = 0; i < partCount; i += 1) {
    const part = buf.subarray(i * PART, Math.min(buf.length, (i + 1) * PART));
    const out = await c.call("POST", `files/${fileId}/parts/${i}`, { body: { data: part.toString("base64") } });
    if (out.statusCode !== 200) return { init, part: out };
  }
  return { init, fileId, complete: await c.call("POST", `files/${fileId}/complete`, { body: {} }) };
}

test("تكامل: رفعٌ مُجزَّأ مشفَّر، وتنزيلٌ بالأجزاء يُدقَّق كل جزء منه", { skip: SKIP }, async () => {
  const sql = makePsqlSql(URL);
  await withMedins(async (env) => {
    const { e, v } = await setup(env, sql);
    const ins = ok(await e.call("POST", "insurers", { body: { nameAr: "التعاونية" } }), 201).insurer;
    const offer = ok(await e.call("POST", "offers", { body: { insurerId: ins.id, title: "عرض" } }), 201).offer;
    const pdf = fakePdf(Math.floor(5.6 * 1024 * 1024));

    const up = await uploadAll(e, offer.id, pdf);
    assert.equal(up.init.body.partCount, 3);
    const file = ok(up.complete).file;
    assert.equal(file.status, "ready");
    assert.equal(file.sizeBytes, pdf.length);

    /* المتجر: خاصّ، شيفرةٌ لا تعلن نوعها، مسارٌ عشوائيّ بلا اسم */
    const puts = env.blob.calls.filter((c) => c.op === "put");
    assert.equal(puts.length, 3);
    for (const p of puts) {
      assert.equal(p.opts.access, "private");
      assert.equal(p.opts.contentType, "application/octet-stream");
      assert.equal(p.opts.token, "vercel_blob_rw_SYNTHETIC_MEDINS");
      assert.match(p.pathname, new RegExp(`^medins/${offer.id}/[0-9a-f]{32}$`));
      assert.ok(!env.blob.objects.get(p.pathname).includes(Buffer.from("%PDF-")), "نصٌّ صريح في المتجر");
    }
    /* لا مسار ولا IV ولا وسم في أيّ ردّ */
    const detail = ok(await v.call("GET", `offers/${offer.id}`));
    assert.doesNotMatch(JSON.stringify(detail), /medins\/|enc_|encIv|blob/i);

    /* التكرار: الملفّ نفسه للعرض نفسه */
    const dup = await e.call("POST", "files/init", { body: { offerId: offer.id, kind: "quote", fileName: "copy.pdf", format: "pdf", sizeBytes: pdf.length, sha256: sha256(pdf) } });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.body.fileId, file.id);

    /* المشاهد ينزّل الأصل جزءًا جزءًا، وكل جزء يُدقَّق */
    const parts = [];
    for (let i = 0; i < 3; i += 1) {
      const out = await v.call("GET", `files/${file.id}/parts/${i}`);
      assert.equal(out.statusCode, 200);
      assert.equal(out.headers["content-type"], "application/octet-stream");
      assert.match(out.headers["content-disposition"], /^attachment/);
      assert.equal(out.headers["x-content-type-options"], "nosniff");
      parts.push(out.body);
    }
    assert.ok(Buffer.concat(parts).equals(pdf), "الملفّ المنزَّل يختلف عن الأصل");
    const events = ok(await e.call("GET", "audit?limit=100")).events;
    const downloads = events.filter((x) => x.event === "file_downloaded");
    assert.equal(downloads.length, 3);
    for (const d of downloads) {
      assert.equal(d.userId, env.IDS.viewer);
      assert.equal(d.meta.action, "download");
      assert.equal(d.meta.fileId, file.id);
      assert.equal(d.meta.offerId, offer.id);
      assert.ok(d.ts);
    }
    assert.ok(!JSON.stringify(events).includes("عرض.pdf"), "اسم الملفّ في التدقيق");

    /* تبديل جزأين في المتجر: الوسم يرفض قبل أن يخرج بايت */
    const rows = await sql`SELECT part_index, blob_pathname FROM medins_file_parts WHERE file_id = ${file.id}::uuid ORDER BY part_index`;
    const p0 = env.blob.objects.get(rows[0].blob_pathname);
    env.blob.objects.set(rows[0].blob_pathname, env.blob.objects.get(rows[1].blob_pathname));
    const swapped = await v.call("GET", `files/${file.id}/parts/0`);
    assert.equal(swapped.statusCode, 404);
    assert.ok(!Buffer.isBuffer(swapped.body));
    env.blob.objects.set(rows[0].blob_pathname, p0);

    /* الحذف: لا تنزيل بعده، والكائنات تُمحى، والإشارات تُفكّ */
    const cls = ok(await e.call("POST", `offers/${offer.id}/classes`, { body: { classCode: "A" } }), 201).class;
    ok(await e.call("POST", "catalog", { body: { code: "annual_limit", labelAr: "حد", category: "limits", valueType: "amount", unit: "SAR", better: "higher" } }), 201);
    ok(await e.call("PUT", `classes/${cls.id}/benefits`, { body: { values: [{ code: "annual_limit", status: "known", value: 1, sourceFileId: file.id, sourcePage: 3 }] } }));
    assert.equal((await v.call("DELETE", `files/${file.id}`)).statusCode, 403);
    ok(await e.call("DELETE", `files/${file.id}`));
    assert.equal((await v.call("GET", `files/${file.id}/parts/0`)).statusCode, 404);
    assert.equal(env.blob.objects.size, 0);
    const ref = ok(await v.call("GET", `offers/${offer.id}`)).values[0];
    assert.equal(ref.sourceFileId, null);
    /* عرضٌ مسودّة بقايا ملفّاته محذوفة يُحذف */
    assert.equal(ok(await e.call("DELETE", `offers/${offer.id}`)).deleted, true);
  }, { sql });
});

test("تكامل: الخادم لا يثق بشيء من العميل عن الملفّ", { skip: SKIP }, async () => {
  const sql = makePsqlSql(URL);
  await withMedins(async (env) => {
    const { e } = await setup(env, sql);
    const ins = ok(await e.call("POST", "insurers", { body: { nameAr: "ميدغلف" } }), 201).insurer;
    const offer = ok(await e.call("POST", "offers", { body: { insurerId: ins.id, title: "عرض" } }), 201).offer;
    const pdf = fakePdf(4000);

    /* امتدادٌ لا يطابق الصيغة، وصيغة غير مسموحة، وحجمٌ فوق الحدّ */
    const init = (b) => e.call("POST", "files/init", { body: { offerId: offer.id, kind: "quote", fileName: "x.pdf", format: "pdf", sizeBytes: 4000, sha256: sha256(pdf), ...b } });
    assert.equal((await init({ fileName: "x.xlsx" })).statusCode, 400);
    assert.equal((await init({ fileName: "x.exe", format: "exe" })).statusCode, 400);
    assert.equal((await init({ sizeBytes: 20 * 1024 * 1024 + 1 })).statusCode, 400);
    assert.equal((await init({ partCount: 1 })).statusCode, 400, "partCount قُبل من العميل");
    assert.equal((await init({ fileName: "../../etc/passwd.pdf" })).statusCode, 201, "المسار يُنقّى لا يُرفض");
    const stored = await sql`SELECT file_name FROM medins_files WHERE offer_id = ${offer.id}::uuid`;
    assert.ok(!stored[0].file_name.includes("/"));

    /* توقيعٌ مزيّف: «PDF» ببايتات ليست PDF */
    const notPdf = Buffer.from("MZ" + "x".repeat(100));
    const fake = await uploadAll(e, offer.id, notPdf, { fileName: "x.pdf" });
    assert.equal(fake.part.statusCode, 400);

    /* بصمةٌ معلنة كاذبة: يُرفض عند الإكمال 422 ويُطهَّر */
    const lie = await uploadAll(e, offer.id, fakePdf(3000), { sha: "0".repeat(64) });
    assert.equal(lie.complete.statusCode, 422);
    const row = await sql`SELECT status, purged_at FROM medins_files WHERE id = ${lie.fileId}::uuid`;
    assert.equal(row[0].status, "deleted");
    assert.ok(row[0].purged_at);

    /* جزءٌ بحجمٍ غير المتوقَّع */
    const pdf2 = fakePdf(5000);
    const i2 = ok(await e.call("POST", "files/init", { body: { offerId: offer.id, kind: "other", fileName: "y.pdf", format: "pdf", sizeBytes: 5000, sha256: sha256(pdf2) } }), 201);
    assert.equal((await e.call("POST", `files/${i2.fileId}/parts/0`, { body: { data: pdf2.subarray(0, 4000).toString("base64") } })).statusCode, 400);
    assert.equal((await e.call("POST", `files/${i2.fileId}/parts/1`, { body: { data: pdf2.toString("base64") } })).statusCode, 400);
    assert.equal((await e.call("POST", `files/${i2.fileId}/complete`, { body: {} })).statusCode, 409, "أُكمل رفعٌ بلا أجزاء");
    assert.equal((await e.call("POST", `files/${i2.fileId}/parts/0`, { body: { data: "@@@" } })).statusCode, 400);

    /* CSV: UTF-8 صارم */
    const badCsv = Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a]);
    const csv = await uploadAll(e, offer.id, badCsv, { fileName: "n.csv", format: "csv", kind: "other" });
    assert.equal(csv.complete.statusCode, 422);
    const goodCsv = Buffer.from("مستشفى,حي\nالحبيب,العليا\n", "utf8");
    assert.equal((await uploadAll(e, offer.id, goodCsv, { fileName: "n.csv", format: "csv", kind: "other" })).complete.statusCode, 200);

    const events = ok(await e.call("GET", "audit?limit=100")).events;
    assert.ok(events.some((x) => x.event === "file_upload_rejected" && x.meta.reason === "sha_mismatch"));
    assert.ok(events.some((x) => x.event === "file_upload_rejected" && x.meta.reason === "signature"));
    assert.ok(events.some((x) => x.event === "file_upload_completed"));
  }, { sql });
});
