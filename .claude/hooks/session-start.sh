#!/bin/bash
# Installs dependencies in cloud sessions. Silent on success. On failure it
# prints the tail of the log, which lands in Claude's context.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0

log="${TMPDIR:-/tmp}/twototango-session-start.log"
if ! npm ci --no-audit --no-fund >"$log" 2>&1; then
  echo "SessionStart hook: npm ci failed, dependencies may be missing. Last lines of $log:"
  tail -n 20 "$log"
fi
exit 0
