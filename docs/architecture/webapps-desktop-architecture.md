# Offline Neurodesk Webapps

## Distributions

One Electron application contains all 24 webapps and their complete runtime assets. The supported desktop targets are macOS ARM64, Linux x64 and Windows x64. Every app offers both a smaller suite without models and a complete suite with models included, after its available upstream Neurodesk containers.

| Distribution | Execution profile |
| --- | --- |
| Desktop suite | Local or airgapped workstation; one File menu selects any app |
| Apptainer SIF | The same Linux suite with its system libraries, Xvfb and an init process; graphical HPC use and JSON automation jobs |
| Existing native executables | Separate Greedy, SynthSR, SynthSeg and SYNcro releases on the platforms listed in the catalog |

The suite runs the browser's compiled WebAssembly, WebGPU and Python pipelines. It does not depend on the separately published native executables. `assemble.mjs --app ID --out DIRECTORY` can generate a subset from the same registry and asset lock; the published release is the complete suite.

## Cold-start offline operation

`registry/offline-assets.sources.json` declares external inputs. The lock records their exact URLs, hashes, sizes and dependencies. Assembly verifies the cache and copies the complete dependency closure into the release, including neural-network weights, templates, atlases, WebAssembly, Pyodide and Python wheels. Large files stay out of Git.

The desktop host serves app files through a loopback server. HTTPS requests resolve exclusively to verified packaged files. Unlisted requests fail. In the model-inclusive edition there is no network fallback or model downloader. Profiles begin empty during tests. `--verify` checks the packaged site and model files against the manifest.

The renderer uses Electron's sandbox with context isolation and no Node integration. Local OME-Zarr access requires an explicit directory selection or `--zarr DIRECTORY`; the resulting temporary URL cannot escape that directory through path traversal or symlinks.

## Edition without models

`without-models.mjs` derives the smaller edition from the verified full bundle. It removes every locked model and matching site copy, including MuscleMap's split model. The manifest retains exact source URLs, hashes and sizes. Local model pieces are reconstructed from their pinned complete model.

Only these declared models can be downloaded. The main process verifies model bytes before serving them, caches verified downloads, and reuses them on later runs. Concurrent requests share one download; corrupt downloads are rejected and retried on the next request. App and runtime files remain bundled. The model-inclusive edition never enables this path.

Both editions are built and tested on all three platforms and as Apptainer images. The package tests exercise an actual first-use model download in the smaller edition, plus all-app startup. Tests verify offline cache reuse and rejection of corrupt or unlisted models.

## HPC execution

The compiled executable accepts `--app ID` and `--job JOB.json --output DIRECTORY`. A JSON job drives the same controls as the GUI, supplies local input files, waits for results and exports files. Success writes `job-result.json` and exits zero. Failure exits nonzero. The output directory must be new or empty.

The SIF includes Xvfb for jobs without a physical display. `tini` lets Xvfb complete its startup handshake and handles child processes. Chromium runs without its setuid sandbox inside the container; the normal desktop renderer keeps its sandbox enabled.

NiiMath's batch profile is tested numerically in Docker with `--network=none` and in Apptainer. Existing native executable workflows provide additional headless coverage. Other apps can run interactively in a graphical HPC session. JSON automation requires a release-specific sequence of controls; it is not a stable scientific CLI for each app. Drawing and exploration workflows still need the user's choices.

WebGPU methods require compatible GPU hardware and drivers. All 24 representative offline workflows passed on a local Apple silicon GPU. Hosted CI executes eight portable workflows on all three desktop platforms and starts every installed app. The container startup matrix covers all 24 apps. GPU computation on a particular HPC cluster needs that site's driver and graphics configuration; software-rendered CI does not establish GPU parity there. See the exact coverage in [standalone validation](standalone-validation.md).

## Release and interface contract

`registry/standalone.json` supplies real GitHub binary URLs, platform information, checksums, model-inclusion claims and upstream Neurodesk container choices. The shared dialog renders it for every app, including VesselBoost and SynthSeg. Compilation commands are not standalone downloads. The lightNIIng bar link is removed; the required ecosystem statement remains in About.

The release workflow builds the locked bundle, tests each platform, tests the installed executables and builds/tests the SIF. Publication requires every distribution job to pass. Files larger than GitHub's asset limit are split into numbered parts. The dialog groups downloads in bordered sections and hides extraction commands inside installation disclosures. Hashes remain in machine-readable release metadata. Installation instructions include local reassembly commands; no network access is needed after transferring the complete set.

`publish.mjs` verifies the individual parts and reassembled archive hashes, uploads a draft release and publishes it after the complete artifact set is present. Its generated catalog records every app version and the source revision. Web deployment refuses a catalog without a matching published suite and checks that the actual binary URLs resolve. The deployed-interface test opens every app's Standalone dialog and checks its release links.

Upstream Neurodesk containers are optional alternatives. Docker pulls use published Docker Hub tags. Apptainer downloads use exact filenames from Neurocommand's `cvmfs/log.txt` and the official Neurodesk worker endpoint. The suite SIF carries the tested webapp pipelines and bundled assets. See [container assignments](standalone-container-research.md) for verified upstream versions and unavailable releases.

## Future applications

`pnpm new-app ID` creates the shared shell integration and the standalone/source/lock entries. Descriptor coverage must exactly match the app registry; a public app cannot opt out of desktop packaging.

Every app must have an executable offline workflow test. Unknown workflows fail. New apps automatically enter the full hosted-CI workflow list; the existing hardware exceptions are explicit and documented. App authors must declare new assets and exercise the scientific stages they add. The host records missing and external requests as test failures.

`pnpm release` automatically adds a dated suite release whenever an app is released. A second suite on the same UTC date advances its minor version so published files remain immutable. Explicit desktop changesets use the same date scheme.

Before deployment, every catalog app version must appear in the released suite, and the catalog must match the current desktop package version. Adding an experimental app or disabling its web-release flag does not bypass that gate. The generator, catalog validation, offline tests, publication checks and deployed-interface checks enforce the contract in code.

For installation and scheduler examples, read [the packaged user guide](../../packages/desktop/STANDALONE.md).
