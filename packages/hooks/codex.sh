#!/bin/sh
# fleetwood — spool one Codex notification.
#
# Codex's `notify` hands the event to argv as a single JSON string rather than on
# stdin, so $1 is the payload. Inert until codex is installed and configured with
#   notify = ["/path/to/codex.sh"]
# in ~/.codex/config.toml — see `fw install-hooks`, which prints the exact line.
set -u

dir="${FLEETWOOD_HOME:-$HOME/.fleetwood}/spool"
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || exit 0

payload="${1:-}"
[ -n "$payload" ] || payload=null

now=$(date +%s)
tmp=$(mktemp "$dir/.tmp.XXXXXX" 2>/dev/null) || exit 0

{
  printf '{"source":"codex","recvAt":%s' "$now"
  printf ',"pane":"%s","tmux":"%s"' "${TMUX_PANE:-}" "${TMUX:-}"
  printf ',"payload":%s}\n' "$payload"
} >"$tmp" 2>/dev/null

mv "$tmp" "$dir/$now-$$-${tmp##*.}.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
exit 0
