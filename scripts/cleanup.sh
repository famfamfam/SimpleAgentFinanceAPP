#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
test -s backups/retained-images || { echo 'No successful release retention record' >&2; exit 1; }
mkdir backups/.maintenance-lock || { echo 'An update or backup is running' >&2; exit 1; }
trap 'rmdir backups/.maintenance-lock' EXIT

containers=$(docker ps -aq --filter label=com.docker.compose.project=finance --filter label=com.docker.compose.service=api --filter label=com.docker.compose.oneoff=True --filter status=exited)
for container in $containers; do docker container rm "$container"; done
images=$({ docker image ls financeapp --no-trunc --format '{{.ID}}'; docker image ls --filter label=io.financeapp.component=api --no-trunc --format '{{.ID}}'; } | sort -u)
for image in $images; do
    if grep -Fxq "$image" backups/retained-images; then continue; fi
    test -z "$(docker ps -aq --filter "ancestor=$image")" || continue
    owner=$(docker image inspect --format '{{index .Config.Labels "io.financeapp.component"}}' "$image")
    if test "$owner" != api; then
        # Releases before ownership labels are accepted only if their revision belongs here.
        revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
        git cat-file -e "${revision}^{commit}" 2>/dev/null || continue
    fi
    tags=$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$image")
    foreign=false
    for tag in $tags; do case "$tag" in financeapp:*) ;; *) foreign=true ;; esac; done
    test "$foreign" = false || continue
    if test -n "$tags"; then
        for tag in $tags; do docker image rm "$tag"; done
    else
        docker image rm "$image"
    fi
done

# Keep five deployment dumps with matching update records; leave manual backups alone.
find backups -maxdepth 1 -type f -name 'finance-????????-??????.dump' |
    LC_ALL=C sort -r | {
    kept=0
    while IFS= read -r dump; do
        printf '%s\n' "$dump" | grep -Eq '^backups/finance-[0-9]{8}-[0-9]{6}\.dump$' || continue
        stamp=${dump#backups/finance-}
        stamp=${stamp%.dump}
        record="backups/update-${stamp}.txt"
        test -f "$record" && test ! -L "$record" || continue
        grep -Fxq "backup=$dump" "$record" || continue
        kept=$((kept + 1))
        if test "$kept" -gt 5; then rm -- "$dump" "$record"; fi
    done
}
