const test = require("node:test");
const assert = require("node:assert/strict");

const { withMedins, ENV } = require("./helpers/medins-harness");

/* ─── بوابة /secure-benefits عبر api/app.js الحقيقيّ ─────────────────────
   كل اختبار يمرّ من الملفّ الذي يستقبله Vercel فعلًا، بقاعدة بوابة مُزيَّفة
   في الذاكرة — فيعمل بلا Postgres. وما يُقاس هو ما يخرج: الحالة، والجسم،
   والكوكي بسماته، وصفوف التدقيق. */

const PLATFORM_404_API = { ok: false, error: "Not found" };

test("الإعداد الناقص يُخفي الوحدة بـ404 مطابق للمنصّة — لكل مستخدم", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    delete process.env.MEDINS_GATE_SECRET;
    const c = client(IDS.editor);
    const page = await c.page();
    assert.equal(page.statusCode, 404);
    assert.equal(page.body, "Not found");
    assert.equal(page.headers["content-security-policy"], undefined, "404 يحمل رؤوس أمان تميّزه");
    const api = await c.call("GET", "me");
    assert.equal(api.statusCode, 404);
    assert.deepEqual(api.body, PLATFORM_404_API);
  });
});

test("سرّ الوحدة المساوي لسرّ جلسة المنصّة أو Droua يُخفيها", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    process.env.MEDINS_GATE_SECRET = ENV.SESSION_SECRET;
    assert.equal((await client(IDS.editor).page()).statusCode, 404);
    process.env.DROUA_GATE_SECRET = "x".repeat(40);
    process.env.MEDINS_GATE_SECRET = "x".repeat(40);
    assert.equal((await client(IDS.editor).page()).statusCode, 404);
  });
});

test("غير المسجَّل: تحويل الصفحة إلى الدخول، و401 للـAPI", async () => {
  await withMedins(async ({ client }) => {
    const c = client(null);
    const page = await c.page();
    assert.equal(page.statusCode, 302);
    assert.equal(page.headers.location, "/login.html");
    const api = await c.call("GET", "me");
    assert.equal(api.statusCode, 401);
  });
});

test("الرفض المبكّر: مستخدمٌ غير محميّ يُردّ 404 بلا أيّ رحلة إلى القاعدة", async () => {
  await withMedins(async ({ client, IDS, gateDb }) => {
    const out = await client(IDS.plain).page();
    assert.equal(out.statusCode, 404);
    assert.equal(gateDb.calls.filter((c) => !/medins_audit/.test(c.text)).length, 0, "استُعلمت القاعدة قبل الرفض");
  });
});

test("محميٌّ ليس عضوًا (ولو كان مالك المنصّة) يُردّ 404، ويُدقَّق الاستكشاف مرّة في النافذة", async () => {
  await withMedins(async ({ client, IDS, gateDb }) => {
    const c = client(IDS.outsider);
    for (let i = 0; i < 4; i += 1) {
      const out = await c.call("GET", "offers");
      assert.equal(out.statusCode, 404);
      assert.deepEqual(out.body, PLATFORM_404_API);
    }
    assert.equal(gateDb.audit.filter((a) => a.event === "access_denied").length, 1);
  });
});

test("العضويّة طبقةٌ مستقلّة: صفٌّ معطَّل، أو بريدٌ مختلف، أو حمايةٌ منزوعة — كلّها 404", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    assert.equal((await client(IDS.editor).page()).statusCode, 200);

    gateDb.members.get(IDS.editor).active = false;
    assert.equal((await client(IDS.editor).page()).statusCode, 404, "العضو المعطَّل دخل");
    gateDb.members.get(IDS.editor).active = true;

    gateDb.members.get(IDS.editor).email = "someone-else@example.test";
    assert.equal((await client(IDS.editor).page()).statusCode, 404, "حسابٌ تغيّر بريده ورث العضويّة");
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });

    process.env.PROTECTED_USER_IDS = IDS.viewer;
    assert.equal((await client(IDS.editor).page()).statusCode, 404, "عضوٌ غير محميّ دخل");
  });
});

test("الصفحة بلا بوابة مفتوحة: شاشة كلمة المرور، بلا اسم الوحدة ولا محتواها", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes }) => {
    gateDb.addMember(IDS.viewer, "viewer", { hash: hashes.viewer });
    const out = await client(IDS.viewer).page();
    assert.equal(out.statusCode, 200);
    assert.match(out.body, /أدخل كلمة المرور/);
    assert.doesNotMatch(out.body, /تأمين|insur|عرض|benefit/i);
    assert.match(out.headers["content-security-policy"], /script-src 'nonce-/);
    assert.equal(out.headers["x-frame-options"], "DENY");
  });
});

test("الفتح: الكلمة الخاطئة 403 موحّد بعد الأرضية الزمنية؛ والصحيحة كوكي ضيّق وتدقيق", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    const c = client(IDS.editor);
    const t0 = Date.now();
    const bad = await c.call("POST", "gate/unlock", { body: { password: "wrong-password" } });
    assert.ok(Date.now() - t0 >= 590, "الفشل أسرع من الأرضية");
    assert.equal(bad.statusCode, 403);
    assert.deepEqual(bad.body, { ok: false, error: "تعذّر فتح القسم" });

    const good = await c.call("POST", "gate/unlock", { body: { password: PASSWORDS.editor } });
    assert.equal(good.statusCode, 200);
    assert.equal(good.body.role, "editor");
    const cookie = [].concat(good.headers["set-cookie"]).find((x) => x.startsWith("medins_gate="));
    assert.ok(cookie);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/secure-benefits"]) assert.ok(cookie.includes(attr), attr);
    const ok = gateDb.audit.find((a) => a.event === "gate_unlock_success");
    assert.equal(ok.role, "editor");
    assert.equal(ok.user_id, IDS.editor);
    assert.equal(gateDb.audit.find((a) => a.event === "gate_unlock_failed").meta.reason, "bad_password");
    assert.ok(!JSON.stringify(gateDb.audit).includes(PASSWORDS.editor), "كلمة مرور في التدقيق");
  });
});

test("كلمة مرور لكل عضو: كلمة المحرّر لا تفتح للمشاهد، والعضو بلا كلمة لا يدخل", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.viewer, "viewer", { hash: hashes.viewer });
    gateDb.addMember(IDS.editor, "editor", { hash: null });
    const v = await client(IDS.viewer).call("POST", "gate/unlock", { body: { password: PASSWORDS.editor } });
    assert.equal(v.statusCode, 403);
    const e = await client(IDS.editor).call("POST", "gate/unlock", { body: { password: PASSWORDS.editor } });
    assert.equal(e.statusCode, 403);
    assert.deepEqual(e.body, v.body, "ردّ «بلا كلمة» يختلف عن «كلمة خاطئة»");
    assert.equal(gateDb.audit.filter((a) => a.meta.reason === "no_password").length, 1);
  });
});

test("القفل التصاعدي: بعد خمس إخفاقات تُرفض الكلمة الصحيحة أيضًا", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.viewer, "viewer", { hash: hashes.viewer });
    const c = client(IDS.viewer);
    for (let i = 0; i < 5; i += 1) await c.call("POST", "gate/unlock", { body: { password: "nope-" + i } });
    const locked = await c.call("POST", "gate/unlock", { body: { password: PASSWORDS.viewer } });
    assert.equal(locked.statusCode, 403);
    assert.ok(gateDb.audit.some((a) => a.event === "gate_locked_out"));
    assert.equal(gateDb.attempts.length, 5, "المحاولة المردودة بالقفل حُسبت");
  });
});

test("بوابةٌ لا تُدقَّق لا تُفتح: فشل تسجيل النجاح يُنتج 404 بلا كوكي", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    gateDb.armed.auditFail = true;
    const out = await client(IDS.editor).call("POST", "gate/unlock", { body: { password: PASSWORDS.editor } });
    assert.equal(out.statusCode, 404);
    assert.ok(![].concat(out.headers["set-cookie"] || []).some((x) => x.startsWith("medins_gate=") && !/Max-Age=0/.test(x)));
  });
});

test("بعد الفتح: البيانات تعمل، والقفل يُبطل الجلسة فعلًا", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    const c = client(IDS.editor);
    assert.deepEqual((await c.call("GET", "me")).body, { ok: false, locked: true });
    await c.call("POST", "gate/unlock", { body: { password: PASSWORDS.editor } });
    const me = await c.call("GET", "me");
    assert.equal(me.statusCode, 200);
    assert.equal(me.body.role, "editor");
    const page = await c.page();
    assert.match(page.body, /data-role="editor"/);
    assert.ok(gateDb.audit.some((a) => a.event === "section_opened"));

    const stolen = c.jar.get("medins_gate");
    await c.call("POST", "gate/lock", { body: {} });
    assert.equal((await c.call("GET", "me")).statusCode, 401);
    c.jar.set("medins_gate", stolen);
    assert.equal((await c.call("GET", "me")).statusCode, 401, "النسخة المسروقة ما زالت صالحة بعد القفل");
  });
});

test("المسار المجهول 404 قبل أي فحص بوابة — ولو كانت مقفلة", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    const out = await client(IDS.editor).call("GET", "offers/not-a-uuid");
    assert.equal(out.statusCode, 404);
    assert.deepEqual(out.body, PLATFORM_404_API);
  });
});

test("توكن بنوعٍ آخر (Droua) موقَّعٌ بسرّ الوحدة لا يفتحها", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    const { createTokenCodec } = require("../lib/secure-kit/token");
    const now = Date.now();
    const sid = "f".repeat(64);
    gateDb.sessions.set(createTokenCodec({ type: "droua-gate" }).hashSid(sid), {
      sid_hash: createTokenCodec({ type: "droua-gate" }).hashSid(sid), user_id: IDS.editor,
      idle_exp: now + 600000, absolute_exp: now + 3600000, revoked_at: null,
    });
    const forged = createTokenCodec({ type: "droua-gate" }).issue(
      { userId: IDS.editor, sid, now, idleMs: 600000, absoluteExp: now + 3600000 }, ENV.MEDINS_GATE_SECRET).token;
    const c = client(IDS.editor);
    c.jar.set("medins_gate", forged);
    assert.equal((await c.call("GET", "me")).statusCode, 401);
  });
});

test("CSRF: كتابةٌ بلا JSON أو من مصدرٍ آخر تُرفض 403", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes, PASSWORDS }) => {
    gateDb.addMember(IDS.editor, "editor", { hash: hashes.editor });
    const c = client(IDS.editor);
    const form = await c.call("POST", "gate/unlock", { body: { password: PASSWORDS.editor }, headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(form.statusCode, 403);
    await c.call("POST", "gate/unlock", { body: { password: PASSWORDS.editor } });
    const evil = await c.call("POST", "insurers", { body: { nameAr: "س" }, headers: { origin: "https://evil.example" } });
    assert.equal(evil.statusCode, 403);
  });
});

test("جلسة المنصّة تنزلق للعضو وحده", async () => {
  await withMedins(async ({ client, IDS, gateDb, hashes }) => {
    gateDb.addMember(IDS.viewer, "viewer", { hash: hashes.viewer });
    const member = await client(IDS.viewer).page();
    assert.ok([].concat(member.headers["set-cookie"] || []).some((x) => x.startsWith("session=")));
    const outsider = await client(IDS.outsider).page();
    assert.equal(outsider.headers["set-cookie"], undefined);
  });
});
