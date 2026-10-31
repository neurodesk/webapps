# @neurodesk/node-drivers

## 0.3.1

### Patch Changes

- d8ac48c: Convert DICOM with @niivue/dcm2niix 1.4.20261029 in every app and command line. The shared client is a thin layer over its `convert`, which pairs sidecars and gradients, times out and terminates its worker; bundler-less apps stage the same JPEG build (JPEG-LS and JPEG 2000) from npm instead of a committed 1.3 copy, and all apps share one WASM. A conversion that yields some images now keeps them; dcm2niix's last log line is reported when none are produced. Output names drop the `input_` prefix and never include the input folder, whose name can identify a patient.

## 0.3.0

### Minor Changes

- 5b5ff35: Add the `brainchop-mindgrab` command line, which runs the native brainchopC argv (`-o`, `--mask [PATH]`, `--border MM`, `--ct`, `--comply`) on MindGrab's CPU WebAssembly, so Linux containers can skull-strip for meica-rs `--moco` and fastprep without the native build.

## 0.2.0

### Minor Changes

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.
