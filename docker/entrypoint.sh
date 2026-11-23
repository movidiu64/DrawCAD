#!/bin/sh
# Starts as root only long enough to prepare the data folder, then runs the app
# as PUID:PGID (default 99:100 = nobody:users on Unraid).
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
DATA="${DRAWCAD_DATA:-${COTARE_DATA:-/data}}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # recursive chown only when the owner is not the expected one (new or moved folder)
  if [ "$(stat -c %u:%g "$DATA")" != "$PUID:$PGID" ]; then
    echo "drawcad: setting the owner of $DATA to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA"
  fi
  # root's HOME is not accessible to the app user; libraries look for their config there
  export HOME=/tmp
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi

# already running as a non-root user (e.g. "user:" in compose): the folder must be writable
if ! touch "$DATA/.write-test" 2>/dev/null; then
  echo "drawcad: $DATA is not writable by user $(id -u):$(id -g)" >&2
  exit 1
fi
rm -f "$DATA/.write-test"
exec "$@"
