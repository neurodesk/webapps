# dicompare command line

Run the web app's DICOM protocol checks without a browser. The command line
loads the same Pyodide 0.27.0 build and the same pinned `dicompare` 0.11.1 wheel
as the web app's offline worker, in Node, and calls the worker's Python code.
No Python installation is needed.

```sh
dicompare self-check
dicompare analyze session/ --output acquisitions.json
dicompare compare session/ --schema protocol.json --schema-index 0 --output comparison.json
dicompare compare session/ --schema QSM_Consensus_Guidelines_v1.0
dicompare build-schema session/ --name "Site protocol" --author "A. Author" --output protocol.json
dicompare schemas
```

`analyze` and `compare` write the reports of the app's automation operations
(`apps/dicompare/automation.json`): `acquisitions.json` and the `comparison.json`
compliance report. `build-schema` writes the schema the app exports from
unedited acquisitions. `--schema` takes a JSON file or the name of a schema in
the app's library (`dicompare schemas`). DICOM arguments are files or
directories, read recursively in sorted order. Reports go to standard output
unless `--output` is given; progress and a JSON summary go to standard error.

## How it matches the web app

- `src/python.js` is generated from `apps/dicompare/src/workers/pyodide.worker.ts`
  by `scripts/sync-python-calls.mjs`. It holds the worker's install, analysis,
  version and validation code, unchanged. The test fails when the worker changes
  and the file was not regenerated. The command line's schema builder stays in
  `src/node.js` with the same Python text and reference outputs; upstream now
  builds edited web schemas in JavaScript to preserve graded constraints.
- `python.manifest.json` is generated from `registry/offline-assets.sources.json`
  and its lock by `scripts/sync-python-manifest.mjs`: the Pyodide packages and
  wheels the installed suite stages for dicompare, in the same order. The test
  also holds the Pyodide core files from npm to the CDN files the app loads.
- `schemas/` is copied from `apps/dicompare/public/schemas` at build time.

After an upstream sync, run both sync scripts and
`node validation/browser-reference.mjs` after `pnpm --filter dicompare build`.

Every Python package is size- and SHA-256-verified before Pyodide starts. A run
never uses the network: Pyodide and micropip fall back to the CDN or PyPI for a
missing package, and the command line refuses those requests.
`NEURODESK_DICOMPARE_MODEL_DIR` or `--cache-dir` selects the package directory;
`NEURODESK_OFFLINE=1` or `--offline` refuses to download. Portable releases
include every package.

## Validation

`validation/cli-check.mjs [--executable PATH]` runs the command line on the app's
example, `t1-dicom-protocol` from `apps/dicompare/examples.json`, and compares
each report with `validation/browser-reference.json`. The browser references come
from the production app's automation in Chromium. They cover `analyze`,
`compare` against a library schema, and `compare` against the schema the
command line builds. dicompare stamps each validation with the time it ran
(`analysis_timestamp`), so that one value is excluded from the comparison.
Every other byte must match. The app has no schema automation operation, so
`build-schema` is held to the in-repository command line. The browser's
`compare` against that schema passes every check.

The deployed web app installs dicompare from PyPI, which resolved nibabel 5.4.2
and tabulate 0.10.0 when the reference was recorded. The command line and the
installed suite use the pinned nibabel 5.3.3 and tabulate 0.9.0. The reports are
identical. `pythonAssets` in the reference lists what the browser fetched.

dicompare checks acquisition parameters against a protocol. It is not clinical
compliance certification.
