$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "finance-deploy-test-$PID"
if (Test-Path -LiteralPath $testRoot) { throw 'Test directory already exists' }
New-Item -ItemType Directory -Path (Join-Path $testRoot 'scripts') -Force | Out-Null
try {
    Copy-Item (Join-Path $PSScriptRoot '../scripts/Deploy.ps1') (Join-Path $testRoot 'scripts/Deploy.ps1')
    Set-Content -LiteralPath (Join-Path $testRoot 'scripts/Build-Release.ps1') -Value @'
$global:calls.Add('build')
if ($global:failure -eq 'build') { throw 'build failed' }
'@
    function global:git {
        $global:calls.Add('history')
        $global:LASTEXITCODE = 0
        'ee1de37e8f58b1329ac54eadac88fcb7085d308f'
    }
    function global:go {
        $step = if ($args[0] -eq 'vet') { 'vet' } else { 'go-test' }
        $global:calls.Add($step)
        $global:LASTEXITCODE = if ($global:failure -eq $step) { 1 } else { 0 }
    }
    function global:npm {
        $global:calls.Add('js-test')
        $global:LASTEXITCODE = if ($global:failure -eq 'js-test') { 1 } else { 0 }
    }
    function global:ssh {
        [CmdletBinding()]
        param(
            [Parameter(Position=0)] [string]$server,
            [Parameter(Position=1)] [string]$remote,
            [Parameter(ValueFromPipeline=$true)] [string]$line
        )
        begin { $lines = [Collections.Generic.List[string]]::new() }
        process { if ($null -ne $line) { $lines.Add($line) } }
        end {
        if ($server -ne 'root@finance.example.org') { throw 'SSH used the wrong server' }
        $command = if ($remote -eq 'sh -s') { $lines -join "`n" } else { $remote }
        if (($command -match 'git merge-base|install.sh') -and $remote -ne 'sh -s') {
            throw 'Multiline SSH scripts must use stdin so shell quotes survive Windows argument parsing'
        }
        if ($remote -eq 'sh -s' -and -not $command.EndsWith("`n#")) {
            throw 'Windows native stdin appends CRLF, so remote scripts must end with a comment'
        }
        if ($command.Contains("`r")) { throw 'Remote shell command contains Windows carriage returns' }
        $command | & sh -n
        if ($LASTEXITCODE -ne 0) { throw 'Remote shell command has invalid syntax' }
        if ($command -match 'git merge-base') {
            $step = 'preflight'
            foreach ($required in @('git status --porcelain', 'docker compose config -q', 'com.docker.compose.project.working_dir', 'docker compose ps -q api', '/opt/finance', 'COMPOSE_PROJECT_NAME=finance')) {
                if (-not $command.Contains($required)) { throw "Preflight is missing $required" }
            }
        } elseif ($command -match 'mktemp -d') {
            $step = 'stage'
            if ($global:failure -ne $step) { 'tmp/deploy.ABCDE12345' }
        } elseif ($command -match 'install.sh') {
            $step = 'install'
            foreach ($required in @('sh tmp/deploy.ABCDE12345/install.sh /opt/finance', 'docker compose exec -T api /finance healthcheck', 'rmdir tmp/deploy.ABCDE12345')) {
                if (-not $command.Contains($required)) { throw "Installation is missing $required" }
            }
            if ($command -match 'scripts/cleanup\.sh') { throw 'Repeating installer cleanup can report a successful deployment as failed' }
            if ($command -match 'docker (system|builder|image) prune') { throw 'Shared Docker resources must not be pruned' }
        } else { throw 'SSH used an unexpected command' }
        $global:calls.Add($step)
        $global:LASTEXITCODE = if ($global:failure -eq $step) { 1 } else { 0 }
        }
    }
    function global:scp {
        if ($args[0] -ne 'releases/finance-release.tar.gz' -or $args[1] -ne 'root@finance.example.org:/opt/finance/tmp/deploy.ABCDE12345/release.tar.gz') {
            throw 'SCP used the wrong release path or server'
        }
        $global:calls.Add('upload')
        $global:LASTEXITCODE = if ($global:failure -eq 'upload') { 1 } else { 0 }
    }
    $deploy = Join-Path $testRoot 'scripts/Deploy.ps1'
    $global:calls = [Collections.Generic.List[string]]::new()
    $failed = $false
    try { & $deploy } catch { $failed = $true }
    if (-not $failed -or $global:calls.Count -ne 0) { throw 'Missing server must be rejected before any deployment step' }
    foreach ($case in @(
        @{ name = 'successful deployment skips a required step'; failure = ''; expected = 'history,preflight,vet,go-test,js-test,build,stage,upload,install' },
        @{ name = 'unsafe server is used despite failed preflight'; failure = 'preflight'; expected = 'history,preflight' },
        @{ name = 'failed vet is ignored'; failure = 'vet'; expected = 'history,preflight,vet' },
        @{ name = 'failed Go tests are ignored'; failure = 'go-test'; expected = 'history,preflight,vet,go-test' },
        @{ name = 'failed JavaScript tests are ignored'; failure = 'js-test'; expected = 'history,preflight,vet,go-test,js-test' },
        @{ name = 'failed build is uploaded'; failure = 'build'; expected = 'history,preflight,vet,go-test,js-test,build' },
        @{ name = 'failed staging is used'; failure = 'stage'; expected = 'history,preflight,vet,go-test,js-test,build,stage' },
        @{ name = 'failed upload is installed'; failure = 'upload'; expected = 'history,preflight,vet,go-test,js-test,build,stage,upload' },
        @{ name = 'failed installation reports success'; failure = 'install'; expected = 'history,preflight,vet,go-test,js-test,build,stage,upload,install' }
    )) {
        $global:calls = [Collections.Generic.List[string]]::new()
        $global:failure = $case.failure
        $failed = $false
        try { & $deploy -Server 'root@finance.example.org' } catch { $failed = $true }
        if ($failed -ne [bool]$case.failure -or ($global:calls -join ',') -ne $case.expected) {
            throw "$($case.name): failed=$failed, calls=$($global:calls -join ',')"
        }
    }
    $global:calls = [Collections.Generic.List[string]]::new()
    $failed = $false
    try { & $deploy -Server '-oProxyCommand=bad' } catch { $failed = $true }
    if (-not $failed -or $global:calls.Count -ne 0) { throw 'Invalid server was not rejected' }
    Write-Host 'Deployment script tests passed.'
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
