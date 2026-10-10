# Windows signing preparation

Issue [#176](https://github.com/neurodesk/webapps/issues/176) uses Azure Artifact
Signing. Organization account setup is pending. This integration is disabled by
default and does not establish that any existing Windows download is signed.
macOS signing and notarization continue through their existing release jobs.

## Activation configuration

The organization must create an Artifact Signing account, complete identity
validation and create a public-trust certificate profile before activation.
An Azure application or managed identity needs the **Artifact Signing Certificate
Profile Signer** role on that profile. Configure a GitHub OIDC federated credential
for this repository's `main` branch. Releases must run from that branch; do not
trust pull-request or fork subjects. No client secret or certificate is stored in
GitHub. The Windows producer jobs and reusable-workflow callers grant
`id-token: write`; signing itself is suppressed on pull requests.

Set these repository variable names after organization setup:

| Variable | Purpose |
| --- | --- |
| `AZURE_CLIENT_ID` | OIDC application's client identifier |
| `AZURE_TENANT_ID` | Azure tenant identifier |
| `AZURE_SUBSCRIPTION_ID` | Subscription containing the signing account |
| `AZURE_ARTIFACT_SIGNING_ENDPOINT` | HTTPS regional `codesigning.azure.net` endpoint with a trailing slash |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT` | Signing account name |
| `AZURE_ARTIFACT_SIGNING_PROFILE` | Public-trust certificate profile name |
| `WINDOWS_SIGNING_ENABLED` | Set to `true` only after the variables and federation are ready |

Unset or `false` preserves unsigned builds. Other flag values fail validation.
When enabled, missing configuration, OIDC failure, service errors, missing
executables, absent timestamps and signature verification errors stop packaging
or publication. A successful unsigned PR build is not activation evidence.
Disabling the flag permits unsigned builds again; it does not remove signatures
from artifacts already published.

Before closing #176, run the existing release workflows with signing enabled,
download the produced Windows ZIPs, and run `signtool verify /pa /all /tw` on their
extracted executables and libraries on a clean Windows machine. Record the
publisher identity and timestamp evidence. This step remains pending until the
organization account exists. Signatures do not guarantee immediate SmartScreen
reputation.

## Signing and verification

The local composite action pins official `Azure/login` v3 to
`935127ca5bb3c4b02c9c2c10060028383878f33f` and authenticates through OIDC.
The signing helper calls the official `ArtifactSigning` PowerShell module at
`0.1.8`, the version used by official `Azure/artifact-signing-action` v2 at
`c0ae2c1d0c1847ab81ac0ab8521bee597cfedd30`. The module pins Windows SDK BuildTools
`10.0.26100.4188` and `Microsoft.ArtifactSigning.Client` `1.0.128`.
We invoke the module inside each packager because its temporary staging directory
must be signed before the archive and checksums are written. The official signing
action cannot run between those operations inside a Python function.

The signer uses the OIDC-authenticated Azure CLI session. It excludes the other
credential providers to avoid an unintended credential fallback. It signs PE
`.exe`, `.dll` and `.node` files with SHA-256 and an RFC 3161 SHA-256 timestamp at
`http://timestamp.acs.microsoft.com`. Microsoft documents that timestamp service
URL. Each file must then pass `signtool verify /pa /all /tw` with exit code zero
and have a valid Authenticode signature and a timestamp certificate.

`windows-signatures.json` inside the payload records the hashes of the verified
files and timestamp certificate thumbprints. On Windows, extracted-archive
validation repeats the native trust check. On Linux and macOS, publication gates
check complete file coverage, those exact hashes and bounded PE certificate
records in the ZIP. That is evidence from the trusted Windows CI producer, not a
second Windows trust-chain verification on Linux. Archive hashes and normal
scientific validation receipts still apply. Keep artifact upload/download inside
the same trusted workflow run.

Electron uses the pinned electron-builder 26 `afterSign` hook after executable
resource editing and before ZIP creation. The hook owns Windows signing, while
builder's own signing is disabled. It signs the whole unpacked PE payload and
requires `neurodesk-webapps.exe`. Archive verification occurs before release
splitting and again before publication, including reassembled multipart ZIPs.
Offline resource integrity checks remain in place and fail if signing changes a
checksummed scientific asset without a corresponding bundle update.

## Release inventory

| Distribution | Windows coverage |
| --- | --- |
| Packages with `release.json`, through `node-cli-portable.yml` | Launcher, private `runtime/node.exe`, native libraries and Node add-ons before ZIP |
| Native SynthSR | `synthsr.exe` and `webgpu_dawn.dll` before ZIP |
| Native Greedy | `greedy-rs.exe` before ZIP and before the npm native copy |
| Electron desktop | Unpacked Electron executables, DLLs and Node add-ons before ZIP |
| Native SynthSEG | Current native release is macOS-only; its separate Node portable release uses the shared signing path |
| Compute server | Current published distribution is Linux-only; no Windows archive to sign |
| Other Rust executables | No additional published Windows archives currently exist; new Windows packagers must call `sign_tree` before archiving and `verify_zip` at publication |

## Reproducible preparation checks

These checks need no Azure account and make no signing-service requests:

```sh
python scripts/lib/test_windows_signing.py
python exes/node-cli/scripts/test_portable_release.py
python exes/synthsr/scripts/test_portable_release.py
node --test test/windows-signing.test.mjs test/independent-workflows.test.mjs
node --test packages/desktop/test/release-files.test.js
pnpm test:contracts
```

The `windows-signing-policy` workflow runs the Python policy and packager tests on
Linux and Windows and parses the PowerShell integration on Windows. Its synthetic
PE certificate fixtures test policy and mutation detection; they are not actual
Authenticode signatures. Account-backed signing and clean-machine Windows
verification remain activation requirements.

## Official references

- [Microsoft signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)
- [Official Artifact Signing action and module pins](https://github.com/Azure/artifact-signing-action/blob/c0ae2c1d0c1847ab81ac0ab8521bee597cfedd30/action.yml)
- [Official action OIDC guide](https://github.com/Azure/artifact-signing-action/blob/c0ae2c1d0c1847ab81ac0ab8521bee597cfedd30/docs/OIDC.md)
- [GitHub OIDC with Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Microsoft SignTool verification](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature)
