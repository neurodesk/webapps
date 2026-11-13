<#
.SYNOPSIS
Run a portable release's self-check inside a clean Windows Server Core container.

.DESCRIPTION
Runs inside the container started by verify_clean_windows.ps1, with the extracted release at
-Release. Server Core has no Visual C++ runtime; -InstallVc2019 first installs the Visual C++
2015-2019 runtime 14.29 from C:\clean\vc_redist_2019.x64.exe, which is too old for ONNX Runtime
1.29. -ExpectFailure is the negative control: the self-check must fail to load a native module.
#>
param(
    [Parameter(Mandatory)][string]$Release,
    [switch]$InstallVc2019,
    [switch]$ExpectFailure
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($InstallVc2019) {
    $installer = Start-Process 'C:\clean\vc_redist_2019.x64.exe' -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
    if ($installer.ExitCode -notin 0, 3010) { throw "Visual C++ 2019 runtime install failed: $($installer.ExitCode)" }
}
$system = 'C:\Windows\System32\msvcp140.dll'
if (Test-Path $system) {
    "System Visual C++ runtime: msvcp140.dll $((Get-Item $system).VersionInfo.FileVersion)"
} else {
    'System Visual C++ runtime: none'
}
$executables = @(Get-ChildItem $Release -Filter *.exe -File)
if ($executables.Count -ne 1) { throw "Expected one launcher in $Release, found $($executables.Count)" }

# Windows PowerShell turns redirected native stderr into errors; Stop would make them fatal.
$ErrorActionPreference = 'Continue'
$output = & $executables[0].FullName self-check 2>&1 | Out-String
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$output.Trim()
if ($ExpectFailure) {
    if ($code -eq 0) { throw 'Negative control passed: this container provides a Visual C++ runtime and cannot detect a missing one' }
    if ($output -notmatch 'ERR_DLOPEN_FAILED') { throw "Negative control failed for another reason (exit $code)" }
    "Negative control failed as expected (exit $code)"
} elseif ($code -ne 0) {
    throw "self-check failed with exit code $code"
}
