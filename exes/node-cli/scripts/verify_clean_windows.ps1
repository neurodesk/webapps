<#
.SYNOPSIS
Check that a Windows portable archive runs on clean Windows, not only on the build runner.

.DESCRIPTION
GitHub's Windows runners have a current Visual C++ runtime in System32, so `portable_release.py
verify` there cannot notice a release that depends on it. This script extracts the archive and runs
its self-check in Windows Server Core containers matching the runner's Windows build:

1. Negative control (when the release ships Visual C++ runtime DLLs): with those DLLs removed,
   self-check must fail with ERR_DLOPEN_FAILED, proving the container lacks a usable runtime.
2. Without any Visual C++ runtime installed.
3. With the Visual C++ 2015-2019 runtime 14.29 installed, which ONNX Runtime 1.29 cannot use
   ("A dynamic link library (DLL) initialization routine failed").
#>
param([Parameter(Mandatory)][string]$Archive)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pins = Get-Content -Raw (Join-Path $PSScriptRoot 'clean-windows-inputs.json') | ConvertFrom-Json
$build = [Environment]::OSVersion.Version.Build
$imagePin = $pins.images.PSObject.Properties[[string]$build]
if ($null -eq $imagePin) { throw "No Server Core image is known for Windows build $build" }
$image = $imagePin.Value.image
$vcRuntimeNames = 'msvcp140*.dll', 'vcruntime140*.dll', 'concrt140.dll', 'vccorlib140.dll'

$work = Join-Path ([IO.Path]::GetTempPath()) 'clean-windows'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory $work | Out-Null
Expand-Archive -LiteralPath $Archive -DestinationPath (Join-Path $work 'release')
$release = @(Get-ChildItem (Join-Path $work 'release') -Directory)
if ($release.Count -ne 1) { throw "Expected one folder in $Archive" }
$name = $release[0].Name

$installerPath = Join-Path $work 'vc_redist_2019.x64.exe'
Invoke-WebRequest $pins.vc2019.url -OutFile $installerPath
$installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installerHash -ne $pins.vc2019.sha256) { throw 'Visual C++ 2019 installer SHA256 mismatch' }
$vc2019 = (Get-Item $installerPath).VersionInfo.FileVersion
if ($vc2019 -ne $pins.vc2019.version) { throw "Expected Visual C++ $($pins.vc2019.version), got $vc2019" }
Copy-Item (Join-Path $PSScriptRoot 'clean-windows-self-check.ps1') $work

# Some Windows runner images install Docker with its service stopped.
$service = Get-Service docker -ErrorAction SilentlyContinue
if ($null -eq $service) { throw 'Docker is not installed on this runner; Windows containers are required' }
if ($service.Status -ne 'Running') {
    "Starting the $($service.Name) service ($($service.Status))"
    Start-Service $service.Name
    $service.WaitForStatus('Running', [TimeSpan]::FromMinutes(2))
}
docker version --format 'Docker {{.Server.Version}} ({{.Server.Os}})'
if ($LASTEXITCODE -ne 0) { throw 'The Docker daemon is not reachable' }
docker pull $image
if ($LASTEXITCODE -ne 0) { throw "docker pull $image failed" }

function Invoke-Clean([string]$Title, [string]$Folder, [string[]]$Switches) {
    "=== $Title ($image)"
    docker run --rm -v "${work}:C:\clean" $image powershell -NoProfile -ExecutionPolicy Bypass `
        -File C:\clean\clean-windows-self-check.ps1 -Release "C:\clean\$Folder\$name" @Switches
    if ($LASTEXITCODE -ne 0) { throw "$Title failed" }
}

$shipped = @(Get-ChildItem $release[0].FullName -Recurse -File -Include $vcRuntimeNames)
if ($shipped.Count -gt 0) {
    Copy-Item (Join-Path $work 'release') (Join-Path $work 'control') -Recurse
    Get-ChildItem (Join-Path $work "control\$name") -Recurse -File -Include $vcRuntimeNames | Remove-Item
    Invoke-Clean 'Negative control: release without its Visual C++ runtime' 'control' @('-ExpectFailure')
    Invoke-Clean 'Negative control: release with only the old system runtime' 'control' @('-InstallVc2019', '-ExpectFailure')
} else {
    'The release ships no Visual C++ runtime DLLs; skipping the negative control'
}
Invoke-Clean 'Clean Windows without a Visual C++ runtime' 'release' @()
Invoke-Clean "Clean Windows with the Visual C++ runtime $vc2019" 'release' @('-InstallVc2019')
"PASS clean Windows self-check for $name"
