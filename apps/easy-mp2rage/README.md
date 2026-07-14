# Easy MP2RAGE T1 Map

B1-corrected T1 mapping from MP2RAGE, at 3T and 7T. Runs in the browser or from
the command line.

Web app: https://mp2rage.neurodesk.org/

Drag in DICOM folders or NIfTI files, set their roles, and it computes a
B1-corrected T1 map in your browser. Your images are never uploaded and all
processing runs client-side. Outputs download as NIfTI. When the input was a
DICOM folder, the T1 map also downloads as a derived DICOM series.

The hosted site loads Google Analytics for anonymous usage statistics (page
views only, for the NeuroDesk team); it never has access to your images or
results. Remove the Google Analytics snippet from web/index.html if you self-host
and do not want it.

## What it does

- T1 map: B1-corrected T1 (ms) from MP2RAGE, using either a SA2RAGE scan or a
  generic Siemens B1 map (for example a tfl / TB1TFL flip-angle map) as the B1
  source. A B1 map with a smaller field of view than the MP2RAGE can be extended
  to cover the brain with a smooth low-order fit.
- SA2RAGE to B1 map: the relative B1 map on its own.
- UNI denoising: MP2RAGE UNI to UNI-DEN (O'Brien robust combination), which
  removes the background noise.

## What it is based on

The maths is a port of the T1-mapping parts of Jose Marques'
MP2RAGE-related-scripts (https://github.com/JosePMarques/MP2RAGE-related-scripts):

- MP2RAGE T1 lookup and B1 correction: Marques et al. 2010, NeuroImage.
- SA2RAGE B1 mapping: Eggenschwiler et al. 2012, MRM.
- UNI denoising (robust combination): O'Brien et al. 2014, PLoS ONE.

There are three implementations in this repo. The numeric core is validated to
match across all three (see crates/mp2rage-cli/tests and tools/gen_golden.py):

- mp2rage_t1/ is the reference Python package and CLI.
- crates/ is a Rust port (mp2rage-core), a native CLI (mp2rage-cli), and a
  WebAssembly build (mp2rage-wasm).
- web/ is the in-browser app (the Rust core compiled to WASM).

## Command line (Python)

Install:

    pip install -e .        # add ".[qc]" for the QC figure

numpy, scipy, nibabel and pydicom install automatically. dcm2niix is only needed
for DICOM input. Point it at scan folders (DICOM) or dcm2niix NIfTI files (with
their .json sidecars), in any order. Roles and timing are read from the headers,
including field strength.

    # SA2RAGE B1 source (typically 7T)
    easy-mp2rage-t1map -i INV1 INV2 UNI SA2RAGE -o out --qc

    # generic Siemens B1 map instead of SA2RAGE (typically 3T)
    easy-mp2rage-t1map -i INV1 INV2 UNI -o out --b1-map B1MAP --b1-map-type tfl

UNI plus one B1 source (SA2RAGE, --b1-map, or a tfl flip-angle map passed in -i)
are required. INV2 (used for the brain mask) and INV1 are used if present. Run
easy-mp2rage-t1map -h for all options.

Output:

    out/t1map/<sub>_T1map.nii.gz     B1-corrected T1 in ms (main output)
        b1map/<sub>_B1map.nii.gz     relative B1 (1.0 = nominal)
        <sub>_parameters.json        every value used

Check these against your protocol:

- --trflash is the MP2RAGE GRE readout TR (echo spacing). It is not stored in
  DICOM. Default is 7.0 ms. An error of 1 ms is about 40 ms in T1.
- SA2RAGE outer TR, second delay and second flip angle are not reliably in the
  header. Header-derived defaults are used. Override with --sa2rage-tr,
  --sa2rage-td2, --sa2rage-fa.
- Field strength is auto-detected and sets the SA2RAGE average T1 (1.2 s at 3T
  and below, 1.5 s at 7T). Override with --b0 or --sa2rage-avgt1.
- With --b1-map, set --b1-map-type to how it stores B1: tfl (Siemens flip-angle
  map, value = flip degrees times 10, prep angle --b1-ref-angle default 80),
  percent (100 = nominal), or relative (1.0 = nominal).

## Command line (Rust)

    cargo run -p mp2rage-cli --release -- \
      --uni UNI.nii.gz --inv2 INV2.nii.gz --b1-map B1.nii.gz \
      --b1-map-type tfl --b1-extend-fov --out out

## Run the web app locally

The web app is a static site (Rust compiled to WebAssembly). To build and run it
yourself, following the same approach as QSMbly:

Prerequisites:

- Rust: install from https://rustup.rs/
- wasm-pack: `cargo install wasm-pack`

Build the WebAssembly and stage it into web/:

    bash tools/build_wasm.sh

Serve the web/ folder over HTTP and open it. It uses ES modules and WebAssembly,
so it must be served over http, not opened as a file:// path:

    cd web
    python3 -m http.server 8080
    # then open http://localhost:8080

Any static file server works (for example `npx serve web`). All processing runs
client-side; there is no backend and your images are never uploaded.

Tests:

    cargo test                     # Rust core parity + CLI + WASM API
    node web/test/e2e_node.mjs     # headless data path (WASM in Node)

## Notes

- DICOM: a Siemens tfl B1 map (TB1TFL) exports two series, an anatomical
  reference and the flip-angle map. Only the flip-angle map (the FLIP ANGLE MAP,
  or "famp", one) is the B1 map. Prefer the distortion-corrected (DIS2D/DIS3D)
  MP2RAGE images over the non-corrected _ND versions. The web app flags both.
- Use the plain UNI, not UNI-DEN, as the input to correction if you have it.
  Voxels where the B1 fit does not converge are left as 0.
- Research code, no warranty. Check the maps and the parameters.

## Deploying

The web app is a static site (Rust compiled to WASM). GitHub Pages builds and
publishes it. See docs/DEPLOY.md.

## License

GPL-3.0-or-later. Please cite Marques 2010 (NeuroImage), Marques and Gruetter
2013 (PLoS ONE), Eggenschwiler 2012 (MRM) and O'Brien 2014 (PLoS ONE). See
CITATION.cff.
