# MRI2Vid

Turn a stack of medical images into a scrolling video (MP4 or WebM) by stepping
through the slices. There are two ways to use it: a browser tool that runs fully
on your machine, and the original Python command-line script.

## Browser tool

Live site (once GitHub Pages is enabled): https://thomshaw92.github.io/DICOM2Vid/

### please note, this repo was written partly with Claude AI, and may contain errors.
Drag in a DICOM folder, or a `.nii` / `.nii.gz` / `.mgz` file. Pick the
orientation, frame rate, slice range, and whether to overlay slice numbers, then
preview and download the video. It reads the images, windows and reslices them,
and encodes the video in the page.

- Your images and all processing stay in your browser and are never uploaded. The
  only external request is anonymous page-view analytics (Google Analytics), which
  never sees your images. To disable it, delete `web/js/analytics.js` and the two
  analytics `<script>` tags in `web/index.html`.
- Inputs: DICOM (single-frame series and enhanced multiframe, grayscale and RGB
  such as color-FA maps), NIfTI, and FreeSurfer MGZ. Compressed DICOM
  (JPEG/JPEG2000) is not supported; convert it to uncompressed locally first.
- A whole DICOM directory is grouped by series; the most likely structural scan
  (a T1w, for example) is selected first, and you can pick any other series.
- The right panel shows the volume in a NiiVue viewer for windowing, and the
  actual output frames in a scrubber so you see exactly what the video contains.
- Video is encoded with WebCodecs (H.264 in MP4, or VP9 in WebM) where available,
  falling back to MediaRecorder WebM on older browsers.

The browser tool ports the behavior of `MRI2vid.py` for grayscale DICOM (global
min/max normalize, the six orientations, slice range, slice annotation). That path
is checked against the Python reference frame-for-frame (see Development).

## Command-line tool

The original script renders one DICOM folder to an MP4.

```
python MRI2vid.py --folder <path_to_dicom_folder> --output out.mp4 --orientation sagittal
```

Options:

- `--orientation`: `sagittal`, `coronal`, `axial`, `sagittal_flipped`,
  `coronal_flipped`, `axial_flipped`.
- `--fps`: frames per second (default 20).
- `--start-slice` / `--end-slice` / `--slice-step`: limit or subsample the slice
  range (0-based, end exclusive; negative indices count from the end).
- `--annotate-slices`: overlay slice numbering.

Install the Python dependencies with `pip install -r requirements.txt`. On macOS
you may also need `brew install ffmpeg`.

## Development

The browser app is plain ES modules with no build step. All dependencies are
vendored under `web/js/vendor` (no CDN).

- Serve locally: `cd web && python3 -m http.server 8000`, then open
  http://localhost:8000.
- Run the parity and reader tests: generate the goldens once, then run the tests.

```
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt nibabel
python tools/gen_phantom.py && python tools/gen_reference.py
node --test tools/test/
```

The DICOM grayscale pipeline must reproduce the reference frame stack with
`max|diff| = 0`. NIfTI and MGZ readers are checked against nibabel; the series
ranker against labeled synthetic series.

- Browser smoke test (needs Playwright): `npm install && npx playwright install chromium`
  then `node tools/browser/smoke.mjs`. It checks in-browser parity, MP4/WebM/NIfTI/
  color encoding, and the full UI flow.
- Update vendored dependencies: `bash tools/vendor.sh`.

No subject data (PHI) is stored in this repository. The phantom generator produces
fully synthetic images; its output and the goldens are gitignored.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
