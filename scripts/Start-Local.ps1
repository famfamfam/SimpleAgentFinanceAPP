param([string]$HostName = '', [switch]$Android)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path -LiteralPath '.env')) {
    $taskRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $taskBytes = New-Object byte[] 32
    $taskRandom.GetBytes($taskBytes)
    $taskSecret = [Convert]::ToBase64String($taskBytes)
    $taskRandom.GetBytes($taskBytes)
    $taskPassword = ([BitConverter]::ToString($taskBytes)).Replace('-', '').ToLowerInvariant()
    $taskRandom.GetBytes($taskBytes)
    $taskRegistrationPassword = ([BitConverter]::ToString($taskBytes)).Replace('-', '').ToLowerInvariant()
    $taskRandom.Dispose()
    @("APP_SECRET=$taskSecret", "POSTGRES_PASSWORD=$taskPassword", "REGISTRATION_PASSWORD=$taskRegistrationPassword", 'API_PORT=18080', 'OPENROUTER_API_KEY=', 'OPENROUTER_MODEL=xiaomi/mimo-v2.6-flash') | Set-Content -LiteralPath '.env' -Encoding ASCII
}
$taskLines = Get-Content -LiteralPath '.env'
if (-not $HostName) {
    $taskHostLine = $taskLines | Where-Object { $_ -match '^APP_HOST=' } | Select-Object -Last 1
    if ($taskHostLine) { $HostName = $taskHostLine.Substring(9) }
}
if (-not $HostName) {
    $HostName = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1
}
if (-not $HostName) { $HostName = 'localhost' }
@($taskLines | Where-Object { $_ -notmatch '^APP_HOST=' }) + "APP_HOST=$HostName" | Set-Content -LiteralPath '.env' -Encoding ASCII
$env:APP_HOST = $HostName
docker compose --profile https up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed' }
if ($Android) {
    $taskAdb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    if (-not (Test-Path -LiteralPath $taskAdb)) { $taskAdb = 'adb' }
    & $taskAdb reverse tcp:18080 tcp:18080
    & $taskAdb shell am start -a android.intent.action.VIEW -d 'http://localhost:18080'
}
Write-Host 'PC / Android through ADB: http://localhost:18080'
Write-Host "iPhone HTTPS: https://${HostName}:18443"
Write-Host "Local test certificate: http://${HostName}:18081/ca.crt"
