#!/usr/bin/env bash
# Brohda 2.1 M3 — production-shaped migration rehearsal (local Supabase only). See scripts/m3-migration-rehearsal.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH"
TMP="${TMPDIR:-/tmp}/m3-before.json"
echo "== 1. production schema (migrations 1..215)"; pnpm -s supabase db reset --local --version 20260101000215 >/dev/null 2>&1
echo "== 2. production-shaped data";                  node scripts/m3-migration-rehearsal.mjs seed
echo "== 3. snapshot of every existing table";        node scripts/m3-migration-rehearsal.mjs snapshot > "$TMP"; node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log("   head",s.head,"tables",Object.keys(s.tables).length)' "$TMP"
echo "== 4. apply migration 216 only";                pnpm -s supabase migration up --local 2>&1 | grep -E "Applying|ERROR" | sed 's/^/   /'
echo "== 5. verify";                                  node scripts/m3-migration-rehearsal.mjs verify "$TMP"
