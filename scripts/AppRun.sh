#!/bin/sh
set -eu

if [ -z "${APPDIR:-}" ]; then
  APPDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fi

export PATH="${APPDIR}:${APPDIR}/usr/sbin${PATH:+:${PATH}}"
export LD_LIBRARY_PATH="${APPDIR}/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
export XDG_DATA_DIRS="${APPDIR}/usr/share:/usr/local/share:/usr/share${XDG_DATA_DIRS:+:${XDG_DATA_DIRS}}"
export GSETTINGS_SCHEMA_DIR="${APPDIR}/usr/share/glib-2.0/schemas"

exec "$APPDIR/{{.ExecutableName}}" "$@"
