# neurodesk-compute

A small, token-protected HTTP + Server-Sent-Events server that runs the
Neurodesk `nesvor` container (fetal MRI slice-to-volume reconstruction, GPU) on
a machine you control, so that the browser webapp at
<https://webapps.neurodesk.org/nesvor/> can offload the reconstruction. One
static binary per platform; no Python, Node.js or runtime to install. The wire
protocol is in
[docs/architecture/remote-compute-protocol.md](../../docs/architecture/remote-compute-protocol.md)
and the design in
[docs/architecture/nesvor-remote-compute.md](../../docs/architecture/nesvor-remote-compute.md).

## Install

1. Download `neurodesk-compute-<version>-<platform>.tar.gz` (`.zip` on Windows)
   from the release, verify the `.sha256`, and extract it.
2. Check the host: `neurodesk-compute doctor` reports whether docker (and the
   NVIDIA container runtime), apptainer or a native `nesvor` are present, whether
   `nvidia-smi` sees a GPU, whether the pinned image is downloaded, and prints the
   URLs and the token.
3. Fetch the pinned image once: `neurodesk-compute pull` (`docker pull` of
   `vnmd/nesvor_0.5.0@sha256:4a9b3462…`, or `apptainer pull` of
   `nesvor_0.5.0_20260722.simg` into the data directory).
4. Start it: `neurodesk-compute serve` (or just `neurodesk-compute`). It prints
   the listening URLs for every local IPv4 address, the token, the runner, GPU
   availability and the TLS mode.

The token is generated on first start and stored owner-readable in
`<data-dir>/token`; pass `--token` or set `NEURODESK_COMPUTE_TOKEN` to fix it.

## Using it from a browser

**A. Bundled page.** Open `https://<server>:8765/` (or `http://` with
`--insecure-http`). The release archive can carry a `www/` directory beside the
executable with the built nesvor app, which the server serves at `/` with
cross-origin-isolation headers; `--www DIR` points at another build. The page is
same-origin with the API, so no certificate warning has to be accepted twice.

**B. Hosted page.** Open <https://webapps.neurodesk.org/nesvor/>, choose the
remote compute option and enter `https://<server>:8765` and the token. With the
default self-signed certificate, open `https://<server>:8765/` once in the same
browser and accept the certificate first; otherwise the hosted (HTTPS) page
cannot reach the server. A plain-HTTP server (`--insecure-http`) can only be
used with shape A, or behind a reverse proxy that terminates TLS.

`http://localhost:*` and `http://127.0.0.1:*` origins are always allowed for
development; other origins need `--allow-origin`.

## GPU requirements

- **Linux**: an NVIDIA GPU, a recent driver, Docker and the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
  (`docker run --gpus all` must work), or apptainer with `--nv`.
- **Windows**: Docker Desktop with the WSL2 backend and an NVIDIA driver that
  supports WSL2 GPU passthrough.
- **macOS**: no NVIDIA GPU containers. The macOS build is for `--runner native`
  (a local nesvor install), `--runner simulate` and development.
- `--cpu` runs without a GPU (`--device -1`); it is very slow but works anywhere.

## Runners

`--runner` selects `docker` (default when `docker info` works), `apptainer`,
`native` (a `nesvor` on `PATH`) or `simulate`. The simulated runner replaces the
tool by a placeholder that averages the uploaded stacks; every response and the
UI mark such results as simulated. It is what the tests and
`make run-simulated` use.

Containers run with `--rm`, `--network none`, only the job directory mounted at
`/job`, and the GPU. Job ids are 128-bit random and never listed.

## Data retention and privacy

Inputs and outputs exist only in `<data-dir>/jobs/<id>/` on the compute host.
A job's directory is removed on `DELETE`, when a finished job is older than
`--retain` (default 1 h), and at server shutdown. Nothing is sent to Neurodesk
or any third party; the server writes no analytics.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--listen ADDR` | `0.0.0.0:8765` | Socket address to bind. |
| `--token T` / `NEURODESK_COMPUTE_TOKEN` | generated | Bearer token. |
| `--data-dir DIR` | platform data dir, `neurodesk-compute` | Jobs, token, TLS files, apptainer image. |
| `--runner R` | auto (docker, apptainer, native) | `docker`, `apptainer`, `native` or `simulate`. |
| `--image REF` | pinned digest / `<data-dir>/nesvor_0.5.0_20260722.simg` | Docker image or `.simg` path. |
| `--cpu` | off | No GPU passthrough, adds `--device -1`. |
| `--parallel N` | 1 | Jobs running at once (multi-GPU hosts). |
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
