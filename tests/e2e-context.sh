#!/usr/bin/env bash
#
# End-to-end check: does a CodeBuddy model keep context across turns in omp?
#
# Run this in YOUR OWN terminal (not from an agent shell) — omp needs a real
# session and working CodeBuddy auth, which an embedded shell may not have.
#
#   bash tests/e2e-context.sh
#
# PASS: the second answer contains 7391.
# FAIL: it says it has no previous context / asks what you mean.
#
# To also check the credit status bar, run `omp` interactively afterwards and
# look at the footer row — it should show "会话 … cr · 剩余 …/… cr".
#
set -u
MODEL="${MODEL:-codebuddy/hy4-preview}"
DIR="${TMPDIR:-/tmp}/omp-e2e-context"
mkdir -p "$DIR"
cd "$DIR" || exit 1

echo "=== turn 1: remember a number ==="
omp -p --model "$MODEL" "请记住这个数字：7391。只回复两个字：好的"

echo
echo "=== turn 2: ask for it back (continues the same session) ==="
ANSWER="$(omp -p -c --model "$MODEL" "我上一条消息让你记住的数字是多少？只回复那个数字，不要解释")"
echo "$ANSWER"

echo
if echo "$ANSWER" | grep -q "7391"; then
	echo "PASS — context was carried across turns (resume works)"
	exit 0
fi
echo "FAIL — the model did not see turn 1; context is still being lost"
exit 1
