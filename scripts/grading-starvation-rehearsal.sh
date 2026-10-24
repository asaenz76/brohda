#!/usr/bin/env bash
# Grading starvation rehearsal on a LOCAL production-shaped database (see grading-starvation-rehearsal.mjs). Local only.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH"
T=$(mktemp -d)
getv() { grep -E "^$1=" .env.test.local | head -1 | cut -d= -f2-; }
URL=$(getv TEST_SUPABASE_URL); case "$URL" in *127.0.0.1*|*localhost*) ;; *) echo "refusing: not the local Supabase" >&2; exit 2;; esac
run_job() { # the REAL job entry points, pointed explicitly at the LOCAL test stack (never .env.local)
  NODE_OPTIONS=--conditions=react-server NEXT_PUBLIC_SUPABASE_URL="$URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$(getv TEST_SUPABASE_ANON_KEY)" SUPABASE_SERVICE_ROLE_KEY="$(getv TEST_SUPABASE_SERVICE_ROLE_KEY)" pnpm exec tsx "$1" 2>&1
}
echo "== 1. production schema (migrations 1..214)"; pnpm -s supabase db reset --local --version 20260101000214 >/dev/null 2>&1
echo "== 2. production-shaped history";            node scripts/grading-starvation-rehearsal.mjs seed | tail -1
echo "== 3. starvation backlog + gradeable Picks";  node scripts/grading-starvation-rehearsal.mjs backlog
node scripts/grading-starvation-rehearsal.mjs snapshot > "$T/before.json"
echo "== 4. FIXED code, migration 215 NOT applied (deploy-ahead-of-migration)"
run_job scripts/grade-predictions.ts | grep -E "examined|graded:|still pending|migration 215" | sed 's/^/   /'
node scripts/grading-starvation-rehearsal.mjs verify "$T/before.json" fallback
echo "== 5. apply migration 215 only";              pnpm -s supabase migration up --local 2>&1 | grep -E "Applying|ERROR" | sed 's/^/   /'
echo "== 6. FIXED code + migration 215";
run_job scripts/grade-predictions.ts | grep -E "examined|graded:|correct|incorrect|void|still pending|failures" | sed 's/^/   /'
run_job scripts/resolve-challenges.ts | grep -E "examined|resolved" | sed 's/^/   /'
node scripts/grading-starvation-rehearsal.mjs verify "$T/before.json" fixed
echo "== 7. idempotent: run both again"
run_job scripts/grade-predictions.ts | grep -E "examined|graded:" | sed 's/^/   /'
run_job scripts/resolve-challenges.ts | grep -E "examined|resolved" | sed 's/^/   /'
node scripts/grading-starvation-rehearsal.mjs verify "$T/before.json" fixed
