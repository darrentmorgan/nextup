#!/usr/bin/env bash
# Saves the element trees the drawing-evidence tests print (EVIDENCE <name> <json>) to
# docs/evidence/drawings/<name>.json: what each surface is handed to draw, not its paint.
# Run scripts/check.sh first; it leaves the scratch copy this reads.
set -euo pipefail
cd "$(dirname "$0")/.."
LIVE=${NEXTUP_LIVE:-${TMPDIR:-/tmp}/nextup-check/nextup}
OUT=docs/evidence/drawings
[[ -d $LIVE ]] || { echo "no scratch copy at $LIVE; run scripts/check.sh first"; exit 1; }
out=$(claude plugin test "$LIVE" 2>&1) || { echo "$out"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"
echo "$out" | grep '^EVIDENCE ' | python3 -c '
import json, re, sys
def norm(v, ids):
    # Press handles, tool-call ids and run times differ per run; normalise them so the trees are byte-stable.
    if isinstance(v, dict):
        return {k: norm(x, ids) for k, x in v.items() if k != "handle"}
    if isinstance(v, list):
        return [norm(x, ids) for x in v]
    if isinstance(v, str):
        v = re.sub(r"toolu_[0-9a-f]{32}", lambda m: ids.setdefault(m.group(0), f"toolu_{len(ids) + 1}"), v)
        return re.sub(r"^\d+ms$", "#ms", v)
    return v
for line in sys.stdin:
    _, name, tree = line.rstrip("\n").split(" ", 2)
    with open(f"'"$OUT"'/{name}.json", "w") as f:
        json.dump(norm(json.loads(tree), {}), f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(name)
'
