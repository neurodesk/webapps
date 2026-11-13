# Exercise the real signing script with local doubles for Azure and Windows trust tools.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workRoot = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$previousLocalAppData = $env:LOCALAPPDATA
New-Item -ItemType Directory $workRoot | Out-Null
$env:LOCALAPPDATA = $workRoot
$testState = @{ signed = @(); verified = @(); timestamp = $true }

function Import-Module { param($Name, $RequiredVersion) }
function Get-ChildItem {
    [pscustomobject]@{ Directory = [pscustomobject]@{ Name = 'x64' }; FullName = 'Invoke-TestSignTool' }
}
function Get-AuthenticodeSignature {
    param($LiteralPath)
    $text = [IO.File]::ReadAllText($LiteralPath)
    $status = switch ($text) {
        'unsigned' { 'NotSigned' }
        'invalid Microsoft signature' { 'HashMismatch' }
        'untrusted Microsoft signature' { 'NotTrusted' }
        default { 'Valid' }
    }
    $timestamp = if ($testState.timestamp) { [pscustomobject]@{ Thumbprint = 'fixture timestamp' } } else { $null }
    [pscustomobject]@{ Status = $status; TimeStamperCertificate = $timestamp }
}
function Invoke-ArtifactSigning {
    param([string]$Files)
    foreach ($file in $Files.Split(',')) {
        $testState.signed += $file
        [IO.File]::WriteAllText($file, 'application signature')
    }
}
function Invoke-TestSignTool {
    $testState.verified += $args[-1]
    $global:LASTEXITCODE = 0
}

try {
    $launcher = Join-Path $workRoot 'tool.exe'
    $runtime = Join-Path $workRoot 'msvcp140.dll'
    $request = Join-Path $workRoot 'files.json'
    $evidence = Join-Path $workRoot 'windows-signatures.json'
    @($launcher, $runtime) | ConvertTo-Json | Set-Content $request
    [IO.File]::WriteAllText($launcher, 'unsigned')
    [IO.File]::WriteAllText($runtime, 'Microsoft signature')
    $before = (Get-FileHash $runtime).Hash
    & (Join-Path $PSScriptRoot 'windows-signing.ps1') -FilesJson $request -Root $workRoot -Evidence $evidence
    if ($testState.signed.Count -ne 1 -or $testState.signed[0] -ne $launcher) { throw 'Only the unsigned launcher should be signed' }
    if ((Get-FileHash $runtime).Hash -ne $before) { throw 'The vendor DLL was modified' }
    if ($testState.verified.Count -ne 2) { throw 'Both files must pass SignTool verification' }
    $proof = Get-Content -Raw $evidence | ConvertFrom-Json
    if ($proof.files.'msvcp140.dll'.sha256 -ne $before.ToLowerInvariant()) { throw 'Evidence must cover the original vendor bytes' }

    $testState.signed = @()
    & (Join-Path $PSScriptRoot 'windows-signing.ps1') -FilesJson $request -Root $workRoot -Evidence $evidence
    if ($testState.signed.Count -ne 0) { throw 'Already signed files must not be signed again' }

    foreach ($invalid in @('invalid Microsoft signature', 'untrusted Microsoft signature')) {
        [IO.File]::WriteAllText($runtime, $invalid)
        $before = (Get-FileHash $runtime).Hash
        $rejected = $false
        try {
            & (Join-Path $PSScriptRoot 'windows-signing.ps1') -FilesJson $request -Root $workRoot -Evidence $evidence
        } catch {
            if ($_ -notmatch 'valid timestamped Authenticode signature') { throw }
            $rejected = $true
        }
        if (-not $rejected) { throw 'An invalid vendor signature must fail verification' }
        if ($testState.signed.Count -ne 0 -or (Get-FileHash $runtime).Hash -ne $before) {
            throw 'An invalid vendor signature must never be replaced or modified'
        }
    }
    [IO.File]::WriteAllText($runtime, 'Microsoft signature')
    $testState.timestamp = $false
    $rejected = $false
    try {
        & (Join-Path $PSScriptRoot 'windows-signing.ps1') -FilesJson $request -Root $workRoot -Evidence $evidence
    } catch {
        if ($_ -notmatch 'valid timestamped Authenticode signature') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'A preserved signature still requires a timestamp' }
    'PASS vendor signatures remain unmodified and fully verified'
} finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    Remove-Item -LiteralPath $workRoot -Recurse -Force
}
