# Remote compute protocol v1

The contract between a Neurodesk webapp and a compute server. Two implementations
exist: `exes/compute-server` (Rust, the shipped `neurodesk-compute` binary) and
`test-utils/compute-reference-server.mjs` (Node, used by browser and desktop tests).
`test/remote-compute-protocol.test.mjs` runs the same suite against both. The design
rationale is in [nesvor-remote-compute.md](nesvor-remote-compute.md).

## Transport

- Base path `/api/v1`. JSON request and response bodies use camelCase.
- Pair with `POST /api/v1/pair`, JSON `{ "code": "<installation code>" }`.
  The response is `{ "token": "<client credential>", "clientId": "<owner>" }`.
  The installation code never authorizes patient operations. Each pairing owns
  its own jobs. Send `Authorization: Bearer <client credential>` on subsequent
  requests. Credentials are never accepted in URLs. The browser keeps the
  credential in tab session storage for reload recovery. Disconnect clears it.
  Only the server address goes into persistent local storage.
- `DELETE /api/v1/session` revokes the current credential. `GET /api/v1/jobs`
  returns `{ "jobs": [...] }` for that credential's owner. Other owners' job IDs
  return 404 on every endpoint, including output and cancellation.
- CORS: the server answers preflights for allowed origins with
  `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key`,
  `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`,
  `Access-Control-Allow-Private-Network: true`, `Access-Control-Max-Age: 600`, and
  `Vary: Origin`. Requests from other origins are rejected before executing a handler. `Origin`-less
  requests (same origin, curl) are always allowed.
- Errors: `{ "error": { "code": string, "message": string } }`. Codes: `invalid-spec` (400),
  `unauthorized` (401), `not-found` (404), `conflict` (409), `too-large` (413),
  `runner-unavailable` (503).
- Every response carries `Cache-Control: no-store`.

## Endpoints

### `GET /api/v1/info`

Without a token:

```json
{ "service": "neurodesk-compute", "version": "0.1.20260921", "protocol": 1, "auth": "pairing" }
```

With a valid token the same object also contains:

```json
{
  "simulated": false,
  "runner": "docker",
  "gpu": { "available": true, "name": "NVIDIA RTX A6000" },
  "tools": [
    { "id": "nesvor", "version": "0.5.0", "image": "vnmd/nesvor_0.5.0@sha256:4a9b3462…", "commands": ["reconstruct"] }
  ],
  "limits": { "maxUploadBytes": 4294967296, "maxFiles": 40 }
}
```

`simulated` is `true` when the server runs the placeholder tool instead of the
container. `gpu.name` is `null` when unknown.

### `POST /api/v1/jobs`

`Idempotency-Key` is required and scoped to the paired owner. Retrying the same
accepted key with identical parsed settings and file bytes returns the same job
receipt. Changed content under an accepted key returns 409. Use a new key for a
new run. Current retries resend the complete upload; chunked resume is not yet
implemented.

`multipart/form-data`. The first part is named `spec` and holds the JSON job
specification. Every further part is a file whose part name is referenced by the
spec (`stack-0`, `mask-0`, …). Part file names are ignored; the tool assigns names.

Response `202 Accepted`:

```json
{ "id": "3f9c2c8a0a6d4b0f9d2c1d5a2f0c7b11", "status": "queued", "position": 0 }
```

`position` is the number of jobs ahead in the queue.

### `GET /api/v1/jobs/{id}`

```json
{
  "id": "3f9c…",
  "tool": "nesvor",
  "command": "reconstruct",
  "status": "running",
  "position": 0,
  "progress": 0.42,
  "stage": "Reconstruction",
  "message": "NeSVoR training starts.",
  "simulated": false,
  "createdAt": "2026-09-21T10:00:00Z",
  "startedAt": "2026-09-21T10:00:03Z",
  "finishedAt": null,
  "error": null,
  "outputs": []
}
```

`status` is one of `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`.
`progress` is a fraction in `[0, 1]` or `null` before the first progress event.
`outputs` is filled when the job succeeded:

```json
"outputs": [
  { "name": "volume.nii.gz", "bytes": 2334211, "contentType": "application/gzip" },
  { "name": "result.json", "bytes": 812, "contentType": "application/json" },
  { "name": "log.txt", "bytes": 15320, "contentType": "text/plain" }
]
```

`error` is `{ "code": "tool-failed", "message": "nesvor exited with status 1" }`
for failed jobs and `null` otherwise.

### `GET /api/v1/jobs/{id}/events`

`text/event-stream`. The server first replays the current state, then streams:

| Event | Data |
| --- | --- |
| `status` | `{ "status": "queued", "position": 1 }` |
| `progress` | `{ "fraction": 0.42, "stage": "Reconstruction" }` |
| `log` | `{ "line": "2026-09-21 10:00:03 [INFO] Registration starts ...", "level": "info" }` |
| `done` | The complete job object of `GET /jobs/{id}` |

`level` is `info`, `warning` or `error`. A comment line (`: keepalive`) is sent
every 15 s. The stream closes after `done`. Reconnecting replays the state again.

### `GET /api/v1/jobs/{id}/outputs/{name}`

Bytes of the named output with `Content-Type`, `Content-Length` and
`Content-Disposition: attachment; filename="<name>"`. `404` for unknown names or
jobs that did not succeed.

### `POST /api/v1/jobs/{id}/cancel`

Returns the current job. A running job enters `cancelling`; `cancelled` and the
terminal event occur only after its process exits. Cancelling a queued job
removes it from the queue. Cancellation retains status and logs for inspection.

### `DELETE /api/v1/jobs/{id}`

Deletes a terminal job and its files, returning 204. Active jobs return 409;
unknown or other-owner IDs return 404. Download results before deleting.

### Persistence

The server writes job ownership, receipt and status atomically to its data
folder. Startup reconciles interrupted runs and restores terminal records so
retention cleanup continues after restart. Stopping the server does not delete
completed jobs.

## Job specification: `nesvor`

```json
{
  "tool": "nesvor",
  "command": "reconstruct",
  "stacks": [
    { "file": "stack-0", "thickness": 3.0, "mask": "mask-0" },
    { "file": "stack-1", "thickness": 3.0 }
  ],
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

Validation rules, applied identically by both servers:

- `tool` is `nesvor`; `command` is `reconstruct`.
- `stacks` has 1 to 20 entries. `file` names a multipart part that was received.
  `thickness` is a finite number in `(0, 20]`. `mask` is optional and names a part.
- `options` keys are all optional; unknown keys are rejected. Ranges:
  `outputResolution` in `[0.3, 3]`; `registration` in `svort`, `svort-only`,
  `svort-stack`, `stack`, `none`; booleans as listed; `iterations` integer in
  `[100, 20000]`; `weight*` in `[0, 100]`; `batchSize` integer in `[256, 32768]`;
  `log2HashmapSize` integer in `[15, 24]`.
- Every referenced part must be a NIfTI-1 file, gzipped or not (magic `n+1` or
  `ni1` at byte 344 of the decompressed header). Anything else is `invalid-spec`.

Command line produced from the spec (the Rust server's `argv`; the Node reference
server logs the same line without running it):

```
nesvor reconstruct
  --input-stacks /job/in/stack-0.nii.gz /job/in/stack-1.nii.gz
  --stack-masks /job/in/mask-0.nii.gz            # only when every stack has a mask
  --thicknesses 3.0 3.0
  --output-volume /job/out/volume.nii.gz
  --output-json /job/out/result.json
  --output-resolution 0.8
  --registration svort
  --segmentation                                  # flags only when true
  --bias-field-correction
  --otsu-thresholding
  --stacks-intersection
  --deformable
  --n-iter 6000
  --single-precision
  --weight-transformation 0.1 --weight-deform 0.1 --weight-image 1.0
  --batch-size 4096 --log2-hashmap-size 19
  --verbose 1
```

Masks must be supplied for every stack or for none. Partial mask bundles are
rejected instead of silently discarding masks.

Outputs: `volume.nii.gz`, `result.json` and `log.txt` (the complete stdout and
stderr of the tool). A failed job still exposes `log.txt` through the events
stream's log lines and in `GET /jobs/{id}`'s `error.message`.

## Progress mapping for `nesvor`

Log lines follow Python logging: `YYYY-MM-DD HH:MM:SS [LEVEL] message`.

| Line contains | Stage | Fraction |
| --- | --- | --- |
| `Data loading starts` | Loading stacks | 0.02 |
| `Segmentation starts` | Brain masking | 0.08 |
| `Bias Field Correction starts` | Bias field correction | 0.15 |
| `Assessment starts` | Stack assessment | 0.20 |
| `Registration starts` | Motion correction | 0.25 |
| `Reconsturction starts` or `Reconstruction starts` | Reconstruction | 0.40 |
| `NeSVoR training starts.` | Reconstruction | 0.40 |
| training table row (`time epoch iter …` columns) | Reconstruction | 0.40 + 0.50 × iter / iterations |
| `Results saving starts` | Sampling volume | 0.92 |
| `finished, overall time` | Finished | 1.00 |

A training row is a line whose message consists of whitespace-separated columns
where the first column parses as `H:MM:SS` and the third as an integer. The upstream
spelling `Reconsturction` is a typo in NeSVoR 0.5.0 and must be matched.

## The simulated tool

With `--runner simulate` (Rust) or by default (Node reference server) the `nesvor`
tool is replaced by a placeholder: the server decompresses every stack, averages the
voxels of all stacks that share the first stack's dimensions, writes the mean as a
float32 NIfTI-1 gzipped volume with the first stack's header, and writes
`result.json` as `{ "simulated": true, "stacks": N, "options": {…} }`. It logs the
`argv` it would have run and the stage lines of the table above so that progress
parsing is exercised. `info.simulated` and every job's `simulated` are `true`.

## Job specification: `sct`

SCT analysis runs on the CPU in the registry-pinned image
`vnmd/spinalcordtoolbox_7.3.3@sha256:974f6019415df81465ac03102d27b8a23945155b96a45e7b5f525a3d0d55ab83`.
This image reports SCT `7.3` through `sct_version`, despite its `7.3.3` tag.
The authenticated tool entry advertises its version, image and commands. Container
selection and GPU requirements belong to each tool; NeSVoR keeps its existing
image override and CPU option. SCT never receives NeSVoR's `--device` flag. SCT is advertised and accepted only
with Docker or the explicit simulator. Docker runs the pinned image with
`--pull=never`; the operator pulls it before the first job. Native and Apptainer runners do not
guarantee the pinned dependency stack and do not advertise SCT.

Morphometry accepts a cord segmentation without an anatomy image:

```json
{"tool":"sct","command":"process_segmentation","cord":"cord","options":{"perSlice":true,"angleCorrection":true,"slices":"2:12"}}
```

Lesion analysis accepts an independent lesion mask and an optional cord mask:

```json
{"tool":"sct","command":"analyze_lesion","lesion":"lesion","cord":"cord","options":{}}
```

Only the fields shown are accepted. `cord` and `lesion` reference distinct
uploaded NIfTI-1 parts. No unused parts are accepted. Every SCT mask uses its
role as its multipart name, so `cord` must reference `cord` and `lesion` must
reference `lesion`. The server stores the original bytes as `cord.nii[.gz]`
and `lesion.nii[.gz]`. It does not threshold, resample or change orientation.
SCT validates scientific input requirements itself.

Morphometry options are optional. `perSlice` and `angleCorrection` are booleans,
passed as `-perslice 0|1` and `-angle-corr 0|1`. `slices` is a nonempty comma-separated
list of nonnegative slice indices or ascending inclusive ranges such as
`2:12,15`, passed as `-z`. Unknown options are rejected. Lesion analysis currently
accepts no options. Omitted options retain upstream defaults.

The allowlisted commands are:

```
sct_process_segmentation -i /job/in/cord.nii.gz -o /job/out/morphometry.csv
sct_analyze_lesion -m /job/in/lesion.nii.gz -s /job/in/cord.nii.gz -ofolder /job/out
```

The lesion `-s` argument is omitted when no cord is supplied. Morphometry returns
`morphometry.csv`. Lesion analysis returns native `lesion_analysis.xlsx`,
`lesion_analysis.pkl` and `lesion_label.nii[.gz]`, retaining the input compression. Both commands also expose
`log.txt`. Downloads preserve original native bytes. Lesion spreadsheets and
pickle files are not CSV files. Independent native runs may differ in timestamps
and archive metadata; numerical/data fields are the compatibility contract.
A downloaded artifact must match its originating run byte for byte.

Simulation exercises transport and cancellation only. Its morphometry CSV is
explicitly labelled simulated; lesion placeholders have the native filenames
but contain no scientific results. Never use simulated output for analysis.

## HPC features: single-owner mode, projects, data roots, Slurm

[ADR-0004](../adr/0004-hpc-batch-compute-for-cryo-em.md) adds these features for
cryo-EM processing on a cluster. They are additive: a server that does not
enable them answers every request above exactly as before, and a client that
does not use them sees no change. A client checks `info.features` before using
any of them.

### Single-owner mode

`neurodesk-compute serve --single-owner` (reference server: `singleOwner: true`)
maps every pairing to one owner, the Unix user the server runs as.

- `POST /api/v1/pair` returns `{ "token": "<credential>", "clientId": "single-owner" }`.
  Every credential sees the same jobs and projects.
- Sessions are keyed by credential, in both modes. `DELETE /api/v1/session`
  revokes only the credential that calls it.
- In single-owner mode a credential that has not been used for 14 days
  (`SESSION_IDLE_DAYS`) is revoked. Use refreshes it; the server may persist the
  refresh at most once per hour.
- The server refuses `--token` on its command line in this mode, because other
  users of a login node can read process arguments. It reads the pairing code
  from `<data-dir>/token` or `NEURODESK_COMPUTE_TOKEN`, and refuses to start when
  the token file is readable by group or others.
- Projects, data roots and the `relion` tool exist only in this mode.

### Additions to `GET /api/v1/info`

With a valid token:

```json
{
  "ownership": "single",
  "features": ["projects", "dataRoots", "scheduler"],
  "dataRoots": [{ "id": "facility", "label": "facility" }],
  "profiles": [{ "name": "gpu-4", "summary": "4 GPUs, 24 CPUs, 128G, 24:00:00" }],
  "limits": { "maxUploadBytes": 4294967296, "maxFiles": 40, "maxDownloadBytes": 2147483648 }
}
```

- `ownership` is `"pairing"` or `"single"`. Absent on older servers; treat absent
  as `"pairing"`.
- `features` lists `projects` and `dataRoots` in single-owner mode and
  `scheduler` with the Slurm runner. A per-pairing server sends `features: []`;
  older servers omit it. Absent or empty means none.
- `dataRoots` is present only with the `dataRoots` feature; `profiles` only with
  the `projects` feature (the Slurm runner's profiles, or the built-in `local`
  profile).
- `limits.maxDownloadBytes` is always present on servers that implement this
  section; default 2 GiB (`--max-download-bytes`).

Without a token the response is unchanged.

### Data roots

The operator names read-only directories:
`--data-root facility=/scratch/cryoem/incoming` (repeatable). A root id matches
`^[a-z0-9][a-z0-9-]{0,31}$`; its label is its id.

#### Relative paths

Every path a client sends for a data root or a project is a relative path:

- at most 1024 bytes of UTF-8, `/`-separated;
- no empty, `.` or `..` component, no leading `/`, no `\`, no NUL;
- the empty string means the root itself.

The server joins it to the root, canonicalises the result (resolving symlinks)
and rejects it unless the canonical path lies inside the canonical root. The
listing endpoint and spec validation both apply this rule. Rejections are
`invalid-spec` (400) for specs and `not-found` (404) for listings, so a listing
never tells apart a missing path from one outside the root.

#### `GET /api/v1/roots`

`{ "roots": [{ "id": "facility", "label": "facility" }] }`

#### `GET /api/v1/roots/{root}/entries?path=<relative>&cursor=<cursor>`

One directory level, sorted by name (byte order), at most 1000 entries per page:

```json
{
  "path": "2026-11/grid3",
  "entries": [
    { "name": "FoilHole_1.tiff", "kind": "file", "bytes": 1234567, "modifiedAt": "2026-11-07T10:00:00Z" },
    { "name": "raw", "kind": "directory", "bytes": null, "modifiedAt": "2026-11-07T09:00:00Z" }
  ],
  "next": null
}
```

- Names starting with `.` are omitted. A symlink is listed with its target's kind
  only when the target lies inside the root; other symlinks are omitted.
- `next` is an opaque cursor for the following page, or `null`.
- Unknown roots, missing paths and paths outside the root are 404.

#### Pattern matching

A spec names files in a root as
`{ "root": "facility", "path": "2026-11/grid3", "pattern": "*.tiff" }`.
`pattern` is 1 to 255 bytes, contains no `/`, and uses only `*` (any run of
characters) and `?` (one character). It matches names in that one directory,
dotfiles excluded. Every match is canonicalised and must lie inside the
canonical root, and no match may be a symlink: jobs see the root at
`/data/<root>`, where a link's host target does not exist. Commands name the
canonical directory and file the server resolved, never a symlinked path the
client typed. No match, or a symlinked match, is `invalid-spec`.

A single file is named as `{ "root": "facility", "path": "2026-11/gain.mrc" }`
(no `pattern`): the path must be a regular file whose canonical path lies inside
the canonical root. Patterns match regular files only.

Inside a job the root is mounted read-only at `/data/<root>`; specs and STAR
files refer to it by that path.

### Projects

A project is one RELION project directory on the server,
`<data-dir>/projects/<project id>/`. Project ids are 32 lowercase hex digits.
The server keeps its project records in `<data-dir>/project-records/`; the
project directory holds only RELION's files.

#### `POST /api/v1/projects`

JSON `{ "name": "Apoferritin grid 3" }`: 1 to 100 characters, no control
characters. Response `201`:

```json
{ "id": "…", "name": "Apoferritin grid 3", "createdAt": "2026-11-07T10:00:00Z", "jobs": [] }
```

#### `GET /api/v1/projects`

`{ "projects": [{ "id": "…", "name": "…", "createdAt": "…", "jobCount": 3 }] }`, newest first.

#### `GET /api/v1/projects/{id}`

The project with its jobs in creation order:

```json
{
  "id": "…",
  "name": "…",
  "createdAt": "…",
  "jobs": [
    { "id": "…", "command": "import", "directory": "Import/job001", "status": "succeeded", "dependsOn": [], "createdAt": "…", "finishedAt": "…" },
    { "id": "…", "command": "motioncorr", "directory": "MotionCorr/job002", "status": "running", "dependsOn": ["<import job id>"], "createdAt": "…", "finishedAt": null }
  ]
}
```

#### `DELETE /api/v1/projects/{id}`

`204` after removing every job record and the directory. `409` while any job in
it is not terminal.

#### Jobs in a project

- A `relion` spec names its `project`. The server assigns the next RELION job
  directory `<Type>/jobNNN` (NNN counts all jobs in the project from 001, zero
  padded to three digits, more digits past 999; a number is never reused, even
  after its job is deleted). `Type` is fixed per command
  (see the `relion` section).
- The job object gains `"project": "<id>"` and `"directory": "Class2D/job006"`.
  Jobs outside projects carry `"project": null, "directory": null`.
- An input that refers to an earlier job is a project-relative path such as
  `"Extract/job005/particles.star"`. It must name a listed output of a succeeded
  job in the same project; outputs of failed or cancelled jobs are listed for
  reading but never accepted as inputs. That job becomes a direct dependency. Dependencies
  are checked and recorded under the store's lock and persisted.
- Project jobs are never removed by the retention sweep.
- `DELETE /api/v1/jobs/{id}` on a project job returns `409` unless the job is
  terminal, its scheduler submission is resolved, and no other job in the project
  depends on it. On success the job's directory is removed from the project.
- The server does not write RELION's `default_pipeline.star`.

#### Paths inside the job

The project is mounted read-write at `/project`, the job's working directory.
Data roots are mounted read-only at `/data/<root>`. Uploaded parts (`gain`,
`mask`) are stored inside the job directory as `<Type>/jobNNN/<part>.mrc` and
referenced by that project-relative path.

### Outputs of project jobs

After a project job ends the server lists every regular file under its
`<Type>/jobNNN/` directory, recursively, as an output whose `name` is the
project-relative path (`"Class2D/job006/run_it200_classes.mrcs"`), sorted by
name. Symlinks are listed only when their canonical target lies inside the job
directory, and the job directory must canonicalise to the canonical project
directory joined with `<Type>/jobNNN`: when any part of it is a symlink, nothing
is listed or served. A file larger than `limits.maxDownloadBytes` carries
`"download": false`; other outputs carry `"download": true`. Outputs of jobs
outside projects keep the v1 shape (no `download` field).

`GET /api/v1/jobs/{id}/outputs/{name}` accepts a name containing `/`, sent
either percent-encoded as one segment or as further path segments. Clients send
one percent-encoded segment: URL parsers normalise `..` segments in the
multi-segment form before the server sees them. The server
canonicalises the joined path and serves it only when it is a listed output
inside the job's directory. `download: false` outputs return `413 too-large`.
`Content-Disposition` carries the last path component.

Failed and cancelled project jobs also list their files, so their logs can be
read; v1 jobs keep serving outputs only after success. A project job cancelled
before it started keeps its (possibly empty) directory and number until it is
deleted.

### Job object additions

```json
{
  "project": "…",
  "directory": "Class2D/job006",
  "dependsOn": ["…"],
  "scheduler": { "id": "123456", "state": "PENDING" }
}
```

- `scheduler` is `null` until Slurm has accepted the job and for local runners.
  `state` is Slurm's state string.
- Status values do not change. A job the server is still submitting, or that
  Slurm holds, is `queued` with `position: 0`; `message` carries Slurm's pending
  reason (`Waiting in the cluster queue (Priority)`).
- Cancelling a job that has a scheduler id, or whose submission is in flight,
  moves it to `cancelling` instead of `cancelled`; it becomes `cancelled` when
  Slurm reports a terminal state, or when reconciliation proves Slurm never
  accepted it.

New `error.code` values: `interrupted` (the server cannot establish the job ever
ran), `scheduler-lost` (Slurm no longer knows the job), `scheduler-failed` (a
terminal Slurm state other than `COMPLETED`; `message` names the state and
`exit:signal`; also an `sbatch` that reports *Batch job submission failed*,
without reconciliation). `COMPLETED` with `RELION_JOB_EXIT_FAILURE`, or with no
marker within the grace period, is `tool-failed`.

While Slurm holds a job, `message` is its pending reason; log lines do not
replace it. In Slurm mode a job not yet handed to Slurm stays queued across a
restart; a job handed to Slurm is re-attached by its Slurm id or name, whatever
the launch profiles are by then.

### Resource profiles

The Slurm runner reads `--slurm-config <file.json>`:

```json
{
  "apptainer": "/usr/bin/apptainer",
  "image": { "path": "/shared/images/relion/relion_5.1.1.sif" },
  "scratch": "$TMPDIR",
  "profiles": {
    "cpu": { "partition": "cpu", "cpus": 16, "gpus": 0, "memory": "64G", "time": "12:00:00" },
    "gpu-4": { "partition": "gpu", "account": "lab", "qos": null, "cpus": 24, "gpus": 4, "memory": "128G", "time": "24:00:00" }
  },
  "defaults": {
    "import": "cpu", "motioncorr": "cpu", "ctffind": "cpu", "autopick": "cpu", "extract": "cpu",
    "class2d": "gpu-4", "select": "cpu", "initialmodel": "gpu-4", "refine3d": "gpu-4",
    "maskcreate": "cpu", "postprocess": "cpu"
  }
}
```

A spec may name `"profile": "<name>"`; otherwise the command's default applies.
With more than one profile, every command of a project tool needs a default:
the server refuses to start otherwise. `image.sha256` may be left out for the
image `neurodesk-compute fetch-image relion` downloads, whose SHA-256 the server
pins; any other image needs it.
The caller never passes Slurm flags.

- `scratch` is `$NAME`, `${NAME}` or an absolute path; each job uses and removes
  `<scratch>/nd-<job id>`.
- A profile may set `gres` (for example `gpu:a100:4`) in place of `gpu:<gpus>`.
- `partition`, `account`, `qos`, `memory` and `time` accept only plain Slurm
  tokens. The data directory, data roots, image and apptainer paths may contain
  only letters, digits and `/ . _ + - @ ~ =`; the server refuses others at
  startup, because they are written into the batch script. The simulated runner uses the built-in
profile `local` (`cpus` = available parallelism, `gpus` = 0) unless a config
file is given.

### Slurm runner

`--runner slurm` requires `--single-owner` and `--slurm-config`. The lifecycle,
state mapping and isolation rules are those of ADR-0004. Timing constants:

| Constant | Value |
| --- | --- |
| Poll interval (`squeue --me`, one call for all jobs) | 15 s |
| `sacct -S` margin before the recorded submission time | 5 min |
| Accounting retry window before `interrupted` or `scheduler-lost` | 10 min |
| Grace period for `RELION_JOB_EXIT_*` after `COMPLETED` | 120 s |
| Polling failures before new submissions return `runner-unavailable` | 10 min |

The batch script is `<Type>/jobNNN/job.sbatch`; Slurm's output is
`<Type>/jobNNN/run.out` and `run.err`, which are the job's log. Each step of a
command (the main program and every follow-up step) runs in its own
`apptainer exec` with the same mounts; only the main step runs under `mpirun`.

## Job specification: `relion`

RELION 5.1.1 in the Neurodesk `relion` container, one RELION job per compute
job, inside a project. The commands are data in
[`packages/cryo-em/src/commands.json`](../../packages/cryo-em/src/commands.json),
which is the source of truth for options, defaults, ranges and argument order.
`packages/cryo-em/src/spec.js` interprets it for the app and the reference
server; the Rust server interprets the same file and is held to
`packages/cryo-em/test/fixtures/argv-cases.json`. The package README defines the
table's schema. The simulated `relion` tool is documented separately.

The image is
`vnmd/relion_5.1.1@sha256:14c760762a640c7dca9033cc261d80428ceee74239e9e60eb2a5080962c1c3a0`
(tag `20261107`), which `info.tools[].image` reports. The Slurm runner runs its
Apptainer image, mirrored once to the Hugging Face dataset `neurodeskorg/webapps`
under `cryo-em/relion-image/` and pinned by SHA-256 in
`exes/compute-server/src/examples.rs`; `neurodesk-compute fetch-image relion`
downloads it.

```json
{
  "tool": "relion",
  "command": "class2d",
  "project": "0123456789abcdef0123456789abcdef",
  "profile": "gpu-4",
  "inputs": { "particles": "Extract/job005/particles.star" },
  "options": { "nrClasses": 50, "particleDiameter": 200 }
}
```

Validation rules, applied identically by both servers:

- Only `tool`, `command`, `project`, `profile`, `inputs` and `options`. `tool`
  is `relion`; `command` is one of the table's commands; `project` is an
  existing project id; `profile`, when present, names a configured profile.
- `inputs` and `options` reject unknown keys. Options take their GUI default
  when omitted, except the required ones. `int` options must be integers;
  every number must be finite and within the table's inclusive range.
- An earlier-job input is a project-relative path (the relative path rules
  above) of the form `<Type>/jobNNN/<file>`, where `Type` is one the input
  allows and the file has the input's suffix. It must also be a listed output
  of a succeeded job in the same project (see Projects).
- An uploaded input is `{ "part": "<input name>" }`; the multipart part has the
  input's name and is an MRC file. Unused parts are rejected.
- A data-root input is `{ "root", "path", "pattern" }` (see Data roots).
- The profile must be able to run the command (launch rules below).

| Command | Job type | Inputs | Main options (GUI default) |
| --- | --- | --- | --- |
| `import` | `Import` | `movies`: data root | `angpix`, `kV`, `Cs` (required), `Q0` (0.1), `isMultiframe` (true) |
| `motioncorr` | `MotionCorr` | `movies`: `Import/…/movies.star`; `gain`: optional part, or a data-root file `{ root, path }` | `dosePerFrame` (required), `patchX`, `patchY` (1), `bfactor` (150), `gainRot`, `gainFlip` (0), `doFloat16`, `doSavePs`, `doDoseWeighting` (true) |
| `ctffind` | `CtfFind` | `micrographs`: `MotionCorr` or `Import` `…micrographs.star` | `box` (512), `resMin` (30), `resMax` (5), `dfMin` (5000), `dfMax` (50000), `dfStep` (500), `useGivenPs` (true) |
| `autopick` | `AutoPick` | `micrographs`: `CtfFind`, `MotionCorr` or `Import` `.star` | Laplacian-of-Gaussian only: `logDiamMin` (200), `logDiamMax` (250), `logAdjustThreshold` (0), `logUpperThreshold` (999: off) |
| `extract` | `Extract` | `micrographs`: `CtfFind/…/micrographs_ctf.star`; `coordinates`: `AutoPick/…/autopick.star` | `extractSize` (128, even), `doRescale` (false), `rescale` (128), `doInvert`, `doNorm`, `doFloat16` (true) |
| `class2d` | `Class2D` | `particles`: `Extract` or `Select` `…particles.star` | VDAM only: `nrClasses` (1), `nrIterGrad` (200), `particleDiameter` (200), `tauFudge` (2) |
| `select` | `Select` | `ranker`: `optimiser`, `Class2D/…_optimiser.star`; `classes`: `particles`, `Class2D/…_data.star` | `mode` (`classes` or `ranker`, required); `classes`: `classes` (1 to 1000 distinct integers); `ranker`: `minScore` (0.5), `minParticles`, `minClasses` (-1: off) |
| `initialmodel` | `InitialModel` | `particles`: `Select` or `Extract` `…particles.star` | `nrIter` (200), `nrClasses` (1), `sym` (C1), `doRunC1` (true), `particleDiameter` (200), `tauFudge` (4) |
| `refine3d` | `Refine3D` | `particles`; `reference`: `InitialModel/….mrc`; `mask`: optional `MaskCreate/….mrc` or part | `sym` (C1), `iniHigh` (60), `particleDiameter` (200), `sampling` (7.5 degrees), `autoLocalSampling` (1.8 degrees), `doBlush` (false), `doSolventFsc` (false) |
| `maskcreate` | `MaskCreate` | `map`: `Refine3D` or `InitialModel` `.mrc` | `lowpassFilter` (15), `angpix` (-1: from the map), `inimaskThreshold` (0.02), `extendInimask`, `widthMaskEdge` (3) |
| `postprocess` | `PostProcess` | `halfMap`: `Refine3D/…half1…_unfil.mrc` or `half2`; `mask`: `MaskCreate/….mrc` or part | `angpix` (-1), `doAutoBfac` (true), `autobLowres` (10), `doAdhocBfac` (false) |

### Command line

The generated arguments equal the command RELION 5.1.1's GUI writes to the job's
`note.txt` for the same settings, compared as shell words after removing the
MPI launcher, with `` `which relion_x` `` read as `relion_x`. Every RELION
program gets `--pipeline_control <Type>/jobNNN/`, so it writes
`RELION_JOB_EXIT_SUCCESS` or `RELION_JOB_EXIT_FAILURE`. Exceptions:

- `import` first links the data-root directory into its job,
  `ln -sfn /data/<root>/<path> <Type>/jobNNN/data`, then runs
  `relion_import --i "<Type>/jobNNN/data/<pattern>"`: `relion_import` refuses
  absolute paths. Later STAR files name movies through that link, which stays
  valid because every job mounts the root at the same `/data/<root>`.
- `select` with `mode: "classes"` replaces the GUI's interactive
  `relion_display` with `relion_star_handler --select rlnClassNumber` per run of
  consecutive classes, joined by `relion_star_handler --combine` when there is
  more than one run. Only the last call writes the exit marker.

The server runs the main program in `/project`, under
`mpirun --bind-to none -np <ranks>` when the launch has more than one rank, then
any follow-up steps in order, stopping at the first failure. `initialmodel` has
follow-up steps, as in the GUI: `rm -f` of the success marker,
`relion_align_symmetry`, and `touch` of the marker.

### Launch rules

| Command | MPI ranks | `--j` | `--gpu ""` |
| --- | --- | --- | --- |
| `motioncorr` | `max(1, floor(cpus / 4))` | `floor(cpus / ranks)` | never |
| `ctffind`, `autopick`, `extract` | `cpus` | not passed | never |
| `refine3d` | smallest odd number at least `max(3, gpus + 1)` | `floor(cpus / ranks)` | when the profile has GPUs |
| `class2d`, `initialmodel` | 1 (RELION refuses MPI with VDAM) | `cpus` | when the profile has GPUs |
| `maskcreate` | 1 | `cpus` | never |
| `import`, `select`, `postprocess` | 1 | not passed | never |

A program is the `_mpi` build when it runs with more than one rank. A profile
with fewer CPUs than `refine3d` needs ranks is refused for `refine3d` at
startup and in specs.

### Outputs and progress

Outputs follow [Outputs of project jobs](#outputs-of-project-jobs). Success
also requires these files in the job directory:

| Command | Required outputs |
| --- | --- |
| `import` | `movies.star`, or `micrographs.star` when `isMultiframe` is false |
| `motioncorr` | `corrected_micrographs.star` |
| `ctffind` | `micrographs_ctf.star` |
| `autopick` | `autopick.star` |
| `extract` | `particles.star` |
| `class2d` | `run_itNNN_data.star`, `_optimiser.star`, `_model.star`, `_classes.mrcs` (NNN = `nrIterGrad`, three digits) |
| `select` | `particles.star`; with `ranker` also `class_averages.star` and `rank_optimiser.star` |
| `initialmodel` | `initial_model.mrc`, `run_itNNN_model.star`, `run_itNNN_data.star` |
| `refine3d` | `run_data.star`, `run_optimiser.star`, `run_model.star`, `run_class001.mrc`, `run_half1_class001_unfil.mrc`, `run_half2_class001_unfil.mrc` |
| `maskcreate` | `mask.mrc` |
| `postprocess` | `postprocess.mrc`, `postprocess_masked.mrc`, `postprocess.star` |

| Line contains | Commands | Fraction |
| --- | --- | --- |
| RELION's progress bar, `t1/t2 sec\|min\|hrs` then dots then `~~(,_,">` | `motioncorr`, `ctffind`, `autopick`, `extract` | dots / 60 (last `\r` update on the line) |
| `Gradient optimisation iteration N of M` | `class2d`, `initialmodel` | (N − 1) / M |
| `Auto-refine: Iteration= N` | `refine3d` | min(0.9, N / 25), an estimate |
| `Auto-refine: Refinement has converged` | `refine3d` | 0.9 |

A line containing `ERROR` is logged as `error`, one containing `WARNING` or
`Warning` as `warning`.

## The simulated `relion` tool

With `--runner simulate` (Rust) or by default (Node reference server, in
single-owner mode) the `relion` tool runs no RELION program. It checks that
every file the job's inputs reference exists, then writes each command's
outputs as small valid STAR and MRC files that reference earlier jobs by
project-relative path. A chain of jobs is therefore checked through the same
references RELION follows. `info.simulated` and every job's `simulated` are
`true`. The Node implementation is `test-utils/relion-simulator.mjs`;
`test/remote-compute-hpc.test.mjs` runs a chain from `import` to
`postprocess` against either server. Files must match the structure below:
names, data blocks, columns and MRC dimensions. Bytes may differ between the
two servers.

The reference server takes the HPC settings as options of
`startReferenceServer`: `singleOwner`, `dataRoots` (`{ id: absolutePath }`),
`dataDir` (default: a temporary directory removed on close),
`maxDownloadBytes`, `localProfile` (`{ cpus, gpus }` of the `local` profile,
default the available parallelism and no GPUs) and `clock` (milliseconds, for
the session idle limit).

### Sequence

1. Log `Simulated run of: <line>` for the main program and each `then` step
   of `relionCommand`, with the main program prefixed by
   `mpirun --bind-to none -np <mpiRanks>` when `mpiRanks` is above 1. Arguments
   that are empty or contain whitespace are written in double quotes.
2. Log, at level `warning`,
   `SIMULATED relion: no RELION program runs and every output is a placeholder`.
3. Check references (below). On failure log `ERROR: <message>` and fail the job
   with `tool-failed` and that message.
4. Log the command's synthetic lines (below), one per stage delay, each passed
   through `parseRelionLogLine` for its level and progress. Cancellation is
   checked before each line and ends the job `cancelled` with no exit marker.
5. Write the outputs and log the writer's summary lines. A required output
   missing afterwards fails the job.
6. Report progress 1 (`Finished`) and succeed.

A job that started writes, however it ends, `run.out` (every line logged by
steps 1 to 5, without timestamps), `run.err` (the `error` lines, possibly empty)
and the exit marker:
`RELION_JOB_EXIT_SUCCESS` on success, `RELION_JOB_EXIT_FAILURE` on failure,
none on cancellation. These files are then listed with the job's outputs.

### Reference check

- An input that is a project path must exist inside the project. A `.star`
  input is scanned. An `.mrc` or `.mrcs` input inside the project must carry
  the MRC magic.
- An uploaded part (`<Type>/jobNNN/<part>.mrc`) must exist and be MRC.
- A data-root file (`{ root, path }`) must exist inside its root. A data-root
  pattern is matched again, by the rules of [Pattern matching](#pattern-matching).
- Scanning a STAR file reads every key-value pair and loop column whose label
  is one of `rlnMicrographMovieName`, `rlnMicrographName`,
  `rlnMicrographNameNoDW`, `rlnMicrographMetadata`, `rlnMicrographGainName`,
  `rlnCtfPowerSpectrum`, `rlnCtfImage`, `rlnMicrographCoordinates`,
  `rlnImageName`, `rlnReferenceImage`, `rlnModelStarFile`,
  `rlnExperimentalDataStarFile`, `rlnUnfilteredMapHalf1`,
  `rlnUnfilteredMapHalf2` and `rlnMaskName`. A value loses a leading
  `<n>@` image index and a trailing `:mrc` or `:mrcs`. `/data/<root>/…` resolves
  inside that data root; another absolute path fails; anything else resolves
  inside the project. The canonical result must lie inside the root or the
  project and be a regular file. A value with an index must name an MRC whose
  `nz` is at least the index. A referenced `.star` file is scanned in turn,
  once.
- `postprocess` also requires the other half map (`half1` and `half2` swapped
  in the input path). Both half maps and the mask must have the same `nx`.

Messages name the referring file and the reference:
`Extract/job005/particles.star references Extract/job005/Movies/FoilHole_1.mrcs, which does not exist`
or `… references image 5 of …, which has 4`. For inputs the referrer is
`inputs.<name>`.

### Synthetic log lines

| Command | Lines |
| --- | --- |
| `motioncorr`, `ctffind`, `autopick`, `extract` | A heading, `000/??? sec ~~(,_,">`, then four progress bars `t/T sec <dots>~~(,_,">` with 15, 30, 45 and 60 dots (t = 0.50 to 2.00, T = 2.00) |
| `class2d`, `initialmodel` | ` Gradient optimisation iteration N of M (Step size 0.5)` for N in 1, M/4, M/2, 3M/4 and M (rounded, distinct), M = `nrIterGrad` or `nrIter`; `initialmodel` adds an alignment line |
| `refine3d` | ` Auto-refine: Iteration= N` and ` Auto-refine: Resolution= …` for N = 1 to 5, then ` Auto-refine: Refinement has converged, entering last iteration where two halves will be combined...` |
| `import`, `select`, `maskcreate`, `postprocess` | One heading line |

### File formats

STAR files are written as RELION 5 writes them: each block is preceded by
`# version 50001`, then `data_<name>`, then either `loop_` with `_<label> #<n>`
headers and one row per line, or one `_<label> <value>` line per pair. Numbers
are written as `relionNumber` (`%.6g` of the float32 value), integers in
decimal, and values that are empty or contain whitespace in double quotes.

MRC files are MRC2014: a 1024-byte header with no extended header, mode 2
(float32), little endian (`MACHST` `44 44 00 00`), `MAP ` at byte 208,
`NVERSION` 20140, `MAPC/MAPR/MAPS` 1, 2, 3, cell angles 90°, the cell
`n × pixel size`, and `DMIN`, `DMAX`, `DMEAN` and `RMS` computed from the data.
Volumes and single images have `ISPG` 1 and `MZ` = `NZ`. Image stacks (`.mrcs`)
have `ISPG` 0 and `MZ` 1. Micrographs are 64 × 64, particle images and class
averages 32 × 32, and volumes 32³, whatever the box size options say. The pixel
size is the import `angpix` × `binFactor` for micrographs and the particles'
`rlnImagePixelSize` for images and volumes.

### Outputs per command

Paths are relative to the job directory `<Type>/jobNNN`; `<dir>` in a value is
that directory. `<stem>` is a file name without its directory and last
extension. Every `data_optics` table has the optics group name
`opticsGroup1` and number 1, and every later job copies the optics table of
its input and adds the columns listed here.

| Command | Files | Blocks and columns |
| --- | --- | --- |
| `import` | `movies.star` (`isMultiframe`) or `micrographs.star` | `optics`: `rlnOpticsGroupName`, `rlnOpticsGroup`, `rlnMicrographOriginalPixelSize`, `rlnVoltage`, `rlnSphericalAberration`, `rlnAmplitudeContrast` (and `rlnMicrographPixelSize` for micrographs). `movies`: `rlnMicrographMovieName`, `rlnOpticsGroup`; or `micrographs`: `rlnMicrographName`, `rlnOpticsGroup`. One row per matched file, `<Type>/jobNNN/data/<name>`, in byte order: like real import, the simulator first links `<Type>/jobNNN/data` to the data-root directory (in the container `/data/<root>/<path>`; the simulator links the host directory). |
| `motioncorr` | `Movies/<stem>.mrc` (64²); `Movies/<stem>.star`; `Movies/<stem>_noDW.mrc` with `doSaveNoDW`; `Movies/<stem>_PS.mrc` with `doSavePs`; `corrected_micrographs.star` | `<stem>.star` has `general` pairs `rlnImageSizeX` 64, `rlnImageSizeY` 64, `rlnImageSizeZ` 24, `rlnMicrographMovieName`, `rlnMicrographGainName` (when a gain is given: its job-visible path), `rlnMicrographBinning`, `rlnMicrographOriginalPixelSize`, `rlnMicrographDoseRate`, `rlnMicrographPreExposure`, `rlnVoltage`, `rlnMicrographStartFrame`, `rlnMotionModelVersion` 0. `corrected_micrographs.star`: `optics` + `rlnMicrographPixelSize`; `micrographs`: `rlnMicrographName` (`<dir>/Movies/<stem>.mrc`), `rlnMicrographNameNoDW` (with `doSaveNoDW`), `rlnMicrographMetadata`, `rlnOpticsGroup`, `rlnAccumMotionTotal`, `rlnAccumMotionEarly`, `rlnAccumMotionLate`, `rlnCtfPowerSpectrum` (with `doSavePs`). |
| `ctffind` | `Movies/<stem>.ctf` (MRC, 64²) per micrograph; `micrographs_ctf.star` | `optics` copied; `micrographs`: the input's columns + `rlnCtfImage` (`<dir>/Movies/<stem>.ctf:mrc`), `rlnDefocusU`, `rlnDefocusV`, `rlnCtfAstigmatism`, `rlnDefocusAngle`, `rlnCtfFigureOfMerit`, `rlnCtfMaxResolution` (and `rlnPhaseShift` with `doPhaseshift`). |
| `autopick` | `Movies/<stem>_autopick.star` per micrograph; `autopick.star` | Each coordinate file has one block `data_` with `rlnCoordinateX`, `rlnCoordinateY`, `rlnClassNumber`, `rlnAutopickFigureOfMerit`, `rlnAnglePsi` and four picks at (16, 16), (48, 16), (16, 48) and (48, 48). `autopick.star`: `coordinate_files` with `rlnMicrographName`, `rlnMicrographCoordinates` (`<dir>/Movies/<stem>_autopick.star`). |
| `extract` | `Movies/<stem>.mrcs` (one 32² image per pick); `particles.star` | `optics` + `rlnImagePixelSize` (micrograph pixel × `extractSize / rescale` with `doRescale`), `rlnImageSize` 32, `rlnImageDimensionality` 2, `rlnCtfDataAreCtfPremultiplied` 0. `particles`: `rlnCoordinateX`, `rlnCoordinateY`, `rlnAutopickFigureOfMerit`, `rlnClassNumber`, `rlnAnglePsi`, `rlnImageName` (`<nnnnnn>@<dir>/Movies/<stem>.mrcs`, six digits, from 1), `rlnMicrographName` (the CTF table's), `rlnOpticsGroup`, `rlnCtfMaxResolution`, `rlnCtfFigureOfMerit`, `rlnDefocusU`, `rlnDefocusV`, `rlnDefocusAngle`, `rlnCtfBfactor`, `rlnCtfScalefactor`, `rlnPhaseShift`. Micrographs without a coordinate file are skipped. |
| `class2d` | `run_itNNN_data.star`, `run_itNNN_classes.mrcs` (K images of 32²), `run_itNNN_model.star`, `run_itNNN_optimiser.star`; NNN = `nrIterGrad`, K = `nrClasses` | Data: the input's `optics` and `particles` with `rlnClassNumber` = (row mod K) + 1 and `rlnAnglePsi`, `rlnOriginXAngst`, `rlnOriginYAngst`, `rlnNormCorrection`, `rlnLogLikeliContribution`, `rlnMaxValueProbDistribution`, `rlnNrOfSignificantSamples`, `rlnGroupNumber` set. Model: `model_general` pairs (`rlnReferenceDimensionality` 2, `rlnDataDimensionality` 2, `rlnOriginalImageSize` 32, `rlnCurrentResolution`, `rlnCurrentImageSize`, `rlnPaddingFactor`, `rlnPixelSize`, `rlnNrClasses` K, `rlnNrBodies`, `rlnNrGroups`, `rlnNrOpticsGroups`, `rlnTau2FudgeFactor`); `model_classes`: `rlnReferenceImage` (`<k>@<dir>/run_itNNN_classes.mrcs`), `rlnClassDistribution`, `rlnAccuracyRotations`, `rlnAccuracyTranslationsAngst`, `rlnEstimatedResolution`, `rlnOverallFourierCompleteness`. Optimiser: `optimiser_general` pairs `rlnOutputRootName` (`<dir>/run`), `rlnModelStarFile`, `rlnExperimentalDataStarFile`, `rlnCurrentIteration`, `rlnNumberOfIterations`, `rlnDoSplitRandomHalves` 0, `rlnParticleDiameter`. |
| `select`, `classes` | `classes_<aaa>_<bbb>.star` per run of consecutive classes when there is more than one run; `particles.star` | The input's `optics` and the `particles` rows whose `rlnClassNumber` lies in a run, runs in ascending order, rows in input order within a run. |
| `select`, `ranker` | `particles.star`, `class_averages.star`, `rank_optimiser.star` | Reads the optimiser's model and data files. Class k of K scores 1 − (k − 1) / K. Selected: classes scoring at least `minScore`, then more classes in score order until `minClasses` and `minParticles` are met (when not −1). `class_averages.star`: block `data_` with `rlnReferenceImage`, `rlnClassScore`, `rlnClassDistribution`, `rlnEstimatedResolution`, best first. `rank_optimiser.star`: `optimiser_general` with `rlnOutputRootName` `<dir>/rank`, the input's `rlnModelStarFile`, `rlnExperimentalDataStarFile` `<dir>/particles.star` and `rlnCurrentIteration`. |
| `initialmodel` | `run_itNNN_data.star`, `run_itNNN_classNNN.mrc` per class (32³ sphere), `run_itNNN_model.star`, `initial_model.mrc`; NNN = `nrIter` | Data: `rlnClassNumber` = (row mod K) + 1 and `rlnAngleRot`, `rlnAngleTilt`, `rlnAnglePsi`, `rlnOriginXAngst`, `rlnOriginYAngst`. Model: `model_general` (dimensionality 3) and `model_classes` with `rlnReferenceImage` `<dir>/run_itNNN_classNNN.mrc`. `initial_model.mrc` is the volume of the class with the most particles. |
| `refine3d` | `run_data.star`, `run_class001.mrc`, `run_half1_class001_unfil.mrc`, `run_half2_class001_unfil.mrc` (32³ spheres), `run_model.star`, `run_optimiser.star` | Data: angles and origins, `rlnClassNumber` 1, `rlnRandomSubset` (row mod 2) + 1, and the class2d statistics columns. Model: `model_general`, `model_classes` (`rlnReferenceImage` `<dir>/run_class001.mrc`), and `model_class_1` with `rlnSpectralIndex`, `rlnResolution`, `rlnAngstromResolution`, `rlnGoldStandardFsc` for shells 0 to 16. Optimiser: `rlnOutputRootName` `<dir>/run`, `rlnModelStarFile`, `rlnExperimentalDataStarFile`, `rlnDoSplitRandomHalves` 1. |
| `maskcreate` | `mask.mrc` | The input map's size; a sphere of radius min(nx / 2 − `widthMaskEdge` − 1, 10 + `extendInimask`) with a cosine edge `widthMaskEdge` voxels wide. Pixel size `angpix`, or the map's when −1. |
| `postprocess` | `postprocess.mrc`, `postprocess_masked.mrc` (32³), `postprocess.star` | `general` pairs `rlnFinalResolution`, `rlnBfactorUsedForSharpening` (−60 with `doAutoBfac`, else `adhocBfac` with `doAdhocBfac`, else 0), `rlnUnfilteredMapHalf1`, `rlnUnfilteredMapHalf2`, `rlnMaskName`, `rlnRandomiseFrom`. `fsc` loop for shells 0 to 16: `rlnSpectralIndex`, `rlnResolution`, `rlnAngstromResolution` (999 at shell 0), `rlnFourierShellCorrelationCorrected`, `rlnFourierShellCorrelationUnmaskedMaps`, `rlnFourierShellCorrelationMaskedMaps`, `rlnCorrectedFourierShellCorrelationPhaseRandomizedMaskedMaps`. `guinier` loop for shells 1 to 16: `rlnResolutionSquared`, `rlnLogAmplitudesOriginal`, `rlnLogAmplitudesWeighted`, `rlnLogAmplitudesSharpened`. |

The synthetic FSC at shell k of a 32-voxel box is
`1 / (1 + exp((k − 10) / 1.5))`. `rlnFinalResolution` is `32 × pixel size / k₀`,
where k₀ is where that curve crosses 0.143, interpolated linearly between
shells; `rlnRandomiseFrom` is the same at 0.8. The phase-randomised column
equals the FSC below the randomisation shell and is 0 from it on. The
unmasked column is the FSC to the power 1.2. `postprocess` also logs
`  + FINAL RESOLUTION: <value>`.
