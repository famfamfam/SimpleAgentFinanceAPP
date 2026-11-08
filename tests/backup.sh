#!/bin/sh
# Run in a disposable Linux container without host mounts or network; see DEVELOPMENT.md.
set -eu
test -f /.dockerenv && test "$(id -u)" = 0 || { echo 'Use a disposable root Docker container' >&2; exit 1; }
source=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
user="finance-backup-test-$$"
export FIXTURE="$fixture" FIXTURE_USER="$user"
trap 'rm -rf -- "$fixture" "/home/$user" "/usr/local/hestia/data/users/$user"' EXIT
mkdir -p "$fixture/repo/scripts" "$fixture/repo/deploy" "$fixture/bin" "/home/$user" "/usr/local/hestia/data/users/$user"
cp "$source/scripts/backup.sh" "$source/scripts/update.sh" "$source/scripts/publish-hestia-backup.sh" "$source/scripts/cleanup.sh" "$fixture/repo/scripts/"
cp "$source/deploy/RESTORE.md" "$fixture/repo/deploy/"
cat > "$fixture/bin/getent" <<'EOF'
#!/bin/sh
printf '%s:x:1000:1000::/home/%s:/bin/sh\n' "$FIXTURE_USER" "$FIXTURE_USER"
EOF
cat > "$fixture/bin/date" <<'EOF'
#!/bin/sh
case "$*" in
  '-u +%Y%m%d-%H%M%S') printf '20261107-120000\n' ;;
  '-u +%Y%m%dT%H%M%SZ') printf '20261107T120000Z\n' ;;
  *) exit 1 ;;
esac
EOF
cat > "$fixture/bin/docker" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FIXTURE/calls"
case "$*" in
  'compose ps -q api') test -f "$FIXTURE/no-api" || printf 'fixture-api\n' ;;
  'inspect --format {{.Image}} fixture-api') if test -f "$FIXTURE/active-image"; then cat "$FIXTURE/active-image"; else printf 'fixture-old-image\n'; fi ;;
  inspect*) cat "$FIXTURE/runtime" ;;
  'image inspect --format {{.Id}} '*) printf 'sha256:1111111111111111111111111111111111111111111111111111111111111111\n' ;;
  'image inspect --format {{index .Config.Labels "io.financeapp.component"}} '*)
    case "$*" in *99999999*) printf 'other\n';; *) printf 'api\n';; esac ;;
  'image inspect --format {{index .Config.Labels "org.opencontainers.image.revision"}} '*)
    case "$*" in *99999999*) printf 'unknown-revision\n';; *) git rev-parse --short HEAD;; esac ;;
  'image inspect --format {{range .RepoTags}}{{println .}}{{end}} '*)
    case "$*" in
      *33333333*) printf 'financeapp:old-a\nfinanceapp:old-b\n';;
      *55555555*) printf 'financeapp:shared\nother-app:shared\n';;
    esac ;;
  'image ls '*) if test -f "$FIXTURE/images"; then cat "$FIXTURE/images"; fi ;;
  'ps -aq --filter ancestor='*) case "$*" in *44444444*) printf 'other-app-container\n';; esac ;;
  'compose exec -T db pg_dump '*)
    target=''
    previous=''
    for arg do
      if test "$previous" = -f; then target=$arg; fi
      previous=$arg
    done
    if test -n "$target"; then printf 'fixture dump\n' > "$target"; else printf 'fixture dump\n'; fi ;;
  'compose exec -T db pg_restore --list') cat > /dev/null ;;
  'compose cp '*) cp "${3#db:}" "$4" ;;
  'compose exec -T db rm '*) rm -- "$6" ;;
  'compose run --rm --no-deps api migrate') test ! -f "$FIXTURE/fail-migration" ;;
  'compose up -d --no-deps --no-build --wait --wait-timeout 90 api') test ! -f "$FIXTURE/fail-health" ;;
esac
EOF
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"
cd "$fixture/repo"
printf '/backups/\n.env\n.env.next\n' > .gitignore
git init -q -b main
git add .
git -c user.name=Test -c user.email=test@example.invalid commit -qm fixture
first=$(git rev-parse HEAD)
printf '%s\n' "$first" > "$fixture/runtime"
printf 'APP_SECRET=fixture-only\nAPP_IMAGE=old\nAPP_VERSION=old\n' > .env
printf "USER='.finance-backup/.incoming'\n" > "/usr/local/hestia/data/users/$user/backup-excludes.conf"
expect_failure() {
  if "$@" > "$fixture/stdout" 2> "$fixture/stderr"; then echo 'Expected failure' >&2; exit 1; fi
}

# The same lock stops either operation before it touches Docker.
mkdir -p backups/.maintenance-lock
: > "$fixture/calls"
expect_failure sh scripts/backup.sh
expect_failure sh scripts/update.sh
test ! -s "$fixture/calls"
rmdir backups/.maintenance-lock

# First deployment starts dependencies and persists a real, recoverable revision.
touch "$fixture/no-api"
sh scripts/update.sh > /dev/null
grep -q '^compose up -d --wait db redis$' "$fixture/calls"
grep -q "^APP_VERSION=$(git rev-parse --short HEAD)$" .env
test ! -d backups/.maintenance-lock
rm "$fixture/no-api"
printf 'uncommitted\n' > dirty.txt
expect_failure sh scripts/update.sh
test ! -d backups/.maintenance-lock
rm dirty.txt
sh scripts/backup.sh > /dev/null
snapshot=$(find backups -name 'finance-*.partial' -prune -o -type d -name 'finance-????????T??????Z-*' -print)
test "$(cat "$snapshot/runtime-revision")" = "$first"
(cd "$snapshot" && sha256sum -c SHA256SUMS > /dev/null)

# Publication uses the revision saved with the dump, even after API/source updates.
printf 'next source\n' > next.txt
git add next.txt
git -c user.name=Test -c user.email=test@example.invalid commit -qm next
git rev-parse HEAD > "$fixture/runtime"
sh scripts/publish-hestia-backup.sh "$user" > /dev/null
published="/home/$user/.finance-backup/finance-latest.tar"
test "$(tar -xOf "$published" runtime-revision)" = "$first"
test "$(stat -c %a "$published")" = 600
test "$(stat -c %a "/home/$user/.finance-backup")" = 700
mkdir "$fixture/restored"
tar -xf "$published" -C "$fixture/restored"
(cd "$fixture/restored" && sha256sum -c SHA256SUMS > /dev/null)
git clone -q "$fixture/restored/project.bundle" "$fixture/recovered"
git -C "$fixture/recovered" cat-file -e "$first^{commit}"
before=$(sha256sum "$published")

# Bad image metadata, migration errors and corrupt dumps leave the prior copy intact.
for label in dev "${first}-dirty"; do
  printf '%s\n' "$label" > "$fixture/runtime"
  expect_failure sh scripts/backup.sh
  test ! -d backups/.maintenance-lock
done
touch "$fixture/fail-migration"
environment=$(sha256sum .env)
expect_failure sh scripts/update.sh
test "$environment" = "$(sha256sum .env)"
test ! -d backups/.maintenance-lock
printf 'corrupt\n' >> "$snapshot/database.dump"
expect_failure sh scripts/publish-hestia-backup.sh "$user"
test "$before" = "$(sha256sum "$published")"
test ! -d backups/.hestia-publish-lock
printf "USER='*'\n" > "/usr/local/hestia/data/users/$user/backup-excludes.conf"
expect_failure sh scripts/publish-hestia-backup.sh "$user"
test "$before" = "$(sha256sum "$published")"

# A single archive installer validates all payload files before changing the checkout.
mkdir "$fixture/release"
cp scripts/update.sh "$fixture/release/install.sh"
git bundle create "$fixture/release/project.bundle" --all
git rev-parse HEAD > "$fixture/release/revision"
printf 'financeapp:%s\n' "$(git rev-parse --short HEAD)" > "$fixture/release/image"
printf 'fixture image\n' > "$fixture/release/image.tar"
(cd "$fixture/release" && sha256sum image.tar project.bundle revision image install.sh > SHA256SUMS)
rm "$fixture/fail-migration"
package_head=$(git rev-parse HEAD)
git checkout -q --detach "$first"
sh "$fixture/release/install.sh" "$fixture/repo" > /dev/null
test "$(git rev-parse HEAD)" = "$package_head"
test ! -f "$fixture/release/image.tar"
printf 'corrupt image\n' > "$fixture/release/image.tar"
: > "$fixture/calls"
expect_failure sh "$fixture/release/install.sh" "$fixture/repo"
test ! -s "$fixture/calls"

# Cleanup keeps current/previous and any image referenced by another container or tag.
current=sha256:1111111111111111111111111111111111111111111111111111111111111111
previous=sha256:2222222222222222222222222222222222222222222222222222222222222222
printf '%s\n%s\n' "$current" "$previous" > backups/retained-images
printf '%s\n' "$current" "$previous" \
  sha256:3333333333333333333333333333333333333333333333333333333333333333 \
  sha256:4444444444444444444444444444444444444444444444444444444444444444 \
  sha256:5555555555555555555555555555555555555555555555555555555555555555 \
  sha256:9999999999999999999999999999999999999999999999999999999999999999 > "$fixture/images"
: > "$fixture/calls"
sh scripts/cleanup.sh > /dev/null
grep '^image rm ' "$fixture/calls" > "$fixture/removed"
printf 'image rm financeapp:old-a\nimage rm financeapp:old-b\n' > "$fixture/expected"
cmp "$fixture/removed" "$fixture/expected"
test ! -d backups/.maintenance-lock
# Only deployment dumps with their own matching update record are rotated.
for day in 01 02 03 04 05 06 07; do
    dump="backups/finance-200001${day}-000000.dump"
    printf 'fixture dump\n' > "$dump"
    printf 'backup=%s\n' "$dump" > "backups/update-200001${day}-000000.txt"
done
printf 'manual copy\n' > backups/finance-19990101-000000.dump
printf 'unrelated\n' > backups/update-19990101-000000.txt
ln -s finance-19990101-000000.dump backups/finance-19990102-000000.dump
printf 'backup=backups/finance-19990102-000000.dump\n' > backups/update-19990102-000000.txt
sh scripts/cleanup.sh > /dev/null
test ! -f backups/finance-20000101-000000.dump
test ! -f backups/update-20000101-000000.txt
test -f backups/finance-20000107-000000.dump
test -f backups/finance-19990101-000000.dump
test -L backups/finance-19990102-000000.dump
count=0
for dump in backups/finance-200001??-000000.dump; do
    test ! -f "$dump" || count=$((count + 1))
done
# The current deployment dump also counts toward the five retained releases.
test "$count" = 4

printf '%s\n' "$current" > "$fixture/active-image"
sh scripts/update.sh > /dev/null
test "$(sed -n '2p' backups/retained-images)" = "$previous"
touch "$fixture/fail-health"
environment=$(sha256sum .env backups/retained-images)
: > "$fixture/calls"
expect_failure sh scripts/update.sh
test "$environment" = "$(sha256sum .env backups/retained-images)"
test -z "$(grep '^image rm ' "$fixture/calls" || true)"
test ! -d backups/.maintenance-lock
printf 'Backup/release checks passed: shared lock, first deployment, snapshot revision, archive validation, scoped image cleanup.\n'
