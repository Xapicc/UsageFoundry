#!/bin/sh
cat > /dev/null
echo "hook ran DEFER_ON=${DEFER_ON:-unset}" >> "$HOOK_LOG"
echo "hook stderr line" >&2
if [ "${DEFER_ON:-0}" = "1" ]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer","permissionDecisionReason":"deferred by test hook"}}'
fi
exit 0
