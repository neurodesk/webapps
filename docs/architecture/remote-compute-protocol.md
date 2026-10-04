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
