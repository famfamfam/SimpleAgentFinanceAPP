$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "finance-release-test-$PID"
if (Test-Path -LiteralPath $testRoot) { throw 'Test directory already exists' }
New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
$originalLocation = Get-Location
try {
    Copy-Item (Join-Path $PSScriptRoot '../scripts/Build-Release.ps1') (Join-Path $testRoot 'scripts/Build-Release.ps1')
    Copy-Item (Join-Path $PSScriptRoot '../scripts/update.sh') (Join-Path $testRoot 'scripts/update.sh')
    function global:git {
        $global:LASTEXITCODE = 0
        if ($args[0] -eq 'rev-parse') { 'abcdef1' }
        if ($args[0] -eq 'bundle') { [IO.File]::WriteAllText($args[2], 'bundle') }
    }
    function global:docker {
        $global:LASTEXITCODE = 0
        if ($args[0] -eq 'save') { [IO.File]::WriteAllText($args[2], 'image') }
    }
    & (Join-Path $testRoot 'scripts/Build-Release.ps1')
    $archive = Join-Path $testRoot 'releases/finance-release.tar.gz'
    if (-not (Test-Path -LiteralPath $archive)) { throw 'Windows drive-letter path prevented creation of the release archive' }
    Push-Location (Split-Path $archive)
    try { $contents = @(tar -tzf 'finance-release.tar.gz') } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or ($contents -join ',') -ne 'image.tar,project.bundle,revision,image,install.sh,SHA256SUMS') {
        throw 'Release archive does not contain all required files'
    }
    Write-Host 'Release archive test passed.'
} finally {
    Set-Location $originalLocation
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
