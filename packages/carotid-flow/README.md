# @neurodesk/carotid-flow

Carotid detection and flow curves from one retrospectively gated phase-contrast
slice through the neck. The Carotid Flow web app (`apps/carotid-flow`) and the
`carotid-flow` command line both run this code, so they produce the same files.
The methods are described in the app's `README.md`.

- `src/carotid.js` detects both carotids: `detectFromVelocity` for signed
  velocity, `detectFromVariability` for an unsigned speed image. It is pure:
  typed arrays in, typed arrays and numbers out.
- `src/series.js` reads NIfTI files into the series `detectCarotids` takes.
- `src/outputs.js` names and encodes the label map, temporal SD and curves CSV.
- `src/node.js` and `bin/carotid-flow.js` are the command line.

## Command line

The `carotid-flow` command runs the detection on your own computer with
Node.js. It needs no browser, GPU, network or model files.

### Install

Download the release for your platform from the Carotid Flow app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf carotid-flow-VERSION-linux-x64.tar.gz
./carotid-flow-VERSION-linux-x64/carotid-flow self-check
```

On Windows, use `Expand-Archive` and `carotid-flow.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs Carotid Flow in `/usr/local/lib/neurodesk/carotid-flow`
and the `carotid-flow` command in `/usr/local/bin`:

```bash
sudo installer -pkg carotid-flow-VERSION-macos-arm64.pkg -target /
carotid-flow self-check
```

You can also open the package in Finder. To uninstall, delete
`/usr/local/lib/neurodesk/carotid-flow` and `/usr/local/bin/carotid-flow`, then run
`sudo pkgutil --forget org.neurodesk.carotid-flow`.

### Commands

```text
carotid-flow SERIES.nii[.gz] OUTPUT_DIR [settings]
carotid-flow AMPLITUDE.nii[.gz] PHASE.nii[.gz] OUTPUT_DIR [settings]
carotid-flow self-check
carotid-flow --help
```

`SERIES` holds the amplitude frames followed by the same number of phase
frames, as the app's "Detect carotids" operation takes a combined series.
Otherwise give the amplitude and phase series as two files, amplitude first.
Both must be single-slice NIfTI images with the same frame count, size, affine and voxel spacing.
Input is NIfTI only. Convert DICOM with dcm2niix first, or use the web app,
which converts it in the browser.

The settings are the web app's advanced settings and automation parameters:
`--candidate-percentile`, `--head-percentile`, `--venc`, `--tilt-limit`,
`--posterior`, `--anterior`, `--lateral`, `--midline` and `--min-separation`.
They are checked against the same schema as `apps/carotid-flow/automation.json`,
and `--help` lists their ranges and defaults. Raw phase stored as ±4096 or 0–4095
needs `--venc` in cm/s; without it the command stops before writing anything. A `--venc` beside
an unsigned series that is not centred on 2048 is refused, because it cannot be told apart from
a speed image.

`OUTPUT_DIR` must be new or empty. Progress and a one-line summary go to
standard error. An error prints one message and exits with status 1.
`self-check` prints a JSON report of the platform, the Node version and the
runtime's path, after running the whole detection on a built-in tilted
phantom. `download-models` exists only for the portable packager and installs
nothing.

### Outputs

The output directory receives the web app's three downloads, named after
`SERIES` or `AMPLITUDE`:

- `<name>_carotid_labels.nii`, the label map (1 = left carotid, 2 = right)
  on the series grid. Left and right are the patient's, from the affine.
- `<name>_phase_sd.nii`, the temporal SD the vessels were found in.
- `<name>_carotid_curves.csv`, one row per cardiac frame: velocity (cm/s)
  and flow (ml/min) per carotid for signed velocity, or the phase signal per
  carotid for an unsigned speed image.

Editing the labels needs the web app.

### Accuracy

`validation/cli-check.mjs` runs the command on the app's pinned example,
PCMCalculator's open test data, and checks it against `validation/pcmcalculator.json`.
The same file supplies the pins of the app's open-example unit test. Every
output must be byte-identical to the in-repository detection the web app runs.
Measured on the Linux x64 archive: the right carotid averages 211.0 ml/min,
6.3 % below PCMCalculator's manual measurement of 225.2 ml/min (limit 10 %),
with a waveform correlation of 0.9984. The left carotid averages 231.3 ml/min.
The label map has 39 left and 34 right pixels. The three files had the same
SHA-256 as the web app's downloads of the same example. Every release package
must pass this check on its own platform before release.

The example and its reference measurement are from PCMCalculator:

> Vestergaard MB. PCMCalculator [Computer software]. Zenodo; 2026.
> https://doi.org/10.5281/zenodo.18712355
