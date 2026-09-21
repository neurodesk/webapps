# Remote compute protocol v1

The contract between a Neurodesk webapp and a compute server. Two implementations
exist: `exes/compute-server` (Rust, the shipped `neurodesk-compute` binary) and
`test-utils/compute-reference-server.mjs` (Node, used by browser and desktop tests).
`test/remote-compute-protocol.test.mjs` runs the same suite against both. The design
rationale is in [nesvor-remote-compute.md](nesvor-remote-compute.md).

## Transport

- Base path `/api/v1`. JSON request and response bodies use camelCase.
- Authentication: `Authorization: Bearer <token>` on every request except the
  capability probe. `GET /api/v1/jobs/{id}/events` and `GET /api/v1/jobs/{id}/outputs/{name}`
  also accept `?token=<token>` because `EventSource` and `<a download>` cannot set headers.
- CORS: the server answers preflights for allowed origins with
  `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Headers: Authorization, Content-Type`,
  `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`,
  `Access-Control-Allow-Private-Network: true`, `Access-Control-Max-Age: 600`, and
  `Vary: Origin`. Requests from other origins receive no CORS headers. `Origin`-less
  requests (same origin, curl) are always allowed.
- Errors: `{ "error": { "code": string, "message": string } }`. Codes: `invalid-spec` (400),
  `unauthorized` (401), `not-found` (404), `conflict` (409), `too-large` (413),
  `runner-unavailable` (503).
- Every response carries `Cache-Control: no-store`.

## Endpoints

### `GET /api/v1/info`

Without a token:

```json
{ "service": "neurodesk-compute", "version": "0.1.20260921", "protocol": 1, "auth": "bearer" }
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

`status` is one of `queued`, `running`, `succeeded`, `failed`, `cancelled`.
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

### `DELETE /api/v1/jobs/{id}`

Cancels a queued or running job, deletes the job directory, and responds `204`.
Deleting a finished job also removes its outputs. Unknown ids give `404`.

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

Masks are passed only when every stack has one, because `--stack-masks` requires
one mask per stack; otherwise masks are ignored and a warning log line says so.

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
