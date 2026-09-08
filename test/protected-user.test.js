const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const { makeFakeSql } = require("./helpers/fake-sql");

/* ─── الحساب المحميّ ───────────────────────────────────────────────────
   =========================================================================
   ثلاث طبقات، ثلاث مجموعات اختبار:

     أ) القواعد   — lib/auth/protectedUsers.js وحده، بلا قاعدة ولا شبكة.
     ب) البيانات  — lib/auth/users.js: الضمان الفعلي. يقيس ما يخرج إلى
                    القاعدة لا ما تقوله الدالّة، فرفضٌ لا يمنع UPDATE ليس
                    رفضًا.
     ج) الموزّع   — api/app.js من طرف إلى طرف بجلسة موقّعة حقيقية: هذا ما
                    يواجهه مدير النظام فعلًا حين يحاول.

   لماذا الثلاث معًا: (أ) تُثبت المنطق، و(ب) تُثبت أنه يُفرض على كل مُنادٍ
   مهما كان، و(ج) تُثبت أن الطريق من الطلب إلى الرفض موصول بلا فجوة. */

const PROTECTED_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_ID = "99999999-8888-7777-6666-555555555555";
const ADMIN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OWNER2_ID = "0f0f0f0f-1111-2222-3333-444444444444";

/* قيم اختبار محضة — لا صلة لها بأي بيئة حقيقية. */
const TEST_SESSION_SECRET = "test-only-session-secret-not-a-real-value";
const CURRENT_PASSWORD = "current-test-password";
const NEW_PASSWORD = "new-test-password";

/* async عمدًا مع await على fn(): النسخة المتزامنة كانت تستعيد المتغيّر فور
   عودة fn() — أي قبل أن يبلغ جسمها أول await — فتُرفع الحماية في منتصف
   الاختبار وتمرّ حالاتٌ كان يجب أن تُرفض. اختبارٌ يكذب أخطرُ من اختبار
   ساقط، فالمغلّفان هنا ينتظران تمام العمل قبل الاستعادة. */
async function withProtected(ids, fn) {
  const before = process.env.PROTECTED_USER_IDS;
  if (ids === null) delete process.env.PROTECTED_USER_IDS;
  else process.env.PROTECTED_USER_IDS = ids;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.PROTECTED_USER_IDS;
    else process.env.PROTECTED_USER_IDS = before;
  }
}

/* ════════════ أ) القواعد ════════════ */

const rules = require("../lib/auth/protectedUsers");

test("غياب PROTECTED_USER_IDS لا يجعل أي حساب محميًا", async () => {
  await withProtected(null, () => {
    assert.equal(rules.isConfigured(), false);
    assert.equal(rules.isProtected(PROTECTED_ID), false);
    assert.equal(rules.guardUpdate(PROTECTED_ID, { email: "x@y.z" }), null);
    assert.equal(rules.guardDelete(PROTECTED_ID), null);
  });
});

test("إعداد فارغ أو فواصل بلا قيم لا يحمي أحدًا", async () => {
  for (const raw of ["", "   ", ",", " , , "]) {
    await withProtected(raw, () => {
      assert.equal(rules.isConfigured(), false, `«${raw}» يجب ألّا يحمي أحدًا`);
      assert.equal(rules.isProtected(PROTECTED_ID), false);
    });
  }
});

test("الحماية تقع على المعرّفات المذكورة وحدها", async () => {
  await withProtected(` ${PROTECTED_ID} , ${OWNER2_ID} `, () => {
    assert.equal(rules.isProtected(PROTECTED_ID), true);
    assert.equal(rules.isProtected(OWNER2_ID), true);
    assert.equal(rules.isProtected(OTHER_ID), false);
    /* قيم فارغة لا تطابق شيئًا ولو كان الإعداد يحوي فراغات */
    for (const v of [null, undefined, ""]) assert.equal(rules.isProtected(v), false);
  });
});

test("lastLogin مسموح دائمًا — بلا selfEdit وبلا أي شرط", () => {
  assert.equal(rules.refusalFor({ lastLogin: "2026-09-08T00:00:00Z" }), null);
});

test("الحقول المجمّدة مرفوضة حتى على صاحب الحساب نفسه", () => {
  for (const field of ["email", "role", "status", "permissions"]) {
    const refusal = rules.refusalFor({ [field]: "أي-قيمة" }, { selfEdit: true, currentPasswordVerified: true });
    assert.ok(refusal, `${field} يجب أن يُرفض`);
    assert.equal(refusal.reason, "frozen");
    assert.equal(refusal.field, field);
  }
});

test("name و jobTitle: لصاحب الحساب وحده", () => {
  for (const field of ["name", "jobTitle"]) {
    assert.equal(rules.refusalFor({ [field]: "قيمة" }, { selfEdit: true }), null);
    const refusal = rules.refusalFor({ [field]: "قيمة" }, {});
    assert.equal(refusal.reason, "not_self");
  }
});

test("passwordHash يتطلّب صاحب الحساب + التحقّق من كلمة المرور الحالية", () => {
  assert.equal(rules.refusalFor({ passwordHash: "h" }, {}).reason, "not_self");
  assert.equal(rules.refusalFor({ passwordHash: "h" }, { selfEdit: true }).reason, "password_unverified");
  assert.equal(
    rules.refusalFor({ passwordHash: "h" }, { selfEdit: true, currentPasswordVerified: true }),
    null
  );
  /* التحقّق وحده لا يكفي: يجب أن يكون هو صاحب الحساب أيضًا. */
  assert.equal(rules.refusalFor({ passwordHash: "h" }, { currentPasswordVerified: true }).reason, "not_self");
});

test("fail-closed: أي حقل جديد غير مصنَّف مرفوض افتراضيًا", () => {
  /* هذا هو الاختبار الذي يحمي التصميم من الانزلاق: حقل يُضاف إلى جدول
     المستخدمين بعد سنة يجب أن يكون ممنوعًا حتى يُصنَّف صراحةً — لا مسموحًا
     لأن أحدًا لم يتذكّر أن يمنعه. */
  for (const field of ["twoFactorSecret", "apiKey", "id", "createdAt", "أي-حقل-قادم"]) {
    const refusal = rules.refusalFor({ [field]: "v" }, { selfEdit: true, currentPasswordVerified: true });
    assert.ok(refusal, `${field} يجب أن يُرفض افتراضيًا`);
    assert.equal(refusal.reason, "unclassified");
  }
});

test("أول حقل مرفوض يُوقف الرقعة كلّها مهما كان ترتيبه", () => {
  const refusal = rules.refusalFor({ lastLogin: "t", name: "n", role: "owner" }, { selfEdit: true });
  assert.equal(refusal.field, "role");
});

/* ════════════ ب) طبقة البيانات ════════════ */

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DB_PATH = require.resolve("../lib/db");

/* يستبدل lib/db.js بقاعدة مُزيَّفة لأي مُنادٍ داخل المشروع، مهما كان شكل
   مسار الـrequire عنده (../db أو ../../db). الاعتراض بالمسار المحلول لا
   بنصّ الطلب، فلا يفلت مُنادٍ لأن مساره النسبي مختلف. */
async function withFakeDb(sql, fn) {
  const originalLoad = Module._load;
  const cleared = [];
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PROJECT_ROOT) && !key.includes("node_modules")) {
      cleared.push(key);
      delete require.cache[key];
    }
  }
  Module._load = function (request, parent, isMain) {
    if (parent) {
      try {
        if (Module._resolveFilename(request, parent, isMain) === DB_PATH) return { getSql: () => sql };
      } catch (err) {
        /* طلب لا يُحلّ — يمرّ إلى المُحمِّل الأصلي ليرمي خطأه المعتاد. */
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await fn();
  } finally {
    Module._load = originalLoad;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(PROJECT_ROOT) && !key.includes("node_modules")) delete require.cache[key];
    }
    void cleared;
  }
}

function userRow(o) {
  return {
    id: o.id,
    name: o.name || "حساب اختبار",
    email: o.email,
    password_hash: o.passwordHash || "scrypt:00:00",
    role: o.role || "viewer",
    status: o.status || "active",
    job_title: null,
    permissions: null,
    created_at: "2026-01-01",
    last_login: null,
  };
}

/* قاعدة فيها الحسابات الأربعة، تردّ على قراءة المستخدم وعلى الكتابة. */
function fakeUserDb(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return makeFakeSql((call) => {
    if (/SELECT \* FROM users WHERE id =/.test(call.text)) {
      const found = byId.get(call.values[0]);
      return found ? [found] : [];
    }
    if (/UPDATE users SET/.test(call.text)) {
      const found = byId.get(call.values[call.values.length - 1]);
      return found ? [found] : [];
    }
    if (/DELETE FROM users WHERE id =/.test(call.text)) return [{ id: call.values[0] }];
    if (/INSERT INTO audit_log/.test(call.text)) return [];
    return [];
  });
}

const PROTECTED_ROW = userRow({ id: PROTECTED_ID, email: "protected@example.test", role: "hr" });
const OTHER_ROW = userRow({ id: OTHER_ID, email: "other@example.test", role: "viewer" });

test("طبقة البيانات: updateUser على حساب محميّ يرمي ولا يُصدر UPDATE", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([PROTECTED_ROW, OTHER_ROW]);
    await withFakeDb(sql, async () => {
      const users = require("../lib/auth/users");
      for (const patch of [
        { passwordHash: "hash-جديد" },
        { email: "attacker@example.test" },
        { role: "owner" },
        { status: "disabled" },
        { permissions: ["users:manage"] },
        { name: "اسم من مدير النظام" },
      ]) {
        await assert.rejects(() => users.updateUser(PROTECTED_ID, patch), /محميّ|غير قابل للتعديل/);
      }
      assert.equal(sql.matching(/UPDATE users SET/).length, 0, "لا يجوز أن تصل عبارة UPDATE واحدة إلى القاعدة");
    });
  });
});

test("طبقة البيانات: deleteUser على حساب محميّ يرمي ولا يُصدر DELETE", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([PROTECTED_ROW]);
    await withFakeDb(sql, async () => {
      const users = require("../lib/auth/users");
      await assert.rejects(() => users.deleteUser(PROTECTED_ID), /محميّ/);
      assert.equal(sql.matching(/DELETE FROM users/).length, 0);
    });
  });
});

test("طبقة البيانات: touchLastLogin لا ينكسر على حساب محميّ", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([PROTECTED_ROW]);
    await withFakeDb(sql, async () => {
      const users = require("../lib/auth/users");
      const updated = await users.touchLastLogin(PROTECTED_ID);
      assert.equal(updated.id, PROTECTED_ID);
      assert.equal(sql.matching(/UPDATE users SET/).length, 1, "تسجيل الدخول يجب أن يكتب last_login كالمعتاد");
    });
  });
});

test("طبقة البيانات: التعديل الذاتي المصرّح به يمرّ ويكتب فعلًا", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([PROTECTED_ROW]);
    await withFakeDb(sql, async () => {
      const users = require("../lib/auth/users");
      await users.updateUser(PROTECTED_ID, { name: "اسمي الجديد" }, { selfEdit: true });
      await users.updateUser(PROTECTED_ID, { passwordHash: "h" }, { selfEdit: true, currentPasswordVerified: true });
      assert.equal(sql.matching(/UPDATE users SET/).length, 2);
    });
  });
});

test("طبقة البيانات: الحساب غير المحميّ سلوكه لم يتغيّر بحرف", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([PROTECTED_ROW, OTHER_ROW]);
    await withFakeDb(sql, async () => {
      const users = require("../lib/auth/users");
      /* بلا أي opts — نفس نداء الشيفرة القائمة حرفًا بحرف */
      await users.updateUser(OTHER_ID, { email: "new@example.test", role: "admin", passwordHash: "h" });
      await users.deleteUser(OTHER_ID);
      assert.equal(sql.matching(/UPDATE users SET/).length, 1);
      assert.equal(sql.matching(/DELETE FROM users/).length, 1);
    });
  });
});

/* ════════════ ج) الموزّع من طرف إلى طرف ════════════ */

function makeRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; },
    status(code) { out.statusCode = code; return res; },
    json(payload) { out.body = payload; return res; },
    writeHead(code, headers) { out.statusCode = code; Object.assign(out.headers, headers || {}); return res; },
    end(payload) { if (payload !== undefined) out.body = payload; return res; },
  };
  return { res, out };
}

/* طلب PUT/DELETE حقيقي على /api/data/users بجلسة موقَّعة بمفتاح الاختبار. */
async function callUsersApi({ sql, actorRow, method, body }) {
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  return withFakeDb(sql, async () => {
    const { issueSessionToken } = require("../lib/auth/tokens");
    const handler = require("../api/app");
    const token = issueSessionToken(
      { id: actorRow.id, email: actorRow.email, role: actorRow.role },
      false
    );
    const req = {
      method,
      query: { kind: "api", apiPath: "data/users" },
      headers: { cookie: `session=${encodeURIComponent(token)}` },
      body,
    };
    const { res, out } = makeRes();
    await handler(req, res);
    return out;
  });
}

function adminRow() { return userRow({ id: ADMIN_ID, email: "admin@example.test", role: "admin" }); }
function owner2Row() { return userRow({ id: OWNER2_ID, email: "owner2@example.test", role: "owner" }); }

/* الحساب المحميّ بكلمة مرور حقيقية قابلة للتحقّق.

   الدور معامل كي يُعزل أثر الحماية الجديدة عن قاعدة «لا يُدار المالك إلا
   بمالك» القائمة في lib/auth/roles.js. الحالة الافتراضية owner لأنها
   الأسوأ (حتى مالكٌ آخر يُردّ)، أمّا اختبار الانحدار — الذي يُثبت أن
   السلوك القائم لم يتغيّر — فيلزمه هدفٌ غير مالك، وإلّا ردّته تلك القاعدة
   القديمة فبدا الاختبار ناجحًا لسببٍ لا صلة له بما نقيس. */
function protectedRowWithPassword(role = "owner") {
  const { hashPassword } = require("../lib/auth/passwords");
  return userRow({
    id: PROTECTED_ID, email: "protected@example.test", role,
    passwordHash: hashPassword(CURRENT_PASSWORD),
  });
}

test("الموزّع: مدير النظام لا يستطيع تصفير كلمة مرور الحساب المحميّ", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const target = protectedRowWithPassword();
    const sql = fakeUserDb([adminRow(), target]);
    const out = await callUsersApi({
      sql, actorRow: adminRow(), method: "PUT",
      body: { id: PROTECTED_ID, password: NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 403);
    assert.match(out.body.error, /محميّ/);
    assert.equal(sql.matching(/UPDATE users SET/).length, 0);
  });
});

test("الموزّع: مالك آخر لا يستطيع تصفير كلمة مرور الحساب المحميّ", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const target = protectedRowWithPassword();
    const sql = fakeUserDb([owner2Row(), target]);
    const out = await callUsersApi({
      sql, actorRow: owner2Row(), method: "PUT",
      body: { id: PROTECTED_ID, password: NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 403);
    assert.equal(sql.matching(/UPDATE users SET/).length, 0);
  });
});

test("الموزّع: لا أحد يغيّر email أو role أو status أو permissions للحساب المحميّ", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const patches = [
      { email: "attacker@example.test" },
      { role: "viewer" },
      { status: "disabled" },
      { permissions: [] },
      { name: "اسم مفروض" },
    ];
    for (const actor of [adminRow(), owner2Row()]) {
      for (const patch of patches) {
        const sql = fakeUserDb([actor, protectedRowWithPassword()]);
        const out = await callUsersApi({
          sql, actorRow: actor, method: "PUT",
          body: { id: PROTECTED_ID, ...patch },
        });
        assert.equal(out.statusCode, 403, `${actor.role} + ${Object.keys(patch)[0]} يجب أن يُرفض`);
        assert.equal(sql.matching(/UPDATE users SET/).length, 0);
      }
    }
  });
});

test("الموزّع: مدير النظام لا يستطيع حذف الحساب المحميّ", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([adminRow(), protectedRowWithPassword()]);
    const out = await callUsersApi({
      sql, actorRow: adminRow(), method: "DELETE", body: { id: PROTECTED_ID },
    });
    assert.equal(out.statusCode, 403);
    assert.match(out.body.error, /محميّ/);
    assert.equal(sql.matching(/DELETE FROM users/).length, 0);
  });
});

test("الموزّع: صاحب الحساب يغيّر كلمة مروره بالقديمة الصحيحة", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const me = protectedRowWithPassword();
    const sql = fakeUserDb([me]);
    const out = await callUsersApi({
      sql, actorRow: me, method: "PUT",
      body: { id: PROTECTED_ID, password: NEW_PASSWORD, currentPassword: CURRENT_PASSWORD },
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(out.body.ok, true);
    assert.equal(sql.matching(/UPDATE users SET/).length, 1);
  });
});

test("الموزّع: القديمة الخاطئة أو الغائبة تُرفض بالرسالة نفسها", async () => {
  await withProtected(PROTECTED_ID, async () => {
    for (const body of [
      { id: PROTECTED_ID, password: NEW_PASSWORD, currentPassword: "كلمة-خاطئة" },
      { id: PROTECTED_ID, password: NEW_PASSWORD },
      { id: PROTECTED_ID, password: NEW_PASSWORD, currentPassword: "" },
    ]) {
      const me = protectedRowWithPassword();
      const sql = fakeUserDb([me]);
      const out = await callUsersApi({ sql, actorRow: me, method: "PUT", body });
      assert.equal(out.statusCode, 403);
      /* رسالة واحدة للحالتين: لا تُميّز «غائبة» من «خاطئة». */
      assert.equal(out.body.error, rules.MESSAGES.password_unverified);
      assert.equal(sql.matching(/UPDATE users SET/).length, 0);
    }
  });
});

test("الموزّع: صاحب الحساب المحميّ لا يغيّر بريده ولا دوره ولو بكلمة المرور الصحيحة", async () => {
  await withProtected(PROTECTED_ID, async () => {
    for (const patch of [{ email: "new@example.test" }, { role: "admin" }, { status: "disabled" }]) {
      const me = protectedRowWithPassword();
      const sql = fakeUserDb([me]);
      const out = await callUsersApi({
        sql, actorRow: me, method: "PUT",
        body: { id: PROTECTED_ID, currentPassword: CURRENT_PASSWORD, ...patch },
      });
      assert.equal(out.statusCode, 403, `${Object.keys(patch)[0]} يجب أن يُرفض`);
      assert.equal(sql.matching(/UPDATE users SET/).length, 0);
    }
  });
});

/* ── الانحدار: بلا الإعداد، لا شيء تغيّر في المنصّة ── */

test("الموزّع: بلا PROTECTED_USER_IDS يعمل تصفير كلمة المرور كما كان", async () => {
  await withProtected(null, async () => {
    /* نفس المعرّف تمامًا، لكن لا إعداد يحميه — ودورٌ عاديّ كي لا تتدخّل
       قاعدة حماية المالك القديمة فتعطي 403 لسبب آخر. */
    const target = protectedRowWithPassword("hr");
    const sql = fakeUserDb([adminRow(), target]);
    const out = await callUsersApi({
      sql, actorRow: adminRow(), method: "PUT",
      body: { id: PROTECTED_ID, password: NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(sql.matching(/UPDATE users SET/).length, 1, "السلوك القائم يجب أن يبقى كما هو تمامًا");
  });
});

test("الموزّع: تعديل حساب عاديّ يعمل كما كان رغم تفعيل الحماية على غيره", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([adminRow(), OTHER_ROW]);
    const out = await callUsersApi({
      sql, actorRow: adminRow(), method: "PUT",
      body: { id: OTHER_ID, name: "اسم محدَّث", password: NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(sql.matching(/UPDATE users SET/).length, 1);
  });
});

test("الموزّع: حذف حساب عاديّ يعمل كما كان", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const sql = fakeUserDb([adminRow(), OTHER_ROW]);
    const out = await callUsersApi({
      sql, actorRow: adminRow(), method: "DELETE", body: { id: OTHER_ID },
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(sql.matching(/DELETE FROM users/).length, 1);
  });
});

/* ════════════ د) مسار تغيير كلمة المرور الذاتي ════════════
   POST /api/auth/change-password

   ما يُثبَت هنا ليس «الفحوص تعمل» بل «الشكل نفسه لا يسمح»: الهدف يُشتقّ من
   الجلسة ولا يُقبل من العميل بحال، والجسم لا يقبل مفتاحًا واحدًا زائدًا،
   والمسار لا وجود له لغير الحساب المحميّ ولا حين يغيب الإعداد. */

const SECOND_PROTECTED_ID = "22222222-3333-4444-5555-666666666666";

async function callChangePassword({ sql, actorRow, body, method = "POST" }) {
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  return withFakeDb(sql, async () => {
    const { issueSessionToken } = require("../lib/auth/tokens");
    const handler = require("../api/app");
    const token = issueSessionToken({ id: actorRow.id, email: actorRow.email, role: actorRow.role }, false);
    const req = {
      method,
      query: { kind: "api", apiPath: "auth/change-password" },
      headers: { cookie: `session=${encodeURIComponent(token)}` },
      body,
    };
    const { res, out } = makeRes();
    await handler(req, res);
    return out;
  });
}

const VALID_NEW_PASSWORD = "a-sufficiently-long-new-password";

test("الذاتي: الحساب المحميّ يغيّر كلمة مروره بالقديمة الصحيحة", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const me = protectedRowWithPassword("hr"); // دورٌ لا يملك users:edit عمدًا
    const sql = fakeUserDb([me]);
    const out = await callChangePassword({
      sql, actorRow: me,
      body: { currentPassword: CURRENT_PASSWORD, newPassword: VALID_NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    assert.equal(out.body.ok, true);
    /* القيد مُصرَّح به في الردّ لا مسكوت عنه. */
    assert.equal(out.body.sessionsInvalidated, false);
    const updates = sql.matching(/UPDATE users SET/);
    assert.equal(updates.length, 1);
    /* الهدف هو صاحب الجلسة — آخر معامل في العبارة هو WHERE id. */
    assert.equal(updates[0].values[updates[0].values.length - 1], PROTECTED_ID);
  });
});

test("الذاتي: يعمل بلا صلاحية users:edit — القدرة شخصية لا إدارية", async () => {
  await withProtected(PROTECTED_ID, async () => {
    for (const role of ["viewer", "finance", "hr"]) {
      const me = protectedRowWithPassword(role);
      const sql = fakeUserDb([me]);
      const out = await callChangePassword({
        sql, actorRow: me,
        body: { currentPassword: CURRENT_PASSWORD, newPassword: VALID_NEW_PASSWORD },
      });
      assert.equal(out.statusCode, 200, `${role}: ${JSON.stringify(out.body)}`);
      assert.equal(sql.matching(/UPDATE users SET/).length, 1);
    }
  });
});

test("الذاتي: القديمة الخاطئة أو الغائبة تُرفض بالرسالة نفسها", async () => {
  await withProtected(PROTECTED_ID, async () => {
    for (const body of [
      { currentPassword: "كلمة-خاطئة", newPassword: VALID_NEW_PASSWORD },
      { newPassword: VALID_NEW_PASSWORD },
      { currentPassword: "", newPassword: VALID_NEW_PASSWORD },
    ]) {
      const me = protectedRowWithPassword("hr");
      const sql = fakeUserDb([me]);
      const out = await callChangePassword({ sql, actorRow: me, body });
      assert.equal(out.statusCode, 403);
      assert.equal(out.body.error, rules.MESSAGES.password_unverified);
      assert.equal(sql.matching(/UPDATE users SET/).length, 0);
    }
  });
});

test("الذاتي: المستخدم غير المحميّ لا يجد المسار أصلًا", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const other = userRow({ id: OTHER_ID, email: "other@example.test", role: "hr", passwordHash: require("../lib/auth/passwords").hashPassword(CURRENT_PASSWORD) });
    const sql = fakeUserDb([other]);
    const out = await callChangePassword({
      sql, actorRow: other,
      body: { currentPassword: CURRENT_PASSWORD, newPassword: VALID_NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 404, "لا 403 — المسار لا وجود له لغيره");
    assert.equal(out.body.error, "Not found");
    assert.equal(sql.matching(/UPDATE users SET/).length, 0);
  });
});

test("الذاتي: مدير النظام ومالك آخر لا يستطيعان استعماله نيابةً عنه", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const { hashPassword } = require("../lib/auth/passwords");
    const admin = userRow({ id: ADMIN_ID, email: "admin@example.test", role: "admin", passwordHash: hashPassword(CURRENT_PASSWORD) });
    const owner2 = userRow({ id: OWNER2_ID, email: "owner2@example.test", role: "owner", passwordHash: hashPassword(CURRENT_PASSWORD) });
    for (const actor of [admin, owner2]) {
      const sql = fakeUserDb([actor, protectedRowWithPassword("hr")]);
      /* حتى لو عرف كلمة مروره هو وحاول — المسار غير موجود له. */
      const out = await callChangePassword({
        sql, actorRow: actor,
        body: { currentPassword: CURRENT_PASSWORD, newPassword: VALID_NEW_PASSWORD },
      });
      assert.equal(out.statusCode, 404, `${actor.role} يجب ألّا يجد المسار`);
      assert.equal(sql.matching(/UPDATE users SET/).length, 0);
    }
  });
});

test("الذاتي: أي مفتاح زائد في الجسم يُرفض — ولا id يُقبل بحال", async () => {
  await withProtected(`${PROTECTED_ID},${SECOND_PROTECTED_ID}`, async () => {
    const extras = [
      { id: SECOND_PROTECTED_ID },
      { id: OTHER_ID },
      { email: "attacker@example.test" },
      { role: "owner" },
      { status: "disabled" },
      { permissions: ["users:manage"] },
      { name: "اسم" },
      { أي_حقل_قادم: 1 },
    ];
    for (const extra of extras) {
      const me = protectedRowWithPassword("hr");
      const sql = fakeUserDb([me]);
      const out = await callChangePassword({
        sql, actorRow: me,
        body: { currentPassword: CURRENT_PASSWORD, newPassword: VALID_NEW_PASSWORD, ...extra },
      });
      assert.equal(out.statusCode, 400, `${Object.keys(extra)[0]} يجب أن يُرفض`);
      assert.match(out.body.error, /كلمة المرور وحدها/);
      assert.equal(sql.matching(/UPDATE users SET/).length, 0, "لا كتابة عند الرفض");
    }
  });
});

test("الذاتي: حسابٌ محميّ لا يمسّ حسابًا محميًّا آخر", async () => {
  /* حسابان محميّان معًا: الأول يغيّر كلمة مروره، فيجب أن تقع الكتابة على
     معرّفه هو لا على الثاني — والهدف مشتقٌّ من الجلسة فلا سبيل إلى غير ذلك. */
  await withProtected(`${PROTECTED_ID},${SECOND_PROTECTED_ID}`, async () => {
    const me = protectedRowWithPassword("hr");
    const second = userRow({ id: SECOND_PROTECTED_ID, email: "second@example.test", role: "owner" });
    const sql = fakeUserDb([me, second]);
    const out = await callChangePassword({
      sql, actorRow: me,
      body: { currentPassword: CURRENT_PASSWORD, newPassword: VALID_NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 200, JSON.stringify(out.body));
    const updates = sql.matching(/UPDATE users SET/);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values[updates[0].values.length - 1], PROTECTED_ID);
    assert.notEqual(updates[0].values[updates[0].values.length - 1], SECOND_PROTECTED_ID);
  });
});

test("الذاتي: غياب PROTECTED_USER_IDS يُغلق المسار ولا يفتحه للجميع", async () => {
  await withProtected(null, async () => {
    const me = protectedRowWithPassword("hr");
    const sql = fakeUserDb([me]);
    const out = await callChangePassword({
      sql, actorRow: me,
      body: { currentPassword: CURRENT_PASSWORD, newPassword: VALID_NEW_PASSWORD },
    });
    assert.equal(out.statusCode, 404, "بلا إعداد لا يوجد المسار لأحد — ولا يصير مفتوحًا");
    assert.equal(sql.matching(/UPDATE users SET/).length, 0);
  });
});

test("الذاتي: سياسة كلمة المرور الجديدة تُفحص بعد إثبات الهوية لا قبله", async () => {
  await withProtected(PROTECTED_ID, async () => {
    /* قصيرة جدًا */
    let me = protectedRowWithPassword("hr");
    let sql = fakeUserDb([me]);
    let out = await callChangePassword({ sql, actorRow: me, body: { currentPassword: CURRENT_PASSWORD, newPassword: "قصيرة" } });
    assert.equal(out.statusCode, 400);
    assert.equal(sql.matching(/UPDATE users SET/).length, 0);

    /* مطابقة للحالية */
    me = protectedRowWithPassword("hr");
    sql = fakeUserDb([me]);
    out = await callChangePassword({ sql, actorRow: me, body: { currentPassword: CURRENT_PASSWORD, newPassword: CURRENT_PASSWORD } });
    assert.equal(out.statusCode, 400);
    assert.equal(sql.matching(/UPDATE users SET/).length, 0);

    /* ومن لا يُثبت هويته لا يتعلّم السياسة: كلمة قصيرة مع قديمة خاطئة
       تُردّ بردّ الهوية لا بردّ السياسة. */
    me = protectedRowWithPassword("hr");
    sql = fakeUserDb([me]);
    out = await callChangePassword({ sql, actorRow: me, body: { currentPassword: "خاطئة", newPassword: "قصيرة" } });
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.error, rules.MESSAGES.password_unverified);
  });
});

test("الذاتي: GET مرفوض — الكتابة بـPOST وحدها", async () => {
  await withProtected(PROTECTED_ID, async () => {
    const me = protectedRowWithPassword("hr");
    const sql = fakeUserDb([me]);
    const out = await callChangePassword({ sql, actorRow: me, method: "GET", body: {} });
    assert.equal(out.statusCode, 405);
    assert.equal(sql.matching(/UPDATE users SET/).length, 0);
  });
});
