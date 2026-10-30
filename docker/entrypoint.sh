#!/bin/sh
# Pornește ca root doar cât să pregătească folderul de date, apoi rulează aplicația
# ca PUID:PGID (implicit 99:100 = nobody:users pe Unraid).
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
DATA="${DRAWCAD_DATA:-${COTARE_DATA:-/data}}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # chown recursiv doar când proprietarul nu e cel așteptat (folder nou sau mutat)
  if [ "$(stat -c %u:%g "$DATA")" != "$PUID:$PGID" ]; then
    echo "drawcad: ajustez proprietarul $DATA la $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA"
  fi
  # HOME-ul lui root nu e accesibil utilizatorului aplicației; bibliotecile își caută acolo configurări
  export HOME=/tmp
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi

# rulat deja ca utilizator ne-root (ex. „user:” în compose): folderul trebuie să fie scriibil
if ! touch "$DATA/.scriere-test" 2>/dev/null; then
  echo "drawcad: $DATA nu poate fi scris de utilizatorul $(id -u):$(id -g)" >&2
  exit 1
fi
rm -f "$DATA/.scriere-test"
exec "$@"
