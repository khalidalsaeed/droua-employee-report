const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const Module = require("node:module");

const { matchFile, CONFIRMED_ALIASES } = require("../lib/photos/match");
const { inspectPhoto, findDuplicates, MAX_BYTES } = require("../lib/photos/validate");
const { ROWS } = require("../lib/org/source");
const manifest = require("../lib/photos/manifest");
const { plan } = require("../scripts/upload-employee-photos");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* صور الموظفين: المطابقة بالاسم، فحص الملفّ، حارس العرض، والواجهة.
   لا صورة موظف حقيقية في المستودع ولا في هذه الاختبارات — كل صورة هنا
   مولَّدة اصطناعيًّا. */

/* ─── صورة PNG اصطناعية صالحة (بلا مكتبة) ─── */
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w = 4, h = 4, seed = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  /* ضجيج حتمي: الضغط لا يُصغّر الملفّ إلى ما دون حدود الفحص. */
  const raw = Buffer.alloc(h * (1 + w * 3));
  let x = (seed * 2654435761 + 1) >>> 0;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) >>> 0; raw[i] = x >>> 24; }
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0; // filter none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
/* JPEG أدنى: SOI + SOF0 + EOI — يكفي لفحص التوقيع والترويسة والاكتمال. */
function makeJpeg(w = 8, h = 6) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14, 0x41), sof, Buffer.alloc(80, 0x00), Buffer.from([0xff, 0xd9])]);
}

/* ─── المطابقة: اسم الملفّ وحده ─── */
const APPROVED_FILES = [
  "صورة محمد راسل برودان.jpg", "صورة عبد المنان.jpg", "صورة مد هلال مد الدين.jpg", "صورة ساجر.jpg",
  "صورة فرهاد.jpg", "صورة مد شهيد الاسلام.jpg", "صورة الأمين مولا.jpg", "صورة راسل ديوان.jpg",
  "صورة مد توفيق.jpg", "صورة مد طيف الرحمن.jpg", "صورة شميم.jpg", "صورة شكيب مياه.jpg",
];

test("المطابقة: الأسماء الاثنا عشر المعتمدة كلها matched، وكلٌّ لموظف مختلف", () => {
  const results = APPROVED_FILES.map((f) => matchFile(f, ROWS));
  for (const r of results) assert.equal(r.status, "matched", `${r.file}: ${r.status}`);
  assert.equal(new Set(results.map((r) => r.row.row)).size, 12);
});

test("المطابقة: الاختصارات الأربعة لا تُقبل إلا لأنها معتمدة صراحةً", () => {
  assert.deepEqual(Object.keys(CONFIRMED_ALIASES).sort(), ["ساجر", "شميم", "فرهاد", "مد طيف الرحمن"].sort());
  for (const f of ["صورة ساجر.jpg", "صورة شميم.jpg", "صورة فرهاد.jpg", "صورة مد طيف الرحمن.jpg"]) {
    assert.equal(matchFile(f, ROWS).via, "confirmed_alias");
  }
});

test("المطابقة: اسم جزئي غير معتمد ملتبس ولا يُربط", () => {
  const r = matchFile("صورة مد.jpg", ROWS);
  assert.equal(r.status, "ambiguous");
  assert.ok(r.candidates > 1);
  assert.equal(r.row, undefined);
});

test("المطابقة: اسمٌ تامّ يحمله موظفان ملتبس — لا «أوّل نتيجة»", () => {
  const rows = [{ row: 1, nameAr: "أحمد علي" }, { row: 2, nameAr: "احمد علي" }];
  assert.equal(matchFile("صورة أحمد علي.png", rows).status, "ambiguous");
});

test("المطابقة: اسم لا يوجد له موظف unmatched", () => {
  assert.equal(matchFile("صورة شخص غير موجود.jpg", ROWS).status, "unmatched");
});

test("المطابقة: تكرار الاسم في السجلّ يُعالَج بنصفه الحرفي فقط", () => {
  const rows = [{ row: 1, nameAr: "راسل ديوان راسل ديوان" }, { row: 2, nameAr: "راسل ديوان آخر" }];
  assert.equal(matchFile("صورة راسل ديوان.jpg", rows).via, "doubled_record_name");
  assert.equal(matchFile("صورة ديوان.jpg", [rows[0]]).status, "ambiguous");
});

/* ─── الـmanifest ─── */
test("manifest: اثنا عشر مدخلًا، بصمات ومعرّفات ومسارات فريدة", () => {
  assert.equal(manifest.length, 12);
  for (const k of ["photoId", "storageKey", "sha256"]) assert.equal(new Set(manifest.map((e) => e[k])).size, 12, k);
  for (const e of manifest) {
    assert.match(e.photoId, /^[0-9a-f]{16}$/);
    assert.match(e.storageKey, /^employee-photos\/[0-9a-f]{32}$/, "مسار عشوائي لا يكشف اسمًا");
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.equal(e.mime, "image/jpeg");
    assert.ok(e.bytes > 0 && e.bytes <= MAX_BYTES);
  }
});

test("manifest: كل مدخل يطابق موظفًا في المصدر، والمطابقة المعتمدة نفسها", () => {
  const expected = new Map(APPROVED_FILES.map((f) => {
    const r = matchFile(f, ROWS).row;
    return [r.email.toLowerCase(), r.row];
  }));
  for (const e of manifest) {
    assert.equal(expected.get(e.match.email), e.sourceRow, e.match.email);
    assert.ok("eid" in e.match, "حقل eid موجود للانتقال إلى رقم ضمان");
  }
});

test("manifest: رقم ضمان — حين يُملأ — نصّ أرقام وفريد", () => {
  const eids = manifest.map((e) => e.match.eid).filter((v) => v != null);
  for (const v of eids) assert.match(v, /^\d+$/);
  assert.equal(new Set(eids).size, eids.length);
});

test("manifest: لا صور ولا روابط ولا base64 في المستودع", () => {
  /* القيم لا التعليقات: التعليق يشرح لماذا لا base64، والفحص على البيانات. */
  const data = JSON.stringify(manifest);
  assert.doesNotMatch(data, /https?:\/\/|data:image|blob\.vercel/);
  for (const e of manifest) for (const v of Object.values(e)) if (typeof v === "string") assert.ok(v.length <= 80);
  const tracked = fs.readdirSync(ROOT, { recursive: true })
    .filter((f) => !String(f).startsWith("node_modules") && !String(f).startsWith(".git"))
    .filter((f) => /\.(jpe?g|webp)$/i.test(String(f)));
  assert.deepEqual(tracked, [], "لا ملفّات صور موظفين في المستودع");
});

/* ─── فحص الملفّ ─── */
test("الفحص: PNG وJPEG سليمان يُقبلان مع الأبعاد والبصمة", () => {
  const png = inspectPhoto(makePng(5, 3), { fileName: "a.png", declaredMime: "image/png" });
  assert.deepEqual([png.mime, png.width, png.height], ["image/png", 5, 3]);
  assert.match(png.sha256, /^[0-9a-f]{64}$/);
  const jpg = inspectPhoto(makeJpeg(8, 6), { fileName: "a.JPG" });
  assert.deepEqual([jpg.mime, jpg.width, jpg.height], ["image/jpeg", 8, 6]);
});

test("الفحص: نوعٌ غير صورة يُرفض مهما كان اسمه", () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x20)]);
  assert.throws(() => inspectPhoto(pdf, { fileName: "صورة شكيب مياه.jpg" }), /ليس صورة/);
});

test("الفحص: النوع المُعلن أو الامتداد المخالف للمحتوى مرفوض", () => {
  assert.throws(() => inspectPhoto(makePng(), { declaredMime: "image/jpeg" }), /لا يطابق محتواه/);
  assert.throws(() => inspectPhoto(makePng(), { fileName: "x.jpg" }), /امتداد/);
});

test("الفحص: الحجم الزائد يُرفض قبل أي شيء آخر", () => {
  const big = Buffer.concat([makePng(), Buffer.alloc(MAX_BYTES)]);
  assert.throws(() => inspectPhoto(big), /الحدّ المسموح/);
});

test("الفحص: الملفّ المبتور أو التالف يُرفض", () => {
  const png = makePng(16, 16);
  assert.throws(() => inspectPhoto(png.subarray(0, png.length - 12)), /مبتور/);
  const jpg = makeJpeg();
  assert.throws(() => inspectPhoto(jpg.subarray(0, jpg.length - 2)), /مبتور/);
  const broken = Buffer.from(png); broken.write("XXXX", 12, "latin1");
  assert.throws(() => inspectPhoto(broken), /تالفة/);
});

test("التكرار: الصورة نفسها باسمين تُكشف بالبصمة", () => {
  const a = inspectPhoto(makePng(4, 4, 1)), b = inspectPhoto(makePng(4, 4, 2));
  assert.deepEqual(findDuplicates([a, b, a]), [[0, 2]]);
});

test("سكربت الرفع: لا يرفع ملتبسًا ولا مكرّرًا ولا ملفًّا لا يطابق بصمة المعتمد", () => {
  const png = makePng(4, 4, 9);
  const { items, summary } = plan([
    { name: "صورة مد.png", bytes: png },
    { name: "صورة غير موجود.png", bytes: png },
    { name: "صورة شكيب مياه.png", bytes: png },
    { name: "صورة الأمين مولا.png", bytes: png },
  ]);
  assert.deepEqual(items.map((i) => i.status), ["ambiguous", "unmatched", "hash_mismatch", "duplicate"]);
  assert.equal(summary.matched, 0);
  assert.ok(items.every((i) => i.entry === null));
});

/* ─── المتجر والحارس ─── */
const BLOB_ID = require.resolve("@vercel/blob");
const AUTH_ID = require.resolve("../lib/auth/requireAuth");
const MANIFEST_ID = require.resolve("../lib/photos/manifest");
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV = ["EMPLOYEE_PHOTOS_STORE_ID", "VERCEL_OIDC_TOKEN", "BLOB_READ_WRITE_TOKEN", "DROUA_BLOB_READ_WRITE_TOKEN"];

function fakeBlob(objects) {
  const calls = [];
  return {
    calls,
    api: {
      async get(pathname, opts) {
        calls.push({ op: "get", pathname, opts });
        if (!objects.has(pathname)) return null;
        const buf = objects.get(pathname);
        return { stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } }) };
      },
      async put(pathname, body, opts) {
        calls.push({ op: "put", pathname, opts });
        objects.set(pathname, Buffer.from(body));
        return { pathname, url: `https://example.invalid/${pathname}` };
      },
      async list(opts) {
        calls.push({ op: "list", opts });
        return { blobs: [...objects.keys()].slice(0, 1).map((pathname) => ({ pathname })), hasMore: false };
      },
    },
  };
}

/* يُحمّل api/app.js بمتجر مصطنع، وmanifest اصطناعي، وجلسة يحدّدها الطلب. */
async function withApp({ env = {}, entries, objects }, fn) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  ENV.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);
  const blob = fakeBlob(objects || new Map());
  const originalLoad = Module._load;
  const clear = () => Object.keys(require.cache).forEach((k) => {
    if (k.startsWith(PROJECT_ROOT) && !k.includes("node_modules")) delete require.cache[k];
  });
  clear();
  Module._load = function (request, parent, isMain) {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (err) { /* يمرّ */ }
    if (resolved === BLOB_ID) return blob.api;
    if (resolved === AUTH_ID) return { requireUser: async (req) => req._user || null };
    if (resolved === MANIFEST_ID && entries) return entries;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const handler = require("../api/app");
    return await fn({ handler, blob });
  } finally {
    Module._load = originalLoad;
    clear();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function makeRes() {
  const out = { statusCode: 0, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; },
    status(c) { out.statusCode = c; return res; },
    json(p) { out.body = p; return res; },
    writeHead(c, h) { out.statusCode = c; for (const [k, v] of Object.entries(h || {})) out.headers[k.toLowerCase()] = v; return res; },
    end(p) { if (p !== undefined) out.body = p; return res; },
  };
  return { res, out };
}

const OWNER = { id: "u1", role: "owner", status: "active" };
const HR = { id: "u2", role: "hr", status: "active" };
const FINANCE = { id: "u3", role: "finance", status: "active" };
/* رمز OIDC اصطناعي بحمولة JWT؛ Vercel يحقنه في ترويسة كل طلب. */
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const OIDC = jwt({ environment: "preview", exp: Math.floor(Date.now() / 1000) + 3600 });
const STORE = "store_PhotosTest1";
const STORE_ENV = { EMPLOYEE_PHOTOS_STORE_ID: STORE };

async function call(handler, apiPath, query, user, headers = {}) {
  const { res, out } = makeRes();
  await handler({ method: "GET", query: { kind: "api", apiPath, ...query }, headers: { "x-vercel-oidc-token": OIDC, ...headers }, _user: user }, res);
  return out;
}

function syntheticStore() {
  const png = makePng(6, 6, 7);
  const entry = {
    photoId: "0123456789abcdef", match: { email: "someone@example.com", eid: "501" }, sourceRow: 1,
    storageKey: "employee-photos/" + "a".repeat(32), mime: "image/png", bytes: png.length,
    width: 6, height: 6, sha256: inspectPhoto(png).sha256,
  };
  return { png, entries: [entry], objects: new Map([[entry.storageKey, png]]) };
}

test("الحارس: بلا جلسة 401، وبلا employees:view 403 — للفهرس وللصورة", async () => {
  const s = syntheticStore();
  await withApp({ env: STORE_ENV, ...s }, async ({ handler, blob }) => {
    assert.equal((await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, null)).statusCode, 401);
    assert.equal((await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, FINANCE)).statusCode, 403);
    assert.equal((await call(handler, "data/employee-photos", {}, FINANCE)).statusCode, 403);
    assert.equal(blob.calls.length, 0, "لا قراءة من المتجر قبل التفويض");
  });
});

test("العرض: صاحب employees:view يستلم البايتات خاصّة، بلا مسار تخزين", async () => {
  const s = syntheticStore();
  await withApp({ env: STORE_ENV, ...s }, async ({ handler, blob }) => {
    const out = await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, HR);
    assert.equal(out.statusCode, 200);
    assert.ok(Buffer.isBuffer(out.body) && out.body.equals(s.png));
    assert.equal(out.headers["content-type"], "image/png");
    assert.match(out.headers["cache-control"], /^private\b/);
    assert.equal(out.headers["x-content-type-options"], "nosniff");
    assert.doesNotMatch(JSON.stringify(out.headers), /employee-photos\/|blob/i);

    const again = await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, HR, { "if-none-match": out.headers.etag });
    assert.equal(again.statusCode, 304);
  });
});

test("المصادقة: OIDC من ترويسة الطلب ومعرّف المتجر صراحةً — بلا token أبدًا", async () => {
  const s = syntheticStore();
  await withApp({ env: { ...STORE_ENV, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_AjeerStore_x" }, ...s }, async ({ handler, blob }) => {
    assert.equal((await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, HR)).statusCode, 200);
    const [get] = blob.calls;
    assert.equal(get.op, "get");
    assert.equal(get.opts.access, "private");
    assert.equal(get.opts.oidcToken, OIDC);
    assert.equal(get.opts.storeId, "PhotosTest1");
    assert.ok(!("token" in get.opts), "لا توكن قراءة/كتابة — ولا سقوط إلى متجر أجير");
  });
});

test("المصادقة: بلا رمز OIDC لا نداء للمتجر — لا سقوط صامت إلى توكن أجير", async () => {
  const s = syntheticStore();
  await withApp({ env: { ...STORE_ENV, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_AjeerStore_x" }, ...s }, async ({ handler, blob }) => {
    assert.equal((await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, HR, { "x-vercel-oidc-token": "" })).statusCode, 404);
    assert.equal(blob.calls.length, 0);
  });
});

test("الفهرس: معرّفات ومفاتيح ربط فقط — لا storageKey ولا رابط", async () => {
  const s = syntheticStore();
  await withApp({ env: STORE_ENV, ...s }, async ({ handler }) => {
    const out = await call(handler, "data/employee-photos", {}, HR);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(out.body.items, [{ photoId: "0123456789abcdef", eid: "501", email: "someone@example.com" }]);
  });
});

test("المتجر غير مُهيّأ: فهرس فارغ و404 — Placeholder في كل مكان", async () => {
  const s = syntheticStore();
  await withApp({ ...s }, async ({ handler, blob }) => {
    assert.deepEqual((await call(handler, "data/employee-photos", {}, OWNER)).body.items, []);
    assert.equal((await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, OWNER)).statusCode, 404);
    assert.equal(blob.calls.length, 0);
  });
});

test("المتجر: معرّف متجر أجير العامّ أو متجر قسم المراجعة لا يُقدّم شيئًا", async () => {
  const s = syntheticStore();
  for (const other of ["BLOB_READ_WRITE_TOKEN", "DROUA_BLOB_READ_WRITE_TOKEN"]) {
    await withApp({ env: { ...STORE_ENV, [other]: "vercel_blob_rw_PhotosTest1_secret" }, ...s }, async ({ handler, blob }) => {
      assert.equal((await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, OWNER)).statusCode, 404);
      assert.equal(blob.calls.length, 0, `${other}: لا نداء للمتجر`);
    });
  }
});

test("السلامة: كائن مُستبدَل في المتجر لا يُقدَّم", async () => {
  const s = syntheticStore();
  s.objects.set(s.entries[0].storageKey, makePng(6, 6, 99));
  await withApp({ env: STORE_ENV, ...s }, async ({ handler }) => {
    assert.equal((await call(handler, "files/employee-photo", { id: "0123456789abcdef" }, OWNER)).statusCode, 404);
  });
});

test("المعرّف: صيغة غير صالحة أو مجهول 404 بلا نداء للمتجر", async () => {
  const s = syntheticStore();
  await withApp({ env: STORE_ENV, ...s }, async ({ handler, blob }) => {
    for (const id of ["../x", "employee-photos/" + "a".repeat(32), "ffffffffffffffff", ""]) {
      assert.equal((await call(handler, "files/employee-photo", { id }, OWNER)).statusCode, 404, id);
    }
    assert.equal(blob.calls.length, 0);
  });
});

test("الرفع: خاصّ دائمًا، بـOIDC ومعرّف المتجر، وبالبصمة المعتمدة فقط", async () => {
  const s = syntheticStore();
  await withApp({ env: STORE_ENV, entries: s.entries, objects: new Map() }, async ({ blob }) => {
    const store = require("../lib/photos/store");
    await assert.rejects(() => store.putPhoto(s.entries[0], makePng(6, 6, 1), OIDC), /بصمة/);
    await assert.rejects(() => store.putPhoto(s.entries[0], s.png), /OIDC/, "بلا رمز لا رفع");
    await store.putPhoto(s.entries[0], s.png, OIDC);
    const put = blob.calls.find((c) => c.op === "put");
    assert.equal(put.opts.access, "private");
    assert.equal(put.opts.oidcToken, OIDC);
    assert.equal(put.opts.storeId, "PhotosTest1");
    assert.ok(!("token" in put.opts));
    assert.equal(put.opts.addRandomSuffix, false);
    assert.equal(put.pathname, s.entries[0].storageKey);
  });
});

test("سكربت الرفع: رمز development أو preview فقط — لا production — والفحص قراءة لا كتابة", async () => {
  const s = syntheticStore();
  const quiet = console.log;
  for (const [claims, ok] of [
    [{ environment: "preview", exp: Math.floor(Date.now() / 1000) + 3600 }, true],
    [{ environment: "development", exp: Math.floor(Date.now() / 1000) + 3600 }, true],
    [{ exp: Math.floor(Date.now() / 1000) + 3600 }, false],
    [{ environment: "production", exp: Math.floor(Date.now() / 1000) + 3600 }, false],
    [{ environment: "preview", exp: Math.floor(Date.now() / 1000) + 60 }, false],
  ]) {
    await withApp({ env: { ...STORE_ENV, VERCEL_OIDC_TOKEN: jwt(claims) }, ...s }, async ({ blob }) => {
      console.log = () => {};
      try {
        const res = await require("../scripts/upload-employee-photos").checkCredentials();
        assert.equal(res.ok, ok, JSON.stringify(claims));
      } finally { console.log = quiet; }
      assert.ok(blob.calls.every((c) => c.op === "list"), "لا كتابة في الفحص");
    });
  }
});

test("الكتابة عبر المورد مرفوضة", async () => {
  const mod = require("../lib/data/employeePhotos");
  for (const fn of ["create", "update", "remove"]) await assert.rejects(() => mod[fn]({}), /للقراءة فقط/);
});

/* ─── الواجهة ─── */
function loadClient(items, can = true) {
  const listeners = [];
  /* AdminUI متغيّرٌ في النطاق لا خاصيّة على window — كما في الصفحة. */
  const win = {
    AdminUI: {
      can: () => can,
      api: async (m, url) => { assert.equal(`${m} ${url}`, "GET /api/data/employee-photos"); return { ok: true, items }; },
    },
    document: { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) },
  };
  const adminUI = win.AdminUI;
  delete win.AdminUI;
  vm.runInNewContext(read("employee-photos.js"), { window: win, document: win.document, AdminUI: adminUI });
  return { EP: win.EmployeePhotos, listeners };
}

test("الواجهة: رقم ضمان أوّلًا ثم البريد، ورابط داخلي بالمعرّف وحده", async () => {
  const { EP } = loadClient([
    { photoId: "1111111111111111", eid: "501", email: "a@x.com" },
    { photoId: "2222222222222222", eid: null, email: "B@X.com" },
  ]);
  await EP.load();
  assert.equal(EP.urlFor({ eid: "501", email: "b@x.com" }), "/api/files/employee-photo?id=1111111111111111");
  assert.equal(EP.urlFor({ email: " b@x.com " }), "/api/files/employee-photo?id=2222222222222222");
  assert.equal(EP.urlFor({ email: "none@x.com" }), null);
  assert.match(EP.img({ eid: "501" }), /^<img class="ep-img" src="\/api\/files\/employee-photo\?id=1{16}" alt=""/);
});

test("الواجهة: سجلّ بريده يختلف عن بريد المصدر يُحلّ برقم ضمان", async () => {
  const { EP } = loadClient([{ photoId: "3333333333333333", eid: "511", email: "source@x.com" }]);
  await EP.load();
  assert.equal(EP.idFor({ eid: 511, email: "different@x.com" }), "3333333333333333");
  assert.equal(EP.idFor({ eid: "512", email: "different@x.com" }), null, "لا تخمين: لا eid ولا بريد مطابق");
});

test("الواجهة: بلا صورة لا وسم img — والأحرف الأولى تبقى", async () => {
  const { EP } = loadClient([]);
  await EP.load();
  assert.equal(EP.img({ eid: "999", email: "x@y.z" }), "");
});

test("الواجهة: بلا employees:view لا يُطلب الفهرس أصلًا", async () => {
  const { EP } = loadClient([{ photoId: "1111111111111111", eid: "1" }], false);
  await EP.load();
  assert.equal(EP.img({ eid: "1" }), "");
});

test("الواجهة: صورة تعذّر تحميلها تُزال فتظهر الأحرف الأولى — لا صورة مكسورة", () => {
  const { listeners } = loadClient([]);
  const l = listeners.find((x) => x.type === "error");
  assert.ok(l && l.capture === true, "التقاط على المستند لأن error لا يصعد");
  let removed = false;
  l.fn({ target: { classList: { contains: (c) => c === "ep-img" }, remove: () => { removed = true; } } });
  assert.ok(removed);
});

test("الواجهة: معرّف بصيغة غير متوقّعة لا يدخل رابطًا", async () => {
  const { EP } = loadClient([{ photoId: '"><script>', email: "a@x.com" }]);
  await EP.load();
  assert.equal(EP.img({ email: "a@x.com" }), "");
});

test("ملف الموظف: الصورة في رأس الملف فوق الأحرف الأولى", () => {
  const html = read("app-shell.html");
  assert.match(html, /<div class="ep-av dr-av" aria-hidden="true">\$\{esc\(initials\(e\[F\.name\]\)\)\}\$\{EmployeePhotos\.img\(photoRef\(e\)\)\}<\/div>/);
  assert.match(html, /<div class="avatar">\$\{esc\(initials\(e\[F\.name\]\)\)\}\$\{EmployeePhotos\.img\(photoRef\(e\)\)\}<\/div>/, "بطاقة القائمة");
  assert.match(html, /<script src="\/employee-photos\.js\?v=1"><\/script>\n<script src="\/org-chart\.js/);
});

test("أجير: بطاقات التصاريح بلا صور — خارج نطاق هذه الميزة", () => {
  const html = read("app-shell.html");
  /* البطاقة تعرض صفحة التصريح الأصلية بدل الصورة الرمزية — ولا صورة موظف. */
  const ajeer = html.slice(html.indexOf("function ajeerCard"), html.indexOf("function renderAjeer"));
  assert.ok(ajeer.length > 200);
  assert.doesNotMatch(ajeer, /EmployeePhotos|employee-photo/);
});

test("الهيكل: الصورة في العقدة واللوحة وقائمة الجوال، والمرجعية بلا صورة", () => {
  const js = read("org-chart.js");
  assert.match(js, /<span class="oc-av" aria-hidden="true">\$\{esc\(initials\(n\.nameAr\)\)\}\$\{photo\(n\)\}<\/span>/);
  assert.match(js, /oc-p-av" aria-hidden="true">\$\{esc\(initials\(n\.nameAr\)\)\}\$\{photo\(n\)\}/);
  assert.match(js, /oc-row-av" aria-hidden="true">\$\{esc\(initials\(title\)\)\}\$\{photo\(n\)\}/);
  assert.match(js, /if \(!n \|\| n\.kind !== "employee" \|\| !S\.opts/, "عقدة المدير المرجعية لا تأخذ صورة");
  assert.doesNotMatch(js, /\/api\/files\/employee-photo|EmployeePhotos/, "الهيكل لا يجلب الصور بنفسه");
});

test("أكثر الوثائق إلحاحًا: الصورة فوق الأحرف الأولى في العرضين، من المُضيف", () => {
  const js = read("doc-expiry.js");
  /* العرضان صفّ لكل موظف (g) — الصورة في كليهما. */
  const av = js.match(/<span class="dx-av">\$\{esc\(initials\(g\.emp\[F\.name\]\)\)\}\$\{photo\(g\.emp\)\}<\/span>/g) || [];
  assert.equal(av.length, 2, "حسب المدة و حسب الموظف");
  assert.match(read("app-shell.html"), /photoImg:e=>EmployeePhotos\.img\(photoRef\(e\)\)\}\);/);
});

test("أكثر الوثائق إلحاحًا: بلا photoImg تبقى الأحرف كما كانت", () => {
  const DocExpiry = require("../doc-expiry.js");
  assert.equal(typeof DocExpiry.render, "function");
  assert.doesNotMatch(read("doc-expiry.js"), /EmployeePhotos|\/api\/files/, "الملف لا يجلب الصور بنفسه");
});

test("العرض: قصّ بصري فقط مع حفظ النسبة", () => {
  const css = read("employee-photos.css");
  assert.match(css, /\.ep-img\{[^}]*object-fit:cover/);
  assert.match(css, /\.avatar,\.oc-av,\.ep-av,\.dx-av\{position:relative;overflow:hidden\}/);
});
