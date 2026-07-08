#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-"$SCRIPT_DIR/compose.yml"}
ENV_FILE=${ENV_FILE:-"$SCRIPT_DIR/.env"}
SQLITE_FILE=${SQLITE_FILE:-echolens.sqlite}
SQLITE_VOLUME=${SQLITE_VOLUME:-}
SQLITE_HOST_DIR=${SQLITE_HOST_DIR:-"$SCRIPT_DIR/data"}
MIGRATION_IMAGE=${MIGRATION_IMAGE:-python:3.12-slim}

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

POSTGRES_DB=${POSTGRES_DB:-echolens}
POSTGRES_USER=${POSTGRES_USER:-postgres}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}

if docker compose version >/dev/null 2>&1; then
  COMPOSE_BIN="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_BIN="docker-compose"
else
  echo "docker compose is required." >&2
  exit 1
fi

compose() {
  # shellcheck disable=SC2086
  $COMPOSE_BIN -f "$COMPOSE_FILE" "$@"
}

find_sqlite_volume() {
  docker volume ls --format '{{.Name}}' | awk '/(^|_)echolens-data$/ { print; exit }'
}

if [ -z "$SQLITE_VOLUME" ]; then
  SQLITE_VOLUME=$(find_sqlite_volume || true)
fi

if [ -n "$SQLITE_VOLUME" ]; then
  SQLITE_MOUNT="type=volume,src=$SQLITE_VOLUME,dst=/sqlite,readonly"
  SQLITE_SOURCE_DESC="docker volume $SQLITE_VOLUME"
elif [ -f "$SQLITE_HOST_DIR/$SQLITE_FILE" ]; then
  SQLITE_MOUNT="type=bind,src=$SQLITE_HOST_DIR,dst=/sqlite,readonly"
  SQLITE_SOURCE_DESC="host directory $SQLITE_HOST_DIR"
else
  echo "No SQLite source found. Set SQLITE_VOLUME or SQLITE_HOST_DIR before running this script." >&2
  exit 1
fi

echo "Stopping echolens before migration..."
docker stop echolens >/dev/null 2>&1 || true
docker rm echolens >/dev/null 2>&1 || true

echo "Starting PostgreSQL..."
compose up -d postgres

POSTGRES_CONTAINER=$(compose ps -q postgres)
if [ -z "$POSTGRES_CONTAINER" ]; then
  echo "PostgreSQL container was not created." >&2
  exit 1
fi

echo "Waiting for PostgreSQL..."
i=0
until compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "PostgreSQL did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done

POSTGRES_NETWORK=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$POSTGRES_CONTAINER" | sed -n '1p')
if [ -z "$POSTGRES_NETWORK" ]; then
  echo "Cannot detect PostgreSQL docker network." >&2
  exit 1
fi

echo "Migrating auth tables from $SQLITE_SOURCE_DESC..."
docker run --rm \
  --network "$POSTGRES_NETWORK" \
  --mount "$SQLITE_MOUNT" \
  -e PGHOST=postgres \
  -e PGDATABASE="$POSTGRES_DB" \
  -e PGUSER="$POSTGRES_USER" \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  -e SQLITE_PATH="/sqlite/$SQLITE_FILE" \
  "$MIGRATION_IMAGE" sh -s <<'MIGRATE'
set -eu

apt-get update >/dev/null
apt-get install -y --no-install-recommends postgresql-client >/dev/null
rm -rf /var/lib/apt/lists/*

python - <<'PY'
import csv
import os
import sqlite3

sqlite_path = os.environ["SQLITE_PATH"]
if not os.path.exists(sqlite_path):
    raise SystemExit(f"SQLite file not found: {sqlite_path}")

tables = {
    "users": ["id", "username", "email", "password_hash", "terms_accepted_at", "created_at", "updated_at"],
    "sessions": ["token_hash", "user_id", "expires_at", "created_at", "last_seen_at"],
    "email_codes": ["id", "email", "purpose", "code_hash", "attempts", "expires_at", "sent_at", "used_at"],
}

connection = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
try:
    counts = {}
    existing = {
        row["name"]
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    for table, columns in tables.items():
        output_path = f"/tmp/{table}.tsv"
        rows = [] if table not in existing else connection.execute(
            f"SELECT {', '.join(columns)} FROM {table}"
        ).fetchall()
        with open(output_path, "w", newline="", encoding="utf-8") as output:
            writer = csv.writer(output, delimiter="\t", lineterminator="\n")
            for row in rows:
                writer.writerow(["\\N" if row[column] is None else row[column] for column in columns])
        counts[table] = len(rows)
    with open("/tmp/source-counts.sql", "w", encoding="utf-8") as output:
        for table, count in counts.items():
            output.write(f"\\echo source_{table}={count}\n")
finally:
    connection.close()
PY

psql -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  terms_accepted_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  last_seen_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_codes (
  id text PRIMARY KEY,
  email text NOT NULL,
  purpose text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at bigint NOT NULL,
  sent_at bigint NOT NULL,
  used_at bigint
);
CREATE INDEX IF NOT EXISTS email_codes_lookup_idx
  ON email_codes(lower(email), purpose, used_at, sent_at DESC);

CREATE OR REPLACE VIEW users_display AS
SELECT
  id,
  username,
  email,
  to_char(timezone('Asia/Shanghai', to_timestamp(terms_accepted_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS terms_accepted_at,
  to_char(timezone('Asia/Shanghai', to_timestamp(created_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS created_at,
  to_char(timezone('Asia/Shanghai', to_timestamp(updated_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS updated_at
FROM users;

CREATE OR REPLACE VIEW sessions_display AS
SELECT
  token_hash,
  user_id,
  to_char(timezone('Asia/Shanghai', to_timestamp(expires_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS expires_at,
  to_char(timezone('Asia/Shanghai', to_timestamp(created_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS created_at,
  to_char(timezone('Asia/Shanghai', to_timestamp(last_seen_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS last_seen_at
FROM sessions;

CREATE OR REPLACE VIEW email_codes_display AS
SELECT
  id,
  email,
  purpose,
  code_hash,
  attempts,
  to_char(timezone('Asia/Shanghai', to_timestamp(expires_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS expires_at,
  to_char(timezone('Asia/Shanghai', to_timestamp(sent_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS sent_at,
  to_char(timezone('Asia/Shanghai', to_timestamp(used_at::double precision / 1000)), 'YYYY"年"MM"月"DD"日" HH24:MI') AS used_at
FROM email_codes;

CREATE TEMP TABLE tmp_users (
  id text,
  username text,
  email text,
  password_hash text,
  terms_accepted_at bigint,
  created_at bigint,
  updated_at bigint
);
CREATE TEMP TABLE tmp_sessions (
  token_hash text,
  user_id text,
  expires_at bigint,
  created_at bigint,
  last_seen_at bigint
);
CREATE TEMP TABLE tmp_email_codes (
  id text,
  email text,
  purpose text,
  code_hash text,
  attempts integer,
  expires_at bigint,
  sent_at bigint,
  used_at bigint
);

\copy tmp_users FROM '/tmp/users.tsv' WITH (FORMAT csv, DELIMITER E'\t', NULL '\N')
\copy tmp_sessions FROM '/tmp/sessions.tsv' WITH (FORMAT csv, DELIMITER E'\t', NULL '\N')
\copy tmp_email_codes FROM '/tmp/email_codes.tsv' WITH (FORMAT csv, DELIMITER E'\t', NULL '\N')

INSERT INTO users (id, username, email, password_hash, terms_accepted_at, created_at, updated_at)
SELECT id, username, email, password_hash, terms_accepted_at, created_at, updated_at
FROM tmp_users
ON CONFLICT (id) DO UPDATE SET
  username = excluded.username,
  email = excluded.email,
  password_hash = excluded.password_hash,
  terms_accepted_at = excluded.terms_accepted_at,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
SELECT token_hash, user_id, expires_at, created_at, last_seen_at
FROM tmp_sessions
ON CONFLICT (token_hash) DO UPDATE SET
  user_id = excluded.user_id,
  expires_at = excluded.expires_at,
  created_at = excluded.created_at,
  last_seen_at = excluded.last_seen_at;

INSERT INTO email_codes (id, email, purpose, code_hash, attempts, expires_at, sent_at, used_at)
SELECT id, email, purpose, code_hash, attempts, expires_at, sent_at, used_at
FROM tmp_email_codes
ON CONFLICT (id) DO UPDATE SET
  email = excluded.email,
  purpose = excluded.purpose,
  code_hash = excluded.code_hash,
  attempts = excluded.attempts,
  expires_at = excluded.expires_at,
  sent_at = excluded.sent_at,
  used_at = excluded.used_at;

DO $$
DECLARE
  missing_users integer;
  missing_sessions integer;
  missing_email_codes integer;
BEGIN
  SELECT count(*) INTO missing_users
  FROM tmp_users source
  LEFT JOIN users target ON target.id = source.id
  WHERE target.id IS NULL;

  SELECT count(*) INTO missing_sessions
  FROM tmp_sessions source
  LEFT JOIN sessions target ON target.token_hash = source.token_hash
  WHERE target.token_hash IS NULL;

  SELECT count(*) INTO missing_email_codes
  FROM tmp_email_codes source
  LEFT JOIN email_codes target ON target.id = source.id
  WHERE target.id IS NULL;

  IF missing_users <> 0 OR missing_sessions <> 0 OR missing_email_codes <> 0 THEN
    RAISE EXCEPTION 'auth migration verification failed: users %, sessions %, email_codes %',
      missing_users, missing_sessions, missing_email_codes;
  END IF;
END $$;

COMMIT;

\i /tmp/source-counts.sql
SELECT
  (SELECT count(*) FROM tmp_users) AS migrated_users,
  (SELECT count(*) FROM tmp_sessions) AS migrated_sessions,
  (SELECT count(*) FROM tmp_email_codes) AS migrated_email_codes;
SQL
MIGRATE

echo "Migration succeeded. Removing SQLite source..."
if [ -n "$SQLITE_VOLUME" ]; then
  docker volume rm "$SQLITE_VOLUME"
else
  rm -f "$SQLITE_HOST_DIR/$SQLITE_FILE" \
    "$SQLITE_HOST_DIR/$SQLITE_FILE-wal" \
    "$SQLITE_HOST_DIR/$SQLITE_FILE-shm"
  rmdir "$SQLITE_HOST_DIR" 2>/dev/null || true
fi

echo "Starting echolens..."
compose up -d echolens

echo "Done."
