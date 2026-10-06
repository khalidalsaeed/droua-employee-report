/* ─── سياق البوابة: حارسٌ لا يُنسى ─────────────────────────────────────
   =========================================================================
   الوصول إلى ملفّات وحدةٍ **يقع داخل سياق** يفتحه حارسها وحده. ومن يستدعي
   وحدة الملفّات خارجه يأخذ استثناءً في السطر الأوّل — في الاختبار قبل
   الإنتاج.

   لكل وحدة سياقها الخاصّ (نسخة AsyncLocalStorage مستقلّة): سياقٌ مفتوح في
   وحدةٍ لا يفتح ملفّات وحدةٍ أخرى ولو تداخل النداءان. */

const { AsyncLocalStorage } = require("node:async_hooks");

function createGateContext() {
  const storage = new AsyncLocalStorage();

  function runWithGate({ userId, sidHash, role }, fn) {
    if (!userId) throw new Error("سياق البوابة يحتاج هويّة");
    return storage.run(Object.freeze({ userId, sidHash: sidHash || null, role: role || null, at: Date.now() }), fn);
  }

  function current() {
    return storage.getStore() || null;
  }

  function requireGate() {
    const ctx = storage.getStore();
    if (!ctx) throw new Error("لا سياق بوابة — الوصول يمرّ بالحارس");
    return ctx;
  }

  return { runWithGate, current, requireGate };
}

module.exports = { createGateContext };
