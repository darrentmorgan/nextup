#!/usr/bin/env bash
# Privacy scan: prints every tracked line that looks personal or secret; no output means clean.
# Checks home paths, email addresses, secret-shaped tokens, data files, and (when NEXTUP_DATA names a
# board folder) any thread or note title from that board appearing in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
files=$(git ls-files | grep -v '^scripts/privacy-scan.sh$')
hit=0
# Made-up fixture paths in tests, removed from each line before the home path check. Keep it short.
fixtures="s#'/Users/x/proj[^']*'##g; s#'/H/developer/_scratch/dispatch'##g"
scan() { # label, extended regex, optional sed script that removes known fixtures first
  local out
  out=$(echo "$files" | xargs grep -nIE "$2" -- 2>/dev/null | sed -E "${3:-}" | grep -E "$2" || true)
  [[ -z $out ]] || { echo "$1:"; echo "$out"; hit=1; }
}
scan 'home path' '(/Users/|/home/|/Volumes/)[A-Za-z0-9._-]+|[Cc]:\\\\Users|~/[Dd]eveloper/|_scratch/' "$fixtures"
scan 'email' '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
# Private terms that must never appear in public files live outside the repo: the gitignored file
# .privacy-private-terms (one regex per line) and/or env var NEXTUP_PRIVATE_TERMS (newline-separated).
terms=${NEXTUP_PRIVATE_TERMS:-}
[[ ! -f .privacy-private-terms ]] || terms+=$'\n'$(cat .privacy-private-terms)
while IFS= read -r t; do [[ -z $t ]] || scan 'private term' "$t"; done <<< "$terms"
scan 'secret' '(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{20}|sk-ant-|sk_live_|AIza[0-9A-Za-z_-]{20}|npm_[A-Za-z0-9]{20}|xox[abp]-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ|[Bb]earer [A-Za-z0-9._-]{20}|-----BEGIN [A-Z ]*PRIVATE KEY)'
data=$(echo "$files" | grep -E '\.(jsonl?|ndjson|csv|tsv|xlsx|db|sqlite|sql|log|pem|key|p12)$|(^|/)\.env' | grep -vE '(^|/)(plugin|marketplace|hooks)\.json$|(^|/)tsconfig\.json$|^\.claude/settings\.json$|^docs/evidence/drawings/[a-z-]+\.json$|^plugin/hooks/elicit/(fixtures|demo)/[a-z.-]+\.json$|^plugin/hooks/fixtures/permission-[a-z-]+\.json$|^scripts/capture/package(-lock)?\.json$|^scripts/fixtures/marks-cases\.json$|^examples/dataDir/(calendar|drafts|notes|threads)\.json$' || true)
[[ -z $data ]] || { echo 'data file:'; echo "$data"; hit=1; }
if [[ -n ${NEXTUP_DATA:-} ]]; then
  dir=${NEXTUP_DATA/#\~/$HOME}
  titles=$(python3 - "$dir" <<'EOF'
import json, sys, os
seen = set()
def walk(v):
    if isinstance(v, dict):
        for k, x in v.items():
            if k in ('title', 'text', 'next', 'summary') and isinstance(x, str) and len(x.strip()) >= 12:
                seen.add(x.strip().split('\n')[0])
            else:
                walk(x)
    elif isinstance(v, list):
        for x in v:
            walk(x)
for name in ('threads.json', 'notes.json'):
    p = os.path.join(sys.argv[1], name)
    if os.path.exists(p):
        walk(json.load(open(p)))
print('\n'.join(sorted(seen)))
EOF
)
  [[ -n $titles ]] || { echo "no board titles read from $dir"; exit 2; }
  out=$(echo "$files" | xargs grep -nIF -f <(echo "$titles") -- 2>/dev/null || true)
  [[ -z $out ]] || { echo 'board data:'; echo "$out"; hit=1; }
fi
exit $hit
