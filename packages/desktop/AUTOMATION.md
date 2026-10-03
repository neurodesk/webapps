# Run applications from an agent

The catalog apps publish `automation.json` and `automation.schema.json` beside
their built pages. Each schema-2 contract declares explicit operations, input
roles, parameters, output roles and engines. The build stamps the app version.
The desktop checks the contract against its offline inventory before advertising
it. Displayed status text does not control operation completion.

## Start the MCP server

Launch the desktop executable with `--mcp`. It communicates over stdin and
stdout. Diagnostics go to stderr. Browser processing needs the graphical
environment described in [STANDALONE.md](STANDALONE.md).

```json
{
  "mcpServers": {
    "neurodesk": {
      "command": "/absolute/path/to/neurodesk-webapps",
      "args": ["--mcp", "--output", "/absolute/path/to/runs"]
    }
  }
}
```

On macOS, use the executable inside the `.app` bundle. For development, run
`electron packages/desktop --mcp` with `NEURODESK_BUNDLE` pointing to an assembled
desktop resource directory. On Linux without a display, use `xvfb-run -a`.
Scientific GPU validation is separate from software rendering and transport tests.
Follow [the Mac validation guide](SCIENTIFIC-VALIDATION.md) to run real inference.

## Discover, validate and run

Call `apps_list` to discover installed contracts and available engines. Call
`apps_describe` with an `app` ID to inspect its operations. The default operation
is exposed as `run_<app>`, with hyphens replaced by underscores. Other operations
use `run_<app>__<operation>`. Each tool has its own typed request schema.

For example, call `run_brain_extraction` with:

```json
{
  "inputs": { "image": ["/data/head.nii.gz"] },
  "parameters": { "method": "bet", "threshold": 0.5 },
  "engine": "browser",
  "retainViewer": true,
  "timeoutMs": 1800000
}
```

Alternatively, call `apps_validate` or `runs_start` with an additional `app`
field. Use `operation` to select an operation other than the default.
Unknown parameters, invalid values and missing paths fail validation. The
scientific app then validates image content and geometry.

Input roles are explicit. A file role accepts an array of absolute paths. A
DICOM role also accepts a directory path in that array. A URL role accepts
`{"url":"https://host/dataset/"}`. A directory role accepts
`{"directory":"/absolute/path/to/dataset"}`. Each operation declares which
forms it supports. Multiple inputs, such as fixed and moving images or phase
and magnitude, are assigned by role rather than guessed from filenames.

Each input declares `minimum` and `maximum` cardinality. Zero minimum makes a
role optional; an omitted maximum permits multiple items. For converted DICOM,
these counts describe logical images after grouping, not individual slice files.
The transport therefore accepts a whole series even when the image maximum is one.

SynthSeg declares its browser budget under `limits.browser.inputs.image`.
`apps_validate` and `runs_start` read the NIfTI header, reproduce its 1 mm
resampling and padding, and reject an oversized plan before opening a window.
The error reports the padded shape and required buffer size. The 2 GiB cap is
unchanged. Native execution is exempt; DICOM geometry is checked by the runtime
after conversion, as declared by `deferredFormats`.

Only one scientific run is active per server. Each run gets a fresh window and
output directory. Poll `runs_get` with its `runId` until `state` is `succeeded`,
`failed` or `cancelled`. Errors include the app's message. `runs_cancel` aborts
processing and removes partial artifacts. The deadline includes import,
processing and export. Closing the MCP connection cancels the active run and
closes retained viewers.

## Select a DICOM series

Operations that accept images convert DICOM through the shared local converter.
If conversion produces multiple candidates, the run fails with
`SERIES_SELECTION_REQUIRED` and candidate metadata. Retry the original request
with `selections: {"image":"<candidate SHA-256>"}`, replacing `image` with the
input role. The hash identifies the uncompressed converted NIfTI. Reports retain
the original source hashes, converted image metadata and conversion sidecars.
An agent must choose from the actual candidates, not infer a series from a name.

DICOMpare and DICOM2vid use raw DICOM metadata directly. For DICOM2vid's
`encode-dicom`, select a reported candidate using `parameters.seriesUid`.
DICOMpare analyzes all supplied series without converting them into images.

## Read results

Completed runs advertise `neurodesk://runs/<runId>/report` and
`neurodesk://runs/<runId>/artifacts/<artifactId>` as MCP resources. Artifact IDs
are distinct from roles because one role can produce several files. Use the
returned IDs. Reports record each artifact's role, semantic type, byte count
and SHA-256 hash, plus effective parameters and scientific provenance.

Input records are arrays per role. The desktop verifies the browser's report,
original inputs and downloaded artifacts before declaring success. It rechecks
artifact hashes when reading resources. Native and browser SynthSeg both report
FreeSurfer label IDs, names, counts and mL volumes computed from the affine and
spatial units. Unknown units omit mL values with an explanation.

Resource bodies are limited to 64 MiB. For larger files, use the local path in
the execution report. Every run also writes `run.json` under the output root.
Completed files remain on disk after shutdown. Failed or cancelled runs expose
no artifact resources. Viewer-only operations return a source summary and the
controls actually supported by the loaded viewer.

## Control a retained viewer

Set `retainViewer: true` to keep a completed browser run open. Viewer operations
retain their windows by default. Use `sessions_list` to find the `sessionId`.
At most four sessions remain open. Close one with `sessions_close` before
retaining another. Closing a viewer releases its window and local directory
mounts while preserving the completed report and files.

Call `viewers_list` with `sessionId`. It returns viewer IDs and capabilities.
Then call `viewers_state`, `viewers_regions` or `viewers_tab` with both
`sessionId` and `viewerId`. To select a tab, also supply its reported `tabId`.
Region information comes from the app's actual labels, measurements or anatomy.
Unsupported controls return an error.

Move a supported crosshair with `viewers_crosshair`:

```json
{
  "sessionId": "<session ID>",
  "viewerId": "main",
  "position": { "frame": "mm", "value": [0, -20, 30] }
}
```

Coordinates are world millimetres. The result reports the viewer's actual
snapped position. Controls use public viewer APIs; older viewer versions may
not support a crosshair. Commands are serialized per session. A command that
exceeds 30 seconds closes that session. URL access and local directory mounts
are scoped to the requesting window and supplied source tree.

## Select native SynthSeg

Set `NEURODESK_SYNTHSEG_BIN` to an installed executable's absolute path, then
request `engine: "native"`. Supply `ct: true` or `ct: false` explicitly because
the CLI does not use the browser's intensity detection. `mode` is `default` or
`fast`. The report records the actual CLI version, model and backend. The server
invokes it without a shell and never silently changes engines. The validated
SynthSeg 2 GiB single-buffer ceiling is unchanged.

## Generate a desktop job

Save a run request as `request.json`, then run:

```sh
node scripts/automation-job.mjs brain-extraction request.json job.json
neurodesk-webapps --job job.json --output /data/new-results
```

Schema-2 jobs invoke the declared operation through the same browser handler as
MCP. Jobs close their windows after export. Existing schema-1 selector jobs
remain supported, including `failSelector` and its `null` opt-out described in
[STANDALONE.md](STANDALONE.md).

`job-result.json` is the desktop completion report. It appears only after
downloads, scientific provenance, offline asset checks and any requested viewer
acceptance pass. Pending viewers are unavailable through MCP until completion.
Cancellation or failure before publication removes the completion report and its
temporary file. Direct jobs keep downloaded artifacts for inspection; MCP removes
the failed run's output directory. A cancellation requested after publication
does not retract completion.

Run `xvfb-run -a node scripts/desktop/artifact-completion-smoke.mjs` on Linux
to exercise CLI and MCP completion with controlled app fixtures. It checks both
job schemas, offline failures, retained-viewer acceptance and cancellation in
real Electron. Set `NEURODESK_ELECTRON` to use another Electron binary. This
check does not validate scientific processing.

## Add an application

Run `pnpm new-app <id>`. The template includes a contract, an explicitly labelled
input-copy demonstration and a browser download test. Replace the demonstration
with the app's scientific method, keeping one awaited handler for manual and
automated processing.

Register operations with `registerAppAutomation` from
`@neurodesk/webapp-components/automation`. Each handler receives `inputs`,
`parameters`, `signal`, `progress` and `inputDetails`. Return actual `File`
artifacts with declared roles, scientific provenance, and any measurements or
summary. Pass cancellation to workers and check the signal after asynchronous
steps. A cancelled or stale run cannot publish a successful report.

Use `registerViewer` with a public viewer adapter for supported controls. A
viewer operation must register its actual viewer and return a source summary.
Declare artifact cardinality and types, including variable output collections.
Keep DICOM conversion at the shared input boundary unless the operation needs
raw acquisition metadata.

Run `node scripts/automation-coverage.mjs` for declaration coverage and
`node test/automation-catalog.smoke.mjs` after a production build for published
contract and registration checks. Neither establishes scientific correctness.
Add app browser tests that exercise real inputs through processing, cancellation
and verified downloads. Run the desktop tests and
`xvfb-run -a node scripts/desktop/automation-smoke.mjs` on Linux to check the
complete MCP and BET path.

## Generate tools for another workflow runtime

For NeuroFlow, run `node scripts/generate-neuroflow.mjs --out DIRECTORY` from
the repository root. It generates one validated tool per operation and a
shared launcher that uses desktop MCP. See the
[generator guide](neuroflow/README.md) for installation, engine selection,
constraint mapping and verification. The
[type-constraint RFC draft](../../docs/rfcs/0010-neuroflow-data-constraints.md)
proposes portable encoding, space and label-system semantics.

Generate one tool per entry in `operations`. Keep the app ID, operation ID and
contract version with the generated tool. Resolve file paths at execution time,
and use the returned artifact IDs rather than assuming that each role emits one
file. The published schema validates the source contract.

| Contract field | Meaning to preserve |
| --- | --- |
| `inputs` and `parameters` | Typed tool inputs, defaults, bounds and logical cardinality |
| `artifacts` | Output roles, semantic types and cardinality |
| `engines` | Declared launch choices; the installed server reports actual availability |
| `formats` | Accepted encodings, independently of the semantic type |
| `space` | A named reference or a frame relative to an input |
| `labelSystem` | Label vocabulary, independently of voxel geometry |
| `limits` | Engine-specific resource constraints and explicitly deferred formats |

For a NeuroFlow type-vocabulary RFC, keep encodings separate from semantic types:
an MGZ and a NIfTI can both be `neuro:volume`, while only one may be accepted by a
tool. Space compatibility also needs the referenced input or subject identity.
Two unrelated images marked `native` are not guaranteed to share a grid. Named
templates and label systems need versioned identifiers when revisions change
their meaning. These mapping notes describe this contract without imposing a
NeuroFlow document syntax.
