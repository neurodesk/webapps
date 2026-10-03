# Generate NeuroFlow tools

The generator turns each schema-2 `automation.json` operation into a NeuroFlow
0.1 tool document. It copies one dependency-free Node launcher into the bundle.
The launcher calls the desktop MCP interface, so no per-app DOM wrapper is
needed. Browser and native engines use the same generated document.

## Generate a registry bundle

From the Webapps repository, after `pnpm install --frozen-lockfile`:

```sh
node scripts/generate-neuroflow.mjs --out "$TMPDIR/neurodesk-neuroflow"
```

Or generate from one published contract, which already contains `appVersion`:

```sh
node scripts/generate-neuroflow.mjs \
  --contract /path/to/published/automation.json \
  --out "$TMPDIR/synthseg-neuroflow"
```

For an unpublished source contract, supply its package version with `--version`.
Generation fails if the version is missing. It validates the source with the
desktop's parser and every output against the pinned, unmodified upstream
schemas. It does not download schemas.

The destination contains `tools/<app>/<operation>.tool.json` and `scripts/`.
Move these together. The command produces identical bytes from identical
inputs and accepts an identical existing bundle. To update a changed bundle,
generate into a new directory. It refuses to overwrite unrelated or stale
files, and publishes a new bundle only after all documents are valid.

## Run through NeuroFlow

Install the Neurodesk desktop suite containing the same contracts. Set
`NEURODESK_WEBAPPS` to its executable path if it is not named
`neurodesk-webapps` on `PATH`. A macOS application bundle is a directory; use
the actual executable inside its `Contents/MacOS` directory.

```sh
export NEURODESK_WEBAPPS=/absolute/path/to/neurodesk-webapps
neuroflow-mcp --registry "$TMPDIR/neurodesk-neuroflow" \
  --data-root /absolute/path/to/data --check
```

Use the same command without `--check` as the MCP server command. Configure
`--interpreter node=/absolute/path/to/node` if the host's PATH lacks Node.
Generated MCP names contain only letters, digits, underscores and hyphens,
and are at most 64 characters.

A SynthSeg call uses the generated inputs:

```json
{
  "input_image": "/absolute/path/to/T1.nii.gz",
  "param_mode": "default",
  "param_ct": false,
  "engine": "native"
}
```

The native engine still needs the desktop's configured SynthSeg executable.
Availability is checked at execution time. Select `browser` for WebGPU execution
through the desktop app. Its existing resource limits, including the 2 GiB
SynthSeg cap, still apply. `NEURODESK_TIMEOUT_MS` sets the launcher deadline in
milliseconds, default 1800000 and maximum 86400000. Configure NeuroFlow's
`--step-timeout` to allow that time plus process cleanup.

For source-tree testing, `NEURODESK_WEBAPPS_ARGS` is a JSON array of arguments
placed before `--mcp`. Paths and arguments are passed directly to the child
process; the launcher never constructs a shell command.

## Mapping and guarantees

| Contract | Generated tool |
| --- | --- |
| App + operation | `neurodesk.webapps/<app>/<operation>` |
| App version | Tool version and installed-contract check |
| File input role | `input_<role>`, one artifact reference when `maximum` is 1, otherwise an array |
| URL / directory role | `input_<role>`, URL string / directory reference (`neuro:ome-zarr` for a multiscale store) |
| Parameter | `param_<name>`, scalar or array, with defaults and numeric bounds |
| Artifact role | `output_<role>`, one artifact when `maximum` is 1 (optional when `minimum` is 0), otherwise an array |
| Engine list | `engine` enum, defaulting to the first declared engine |
| Report | `report`, a `neuro:report` JSON file with actual run provenance and measurements |
| Formats, space, labelSystem | RFC 0010 qualifiers where the migration mapping applies (below); the unchanged source declaration always stays in `neurodesk/data` |
| Cardinality | Unchanged source declaration in `neurodesk/data` |
| Nested constraints and multipleOf | Unchanged declaration in `neurodesk/parameter` |
| Limits and operation mode | Full source contract in `neurodesk/automation` |

A role with `maximum: 1` is a scalar in the tool document, so a single
artifact from another tool binds to it directly; NeuroFlow never binds a
scalar to an array. The launcher widens a scalar input to the one-element list
the desktop takes and narrows a single-file output to one path (omitting an
absent optional one). A role without a maximum stays an array. Cardinality on
DICOM inputs counts logical images after series selection, not the number of
slice files. A scalar NeuroFlow input accepts one file, not a directory or a
list of DICOM slices. Convert a multi-file series to NIfTI before binding it.
The generator does not expose desktop series-selection controls; it does not
guess a series. DICOM execution also requires a runtime with a DICOM inspector.

The generator uses standard artifact types when their representation matches,
including `core:tabular` for `neuro:table`, `neuro:tract` for
`neuro:tractogram`, `neuro:gradient-table` for `neuro:gradients`,
`neuro:ome-zarr` for `neuro:multiscale-volume`, and `neuro:transform` with
`formats: ["displacement-field"]` for `neuro:displacement-field`.
Other Neurodesk-specific `neuro:` types become `neurodesk:` extension types.
Their original declarations remain in the extension. A union of artifact
types uses `core:file` with the union preserved and verified by the adapter.
Nested parameter arrays use `core:json` elements at the unsupported nesting
boundary, with their full schema still enforced by desktop validation.

Before executing, the launcher checks the installed contract against a
canonical SHA-256 of the complete source contract, then calls `apps_validate`.
A same-version contract change also requires regeneration. For schema-2 NIfTI
inputs, desktop preflight checks the actual NIfTI-1 or NIfTI-2 header, including
gzip and either byte order. This encoding check does not establish spatial
identity or validate the whole voxel payload. It calls
`runs_start`, polls `runs_get`, and reads completed artifacts as MCP resources.
Artifacts above the desktop's 64 MiB resource limit are streamed from that
run's verified local output directory, with the same size and hash checks.
The launcher does not trust an arbitrary path supplied in the report.
It checks report identity, artifact roles, semantic types, cardinality, byte
counts and SHA-256 values. It writes NeuroFlow's `result.json` atomically only
after verification. Scientific errors and mismatched contracts fail the step.
SIGINT, SIGTERM and timeouts cancel the run and close the desktop process.

Viewer operations load and inspect their input and return a report, then close
the viewer. They do not leave a retained interactive session inside NeuroFlow.
Use the desktop MCP viewer controls directly when an agent needs that session.

## Type qualifiers

[NeuroFlow RFC 0010](https://github.com/cdrake/neuroflow-spec/blob/rfc/0010-type-qualifiers/rfcs/0010-type-qualifiers.md)
adds `formats`, `space`, `resolution`, `density` and `labelSystem` to type
declarations, and a document that carries any of them declares
`"neuroflow": "0.1.1"`. The generator promotes a contract annotation to a
qualifier only where source evidence establishes its meaning;
everything else stays in `neurodesk/data` as documentation, which no validator
may report as checked.

| Contract value | Qualifier |
| --- | --- |
| `formats` spellings | RFC tokens as they are (`nifti`, `dicom`, `json`, ...); `gii` becomes `gifti`, `bvals`/`bvecs` become `bval`/`bvec`; `surface` is a category, not a token, and is dropped; any other spelling keeps a `neurodesk:` prefix |
| `space: native` on an input | retained as metadata; these apps also accept images in other frames |
| `space: input` or `subject-1mm` on an artifact | `inputs.input_<role>` of the operation's one spatial file input; two spatial inputs leave it in the extension. `subject-1mm` adds `resolution: 1` |
| `space: fixed` or `moving` on an artifact | `inputs.input_fixed` / `inputs.input_moving` |
| `space: fixed`, `moving` or `input` on an input | none: the input defines that frame |
| `space` on a transform (`moving-to-fixed`, warps) | none: RFC 0010 excludes `space` from `neuro:transform` |
| SYNcro/disconnectome `MNI152-1mm` | `MNI152NLin6Asym`, `resolution: 1`, tied to their identical pinned FSL template |
| TopoFit `scanner-RAS-mm`, dwi2trx `RAS-mm`, VesselBoost `analysis` outputs | `inputs.input_image`; a frame relationship, not a grid-equivalence claim |
| SYNcro native-synthetic output | `inputs.input_primary` |
| `atlas`, `lesion-reference`, `registration-sphere`, unverified labels | extension only; a vendor prefix would not establish a shared frame |
| `labelSystem: FreeSurfer` | `freesurfer` |
| other `labelSystem` values | `neurodesk:<value>` |

The generator checks version and inheritance rules beyond JSON Schema, including
the referenced input's type and cardinality. [Catalog mapping tests](../../../test/neuroflow-qualifiers.test.mjs)
pin the template checksum and the app-specific decisions. TopoFit's optional
ROI does not change the output frame; that frame comes from its anatomical input.

[Runtime enforcement PR #4](https://github.com/cdrake/neuroflow/pull/4) is the
implementation used for the integration check. Use a runtime that evaluates
qualifier compatibility and enforces unresolved
checks before launching consumers. Accepting the `0.1.1` envelope or emitting a
warning is insufficient. Header inspection can establish encoding and spacing,
but not a named template or label-table revision. Such claims need trusted,
artifact-bound provenance; unsupported checks must fail. The desktop continues
to enforce its own app-specific checks and the SynthSeg 2 GiB resource limit.

## Verification

```sh
node --test test/neuroflow-generator.test.mjs test/neuroflow-qualifiers.test.mjs
```

The tests cover the full catalog, deterministic generation, upstream schemas,
input-name collisions, collection outputs, contract drift, hash mismatches,
scientific failure, browser/native selection and cancellation. The transport
tests use the actual desktop MCP/service implementation with a clearly labelled
test executor; they do not claim scientific inference accuracy.

The [schema snapshot record](vendor/README.md) pins the upstream spec and runtime
used for compatibility testing. The snapshot is the RFC 0010 branch of the
spec; the earlier draft in this repository,
[docs/rfcs/0010-neuroflow-data-constraints.md](../../../docs/rfcs/0010-neuroflow-data-constraints.md),
is superseded by it.

For a real scientific integration check, build `neuroflow-mcp` in the upstream
runtime checkout and build this repository's brain-extraction app. Then run:

```sh
pnpm --filter brain-extraction build
NEUROFLOW_MCP_BIN=/absolute/path/to/neuroflow-mcp \
  xvfb-run -a node scripts/desktop/neuroflow-smoke.mjs
```

Use `node` without `xvfb-run -a` on a Mac with a graphical session. Linux
containers that require Electron's sandbox override can set
`NEURODESK_CONTAINER=1`. The check runs two chained BET steps through the actual upstream runtime,
generated launcher, and desktop MCP server. The second step consumes the first
step's scalar brain artifact. It compares the binary mask with
the pinned voxel count and SHA-256 golden, verifies geometry and artifact
hashes, and keeps evidence outside the checkout. It does not test WebGPU
inference or native Metal.
