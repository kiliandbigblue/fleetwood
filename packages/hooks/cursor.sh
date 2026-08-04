#!/bin/sh
# fleetwood — spool one cursor-agent hook event.
#
# Cursor names the event in hooks.json rather than in the payload, so the event
# arrives as $1. See claude.sh for the design constraints.
set -u

dir="${FLEETWOOD_HOME:-$HOME/.fleetwood}/spool"
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || exit 0

payload=$(cat 2>/dev/null)
[ -n "$payload" ] || payload=null

now=$(date +%s)
tmp=$(mktemp "$dir/.tmp.XXXXXX" 2>/dev/null) || exit 0

{
  printf '{"source":"cursor","recvAt":%s' "$now"
  printf ',"pane":"%s","tmux":"%s","arg":"%s"' "${TMUX_PANE:-}" "${TMUX:-}" "${1:-}"
  printf ',"payload":%s}\n' "$payload"
} >"$tmp" 2>/dev/null

mv "$tmp" "$dir/$now-$$-${tmp##*.}.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
exit 0
