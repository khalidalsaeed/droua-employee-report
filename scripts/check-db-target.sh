#!/usr/bin/env bash
# ─── هل DATABASE_URL المحلّيّ هو نفسه في Production؟ ──────────────────────
# =========================================================================
# يُشغَّل **على جهازك** حيث يوجد .env.local — لا في جلسةٍ بعيدة.
#
# ولا يطبع إلا سطرًا واحدًا من ثلاثة. لا قيمة، ولا مضيف، ولا مستخدم، ولا
# كلمة مرور، ولا حتى بصمةً جزئية: المقارنة تقع في الذاكرة وتخرج نتيجةً
# منطقية فقط. فالبصمة الجزئية تُسرّب: من يملك مرشَّحًا يستطيع تأكيده بها.
#
#   DATABASE MATCH ✅     المحلّيّ = Production
#   DATABASE MISMATCH ❌  مختلفان — لا تُشغّل هجرةً بهذا الملفّ
#   CANNOT VERIFY ⚠️      تعذّر الحصول على أحد الطرفين — ولا يُخمَّن
#
# ⛔ لا يكتب في القاعدة شيئًا. وفحصُ المخطّط بعده قرائيٌّ محض.
#
#   التشغيل:  bash scripts/check-db-target.sh

set -uo pipefail
umask 077

say() { printf '%s\n' "$1"; }

# ملفّ Production المؤقّت **خارج المستودع** — لا يُعتمد على .gitignore وحده:
# `vercel env pull` يسحب أسرار الإنتاج كلَّها، لا DATABASE_URL وحده.
TMP="$(mktemp "${TMPDIR:-/tmp}/droua-envcheck.XXXXXXXX" 2>/dev/null)" || { say "CANNOT VERIFY ⚠️"; exit 0; }
# الحذف في كل حال: نجاحًا وفشلًا ومقاطعةً. وبالمسح إن توفّر.
wipe() {
  [ -n "${TMP:-}" ] && [ -f "$TMP" ] || return 0
  command -v shred >/dev/null 2>&1 && shred -u "$TMP" 2>/dev/null || rm -f "$TMP"
}
trap wipe EXIT INT TERM HUP

# قراءةُ قيمةٍ من ملفّ بيئة: أوّل تعريفٍ للمفتاح، بلا اقتباسات ولا فراغٍ
# طرفيّ ولا carriage return — كي لا يُظهر فرقٌ شكليّ اختلافًا حقيقيًّا.
read_env_value() {
  sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null \
    | head -n1 \
    | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# ── ① الطرف المحلّيّ ────────────────────────────────────────────────────
[ -f .env.local ] || { say "CANNOT VERIFY ⚠️"; exit 0; }
LOCAL_URL="$(read_env_value .env.local DATABASE_URL)"
[ -n "$LOCAL_URL" ] || { say "CANNOT VERIFY ⚠️"; exit 0; }

# ── ② طرف Production ───────────────────────────────────────────────────
command -v vercel >/dev/null 2>&1 || { say "CANNOT VERIFY ⚠️"; exit 0; }
vercel env pull "$TMP" --environment=production --yes >/dev/null 2>&1 \
  || { say "CANNOT VERIFY ⚠️"; exit 0; }
PROD_URL="$(read_env_value "$TMP" DATABASE_URL)"
wipe            # لا يُترك ملفُّ أسرار الإنتاج لحظةً بعد قراءته
[ -n "$PROD_URL" ] || { say "CANNOT VERIFY ⚠️"; exit 0; }

# ── ③ المقارنة ─────────────────────────────────────────────────────────
if [ "$LOCAL_URL" != "$PROD_URL" ]; then
  say "DATABASE MISMATCH ❌"
  exit 0
fi
say "DATABASE MATCH ✅"

# ── ④ فحصُ المخطّط — قرائيٌّ محض، ولا يُشغَّل إلا عند التطابق ────────────
# مخرجاتُه تُبتلع كاملةً: قد تحمل أسماء جداول وتفاصيل مخطّط. والحكم من
# رمز الخروج وحده.
if node --env-file=.env.local scripts/verify-droua-schema.js >/dev/null 2>&1; then
  say "SCHEMA PASS"
else
  say "SCHEMA FAIL"
fi
