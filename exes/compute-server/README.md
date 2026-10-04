# neurodesk-compute

A small, token-protected HTTP + Server-Sent-Events server that runs the
Neurodesk `nesvor` container (fetal MRI slice-to-volume reconstruction, GPU) on
a machine you control, so that the browser webapp at
<https://webapps.neurodesk.org/nesvor/> can offload the reconstruction. The first supported scientific deployment is Linux x86-64 with an NVIDIA GPU
and Docker. The server executable does not need Python or Node.js; the scientific
container, models, Docker and NVIDIA runtime are separate requirements. The wire
protocol is in
[docs/architecture/remote-compute-protocol.md](../../docs/architecture/remote-compute-protocol.md)
and the design in
[docs/architecture/nesvor-remote-compute.md](../../docs/architecture/nesvor-remote-compute.md).

## Install

1. In the NeSVoR webapp, open **Standalone** or **Download and set up compute server**.
   The **Compute server · Linux with NVIDIA GPU** section provides any available
   backend archive and copyable setup commands. Preview builds are labelled; they
   are not validated scientific releases. If no download is available, build with
   `make build`, or use a published Linux x86-64 archive when available.
   Verify its `.sha256` before extraction. CI artifacts and draft releases are not
   evidence that reconstruction or offline installation has passed.
2. Check the host: `neurodesk-compute doctor` reports whether docker (and the
   NVIDIA container runtime), apptainer or a native `nesvor` are present, whether
   `nvidia-smi` sees a GPU, whether the pinned image is downloaded, and prints the
   URLs and the pairing code.
3. Fetch the pinned image once: `neurodesk-compute pull` (`docker pull` of
   `vnmd/nesvor_0.5.0@sha256:4a9b3462…`, or `apptainer pull` of
   `nesvor_0.5.0_20260722.simg` into the data directory).
4. From the extracted archive, start `./start.sh --runner docker`. When connecting
   from a preview or another hosted origin, append `--allow-origin https://YOUR-WEBAPP-HOST`.
   The Standalone dialog includes the current page origin in its startup command.
   Leave the terminal open. The server prints
   the listening URLs for every local IPv4 address, the pairing code, the runner, GPU
   availability and the TLS mode.

The installation pairing code is generated on first start and stored owner-readable
in `<data-dir>/token`; `--token` or `NEURODESK_COMPUTE_TOKEN` overrides it.
The code can create a client session through `POST /api/v1/pair`, but cannot read
or mutate jobs. Each successful pairing returns a separate durable bearer token
and client identity. Keep a client token to recover that client's jobs after a
browser or server restart. Re-pairing creates a new identity, not access to earlier
sessions. `DELETE /api/v1/session` revokes the current token. The operator can revoke
other identities by stopping the server and removing their records from the
owner-readable `sessions.json`; do not edit it while the service is running.

## Using it from a browser

**A. Bundled page.** Open `https://<server>:8765/` (or `http://` with
`--insecure-http`). The release archive can carry a `www/` directory beside the
executable with the built nesvor app, which the server serves at `/` with
cross-origin-isolation headers; `--www DIR` points at another build. The page is
same-origin with the API, so no certificate warning has to be accepted twice.

**B. Hosted page.** Open <https://webapps.neurodesk.org/nesvor/>, choose the
remote compute option and enter `https://<server>:8765` and the pairing code. Use a site-trusted TLS certificate for clinical connections.
Self-signed certificates are a development option and require browser trust setup.
Browser permission and mixed-content behavior varies; plain HTTP is not the
supported clinical connection. A reverse proxy can terminate trusted TLS.

`http://localhost:*` and `http://127.0.0.1:*` origins are always allowed for
development; other origins need `--allow-origin`.

## GPU requirements

Linux x86-64 needs an NVIDIA GPU, a compatible driver, Docker and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/).
`docker run --gpus all` must work. CPU, macOS, Windows, native and Apptainer paths
are development options, not validated scientific release targets. Production
runners require `--parallel 1` until GPU allocation is implemented.

## Runners

`--runner` selects `docker` (default when `docker info` works), `apptainer`,
`native` (a `nesvor` on `PATH`) or `simulate`. The simulated runner replaces the
tool by a placeholder that averages the uploaded stacks; every response and the
UI mark such results as simulated. It is what the tests and
`make run-simulated` use.

Containers run with `--rm`, `--network none`, only the job directory mounted at
`/job`, and the GPU. Job ids are 128-bit random; `GET /api/v1/jobs` lists only
the authenticated client's jobs. Status, events, outputs, cancellation and deletion
enforce the same owner. Credentials are accepted only in Authorization headers.

NeSVoR downloads missing SVoRT and segmentation weights into its package checkpoint
directory. The complete required model cache must already be inside the image
before processing with `--network none`. Pulling the image alone has not been
verified to supply every checkpoint. A successful simulated run does not establish
this; validate the real pinned image offline before deployment.

## Data retention and privacy

Inputs and outputs exist only in `<data-dir>/jobs/<id>/` on the compute host.
Successful submission writes synchronized input files and an atomic job record
before acknowledgment. `Idempotency-Key` identifies an immutable submission within
one client identity. Retrying the same key returns its existing receipt while that
record is retained. A SHA-256 fingerprint covers the JSON specification and each
file part; changed settings or bytes with a reused key return 409. Retries upload
the inputs again for this comparison. Use a new key for a changed examination or deliberate rerun.
Unfinished upload directories are removed after an interrupted request or at startup.

`POST /jobs/{id}/cancel` requests cancellation. A running job remains `cancelling`
until its process exits; `DELETE /jobs/{id}` accepts only terminal jobs. Failed
container termination leaves the job nonterminal and stops admission of new work.
A finished job's directory is removed on DELETE or after `--retain` (default 1 h).
Shutdown stops active jobs and preserves records and results. Restart recovers
results and marks interrupted work failed after stopping surviving named Docker
containers. It never silently replays scientific work. Interrupted native/Apptainer
runs require operator cleanup; startup fails closed rather than guessing which
host process to kill. One server can own a data directory at a time.

The Linux data directory has mode 0700; session and job records use mode 0600.
Atomic replacement synchronizes the record and its containing directory. Deletion
writes a tombstone first, so a crash cannot restore a deleted job. Retention resumes
on startup. Nothing is sent to Neurodesk or any third party; the server writes no
analytics. Model acquisition must be completed separately before offline operation.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--listen ADDR` | `0.0.0.0:8765` | Socket address to bind. |
| `--token T` / `NEURODESK_COMPUTE_TOKEN` | generated | Installation pairing code. |
| `--data-dir DIR` | platform data dir, `neurodesk-compute` | Jobs, token, TLS files, apptainer image. |
| `--runner R` | auto (docker, apptainer, native) | `docker`, `apptainer`, `native` or `simulate`. |
| `--image REF` | pinned digest / `<data-dir>/nesvor_0.5.0_20260722.simg` | Docker image or `.simg` path. |
| `--cpu` | off | No GPU passthrough, adds `--device -1`. |
| `--parallel N` | 1 | Must be 1 for production runners; larger values are simulator-only. |
| `--retain DUR` | `1h` | Delete finished jobs after this. |
| `--allow-origin O` | — | Extra CORS origin (repeatable). |
| `--tls-cert PEM --tls-key PEM` | self-signed | Site certificate. |
| `--insecure-http` | off | Plain HTTP. |
| `--www DIR` | `www` beside the executable | Static files served at `/`. |
| `--max-upload-bytes N` | 4 GiB | Request body limit. |
| `--max-files N` | 40 | File parts per job. |

Subcommands: `serve` (default), `doctor`, `pull`. All accept the same flags.

## Development

```sh
make build            # release build
make test             # cargo test (unit + integration, simulate runner)
make lint fmt         # clippy -D warnings, fmt --check
make run-simulated    # serve --runner simulate --insecure-http --listen 127.0.0.1:8765 --token dev
```

Protocol: [remote-compute-protocol.md](../../docs/architecture/remote-compute-protocol.md).


## Native SCT analysis

With `--runner docker`, the server also advertises the CPU-only `sct` tool.
It runs `sct_process_segmentation` and `sct_analyze_lesion` in
`vnmd/spinalcordtoolbox_7.3.3@sha256:974f6019415df81465ac03102d27b8a23945155b96a45e7b5f525a3d0d55ab83`.
This image reports SCT 7.3. Pull that exact image on the compute host before
analysis. `neurodesk-compute pull` and `--image` retain their NeSVoR meaning;
an image override never replaces SCT's pinned runtime. SCT needs no CUDA/GPU.

The SCT webapp sends role-named NIfTI masks only when the user runs analysis.
The server passes their bytes unchanged and returns native CSV for morphometry,
or XLSX, pickle and labeled NIfTI for lesion analysis. See the
[protocol](../../docs/architecture/remote-compute-protocol.md#job-specification-sct)
for supported flags and output names. Existing pairing, ownership, cancellation
and retention rules apply. Native and Apptainer runners do not advertise SCT
because their scientific dependencies cannot be verified against the image pin.
Simulation returns explicit placeholders and proves transport only.
