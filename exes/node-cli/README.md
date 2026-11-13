# Portable Node command-line archives

This directory packages a Node command-line package from `packages/` as a
self-contained release: a private Node runtime, the package with its production
dependencies, its checksum-pinned models and a small launcher. SYNcro and
TopoFit use it. The launcher contains no scientific code.

The launcher takes the tool name from its own file name. `syncro` or
`syncro.exe` runs `runtime/node app/bin/syncro.js`; `topofit` runs
`app/bin/topofit.js`. It resolves symlinks to itself first, so a link such as
`/usr/local/bin/topofit` works. It sets `NEURODESK_<TOOL>_MODEL_DIR` to the
release's `models/` directory unless the caller supplied a model-directory
override. It sets `NEURODESK_OFFLINE=1` for releases that bundle models, so the
first analysis on an airgapped machine needs no downloads or cache preparation.
For `bundleModels: false`, it preserves an inherited `NEURODESK_OFFLINE` value
and permits the package to download missing pinned models when online.

Linux and Windows releases are `tar.gz` and `zip` archives. The macOS release
is an installer package. It installs the same tree in
`/usr/local/lib/neurodesk/<tool>` and links `/usr/local/bin/<tool>` to the
launcher. Its preinstall script removes an earlier installation first.

Each package describes its archives in `release.json`:

| Field | Meaning |
| --- | --- |
| `displayName` | Name used in `README.txt` |
| `app` | App whose version must equal the package version |
| `run` | Arguments shown after the executable in `README.txt` |
| `readme.run`, `readme.notes` | Heading for the run command and closing paragraphs of `README.txt` |
| `validation` | Script, relative to the package, run as `node SCRIPT --executable PATH` on the extracted archive |
| `workflow` | Optional. The workflow that builds the archives, when it is not `<app>-native.yml` because another release source already owns that name (SynthSEG's Rust macOS installer) |
| `bundleModels` | Optional, default `true`. `false` skips `download-models` at packaging, for a tool whose models are too large to ship and download on first use (QSMbly) |
| `targets` | Release targets with their kind (`tar.gz`, `zip`, or `pkg` for macOS), executable name and, optionally, `native`: paths under `app/` of native executables the package's `build` script stages (QSMbly's pinned QSMxT binaries). They keep their execute bit and are signed like the launcher |

The package must have exactly one `bin` entry, `bin/<tool>.js`. Packaging runs
the package's `build` script when it has one, deploys it with `pnpm deploy
--prod`, keeps only the target's ONNX Runtime binding when the package uses ONNX Runtime, downloads the Node
runtime pinned in `node-runtimes.json` and runs `<tool> download-models` into
`models/`.

From the repository root, install the frozen pnpm dependencies. Then run:

```bash
python3 exes/node-cli/scripts/portable_release.py package packages/topofit linux-x64
python3 exes/node-cli/scripts/portable_release.py verify packages/topofit linux-x64
```

Use `windows-x64` on Windows. A package can only be built on its target
operating system and architecture. Verification extracts the archive, checks
every file against `manifest.json`, runs `self-check` and then the package's
validation script, and writes a `.validation.txt` receipt next to the archive
in `exes/node-cli/dist/`.

### Visual C++ runtime on Windows

Windows releases carry the Microsoft Visual C++ 2015-2022 runtime. ONNX
Runtime's `onnxruntime_binding.node` and `onnxruntime.dll` import
`msvcp140.dll`, `vcruntime140.dll` and related DLLs, which Windows does not
include. When they are missing the self-check fails with "The specified module
could not be found"; when another program installed a copy older than 14.40 it
fails with "A dynamic link library (DLL) initialization routine failed", as
SynthSeg 0.11 did on MRI scanner hosts.

Packaging reads the import table of every `.exe`, `.dll` and `.node` file in the
release and copies each Visual C++ runtime DLL it imports, and the DLLs those
import, into that file's folder, where Windows looks first. The DLLs come from
`VC_RUNTIME_DIR` or the newest `Microsoft.VC143.CRT` redistributable folder of the
local Visual Studio 2022 installation (found with `vswhere`), and must be at least
14.40. The release then holds
`licenses/microsoft-visual-cpp-runtime/README.txt`.

Microsoft's [redistribution list](https://learn.microsoft.com/visualstudio/releases/2022/redistribution#visual-c-runtime-files)
allows these release binaries from `VC/redist` to accompany an application,
unmodified, subject to the [Visual Studio license terms](https://visualstudio.microsoft.com/license-terms/vs2022-ga-proenterprise/).
The distributor must hold a valid Visual Studio license and meet its
Distributable Code requirements, including protective terms for recipients.
`VC_RUNTIME_DIR` must contain the release CRT from a licensed installation,
never `debug_nonredist` or preview binaries. The Microsoft DLLs retain their
vendor signatures during release signing and remain under Microsoft's terms,
separate from the application's open-source license. Signature verification
and the release manifest still cover every DLL.

Two checks keep this from regressing:

- `verify` rejects a Windows archive in which any binary imports a Visual C++
  runtime DLL that is not beside it or is older than 14.40. This is a static
  check because GitHub's Windows runners have a current runtime installed
  system-wide, so running the release there passes either way.
- `scripts/verify_clean_windows.ps1` runs in the portable workflow after
  `verify`. It runs the extracted release's `self-check` in Windows Server Core
  containers without a Visual C++ runtime and with the too-old 14.29 runtime,
  after a negative control that removes the release's runtime DLLs and requires
  the self-check to fail in both environments. `scripts/clean-windows-inputs.json`
  pins the Server Core images by digest and the 14.29 installer by its versioned
  Microsoft download URL and SHA256. The check verifies the installer hash
  before use and rejects containers whose system runtime differs from the test
  case. Update the image digest for a runner build when updating its base image.

## macOS installer

On Apple silicon, `make` builds and verifies the package:

```bash
make -C exes/node-cli macos-pkg-adhoc PACKAGE=packages/topofit
make -C exes/node-cli macos-verify-adhoc PACKAGE=packages/topofit
```

Packaging signs every Mach-O file inside out with the hardened runtime:
ONNX Runtime's addon and library, then `runtime/node`, then the launcher.
Only `runtime/node` gets entitlements, from `entitlements/node.plist`. The
V8 JIT needs them under the hardened runtime. They are the entitlements of
the official Node binary pinned in `node-runtimes.json`, minus
`com.apple.security.get-task-allow`, which notarization rejects. Packaging
reads the official binary's code signature and fails if the two differ, so a
Node update that changes them stops the build.

Without Developer ID identities the files are signed ad hoc and the package is
unsigned. It is named `<tool>-<version>-macos-arm64-adhoc.pkg`, and
`verify-release-set` refuses it. Verification checks every signature,
entitlement and manifest entry in the expanded package. It then runs
`sudo installer -pkg ... -target /`, `self-check` and the validation script
against `/usr/local/bin/<tool>`. It changes the machine it runs on.

Signed releases reuse SynthSR's release scripts. With the Developer ID
Application and Installer certificates in the keychain and a notarytool
profile (`make macos-notary-profile APPLE_ID=... TEAM_ID=...`):

```bash
make -C exes/node-cli macos-release PACKAGE=packages/topofit EXPECTED_TEAM_ID=ABCDE12345
```

This checks the notary profile, builds the signed package, then runs
`exes/synthsr/scripts/notarize_macos.sh`. That script submits, staples and
validates the package, and runs `scripts/verify_macos_pkg.sh` as its payload
check. Last, `macos-verify` installs the stapled package and runs the
validation. The receipt holds the validation output followed by the
notarization evidence.

## CI

`.github/workflows/node-cli-portable.yml` builds and verifies every target of
one package. On pull requests the macOS job builds, installs and validates the
ad hoc package and uploads it as `test-installer-macos-arm64`. With
`sign_release`, the release job runs on macOS. It calls
`exes/synthsr/scripts/ci_macos_release.sh exes/node-cli` with the seven
signing secrets, which imports the certificates into a temporary keychain and
runs `make macos-release`. `syncro-native.yml` and `topofit-native.yml` call
the shared workflow and can attach the verified releases to an existing
`syncro-vVERSION` or `topofit-vVERSION` release. TopoFit publishes with
`sign_release`; SYNcro has no macOS target and publishes with
`publish_release`.
