# NeSVoR webapp and decoupled compute: design analysis

Written 2026-09-21 before implementation. This note records what NeSVoR is, why its
compute cannot run in the browser, which deployment shapes were considered for
compute that runs on a machine in the clinician's own network, and the design chosen
for the `nesvor` webapp, the `neurodesk-compute` server and the protocol between
them. The decision itself is [ADR-0003](../adr/0003-remote-compute-nodes.md).

## 1. The upstream tool

[NeSVoR 0.5.0](https://github.com/daviddmc/NeSVoR) reconstructs one isotropic 3D
volume from several stacks of motion-corrupted 2D slices (fetal and neonatal brain
MRI, experimental fetal body). The Neurodesk container
[`nesvor_0.5.0_20260722`](https://github.com/neurodesk/neurocontainers/tree/main/recipes/nesvor)
wraps the upstream image `junshenxu/nesvor:v0.5.0` and exposes one binary, `nesvor`.
Release record, Docker Hub tag and CVMFS name were verified on 2026-09-21:

| Item | Value |
| --- | --- |
| Docker image | `vnmd/nesvor_0.5.0:20260722` |
| Digest | `sha256:4a9b346297bd5c10af4047745b6fa82f2912e06c8fecaab615f2adcb32599f64` |
| Apptainer | `https://neurocontainers.neurodesk.workers.dev/nesvor_0.5.0_20260722.simg` |
| Architecture | x86_64 only; CUDA 11.7 in the upstream image |
| Licence | MIT (upstream) |

The `reconstruct` pipeline, in order: optional 2D fetal brain masking (MONAIfbs UNet),
optional N4 bias field correction (SimpleITK), rigid motion correction (SVoRT
transformer, fetal brain only, or stack-to-stack registration), then training of an
implicit neural representation (tiny-cuda-nn hash-grid encoding plus small MLPs, 6000
Adam iterations by default, mixed precision) and sampling of the trained model onto an
isotropic grid. Deformable motion adds a second hash grid. `nesvor` also exposes
`register`, `svr`, `sample-volume`, `sample-slices`, `segment-stack`,
`correct-bias-field` and `assess`.

The reconstruct command surface that a clinician needs is small. Inputs: N NIfTI
stacks, optional N masks, per-stack slice thickness. Options that change results:
output resolution, registration method, segmentation on/off, bias correction on/off,
Otsu thresholding, stacks intersection, deformable, iteration count, and the loss
weights of the deformable recipe. Everything else is expert tuning that stays behind
an advanced disclosure or is not exposed.

## 2. Can the compute run in the browser?

Every other app in this catalog runs its science in the browser (WebAssembly, WebGPU,
Pyodide). The question was examined per pipeline stage:

| Stage | Browser feasibility | Verdict |
| --- | --- | --- |
| MONAIfbs 2D masking | A 2D UNet; exportable to ONNX and runnable with `ort-web`. | Feasible, but only a preprocessing step. |
| N4 bias correction | SimpleITK; a WASM build of ITK exists but is large. | Feasible with effort; secondary. |
| SVoRT registration | Iterative transformer with volume resampling in the loop; weights are PyTorch, export not published. | Possible in principle, weeks of work, unvalidated. |
| NeSVoR training | Per-subject optimisation of a hash-grid INR: 6000 iterations, 4096 rays × 256 PSF samples each, mixed precision, custom CUDA kernels from tiny-cuda-nn. Minutes on an A100. | Not feasible. A WebGPU port would be a research project and tens of times slower on integrated GPUs; the result would no longer be the validated upstream method. |
| Volume sampling | Inference of the same INR. | Only meaningful with the training stage. |

Conclusion: the validated method is inseparable from CUDA and a data-centre-class GPU.
A browser port would be a different, unvalidated implementation, which the
[container research](standalone-container-research.md) explicitly warns against. The
webapp therefore keeps the clinician-facing work (loading, inspecting and ordering
stacks, assigning thicknesses, choosing a protocol, reviewing and downloading the
result) in the browser and sends the computation to the pinned upstream container
running elsewhere. That "elsewhere" is the new feature requested for the catalog.

## 3. Decoupled compute: shapes considered

Requirement: the clinician uses the hosted web frontend; the processing runs on a
machine inside the clinic network; the clinician enters that machine's address and
downloads a standalone backend application that runs a server there.

### 3.1 Browser constraints that shape the design

- **Mixed content.** `https://webapps.neurodesk.org` may not `fetch` an `http://`
  origin. Only `http://localhost` and `http://127.0.0.1` are exempt. A backend on
  `http://192.168.1.50:8765` is unreachable from the hosted page.
- **Local Network Access.** Chromium now gates requests from a public origin to
  private addresses behind a permission prompt and a CORS preflight that must be
  answered with `Access-Control-Allow-Private-Network: true`. The server must answer
  that preflight or the request never leaves the browser.
- **Self-signed TLS.** A page can talk to `https://192.168.1.50:8765` after the user
  opens that URL once and accepts the certificate warning for that origin. This is
  how OHIF, Orthanc and many local DICOM tools bridge the gap. It is workable and
  documented, not pretty.
- **Cross-origin isolation.** The apps are served with COOP/COEP headers for
  threads. A cross-origin `fetch` from such a page works with ordinary CORS; only
  embedded resources need CORP. No change to the shell.

### 3.2 Topologies

| Shape | Description | Assessment |
| --- | --- | --- |
| A. Backend serves the frontend | The backend also serves the built webapp on the same origin. The clinician opens `http://<server>:8765/` in a browser. | Same origin: no CORS, no mixed content, no certificate step, works offline in the clinic. Frontend version travels with the backend release. |
| B. Hosted frontend, entered address | The catalog page at webapps.neurodesk.org gets a connection field. | Exactly the requested user experience. Requires HTTPS on the backend (self-signed by default, site certificate optional) and CORS/Local Network Access handling. |
| C. Relay through a Neurodesk-hosted broker | The backend dials out to a public relay; the browser talks to the relay. | Patient data transits a third party. Rejected for a clinical tool whose whole point is that data stays inside the network. |
| D. Browser extension / native messaging | Bridges the page to a local process. | Per-browser installs and reviews; no advantage over A. Rejected. |

Decision: implement **A and B together**. They share one server, one protocol and one
frontend. The connection panel autodetects shape A (same-origin backend) and falls
back to the entered address for shape B. The install instructions recommend A for
clinics and explain the certificate step for B. Shape C is explicitly excluded in the
privacy statement.

## 4. The compute server

### 4.1 Language, name and placement

`exes/compute-server` is a Rust crate that builds the binary `neurodesk-compute`. Rust
matches the existing native executables (`exes/synthsr`, `exes/synthseg`,
`exes/greedy`) and their release tooling, gives one static binary per platform with
no runtime to install, and lets the same crate later host tool definitions for other
GPU-bound methods. The server is generic; the `nesvor` tool definition is the first
and only registered tool. A tool definition owns the argument mapping from a
validated job specification to `argv`, so the server never executes caller-supplied
command lines.

### 4.2 Runners

The server executes a tool through one runner selected at start (`--runner`) or
detected in this order:

| Runner | Command shape | Notes |
| --- | --- | --- |
| `docker` | `docker run --rm --gpus all --ipc=host -v <job>:/job vnmd/nesvor_0.5.0@sha256:… nesvor …` | Default on Linux and Windows/WSL2 with the NVIDIA Container Toolkit. Digest-pinned. |
| `apptainer` | `apptainer exec --nv -B <job>:/job nesvor_0.5.0_20260722.simg nesvor …` | HPC nodes and sites without Docker. Image path from `--image`. |
| `native` | `nesvor …` on `PATH` | Inside a Neurodesk desktop session or a manual install. |
| `simulate` | Built-in placeholder that averages the resampled stacks | Only with the explicit flag; every response and the UI mark results as simulated. Used by the crate's tests and by `neurodesk-compute doctor`. |

`neurodesk-compute doctor` reports the detected runner, GPU visibility (`nvidia-smi`
inside the container), image presence and the address the browser should use.
`neurodesk-compute pull` fetches the pinned image ahead of the first job.

### 4.3 Job lifecycle

1. `POST /api/v1/jobs` (multipart: one `spec` JSON part, then file parts) validates
   the spec against the tool definition, writes files into a fresh job directory,
   and queues the job. Response `202 {id, status: "queued", position}`.
2. One job runs at a time by default (`--parallel N` for multi-GPU hosts). The runner
   starts the container with the job directory mounted at `/job`; stdout and stderr
   stream into `log.txt` and to subscribers.
3. `GET /api/v1/jobs/{id}/events` is a Server-Sent Events stream of `status`,
   `progress`, `log` and `done` events. `GET /api/v1/jobs/{id}` returns the same
   state for polling clients.
4. `GET /api/v1/jobs/{id}/outputs/{name}` serves each declared output. Output names
   are fixed by the tool definition (`volume.nii.gz`, `result.json`, `log.txt`).
5. `DELETE /api/v1/jobs/{id}` cancels a running job (kills the container) and removes
   the directory. Finished jobs are also removed after `--retain` (default 1 h) and at
   server shutdown.

Progress: NeSVoR logs `tqdm`-style training iterations and stage banners ("… starts",
"… finished"). The tool definition maps stage banners to coarse progress and
iteration counters to fine progress. Unknown lines are forwarded as log events.

### 4.4 Security model

- **Token.** Every API call except the unauthenticated `GET /api/v1/info` capability
  probe needs `Authorization: Bearer <token>`. The token is generated on first start,
  stored in the data directory with owner-only permissions, printed at start, and can
  be fixed with `--token` or `NEURODESK_COMPUTE_TOKEN`. There is no anonymous mode.
- **Origins.** CORS allows `https://webapps.neurodesk.org`, the server's own origin,
  and any `--allow-origin` values (for a local `pnpm dev` or a mirror). Preflights get
  `Access-Control-Allow-Private-Network: true`. Credentials are never cookies, so
  cross-site request forgery cannot ride a session.
- **TLS.** `--tls-cert/--tls-key` use a site certificate. Without them the server
  generates a self-signed certificate for its hostname and LAN addresses and stores it
  in the data directory. `--insecure-http` serves plain HTTP for shape A on a trusted
  LAN or behind a site reverse proxy; the frontend shows why that origin cannot be
  used from the hosted page.
- **Isolation.** Containers get only the job directory, run with `--rm`, no network
  (`--network none`) and the GPU. Job ids are 128-bit random and never listed to
  other callers. Uploaded file names are replaced with tool-defined names.
- **Bounds.** Body size, file count and per-stack voxel count are capped by the
  tool definition. Logs are line-limited.

### 4.5 Data protection

Inputs and outputs exist only in the job directory on the compute host, inside the
clinic's network, for the lifetime described in 4.3. Nothing is sent to Neurodesk or
any third party. The webapp's Privacy dialog states this and names the address the
user configured. The server writes no analytics.

### 4.6 Distribution

- Source: `exes/compute-server` with a `Makefile` (`build`, `test`, `lint`, `fmt`).
- CI: `.github/workflows/compute-server-native.yml` builds and tests on Linux x64,
  Windows x64 and macOS arm64 and uploads archives named
  `neurodesk-compute-<version>-<platform>.<tar.gz|zip>`, following `synthsr-native`.
- Release archives carry the binary, `README`, licences and a `www/` directory with
  the built `nesvor` app so that shape A works without the hosted site. The server
  serves `www/` beside its executable when present, or `--www DIR`.
- `registry/standalone.json` lists the nesvor container and, once published, the
  server downloads. The shared Standalone dialog renders them; the app's connection
  panel links to that dialog for "Get the compute server".

macOS cannot pass an NVIDIA GPU to Docker, so the macOS build is for `native` and
`simulate` runners and for developers; the Standalone text says so.

## 5. Protocol v1

Base path `/api/v1`. JSON bodies use camelCase. Errors are
`{error: {code, message}}` with 400 (invalid spec), 401 (token), 404, 409 (busy or
already finished), 413 (too large), 503 (runner unavailable).

| Method and path | Purpose |
| --- | --- |
| `GET /info` | `{service: "neurodesk-compute", version, protocol: 1, auth: "bearer"}`; with a valid token also `{tools: [{id, version, image, runner, gpu: {available, name}}], simulated}`. |
| `POST /jobs` | Multipart `spec` + files. `202 {id, status, position}`. |
| `GET /jobs/{id}` | `{id, tool, status, position, progress, stage, message, log, outputs, simulated, createdAt, startedAt, finishedAt}`. |
| `GET /jobs/{id}/events` | SSE. Events `status {status, position}`, `progress {fraction, stage}`, `log {line, level}`, `done {status, outputs}`. Heartbeat comment every 15 s. |
| `GET /jobs/{id}/outputs/{name}` | The output bytes; `Content-Disposition` carries the tool's file name. |
| `DELETE /jobs/{id}` | Cancel and remove. `204`. |

Status values: `queued`, `running`, `succeeded`, `failed`, `cancelled`.

The `nesvor` job spec:

```json
{
  "tool": "nesvor",
  "command": "reconstruct",
  "stacks": [{ "file": "stack-0", "thickness": 3.0, "mask": "mask-0" }],
  "options": {
    "outputResolution": 0.8,
    "registration": "svort",
    "segmentation": true,
    "biasFieldCorrection": true,
    "otsuThresholding": false,
    "stacksIntersection": false,
    "deformable": false,
    "iterations": 6000,
    "singlePrecision": false,
    "weightTransformation": 0.1,
    "weightDeform": 0.1,
    "weightImage": 1.0,
    "batchSize": 4096,
    "log2HashmapSize": 19
  }
}
```

Each `file` value names a multipart part. Outputs: `volume.nii.gz`, `result.json`
(the `--output-json` record), `log.txt`. The same schema is checked by the Rust
server, by the Node reference server used in browser tests, and by
`test/remote-compute-protocol.test.mjs`, which runs the same conformance suite
against any base URL so the two implementations cannot drift.

## 6. The webapp

`apps/nesvor` is generated by `pnpm new-app` and keeps the template's regions.

**Input (open).** Example selector first, then the shared file field accepting
several NIfTI stacks. Each loaded stack becomes a row (name, matrix, spacing,
thickness input prefilled from the slice spacing, optional mask assignment, remove).
The viewer shows the selected stack.

**Reconstruction (open).** A protocol select (Fetal brain, Neonatal brain, Fetal body
deformable, Custom) sets the option group from the upstream quick-start recipes.
Output resolution and registration method are visible; the remaining options sit in a
collapsed Advanced settings disclosure and stay editable in Custom. One primary
button, "Reconstruct volume".

**Compute server (open until connected, then collapsed).** Address field, token
field, Connect button, and a one-line state: detected same-origin server, connected
(tool version, runner, GPU name), simulated, or an explanatory error (certificate
not trusted, plain HTTP from the hosted page, token rejected, unreachable). A link
opens the shared Standalone dialog for the download and install instructions. The
address and token persist in `localStorage` under the app's key.

**Output (collapsed until results).** The reconstructed volume (view in NiiVue,
download), `result.json` and the backend log.

**Status bar.** Queue position, stage and fine progress from the event stream;
elapsed time; the small cancel control that issues the DELETE.

**Console.** The backend log lines and client events.

**About, Cite, Privacy.** About describes the pipeline and the compute split. Cite
comes from `registry/app-information.yml` (NeSVoR TMI 2023, SVoRT MICCAI 2022,
MONAIfbs, N4). Privacy is app-owned text that replaces the template's "processed
locally" sentence with the compute-server statement.

**Example.** SVRTK's six simulated fetal brain stacks and one mask (Apache-2.0,
pinned to commit `e7f08ce3` of `SVRTK/SVRTK`) are mirrored to the Hugging Face
dataset through `scripts/mirror-example-assets.py`. Selecting the example loads the
stacks and mask, prefills thicknesses and selects the Fetal brain protocol with
stack-to-stack registration. Reconstruction still needs a server; the browser test
runs the Node reference server with the simulated tool so the whole path from
example to download is exercised in CI without a GPU.

**Desktop suite.** Every catalog app is packaged in the Electron suite and has an
offline workflow test. The suite's session cancels every request that is not the
loopback bundle server or a pinned asset, and its `https` protocol handler answers
only bundled files, so a compute server would be unreachable. The main process gains
`NEURODESK_COMPUTE_ORIGINS`, a comma-separated list of origins that pass both gates
untouched; nothing else changes in the offline policy. The `nesvor` workflow starts
the Node reference server on a loopback port, exports that origin, connects the app
to it and reconstructs the example. The desktop release notes state that real
reconstruction needs a compute server.

**About statement.** The shared About block currently ends every app's builder
sentence with "and runs entirely in your browser", and a test pins that sentence.
That claim is false for this app. The shared statement is split into `builder` (who
makes and hosts the app) and `execution` (where it runs); an app may override
`execution` in `registry/app-information.yml`, and the loader requires the override
to name where processing happens. The shell renders the override in place of the
default sentence.

## 7. Shared code

- `packages/components/src/compute/` exports `createComputeClient({baseUrl, token})`
  with `info()`, `submit(spec, files, {signal})`, `watch(id, handlers, {signal})`
  (SSE with polling fallback), `cancel(id)`, `output(id, name)`, and
  `describeConnectionError(error, {pageOrigin, baseUrl})`, which turns the browser's
  opaque `TypeError: Failed to fetch` into the mixed-content, certificate, or
  unreachable explanation the panel shows. Subpath `@neurodesk/webapp-components/compute`.
- `packages/components/src/elements/compute-connection.js` defines
  `nd-compute-connection` and `createComputeConnection(config)`: the panel described
  in section 6, built only from the existing sidebar vocabulary
  (`.nd-field`, `.nd-btn-secondary`, `.nd-message`, `.nd-hint`).
- `packages/components/test/compute-client.test.js` and
  `compute-connection.test.js` cover the client against a stub server and the
  element's states under jsdom.

The nesvor app owns only: stack table logic, protocol presets, spec assembly,
result handling, its words and its tests.

## 8. Risks and limits

- **GPU is mandatory** for practical run times. CPU mode is exposed by the server
  (`--cpu`) for validation only; the UI labels it.
- **Windows** needs Docker Desktop with WSL2 and the NVIDIA toolkit; **macOS** has
  no GPU container path. Both are stated in the install text.
- **SVoRT is fetal-brain only.** Neonatal and body protocols use stack registration;
  the protocol select enforces this.
- **Self-signed certificates** are the weakest part of shape B. Shape A is
  recommended in the instructions.
- **No hosted demo backend.** Neurodesk does not run GPU servers for the public
  site; the example needs the user's own server or the simulated tool.
- **Container digest pin** means a new upstream release requires a deliberate
  update of the tool definition and re-verification.

## 9. Verification plan

1. `cargo test` in `exes/compute-server`: spec validation, argv mapping, log
   parsing, token and CORS behaviour, job lifecycle with the simulated tool.
2. `test/remote-compute-protocol.test.mjs` against the Rust server and the Node
   reference server.
3. `apps/nesvor` unit tests: preset mapping, thickness inference, spec assembly.
4. Playwright: example → connect → reconstruct → download, cancellation, failed
   connection explanations, token rejection, retry.
5. `pnpm audit:interfaces`, `pnpm test:mobile`, `pnpm test:interface-workflows`
   on a fresh build, plus `test/design-system.test.mjs`.
6. Manual: one real reconstruction of the example on a CUDA host through Docker,
   recorded in this document when done. Not possible on the authoring machine (no
   GPU, no Docker socket access).

## 10. Verification record, 2026-09-21

| Check | Result |
| --- | --- |
| `cargo test`, `clippy -D warnings`, `fmt --check` in `exes/compute-server` | 26 unit and 8 integration tests pass; clean |
| `test/remote-compute-protocol.test.mjs` against the Node reference server | 8 pass |
| The same suite against `neurodesk-compute serve --runner simulate --insecure-http` | 8 pass |
| `packages/components` unit tests (client, connection element, existing suites) | 117 pass |
| `apps/nesvor` unit tests and `pnpm --filter nesvor test:e2e` (7 browser tests) | pass |
| `packages/desktop` unit tests, root registry, examples, design-system, standalone tests | pass |
| `SMOKE_APPS=nesvor pnpm audit:interfaces` on the production build | pass at 1440 and 390 px |
| Real reconstruction on a CUDA host | not run; no GPU or Docker socket on the authoring machine |
| Electron desktop workflow for nesvor | registered and syntax-checked; not executed here |
