param()
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path -LiteralPath '.env')) { throw 'Run Start-Local.ps1 first' }
New-Item -ItemType Directory -Path 'backups' -Force | Out-Null
$taskLock = Join-Path (Get-Location) 'backups/.maintenance-lock'
New-Item -ItemType Directory -Path $taskLock -ErrorAction Stop | Out-Null
function Invoke-Compose {
    & docker compose @args
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed; previous images and database volumes are retained. See docker compose logs api.' }
}
$taskPreviousImageEnv = $env:APP_IMAGE
$taskPreviousVersionEnv = $env:APP_VERSION
try {
    $taskContainer = docker compose ps -q api
    if ($LASTEXITCODE -ne 0 -or -not $taskContainer) { throw 'Start the existing app before updating' }
    $taskPrevious = docker inspect --format '{{.Image}}' $taskContainer
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the running image' }
    $taskRevision = git rev-parse --short HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify Git revision' }
    $taskChanges = git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read Git status' }
    if ($taskChanges) { $taskRevision += '-dirty' }
    $taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $env:APP_IMAGE = "financeapp:${taskRevision}-${taskStamp}"
    $env:APP_VERSION = $taskRevision
    Invoke-Compose build api
    $taskBackup = Join-Path (Get-Location) "backups/finance-${taskStamp}.dump"
    & "$PSScriptRoot/Backup.ps1" -Destination $taskBackup
    @{ previousImage = $taskPrevious; image = $env:APP_IMAGE; backup = $taskBackup; version = $taskRevision } |
        ConvertTo-Json | Set-Content -LiteralPath "backups/update-${taskStamp}.json" -Encoding UTF8
    # Failed migrations roll back before the currently running API is replaced.
    Invoke-Compose run --rm --no-deps api migrate
    Invoke-Compose up -d --no-deps --no-build --wait --wait-timeout 90 api
    $taskLines = Get-Content -LiteralPath '.env'
    @($taskLines | Where-Object { $_ -notmatch '^(APP_IMAGE|APP_VERSION)=' }) + @("APP_IMAGE=$env:APP_IMAGE", "APP_VERSION=$env:APP_VERSION") |
        Set-Content -LiteralPath '.env.next' -Encoding ASCII
    Move-Item -LiteralPath '.env.next' -Destination '.env' -Force
    Write-Host "Updated to $taskRevision. Database backup: $taskBackup"
} finally {
    $env:APP_IMAGE = $taskPreviousImageEnv
    $env:APP_VERSION = $taskPreviousVersionEnv
    Remove-Item -LiteralPath $taskLock
}
