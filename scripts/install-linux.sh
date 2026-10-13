#!/bin/sh
set -eu
unset LD_PRELOAD LD_LIBRARY_PATH NODE_OPTIONS
app_directory=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
export ELECTRON_RUN_AS_NODE=1
exec "$app_directory/nyastra-mod-manager" "$app_directory/install-linux.mjs" "$app_directory" "$@"
