# neurodesk-compute

A small, token-protected HTTP + Server-Sent-Events server that runs the
Neurodesk `nesvor` container (fetal MRI slice-to-volume reconstruction, GPU) on
a machine you control, so that the browser webapp at
<https://webapps.neurodesk.org/nesvor/> can offload the reconstruction. In
single-owner mode it also runs project tools on a Slurm cluster (see
[HPC](#hpc-single-owner-mode-and-slurm)). The first supported scientific deployment is Linux x86-64 with an NVIDIA GPU
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
`native` (a `nesvor` on `PATH`), `simulate`, or `slurm` for project tools on a
cluster ([HPC](#hpc-single-owner-mode-and-slurm)). The simulated runner replaces the
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
| `--runner R` | auto (docker, apptainer, native) | `docker`, `apptainer`, `native`, `simulate` or `slurm`. |
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
| `--single-owner` | off | Every pairing maps to one owner; enables projects and data roots. Refuses `--token`. |
| `--data-root ID=PATH` | — | Read-only data root (repeatable; single-owner mode). |
| `--max-download-bytes N` | 2 GiB | Project outputs above this are listed with `download: false`. |
| `--slurm-config FILE` | — | Slurm runner configuration (JSON); its profiles also apply to the simulator. |

`--runner slurm` requires `--single-owner`, `--slurm-config` and a loopback
`--listen`. `--parallel` then caps the jobs handed to Slurm; the production
`--parallel 1` rule does not apply to it.

Subcommands: `serve` (default), `doctor`, `pull` (all accept the same flags),
`unlock --data-dir DIR` and `check-slurm --slurm-config FILE --profile NAME
[--data-root ID=PATH] [--data-dir DIR] [--timeout 1h]`, `fetch-example NAME
--dest DIR`, `fetch-image NAME --dest DIR` and `cryo-em` (see "Quick start").

## HPC: single-owner mode and Slurm

For cryo-EM ([ADR-0004](../../docs/adr/0004-hpc-batch-compute-for-cryo-em.md)),
one user runs the server as themselves on a cluster's submit host. Jobs run
as Slurm batch jobs in an Apptainer image; data stays on the cluster and only
the result files the browser asks for leave it.

- **Single owner.** `--single-owner` maps every pairing to one owner, so a
  browser that pairs again next day sees the same projects. Each credential is
  revoked after 14 days without use, and `DELETE /api/v1/session` revokes only
  the calling credential. The pairing code is read from `<data-dir>/token`,
  which must have mode 0600, or from `NEURODESK_COMPUTE_TOKEN`; `--token` is
  refused because other users of a login node can read process arguments.
- **Data roots.** `--data-root facility=/scratch/cryoem/incoming` names a
  read-only directory. Clients list it and select files in it by relative
  path and pattern; the API never shows host paths. Jobs see it at
  `/data/facility`. STAR files store that path, so renaming or removing a root,
  or a site purge of scratch storage, breaks existing projects.
- **Projects.** Each project is a RELION project directory,
  `<data-dir>/projects/<id>/`, mounted read-write at `/project` in its jobs.
  Projects and their jobs are never removed by `--retain`; delete them through
  the API, newest job first.
- **Slurm.** `--runner slurm --slurm-config slurm.json` submits each job with
  `sbatch` as `nd-<job id>` with `--no-requeue`. The batch script
  (`<Type>/jobNNN/job.sbatch`) starts the configured `apptainer` through
  `env -i`, keeping only `PATH`, `HOME`, `USER`, `LANG` and
  `CUDA_VISIBLE_DEVICES`, with `exec --containall --no-mount hostfs,bind-paths`
  and node-local scratch as `--workdir`. The container sees the project, the
  data roots, the image and, for GPU profiles, the GPU driver (`--nv`).
  `run.out` and `run.err` in the job directory are the job's log. Jobs outlive
  the server: stopping it leaves them to Slurm, and the next start re-attaches
  them and re-reads their logs.

`slurm.json`:

```json
{
  "apptainer": "/usr/bin/apptainer",
  "image": { "path": "/shared/images/relion/relion_5.1.1.sif" },
  "scratch": "$TMPDIR",
  "profiles": {
    "cpu": { "partition": "cpu", "cpus": 16, "gpus": 0, "memory": "64G", "time": "12:00:00" },
    "gpu-4": { "partition": "gpu", "account": "lab", "cpus": 24, "gpus": 4, "memory": "128G", "time": "24:00:00" }
  },
  "defaults": {
    "import": "cpu", "motioncorr": "cpu", "ctffind": "cpu", "autopick": "cpu", "extract": "cpu",
    "class2d": "gpu-4", "select": "cpu", "initialmodel": "gpu-4", "refine3d": "gpu-4",
    "maskcreate": "cpu", "postprocess": "cpu"
  }
}
```

Every `relion` command needs a default profile when there is more than one
profile; the server refuses to start otherwise, because the app's "Server
default" names none. `scratch` is `$NAME`, `${NAME}` or an absolute path on the compute node; each
job uses and removes `<scratch>/nd-<job id>`. A profile may set `gres` (for
example `"gpu:a100:4"`) in place of the default `gpu:<gpus>`. The data
directory, data roots, image and `apptainer` paths may contain only letters,
digits and `/ . _ + - @ ~ =`, because they are written into `#SBATCH` lines and
`--bind` arguments.

At startup the server runs `sbatch`, `squeue`, `sacct`, `scontrol` and
`scancel --version`, checks that accounting answers, asks `sbatch --test-only`
to accept every profile, and checks the image's SHA-256 (once per path, size
and modification time; the result is cached in the data directory). Sites
without Slurm accounting are not supported.

### The `relion` tool

The cryo-EM app's jobs are RELION 5.1.1 commands (`import`, `motioncorr`,
`ctffind`, `autopick`, `extract`, `class2d`, `select`, `initialmodel`,
`refine3d`, `maskcreate`, `postprocess`), one RELION job per compute job, in a
project. The tool is offered only in single-owner mode on the `slurm` or
`simulate` runner. Its options, defaults, ranges and command lines are not
written in Rust: `src/tools/relion` embeds
[`packages/cryo-em/src/commands.json`](../../packages/cryo-em/src/commands.json)
at build time and interprets it exactly as `packages/cryo-em/src/spec.js` does
for the app and the Node reference server. The tests hold it to the package's
fixtures: `test/fixtures/argv-cases.json` (the command lines, byte for byte,
which equal what RELION's GUI writes to `note.txt`) and
`test/fixtures/validation-cases.json` (the same accept and refuse decisions
with the same messages, and RELION's number formatting). After changing the
package, regenerate its fixtures (`pnpm --filter @neurodesk/cryo-em fixture`)
and run `make test`.

- Each step runs in `/project`; the main program runs under
  `mpirun --bind-to none -np <ranks>` when its launch rule gives more than one
  rank. Every profile a command defaults to must be able to run it: a profile
  with fewer CPUs than `refine3d` needs MPI ranks (3, or `gpus + 1` rounded up
  to odd) is refused at startup and in specs. With the simulator, the built-in
  `local` profile has the host's CPU count, so a host with fewer than 3 CPUs
  refuses to start in single-owner mode.
- `info.tools[].image` reports
  `vnmd/relion_5.1.1@sha256:14c760762a640c7dca9033cc261d80428ceee74239e9e60eb2a5080962c1c3a0`
  (`tools::relion::IMAGE`, tag `20261107`). The Slurm runner always runs the
  SIF from `--slurm-config`; `fetch-image relion` downloads the one built from
  that image.
- Inputs are earlier jobs' outputs (project-relative paths), uploaded MRC parts
  (`gain`, `mask`, stored in the job directory), or files in data roots:
  `{ root, path, pattern }` for movies and `{ root, path }` for one file, such
  as a gain reference.
- Progress comes from RELION's own lines: the preprocessing progress bar, VDAM
  iterations and auto-refine iterations.

With `--runner simulate`, `relion` runs no RELION program. It logs the command
lines it would run, checks that every file the inputs reference exists
(following STAR files from job to job, into data roots, and image indices into
MRC stacks), replays RELION-format log lines and writes each command's outputs
as small valid STAR and MRC files, then `run.out`, `run.err` and
`RELION_JOB_EXIT_SUCCESS` or `RELION_JOB_EXIT_FAILURE`. A job whose inputs
reference a missing file fails with `tool-failed` naming the referring file.
The files follow "The simulated `relion` tool" in the protocol: the same
names, data blocks, columns and MRC sizes as the Node reference server
(`test-utils/relion-simulator.mjs`), not the same bytes.

### The RELION image

```sh
neurodesk-compute fetch-image relion --dest /shared/images
```

downloads the RELION 5.1.1 Apptainer image to
`/shared/images/relion/relion_5.1.1.sif`, from the Hugging Face dataset at a
pinned commit, resuming and checking it like the example data below. Put it
where every compute node can read it. With that image, `slurm.json` can leave
`image.sha256` out: the server checks the file against the SHA-256 pinned in
`src/examples.rs`. An image you build yourself needs its own `image.sha256`.

### Example data

```sh
neurodesk-compute fetch-example relion-tutorial --dest /scratch/you/examples
```

downloads the 24 movies and the gain reference of RELION's single-particle
tutorial (EMPIAR-10204 subset, CC0, 3.2 GB) from the Hugging Face dataset
`neurodeskorg/webapps` at a pinned commit into
`/scratch/you/examples/relion-tutorial/`. Each file's SHA-256 is pinned in
`src/examples.rs`; a file is written as `<name>.part` and renamed only once it
matches. Rerunning skips verified files and resumes partial ones. The command
prints the flag to add to `serve`, `--data-root examples=/scratch/you/examples`,
and what to import (root `examples`, path `relion-tutorial/Movies`, pattern
`*.tiff`). It honours `HTTPS_PROXY` and verifies TLS against the bundled
Mozilla roots.

### Quick start

```sh
tmux new -s cryo-em
neurodesk-compute cryo-em [--account NAME] [--gpu-partition NAME]
```

does the deployment below in one command, as yourself on a named submit host.
In the data directory (`--data-dir`, default the platform data dir, which
every compute node must read and write) it:

1. writes `slurm.json` once, from `sinfo -h -o "%P %G"` and `apptainer` on
   `PATH`: a `cpu` profile (8 CPUs, 32G, 12 h) on the default partition without
   GPUs and a `gpu` profile (1 GPU, 8 CPUs, 64G, 24 h) on the first partition
   with a `gpu` GRES, with every RELION command's default
   (`src/runner/slurm/quickstart.rs`). Later starts keep the file, so edit it to
   change partitions or resources;
2. fetches the RELION image into `images/` when the file `slurm.json` names is
   missing, and the tutorial into `examples/`, both as below;
3. runs `check-slurm` on both profiles whenever `slurm.json` differs from the
   copy saved after the last passing check (`slurm-check.json`), unless
   `--skip-check`;
4. serves single-owner Slurm on `127.0.0.1:<--port, default 8765>` over HTTP
   with the built app, data root `examples` and any `--data-root`, and prints
   the SSH tunnel command for its host and the pairing code.

### Deployment

1. Pick a named submit host where long-running user processes are allowed (a
   login alias often covers several hosts, and some sites stop user processes
   on login nodes). Run the server there as yourself, never as root or a shared
   account, and keep it alive with `tmux` or a user systemd unit.
2. Check each profile's compute nodes once before use:

   ```sh
   neurodesk-compute check-slurm --slurm-config slurm.json --profile gpu-4 \
     --data-root facility=/scratch/cryoem/incoming --data-dir ~/neurodesk-compute
   ```

   The probe job runs through the same batch script. It reports whether the
   node runs the image, reads every data root, writes the projects directory
   and `/tmp`, sees the allocated GPUs, and keeps out a canary directory named
   by `APPTAINER_BIND`, `APPTAINER_MOUNT` and `SINGULARITY_BIND` as well as the
   server's data directory. A failed probe keeps its files and prints where.
3. Start the server on loopback with the built app:

   ```sh
   neurodesk-compute serve --single-owner --runner slurm --slurm-config slurm.json \
     --data-root facility=/scratch/cryoem/incoming --data-dir ~/neurodesk-compute \
     --listen 127.0.0.1:8765 --insecure-http --www ./www
   ```

   Other users of the host can reach a loopback port, so every API call needs a
   credential and the pairing code file is private. Two users on one host need
   different ports.
4. From your computer, open an SSH tunnel to that named host and port, then
   open `http://localhost:8765` and pair with the code from
   `<data-dir>/token`:

   ```sh
   ssh -N -L 8765:127.0.0.1:8765 you@login2.cluster.example
   ```

   The page and the API share one origin, and `localhost` is a secure context.
   This tunnel is the only supported route for now; the hosted page, Open
   OnDemand and site gateways are not.

### One server per data directory

Besides the `flock` on `server.lock`, which some Lustre and NFS mounts do not
honour across hosts, a Slurm-mode server creates `<data-dir>/instance.lock`
exclusively, naming its host, process id and start time. A clean shutdown
removes it. If the lock is left behind (a crash, a killed process or a lost
host), the server refuses to start and names the holder. Confirm that server
is stopped, then run `neurodesk-compute unlock --data-dir DIR`; it refuses
while a server still holds the `flock`. There is no automatic takeover.

## Development

```sh
make build            # release build
make test             # cargo test (unit + integration; simulate runner, fake Slurm commands)
make lint fmt         # clippy -D warnings, fmt --check
make conformance      # the Node protocol suites against this server (needs node and curl)
make run-simulated    # serve --runner simulate --insecure-http --listen 127.0.0.1:8765 --token dev
```

`make conformance` builds the server and runs `scripts/conformance.sh`: it
starts a per-pairing simulate server and a single-owner simulate server with a
temporary data root (`facility`) and `--max-download-bytes 65536`, then runs
`test/remote-compute-protocol.test.mjs` against the first and
`test/remote-compute-hpc.test.mjs` against both. The same suites run against
the Node reference server by default, so both implementations answer to one
test. CI runs it in `compute-server-native.yml`.

Protocol: [remote-compute-protocol.md](../../docs/architecture/remote-compute-protocol.md).


## Native SCT analysis

With `--runner docker`, the server also advertises the CPU-only `sct` tool.
It runs `sct_process_segmentation` and `sct_analyze_lesion` in
`vnmd/spinalcordtoolbox_7.3.3@sha256:974f6019415df81465ac03102d27b8a23945155b96a45e7b5f525a3d0d55ab83`.
This image reports SCT 7.3. Pull that exact image on the compute host before
analysis. The server starts it with `--pull=never`, so a missing image fails
the job with Docker's "No such image" error instead of downloading it mid-job. `neurodesk-compute pull` and `--image` retain their NeSVoR meaning;
an image override never replaces SCT's pinned runtime. SCT needs no CUDA/GPU.

The SCT webapp sends role-named NIfTI masks only when the user runs analysis.
The server passes their bytes unchanged and returns native CSV for morphometry,
or XLSX, pickle and labeled NIfTI for lesion analysis. See the
[protocol](../../docs/architecture/remote-compute-protocol.md#job-specification-sct)
for supported flags and output names. Existing pairing, ownership, cancellation
and retention rules apply. Native and Apptainer runners do not advertise SCT
because their scientific dependencies cannot be verified against the image pin.
Simulation returns explicit placeholders and proves transport only.
