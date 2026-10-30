#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYASH_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI="$PYASH_ROOT/command/unified-writer-cli.mjs"

# Ensure Grey has a default submit command so --post does not silently skip.
if [[ -z "${GREY_LEMMY_POST_COMMAND:-}" && -z "${MEETING_POST_COMMAND:-}" ]]; then
  export GREY_LEMMY_POST_COMMAND="node $SCRIPT_DIR/program/publish-meeting-to-helpos-from-payload.mjs"
fi

# Compatibility behavior:
# - no args => next
# - first arg is a flag => next + flags
# - first arg is a command => pass through command surface
if [[ $# -eq 0 ]]; then
  exec node "$CLI" next --writer grey
fi

if [[ "$1" == "--list" ]]; then
  shift
  exec node "$CLI" list --writer grey "$@"
fi

if [[ "$1" == "--meeting" || "$1" == --meeting* ]]; then
  exec node "$CLI" run --writer grey "$@"
fi

case "$1" in
  -*)
    exec node "$CLI" next --writer grey "$@"
    ;;
  *)
    CMD="$1"
    shift
    exec node "$CLI" "$CMD" --writer grey "$@"
    ;;
esac
