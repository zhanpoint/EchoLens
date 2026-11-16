#!/bin/sh
set -eu

# This volume belongs only to this service. No worker is running yet;
# remove temporary artifacts left by a crash before starting a new process.
find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
chmod 1777 /tmp

exec gosu nextjs "$@"
