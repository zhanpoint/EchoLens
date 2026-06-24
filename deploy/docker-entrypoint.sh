#!/bin/sh
set -eu

sqlite_path="${SQLITE_PATH:-/app/data/echolens.sqlite}"
case "$sqlite_path" in
  /*) data_dir="$(dirname "$sqlite_path")" ;;
  *) data_dir="/app/$(dirname "$sqlite_path")" ;;
esac

mkdir -p "$data_dir"
chown nextjs:nodejs "$data_dir"

for file in "$sqlite_path" "$sqlite_path-wal" "$sqlite_path-shm"; do
  if [ -e "$file" ]; then
    chown nextjs:nodejs "$file"
  fi
done

exec gosu nextjs "$@"
