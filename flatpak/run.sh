#!/bin/sh
case "${1-}" in
  [nN][xX][mM]:*) set -- --download "$@" ;;
esac
exec zypak-wrapper /app/main/vortex "$@"
