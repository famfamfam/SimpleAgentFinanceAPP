#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."

user=${1:?Usage: publish-hestia-backup.sh HESTIA_USER}
case "$user" in ''|*[!a-zA-Z0-9_-]*) echo 'Invalid Hestia user' >&2; exit 1 ;; esac
test "$(id -u)" = 0 || { echo 'Run as root' >&2; exit 1; }
home=$(getent passwd "$user" | cut -d: -f6)
test "$home" = "/home/$user" && test ! -L "$home" || { echo 'Unexpected user home' >&2; exit 1; }
destination="$home/.finance-backup"
test ! -L "$destination" || { echo 'Backup directory must not be a symlink' >&2; exit 1; }
mkdir -p "$destination"
chown root:root "$destination"
chmod 700 "$destination"
test ! -L "$destination/.incoming" || { echo 'Staging directory must not be a symlink' >&2; exit 1; }
mkdir -p "$destination/.incoming"
chown root:root "$destination/.incoming"
chmod 700 "$destination/.incoming"
exclusions=$(sed -n "s/^USER='\(.*\)'$/\1/p" "/usr/local/hestia/data/users/$user/backup-excludes.conf")
case ",$exclusions," in *",*,"*|*",.finance-backup,"*) echo 'Finance backup is excluded from Hestia' >&2; exit 1 ;; esac
case ",$exclusions," in *",.finance-backup/.incoming,"*) ;; *) echo 'Exclude .finance-backup/.incoming from Hestia user directories first' >&2; exit 1 ;; esac

mkdir backups/.hestia-publish-lock || { echo 'Another publication is running' >&2; exit 1; }
work=''
incoming=''
trap 'test -z "$incoming" || rm -f -- "$incoming"; test -z "$work" || rm -rf -- "$work"; rmdir backups/.hestia-publish-lock' EXIT
work=$(mktemp -d "$(pwd)/backups/.hestia-publish.XXXXXX")
snapshot=$(find backups -mindepth 1 -maxdepth 1 -type d -name 'finance-????????T??????Z-*' ! -name '*.partial' | sort | tail -n 1)
test -n "$snapshot" || { echo 'Run scripts/backup.sh first' >&2; exit 1; }
(cd "$snapshot" && sha256sum -c SHA256SUMS > /dev/null)
test -s "$snapshot/runtime-revision" || { echo 'Snapshot has no runtime revision; run scripts/backup.sh again' >&2; exit 1; }
cp "$snapshot/database.dump" "$snapshot/environment" "$snapshot/revision" "$snapshot/runtime-revision" "$work/"
git bundle create "$work/project.bundle" --all
git cat-file -e "$(cat "$work/runtime-revision")^{commit}"
cp deploy/RESTORE.md "$work/RESTORE.md"
(cd "$work" && sha256sum database.dump environment revision project.bundle runtime-revision RESTORE.md > SHA256SUMS)
tar -C "$work" -cf "$work/payload.tar" database.dump environment revision project.bundle runtime-revision RESTORE.md SHA256SUMS
tar -tf "$work/payload.tar" > /dev/null
incoming=$(mktemp "$destination/.incoming/payload.XXXXXX")
cp "$work/payload.tar" "$incoming"
chmod 600 "$incoming"
mv -f "$incoming" "$destination/finance-latest.tar"
printf 'Published for Hestia: %s/finance-latest.tar\n' "$destination"
