param(
    [ValidatePattern('^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Server = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Server) { throw 'Specify the deployment server with -Server' }
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    $initial = @(git rev-list --max-parents=0 HEAD)
    if ($LASTEXITCODE -ne 0 -or $initial.Count -ne 1 -or $initial[0] -cnotmatch '^[a-f0-9]{40}$') { throw 'Cannot identify the project history' }
    $preflight = @"
set -eu
cd /opt/finance
test -d .git && test -f .env
git merge-base --is-ancestor $($initial[0]) HEAD
test -z "`$(git status --porcelain)"
export COMPOSE_PROJECT_NAME=finance
docker compose config -q
df -h /opt/finance
docker_root=`$(docker info --format '{{.DockerRootDir}}')
test -n "`$docker_root"
df -h "`$docker_root"
containers=`$(docker ps -aq --filter label=com.docker.compose.project=finance)
test -n "`$containers"
for container in `$containers; do
    test "`$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "`$container")" = /opt/finance
done
test -n "`$(docker compose ps -q api)"
test ! -L tmp
mkdir -p tmp
"@
    (($preflight -replace "`r", '') + "`n#") | & ssh $Server 'sh -s'
    if ($LASTEXITCODE -ne 0) { throw 'Server preflight failed; nothing was uploaded' }

    & go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go vet failed' }
    & go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
    & npm test
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript tests failed' }
    & "$PSScriptRoot/Build-Release.ps1"

    $remoteDir = @(& ssh $Server 'umask 077; cd /opt/finance; mktemp -d tmp/deploy.XXXXXXXXXX')
    if ($LASTEXITCODE -ne 0 -or $remoteDir.Count -ne 1 -or $remoteDir[0] -cnotmatch '^tmp/deploy\.[A-Za-z0-9]{10}$') { throw 'Cannot create a server staging directory' }
    $remoteDir = $remoteDir[0]
    & scp 'releases/finance-release.tar.gz' "${Server}:/opt/finance/$remoteDir/release.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "Release upload failed; installation was not started. Staging: /opt/finance/$remoteDir" }

    $install = @"
set -eu
cd /opt/finance
export COMPOSE_PROJECT_NAME=finance
tar -xzf $remoteDir/release.tar.gz -C $remoteDir
sh $remoteDir/install.sh /opt/finance
docker compose exec -T api /finance healthcheck
rm -f -- $remoteDir/release.tar.gz $remoteDir/image.tar $remoteDir/project.bundle $remoteDir/revision $remoteDir/image $remoteDir/install.sh $remoteDir/SHA256SUMS
rmdir $remoteDir
"@
    (($install -replace "`r", '') + "`n#") | & ssh $Server 'sh -s'
    if ($LASTEXITCODE -ne 0) { throw "Installation or verification failed; inspect server output. Staging: /opt/finance/$remoteDir" }

    Write-Host "Deployment to $Server completed."
} finally {
    Pop-Location
}
