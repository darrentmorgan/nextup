#!/usr/bin/env bash
# Test: cut-public.sh builds a one-commit repo with no remote from a stub list, and refuses bad input.
set -uo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pass=0; failn=0
want_user=darrentmorgan; want_host=users.noreply.github.com; want="${want_user}@${want_host}"
ok() { if [[ $1 == 0 ]]; then pass=$((pass + 1)); else failn=$((failn + 1)); echo "FAIL: $2"; fi; }
# A stub list that names two real files; the scans in the copy may fail (stub is not a full repo), so only
# the copy, commit and remote facts are asserted.
printf '# stub\nscripts/privacy-scan.sh\nscripts/check.sh\n' > "$tmp/list.txt"
out=$(CUT_LIST="$tmp/list.txt" bash scripts/cut-public.sh "$tmp/cut" 2>&1); rc=$?
ok $([[ $rc == 0 || $rc == 1 ]]; echo $?) "script ran (rc=$rc)"
ok $([[ -f $tmp/cut/scripts/check.sh && ! -e $tmp/cut/scripts/lint-press.mjs ]]; echo $?) "only listed files copied"
ok $([[ $(git -C "$tmp/cut" rev-list --count HEAD) == 1 ]]; echo $?) "exactly one commit"
ok $([[ -z $(git -C "$tmp/cut" remote) ]]; echo $?) "no remote"
ok $([[ $(git -C "$tmp/cut" log -1 --format=%ae) == "$want" ]]; echo $?) "noreply identity"
ok $([[ $out == *"privacy-scan:"* && $out == *"gitleaks:"* && $out == *"check:"* ]]; echo $?) "three scan results printed"
# Refuses a non-empty destination.
CUT_LIST="$tmp/list.txt" bash scripts/cut-public.sh "$tmp/cut" >/dev/null 2>&1; ok $([[ $? == 2 ]]; echo $?) "refuses non-empty dir"
# Fails clearly when the list is missing.
CUT_LIST="$tmp/none.txt" bash scripts/cut-public.sh "$tmp/cut2" >/dev/null 2>&1; ok $([[ $? == 2 && ! -e $tmp/cut2 ]]; echo $?) "fails on missing list"
# Missing listed file fails unless allowed.
printf 'nope.txt\nscripts/check.sh\n' > "$tmp/l2.txt"
CUT_LIST="$tmp/l2.txt" bash scripts/cut-public.sh "$tmp/cut3" >/dev/null 2>&1; ok $([[ $? == 1 ]]; echo $?) "missing listed file fails"
# The script never pushes or calls gh.
ok $(! grep -nE 'git +push|remote +add|(^|[^a-z])gh +' scripts/cut-public.sh | grep -vE '^[0-9]+:\s*#' | grep -q .; echo $?) "no push/remote/gh in script"
echo "cut-public tests: $pass passed, $failn failed"
[[ $failn == 0 ]]
