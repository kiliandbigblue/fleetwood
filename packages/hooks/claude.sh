#!/bin/sh
# fleetwood — spool one Claude Code hook event.
#
# This runs on nearly every agent event, alongside peon-ping, so it stays cheap:
# no JSON parsing, two forks, and it always exits 0. Anything that could make an
# agent slower or fail is the collector's problem, not the hook's.
#
# The important part is $TMUX_PANE: inherited from the pane the agent was
# launched in, it is what binds this event to a tmux pane.
set -u

dir="${FLEETWOOD_HOME:-$HOME/.fleetwood}/spool"
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || exit 0

payload=$(cat 2>/dev/null)
[ -n "$payload" ] || payload=null

now=$(date +%s)
tmp=$(mktemp "$dir/.tmp.XXXXXX" 2>/dev/null) || exit 0

{
  printf '{"source":"claude","recvAt":%s' "$now"
  printf ',"pane":"%s","tmux":"%s","arg":"%s"' "${TMUX_PANE:-}" "${TMUX:-}" "${1:-}"
  printf ',"env":{"child":"%s","sessionId":"%s","pid":"%s"}' \
    "${CLAUDE_CODE_CHILD_SESSION:-}" "${CLAUDE_CODE_SESSION_ID:-}" "${CLAUDE_PID:-}"
  printf ',"payload":%s}\n' "$payload"
} >"$tmp" 2>/dev/null

# Rename into place so the collector never reads a half-written file.
mv "$tmp" "$dir/$now-$$-${tmp##*.}.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
exit 0
