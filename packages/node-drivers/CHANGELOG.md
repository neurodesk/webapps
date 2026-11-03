# @neurodesk/node-drivers

## 0.3.2

### Patch Changes

- 71881c8: Add the SyN-SDC pipeline (`@neurodesk/sdc/syn`, `/syn/node`, `/syn/browser`): sdcflows 2.17.1's fieldmap-less susceptibility distortion correction for one DWI series and a T1w, in the browser and in Node. The EPI reference is the mean b0 (clipped, N4, clipped), the masks are MindGrab's or uploaded, the T1w is clipped and denoised with `@neurodesk/ants-denoise`, the epi2anat and T1w-to-MNI affines and the restricted SyN on the 1.2 mm grid run `--float 1` in the hmc-registration kernel with a fixed seed, the prior (`models/sdc.manifest.json`) is warped through the MNI affine or left out, and the field-fit module turns the warp into a field in Hz. The whole series is unwarped once with the Jacobian factor, keeping the b0 volumes. The phase-encoding direction and readout time come from options or the sidecar (or EffectiveEchoSpacing); without them the run is refused. Outputs are BIDS derivatives: `desc-sdc_dwi` with its bval, bvec and sidecar, `desc-preproc_fieldmap` (Hz), `desc-coeff_fieldmap`, the `from-orig_to-sdc` displacement field and the brain mask. An `AbortSignal` terminates every worker. MindGrab's Node driver now takes a `signal` too.

## 0.3.1

### Patch Changes

- d8ac48c: Convert DICOM with @niivue/dcm2niix 1.4.20261029 in every app and command line. The shared client is a thin layer over its `convert`, which pairs sidecars and gradients, times out and terminates its worker; bundler-less apps stage the same JPEG build (JPEG-LS and JPEG 2000) from npm instead of a committed 1.3 copy, and all apps share one WASM. A conversion that yields some images now keeps them; dcm2niix's last log line is reported when none are produced. Output names drop the `input_` prefix and never include the input folder, whose name can identify a patient.

## 0.3.0

### Minor Changes

- 5b5ff35: Add the `brainchop-mindgrab` command line, which runs the native brainchopC argv (`-o`, `--mask [PATH]`, `--border MM`, `--ct`, `--comply`) on MindGrab's CPU WebAssembly, so Linux containers can skull-strip for meica-rs `--moco` and fastprep without the native build.

## 0.2.0

### Minor Changes

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.
