#!/usr/bin/env bash
# Local acceptance for the Next up mod: repo rules, privacy scan, type check, validate, tests.
# Runs on a scratch copy of plugin/, with the engine's types: NEXTUP_TYPES, else a dev-mods
# folder the engine hot-reloaded the mod from, else a copy kept in ~/.cache/nextup/types.
# Without engine types, skip engine-dependent checks but still run lint and hook tests.
set -euo pipefail
cd "$(dirname "$0")/.."
# ADR-0001: only marks.ts touches mod-marks.json, and it takes the time from its caller.
bad=$(git grep -nI 'mod-marks\.json' -- 'plugin/*.ts' 'plugin/*.tsx' ':!*.test.tsx' ':!plugin/hooks/marks.ts' | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' || true)
[[ -z $bad ]] || { echo "mod-marks.json outside marks.ts (ADR-0001):"; echo "$bad"; exit 1; }
bad=$(grep -nE 'Date\.now|new Date' plugin/hooks/marks.ts || true)
[[ -z $bad ]] || { echo "marks.ts reads the clock (ADR-0001):"; echo "$bad"; exit 1; }
# Desktop clicks: the app gives a click to the topmost element, so a layer laid over controls eats their clicks.
bad=$(git grep -nE 'position="absolute"|position: .absolute.|hit\.tsx' -- 'plugin/*.tsx' ':!*.test.tsx' || true)
[[ -z $bad ]] || { echo "absolute layer in a drawing (blocks desktop clicks):"; echo "$bad"; exit 1; }
# One live state flow: what a drawing shows lives in atoms, so a write redraws it and a hot reload keeps it. A module
# variable plus $.ui.invalidate is neither, so none is allowed. No line needs one today; if one ever must (a value the
# engine holds that no atom can mirror), add its file:text to ALLOW here with the reason beside it.
ALLOW=''
bad=$(git grep -nF '$.ui.invalidate(' -- 'plugin/*.ts' 'plugin/*.tsx' ':!*.test.tsx' | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' | { [[ -n $ALLOW ]] && grep -vF "$ALLOW" || cat; } || true)
[[ -z $bad ]] || { echo "\$.ui.invalidate in the mod (keep drawn values in atoms):"; echo "$bad"; exit 1; }
# Every press goes through act() or view() (Working…, a result, one events line). A raw onPress skips all three.
node scripts/lint-press.mjs $(git ls-files 'plugin/*.tsx' | grep -v '\.test\.tsx$') || { echo "raw onPress in a Button (use act() or view(); inline arrows, functions, ternaries, and useCallback-wrapped handlers are linted)"; exit 1; }
if node scripts/lint-press.mjs scripts/fixtures/raw-press.tsx.txt >/dev/null; then echo "lint-press missed its negative fixture"; exit 1; fi
node --test scripts/lint-press.test.mjs
echo "privacy:"; bash scripts/privacy-scan.sh
LIVE=${NEXTUP_LIVE:-${TMPDIR:-/tmp}/nextup-check/nextup}
TYPES=${NEXTUP_TYPES:-$(ls -dt "$HOME"/.claude/dev-mods/*/nextup/.claude-plugin/types 2>/dev/null | head -1 || true)}
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/nextup/types
[[ -n $TYPES ]] || TYPES=$CACHE
if [[ -n $TYPES && -d $TYPES ]]; then
  mkdir -p "$LIVE"
  rsync -a --delete --exclude '.claude-plugin/types' plugin/ "$LIVE/"
  rsync -a --delete "$TYPES/" "$LIVE/.claude-plugin/types/"
  echo "tsc:"; tsc -p "$LIVE"
  claude plugin validate "$LIVE" | tail -1
  out=$(claude plugin test "$LIVE" 2>&1) || { echo "$out"; exit 1; }
  echo "$out" | grep -E '^\((pass|fail)\)|^ [0-9]+ (pass|fail)'
  echo "$out" | grep -qE '^ 0 fail' || { echo "$out"; exit 1; }
else
  echo "SKIP engine typecheck, validation and plugin tests: no engine types at $TYPES; hot-reload the mod once, set NEXTUP_TYPES, or copy them to $CACHE"
fi
echo "hook tests:"; hk=$(node --test plugin/hooks/elicit/ask-hook.test.mjs plugin/hooks/elicit/nextup-answer.test.mjs plugin/hooks/permission-wait.test.mjs plugin/hooks/marks-cases.test.mjs plugin/hooks/node-guard.test.mjs 2>&1) || { echo "$hk"; exit 1; }
# Node 22 prints "# pass N" (tap) when not on a terminal, newer Node prints "ℹ pass N"; show whichever, never fail on the summary.
echo "$hk" | grep -E "^(ℹ|#) (pass|fail)" || true
echo "check: PASS"
