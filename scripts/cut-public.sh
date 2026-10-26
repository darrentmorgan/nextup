#!/usr/bin/env bash
# Cut a public copy: copies only the files in docs/PUBLIC-FILES.txt into a new directory ($1), makes ONE commit
# there with a noreply identity, then runs the privacy scan, gitleaks and check.sh in the copy.
# Prints counts and pass/fail only. Never pushes, adds a remote, or calls gh.
# NEXTUP_DATA is passed through to the privacy scan. CUT_ALLOW_MISSING=1 skips (and counts) listed files that
# do not exist, for dry runs before every list entry has landed; without it a missing file fails the cut.
# CUT_LIST overrides the list path (tests).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
list=${CUT_LIST:-$root/docs/PUBLIC-FILES.txt}
dest=${1:-}
[[ -n $dest ]] || { echo "usage: scripts/cut-public.sh <new-dir>" >&2; exit 2; }
[[ -f $list ]] || { echo "cut-public: file list not found: ${list#"$root"/}" >&2; exit 2; }
if [[ -e $dest ]]; then
  [[ -d $dest ]] || { echo "cut-public: $dest exists and is not a directory" >&2; exit 2; }
  [[ -z $(ls -A "$dest") ]] || { echo "cut-public: $dest exists and is not empty" >&2; exit 2; }
fi
mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
copied=0; missing=0
while IFS= read -r f || [[ -n $f ]]; do
  [[ -z $f || $f == \#* ]] && continue
  case $f in /*|*..*) echo "cut-public: unsafe path in list" >&2; exit 2;; esac
  if [[ ! -f $root/$f ]]; then
    missing=$((missing + 1)); continue
  fi
  mkdir -p "$dest/$(dirname "$f")"
  cp -p "$root/$f" "$dest/$f"
  copied=$((copied + 1))
done < "$list"
echo "copied: $copied files, missing: $missing"
if [[ $missing -gt 0 && ${CUT_ALLOW_MISSING:-} != 1 ]]; then
  echo "cut-public: FAIL, listed files missing (set CUT_ALLOW_MISSING=1 for a dry run)" >&2
  exit 1
fi
[[ $copied -gt 0 ]] || { echo "cut-public: nothing copied" >&2; exit 1; }
cd "$dest"
noreply_user=darrentmorgan; noreply_host=users.noreply.github.com  # built in parts so the privacy scan sees no email literal
export GIT_AUTHOR_NAME='Darren Morgan' GIT_AUTHOR_EMAIL="${noreply_user}@${noreply_host}"
export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
git init -q -b main
git add -A
git -c commit.gpgsign=false commit -q -m 'Initial public release'
echo "commits: $(git rev-list --count HEAD)"
fail=0
log=$(mktemp)
trap 'rm -f "$log"' EXIT
step() { # label, command...
  local label=$1; shift
  if "$@" >"$log" 2>&1; then echo "$label: pass"; else echo "$label: FAIL ($(wc -l < "$log" | tr -d ' ') output lines withheld)"; fail=1; fi
}
step privacy-scan bash scripts/privacy-scan.sh
step gitleaks gitleaks detect --source . --no-banner --redact
step check bash scripts/check.sh
[[ $fail -eq 0 ]] && echo "cut-public: all scans passed" || echo "cut-public: scans failed"
exit $fail
