#!/bin/sh
set -eu

exec gosu nextjs "$@"
