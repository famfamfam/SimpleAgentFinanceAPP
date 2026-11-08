#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
mkdir -p backups
mkdir backups/.maintenance-lock || { echo 'An update or backup is running; check backups/.maintenance-lock' >&2; exit 1; }
trap 'rmdir backups/.maintenance-lock' EXIT
container=$(docker compose ps -q api)
test -n "$container" || { echo 'Finance API must be running' >&2; exit 1; }
label=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
runtime=$(git rev-parse --verify "${label}^{commit}") || { echo 'Image has no recoverable Git revision; deploy with scripts/update.sh first' >&2; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="backups/finance-${stamp}-$$"
mkdir "${target}.partial"
docker compose exec -T db pg_dump -U finance -d finance -Fc > "${target}.partial/database.dump"
test -s "${target}.partial/database.dump"
docker compose exec -T db pg_restore --list < "${target}.partial/database.dump" > /dev/null
cp .env "${target}.partial/environment"
git rev-parse HEAD > "${target}.partial/revision"
printf '%s\n' "$runtime" > "${target}.partial/runtime-revision"
(cd "${target}.partial" && sha256sum database.dump environment revision runtime-revision > SHA256SUMS)
mv "${target}.partial" "$target"
find backups -mindepth 1 -maxdepth 1 -type d -name 'finance-????????T??????Z-*' -mtime +13 -exec rm -rf -- {} +
printf 'Backup verified: %s\n' "$target"
