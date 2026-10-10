# @neurodesk/lcmodel

LCModel (`exes/lcmodel`) and FID-A (`exes/fida`) compiled to one WebAssembly
module with a plain C ABI (`wasm/src/lib.rs`), its JavaScript glue
(`src/wasm.js`), the fit workflow the LCModel web app and the `lcmodel`
command line share (`src/pipeline.js`), and the command line itself. The built
`src/lcmodel.wasm` is committed; after changing either crate or `wasm/src`, run
`make wasm` and `make test`.

```js
import { loadLcmodel } from "@neurodesk/lcmodel";
const lcm = await loadLcmodel(fetch(wasmUrl), { onProgress: (text, fraction) => {} });
lcm.addFile("meas.dat", bytes);          // any file FID-A can read
const { datasets } = lcm.load();          // detected and paired with water
const pre = lcm.process(0, {});           // FID-A pipeline -> .RAW/.H2O text
const fit = lcm.run({ control, files: { "spectrum.raw": pre.lcmodel.raw, "basis.basis": basis } });
```

Everything runs synchronously, so call it from a worker. `test/` checks the
module against native LCModel on its test case and runs FID-A's GE PRESS
example through preprocessing and fitting.

## The shared workflow

`src/pipeline.js` makes every choice between loading the files and saving the
results: which basis set each dataset gets (`chooseBasis`, `planGroup`), the
fit range and macromolecule model, the control file, and the downloads and
their names (`resultTexts`). FID-A and LCModel run behind an engine passed in:
the app's worker, or the module loaded in Node (`src/node.js`). Change the
workflow there, so the app and the command line keep writing the same files.

## Command line

The `lcmodel` command runs the web app's fit on your own computer with the
same WebAssembly module. It needs no browser or MATLAB.

### Install

Download the release for your platform from the LCModel app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime and all 25 library basis sets, so it runs offline from
the first use.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf lcmodel-VERSION-linux-x64.tar.gz
./lcmodel-VERSION-linux-x64/lcmodel self-check
```

On Windows, use `Expand-Archive` and `lcmodel.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs LCModel in `/usr/local/lib/neurodesk/lcmodel`
and the `lcmodel` command in `/usr/local/bin`:

```bash
sudo installer -pkg lcmodel-VERSION-macos-arm64.pkg -target /
lcmodel self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/lcmodel` and
`/usr/local/bin/lcmodel`, then run `sudo pkgutil --forget org.neurodesk.lcmodel`.

### Commands

```text
lcmodel SPECTRUM [WATER ...] OUTPUT_DIR [options]
lcmodel download-models [--cache-dir DIR]
lcmodel self-check
lcmodel --help
```

Give the files the app reads: Siemens twix `.dat`, RDA and DICOM, GE P-files,
Philips SDAT/SPAR, NIfTI-MRS, Bruker, or an LCModel `.RAW` with its `.H2O` and
an LCMODL control file. A `.RAW` whose `$SEQPAR` names MEGA-PRESS is fitted
as a difference spectrum; `--edited` or `--no-edited` overrides that. One run
fits one `.RAW`. A folder counts as its files, named by their path
inside it, so each subject's spectrum pairs with its own water reference as in
a folder drop. The last argument is the output directory, which must be new or
empty.

The options are the app's automation parameters for `fit`, in kebab case:
`--basis-set ID` (default `auto`, the recommendation), `--[no-]edited`,
`--macromolecule-model co-edited|none`, `--line-broadening widened|lcmodel`,
`--[no-]remove-bad-averages`, `--bad-average-sd N`, `--[no-]drift-correction`,
`--[no-]phase-and-reference`, `--[no-]water-scaling`,
`--[no-]eddy-current-correction`, `--ppm-start N`, `--ppm-end N`,
`--frequency-mhz N` and `--dwell-time-ms N` (for a `.RAW`),
`--fraction-gm`, `--fraction-wm`, `--fraction-csf` and
`--[no-]metabolite-relaxation`. `--basis FILE` fits with your own `.BASIS`
file (gzipped or not). The defaults are the app's: the widened line-broadening
prior for unedited spectra, LCModel's own prior and the co-edited
macromolecule model for MEGA-PRESS, and no co-edited model with an
MM-suppressed basis set.

When the files hold several datasets, each is fitted in turn as the app's
fit-group operation does, with its recommended basis set unless the one given
suits them all. A dataset that fails is listed in the group table and the
others continue.

Progress goes to standard error. A finished run prints one JSON line with the
written files, the measurements the app's automation reports and the
provenance: the parameters given, the preprocessing settings, the basis set and
its checksum, the LCModel control file and the run time. An error prints one
message and exits with status 1.

`--t1 FILE_OR_DIR` reads a same-session 3D NIfTI or DICOM series. MindMap
segments it on the CPU, then measures each dataset's own spectroscopy voxel
on the tissue maps. Give a T1 or all three fractions, not both. A 4D T1 or
a dataset without a recorded voxel position is refused. Segmentation needs
about 3.9 GB of memory and runs once for a group. The CPU modules contain
the model weights, so the complete archive runs offline.

### Outputs

For a dataset named `meas`, the web app's downloads under the same names:
`meas_concentrations.csv`, `meas_report.html`, `meas.table`, `meas.coord`,
`meas.RAW`, `meas.control`, and when they apply `meas.H2O`,
`meas_edit_off.RAW`, `meas_fida.json`, `meas_tissue_corrected.csv` and
`meas_tissue_correction.json`. A group adds `lcmodel_group.csv` and
`lcmodel_group_wide.csv`, and each fitted dataset's files. A T1 adds each
dataset's `<stem>_voxel_mask.nii` and the shared `<t1>_gm.nii`,
`<t1>_wm.nii` and `<t1>_csf.nii` maps. The correction JSON records MindMap
version, CPU backend, T1 name, coverage and voxel geometry.

### Basis sets and offline use

Releases set `NEURODESK_LCMODEL_MODEL_DIR` to their `models/` directory and
`NEURODESK_OFFLINE=1`. Installed from the repository, the command downloads the
basis set a fit needs to `~/.cache/neurodesk/lcmodel/<set>` (or
`$XDG_CACHE_HOME`, or `--cache-dir`); `download-models` fetches all 25 (23 MB)
ahead of time. Every file's size and SHA-256 are checked against
`model.manifest.json` on every load. With `--offline`, a missing file stops the
run instead of downloading.

### Release check

`validation/cli-check.mjs --executable PATH` runs a command line on every
case of `validation/reference.mjs`: each bundled example with the defaults, and
each option on an example where it changes the result. It holds the command
line to three references that do not run its code path:

- The web app in Chromium. `apps/lcmodel/e2e/reference.spec.js` runs each case
  through the built app and records a SHA-256 of every download in
  `validation/browser-reference.json`; `LCMODEL_BROWSER_REFERENCE=write`
  records it again, and the `web-app-reference` job of `lcmodel-native.yml`
  reruns it with `check` before any archive is built. Every download must be
  byte for byte the same, the report apart from its program-and-time line.
  The tissue correction's inputs (`_tissue_correction.json`) print every
  double in full, and Chromium's and Node's JavaScript engines round a few
  `exp()` results differently in the last bit; that file is compared number
  by number to 1e-12 relative. Its rounded table is compared byte for byte.
- Native gfortran LCModel 6.3-1N on LCModel's test case: the concentration,
  misc and diagnostics tables must be identical.
- The GABA+ fit of the Siemens MEGA-PRESS example pinned natively in
  `wasm/src/session.rs` (`mega_tests`), and the synthetic water-scaling truth
  of `validation/synthetic.mjs` (Cr+PCr 8 and NAA+NAAG 10 within 1 %, and
  0.872 of the creatine with LCModel's prior).

On Linux x64 the command line wrote the browser's files byte for byte in all
15 cases, including forced-CPU MindMap tissues on the defaced Philips T1, apart from one value of the tissue correction's inputs, which
differed by 1.2e-16 relative. The examples download once into the system temporary directory and are
checked against `registry/offline-assets.lock.json`.
