#!/bin/sh
set -eu
umask 077
release=''
if test "$#" = 1; then
    case "$1" in /*) ;; *) echo 'Use an absolute installation path' >&2; exit 1 ;; esac
    release=$(cd "$(dirname "$0")" && pwd)
    for file in image.tar project.bundle revision image install.sh SHA256SUMS; do
        test -f "$release/$file" && test ! -L "$release/$file" || { echo "Missing release file: $file" >&2; exit 1; }
    done
    (cd "$release" && sha256sum image.tar project.bundle revision image install.sh | cmp - SHA256SUMS)
    expected=$(cat "$release/revision")
    printf '%s\n' "$expected" | grep -Eq '^[a-f0-9]{40}$' || { echo 'Invalid release revision' >&2; exit 1; }
    test "$(git bundle list-heads "$release/project.bundle" HEAD | cut -d' ' -f1)" = "$expected" || { echo 'Bundle does not match release' >&2; exit 1; }
    if test ! -d "$1/.git"; then
        git clone "$release/project.bundle" "$1"
        chmod 700 "$1"
    fi
    cd "$1"
elif test "$#" = 0; then
    cd "$(dirname "$0")/.."
else
    echo 'Usage: sh install.sh /absolute/project/path' >&2; exit 1
fi
test -f .env || { echo 'Create .env before deploying' >&2; exit 1; }
mkdir -p backups
mkdir backups/.maintenance-lock || { echo 'An update or backup is running; check backups/.maintenance-lock' >&2; exit 1; }
trap 'rmdir backups/.maintenance-lock' EXIT
test -z "$(git status --porcelain)" || { echo 'Commit or remove uncommitted files before deploying' >&2; exit 1; }
if test -n "$release"; then
    git fetch "$release/project.bundle" HEAD
    git merge --ff-only "$expected"
    docker load -i "$release/image.tar"
    PREBUILT_IMAGE=$(cat "$release/image")
    case "$PREBUILT_IMAGE" in financeapp:*) ;; *) echo 'Unexpected image repository' >&2; exit 1 ;; esac
    test "$(docker image inspect --format '{{index .Config.Labels "io.financeapp.component"}}' "$PREBUILT_IMAGE")" = api || { echo 'Not a Finance release image' >&2; exit 1; }
fi
container=$(docker compose ps -q api)
previous=not-started
if test -n "$container"; then previous=$(docker inspect --format '{{.Image}}' "$container"); fi
revision=$(git rev-parse --short HEAD)
stamp=$(date -u +%Y%m%d-%H%M%S)
export APP_VERSION="$revision"
export APP_IMAGE="financeapp:${revision}-${stamp}"
if test -n "${PREBUILT_IMAGE:-}"; then
    export APP_IMAGE="$PREBUILT_IMAGE"
    built_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$APP_IMAGE")
    test "$built_revision" = "$revision" || { echo 'Prebuilt image does not match this Git checkout' >&2; exit 1; }
else
    docker compose build api
fi
if test -z "$container"; then docker compose up -d --wait db redis; fi
backup="backups/finance-${stamp}.dump"
docker compose exec -T db pg_dump -U finance -d finance -Fc -f "/tmp/finance-${stamp}.dump"
docker compose exec -T db pg_restore --list "/tmp/finance-${stamp}.dump" > /dev/null
docker compose cp "db:/tmp/finance-${stamp}.dump" "$backup"
docker compose exec -T db rm "/tmp/finance-${stamp}.dump"
test -s "$backup"
printf 'previous_image=%s\nimage=%s\nbackup=%s\nversion=%s\n' "$previous" "$APP_IMAGE" "$backup" "$revision" > "backups/update-${stamp}.txt"
# Failed migrations leave the current API running and do not change database data.
docker compose run --rm --no-deps api migrate
docker compose up -d --no-deps --no-build --wait --wait-timeout 90 api
awk '!/^(APP_IMAGE|APP_VERSION)=/' .env > .env.next
printf 'APP_IMAGE=%s\nAPP_VERSION=%s\n' "$APP_IMAGE" "$APP_VERSION" >> .env.next
mv .env.next .env
current=$(docker image inspect --format '{{.Id}}' "$APP_IMAGE")
test -n "$current" || { echo 'Cannot identify deployed image' >&2; exit 1; }
if test "$previous" = "$current" && test -f backups/retained-images; then previous=$(sed -n '2p' backups/retained-images); fi
printf '%s\n%s\n' "$current" "$previous" > backups/retained-images.next
mv backups/retained-images.next backups/retained-images
if test -n "$release"; then rm -f -- "$release/image.tar"; fi
rmdir backups/.maintenance-lock
trap - EXIT
if ! sh scripts/cleanup.sh; then echo 'Update succeeded; inspect cleanup failure separately' >&2; fi
printf 'Updated to %s. Database backup: %s\n' "$revision" "$backup"
