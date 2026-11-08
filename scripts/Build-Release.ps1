param([string]$OutputPath = 'releases/finance-release.tar.gz')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Set-Location $taskRoot
$taskChanges = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $taskChanges) { throw 'Commit your changes before building a release' }
$taskRevision = git rev-parse --short HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify Git revision' }
$taskFullRevision = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify Git commit' }
$taskImage = "financeapp:$taskRevision"
$taskTempRoot = Join-Path $taskRoot 'tmp'
New-Item -ItemType Directory -Path $taskTempRoot -Force | Out-Null
if ((Get-Item -LiteralPath $taskTempRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'tmp must not be a link' }
$taskWork = Join-Path $taskTempRoot ('release-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskWork | Out-Null
try {
    docker build --platform linux/amd64 --build-arg "APP_VERSION=$taskRevision" -t $taskImage .
    if ($LASTEXITCODE -ne 0) { throw 'Image build failed' }
    docker save -o (Join-Path $taskWork 'image.tar') $taskImage
    if ($LASTEXITCODE -ne 0) { throw 'Image export failed' }
    git bundle create (Join-Path $taskWork 'project.bundle') --all
    if ($LASTEXITCODE -ne 0) { throw 'Source export failed' }
    $taskUtf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $taskWork 'revision'), "$taskFullRevision`n", $taskUtf8)
    [IO.File]::WriteAllText((Join-Path $taskWork 'image'), "$taskImage`n", $taskUtf8)
    $taskInstaller = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'update.sh')).Replace("`r`n", "`n")
    [IO.File]::WriteAllText((Join-Path $taskWork 'install.sh'), $taskInstaller, $taskUtf8)
    $taskFiles = @('image.tar', 'project.bundle', 'revision', 'image', 'install.sh')
    $taskSums = foreach ($taskFile in $taskFiles) {
        $taskHash = (Get-FileHash -LiteralPath (Join-Path $taskWork $taskFile) -Algorithm SHA256).Hash.ToLowerInvariant()
        "$taskHash  $taskFile"
    }
    [IO.File]::WriteAllText((Join-Path $taskWork 'SHA256SUMS'), (($taskSums -join "`n") + "`n"), $taskUtf8)
    $taskArchive = Join-Path $taskWork 'finance-release.tar.gz'
    Push-Location $taskWork
    try { tar -czf 'finance-release.tar.gz' @taskFiles SHA256SUMS }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Release archive failed' }
    if ([IO.Path]::IsPathRooted($OutputPath)) { $taskOutput = [IO.Path]::GetFullPath($OutputPath) }
    else { $taskOutput = [IO.Path]::GetFullPath((Join-Path $taskRoot $OutputPath)) }
    New-Item -ItemType Directory -Path (Split-Path $taskOutput -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $taskArchive -Destination $taskOutput -Force
    Write-Host "Release: $taskOutput"
    Write-Host "SHA256: $((Get-FileHash -LiteralPath $taskOutput -Algorithm SHA256).Hash.ToLowerInvariant())"
} finally {
    $taskAllowed = [IO.Path]::GetFullPath($taskTempRoot) + [IO.Path]::DirectorySeparatorChar
    $taskResolved = [IO.Path]::GetFullPath($taskWork)
    if (-not $taskResolved.StartsWith($taskAllowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside tmp' }
    if ((Get-Item -LiteralPath $taskWork).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup of a link' }
    Remove-Item -LiteralPath $taskWork -Recurse -Force
}
