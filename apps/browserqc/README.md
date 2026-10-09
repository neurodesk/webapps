# BrowserQC

BrowserQC computes MRIQC-style image-quality metrics locally in the browser.
Choose a pinned example, a NIfTI scan or a DICOM folder, then select
**Run quality control**. Images and reports remain on your machine.

The MindGrab WebAssembly models compute an independent brain mask and either
tissue fractions or labels. They return results on the displayed input grid.
Niimath computes CJV, CNR, SNR, FBER, WM2MAX, EFC and tissue composition using
the tissue maps, brain mask and pinned MNI air template. These measurements are
an MRIQC-style approximation and are not MRIQC normative values.

NiiVue renders the scan. DICOM import uses the shared dcm2niix converter.
The viewer requires a WebGPU-capable desktop browser. Segmentation can use
WebGPU, WebGL2 or a threaded CPU on a cross-origin isolated page.

## Develop

From the repository root, run `pnpm install`, then `pnpm --filter browserqc dev`.
Run `pnpm --filter browserqc build` for a production build and
`pnpm --filter browserqc test` for TypeScript and unit checks.
`pnpm --filter browserqc test:e2e` builds and runs the browser smoke test.
The full pipeline tests need a WebGPU-capable browser; the CPU automation tests
also need cross-origin isolation.

The example images and air template are pinned in `examples.json` and the
repository's offline asset inventories. Model runtimes are staged from the
pinned `@brainchop/mindgrab` dependency during dev and build.

## Upstream integration

Integrated from niivue/browserqc commit `30f385f498299ceb580ead4709e55ac695b7c55c`.
The default is `mindmap-pve`, with CSF, GM and WM fraction maps and a separate
MindGrab brain mask. The `16chan18cls`, `mindmap` and `mindsnap` label models remain
available. QC uses niimath's public `qc()` method on the displayed image's native
grid. Background noise display, right-drag contrast or pan, and MRIQC-compatible
manual ratings are available. Ratings require ten seconds of inspection and an
edit before download.

The Neurodesk integration keeps its shared shell, local DICOM conversion,
explicit Run action, pinned examples and cancellable automation. Automated PVE
runs return `csf`, `gm`, `wm`, `mask` and `qc`; label runs return `labels`, `mask`
and `qc`. Choose `model: "16chan18cls"` to retain the previous label output.

## Command line

The portable `browserqc` command line runs this app's pipeline in Node, with
the same MindGrab and niimath WebAssembly on the CPU, and writes the app's
downloads. Its archives for Linux, Windows and macOS include the models and
air template and run offline; get them from the Standalone dialog. The app
and the command line share the pipeline in `packages/browserqc`, whose README
describes the options and the release check against this app's own output.

## Native pipeline

Run `python3 cli/qc.py --in T1.nii.gz --out qc.json`. Install the matching
`brainchop-mindgrab`, `brainchop-<model>` and `niimath` executables on PATH or set
`BROWSERQC_BIN`. The CLI requires niimath with `--qc --pve --mask` support and
uses the same model catalog as the app. The default air template is downloaded
from the pinned Neurodesk dataset and SHA-256 checked, including cache hits.
Set `BROWSERQC_CACHE` to choose its external cache directory, or use `--template`
for an explicit alternative air template. Temporary processing data uses `TMPDIR`.

The CLI tests verify argument wiring with stub executables. They do not establish
numerical parity with the browser or native pipelines.

## License

BSD-2-Clause. See [LICENSE](LICENSE).
