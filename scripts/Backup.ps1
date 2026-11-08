param([string]$Destination = '')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not $Destination) { $Destination = Join-Path (Get-Location) ('backups\finance-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump') }
$taskParent = Split-Path $Destination -Parent
New-Item -ItemType Directory -Path $taskParent -Force | Out-Null
# Write binary dump inside the container, then copy it without PowerShell text conversion.
$taskDump = '/tmp/finance-' + [guid]::NewGuid().ToString('N') + '.dump'
docker compose exec -T db pg_dump -U finance -d finance -Fc -f $taskDump
if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed' }
docker compose exec -T db pg_restore --list $taskDump | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Backup verification failed' }
docker compose cp "db:$taskDump" $Destination
if ($LASTEXITCODE -ne 0) { throw 'Backup copy failed' }
docker compose exec -T db rm $taskDump
if ($LASTEXITCODE -ne 0) { throw 'Backup temporary file cleanup failed' }
Write-Host "Backup: $Destination"
