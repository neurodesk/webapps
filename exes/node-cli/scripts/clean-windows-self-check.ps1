<#
.SYNOPSIS
Run a portable release's self-check inside a clean Windows Server Core container.

.DESCRIPTION
Runs inside the container started by verify_clean_windows.ps1, with the extracted release at
-Release. Server Core has no Visual C++ runtime; -InstallVc2019 first installs the Visual C++
2015-2019 runtime 14.29 from C:\clean\vc_redist_2019.x64.exe, which is too old for ONNX Runtime
1.29. -ExpectFailure is the negative control: the self-check must fail to load a native module, as
Node's ERR_DLOPEN_FAILED, the Windows loader's "The specified module could not be found" or "A
dynamic link library (DLL) initialization routine failed" (launchers print only the message), or a
child process's 0xC0000135 (STATUS_DLL_NOT_FOUND). With -InstallVc2019 an access violation
(0xC0000005) also counts: binaries built against the 14.40 runtime can crash on the older
msvcp140.dll instead of failing to load. Any other failure, or success, fails the check.
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
    $version = (Get-Item $system).VersionInfo
    "System Visual C++ runtime: msvcp140.dll $($version.FileVersion)"
    if (-not $InstallVc2019 -or $version.FileMajorPart -ne 14 -or $version.FileMinorPart -ne 29) {
        throw 'The container must have no Visual C++ runtime, or exactly 14.29 in the old-runtime case'
    }
} else {
    if ($InstallVc2019) { throw 'The Visual C++ 2019 installer did not install msvcp140.dll' }
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
$exit = '{0} (0x{1:X8})' -f $code, $code
if ($ExpectFailure) {
    if ($code -eq 0) { throw 'Negative control passed: this container provides a Visual C++ runtime and cannot detect a missing one' }
    if ($output -match 'ERR_DLOPEN_FAILED|The specified module could not be found|initialization routine failed|0xC0000135') {
        "Negative control failed as expected: a native module did not load (exit $exit)"
    } elseif ($InstallVc2019 -and $code -eq -1073741819) {
        "Negative control failed as expected: the old runtime crashed with an access violation (exit $exit)"
    } else {
        throw "Negative control failed for another reason (exit $exit)"
    }
} elseif ($code -ne 0) {
    throw "self-check failed with exit code $exit"
}
