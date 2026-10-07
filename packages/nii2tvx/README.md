# @neurodesk/nii2tvx

Structural disconnection in the browser: open a TVX tract atlas once, then query a lesion mask
against every tract. The engine is `exes/nii2tvx` compiled to WebAssembly — 21 KB, no
filesystem, no zlib, no `main` — so this package owns decompression, the memory rules and the
number formatting.

```js
import { openAtlas, toTsv } from '@neurodesk/nii2tvx';

const atlas = await openAtlas(atlasBytes);        // .tvx, gzipped or not
const fractions = await atlas.query(lesionBytes); // .nii or .nii.gz, on the atlas grid
const tsv = toTsv(atlas.tracts, [{ id: 'sub-01', fractions }]);
atlas.close();
```

`query` returns one float per tract: the fraction of that bundle's streamlines passing through
the lesion. `NaN` means the bundle has no streamlines inside the volume, which is missing data
rather than a failure. A lesion on a different grid throws with the reason the C core printed.

`toTsv` reproduces the CLI's table byte for byte, which is why `formatG` reimplements C's
`printf("%g")` instead of using `Number.toPrecision`: the two disagree on `nan` versus `NaN`,
on `3.24086e-05` versus `0.0000324086`, and on `1e-07` versus `1e-7`. The first of those is
what one clipped streamline of the largest HCP1065 bundle produces, so it is not academic.

Measured on an Apple M4 Pro with the 87-tract HCP1065 atlas: 13 ms to open the 88 MB atlas,
9 ms to open a mask, 57 ms for all 87 queries.

## The committed module

`wasm/nii2tvx.{mjs,wasm}` is checked in because no CI runner has emscripten, the same choice
`packages/registration` and `packages/synthseg` make. Rebuild it with `make wasm`, which runs
emcc in `exes/nii2tvx` and copies the result here. `npm test` fails if the committed module
stops agreeing with the native tool, so the artifact cannot drift from the C unnoticed.

## Command line

The `disconnectome` command scores a lesion on your own computer with Node.js
and this package's WebAssembly core. It writes the Disconnectome web app's TSV
download byte for byte. It needs no browser, GPU or native build. The command
lives in this package because `@neurodesk/nii2tvx` is already the package whose
version is linked to the disconnectome app, and the portable packager takes one
`bin` per package.

### Install

Download the release for your platform from the Disconnectome app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime and both query atlases, so it runs offline from the
first use.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf disconnectome-VERSION-linux-x64.tar.gz
./disconnectome-VERSION-linux-x64/disconnectome self-check
```

On Windows, use `Expand-Archive` and `disconnectome.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs Disconnectome in `/usr/local/lib/neurodesk/disconnectome`
and the `disconnectome` command in `/usr/local/bin`:

```bash
sudo installer -pkg disconnectome-VERSION-macos-arm64.pkg -target /
disconnectome self-check
```

You can also open the package in Finder. To uninstall, delete
`/usr/local/lib/neurodesk/disconnectome` and `/usr/local/bin/disconnectome`, then run
`sudo pkgutil --forget org.neurodesk.disconnectome`.

### Commands

```text
disconnectome LESION.nii[.gz] OUTPUT_DIR [--atlas enigma|hcp1065]
                                         [--cache-dir DIR] [--offline]
disconnectome download-models [--cache-dir DIR]
disconnectome self-check
disconnectome --help
```

`--atlas` selects ENIGMA Symmetric (65 bundles, the default) or HCP1065
(87 bundles), the two the app offers. They are different parcellations, so a
result cannot be carried from one to the other. The lesion must be on the
MNI152 1 mm grid (182 × 218 × 182, sform) that both atlases use. Any other
lesion is refused with the app's advice, "Not on the 182 × 218 × 182 MNI152
grid; normalize it with SYNcro first.", followed by the reason the C core gave.
Input is NIfTI only; the web app converts DICOM.

`OUTPUT_DIR` must be new or empty. Progress and the count of disconnected
bundles go to standard error. An error prints its message and exits with
status 1. `self-check` prints a JSON report of the platform, the Node version
and the runtime's path after loading the WebAssembly core. Inside a release
it also checks both installed atlases.

### Atlases and offline use

Releases set `NEURODESK_DISCONNECTOME_MODEL_DIR` to their `models/` directory
and `NEURODESK_OFFLINE=1`. Run from the repository, the command downloads the
TVX atlas it needs (7.9 MB ENIGMA, 21.8 MB HCP1065) to
`~/.cache/neurodesk/disconnectome/<revision>` (or `$XDG_CACHE_HOME`, or
`--cache-dir`) on first use. `download-models` fetches both ahead of time.
Every file's size and SHA-256 are checked against `disconnectome.manifest.json`
on every load. A file that fails the check stops the run and names the path to
delete. With `--offline`, a missing atlas stops the run instead of downloading.

`disconnectome.manifest.json` is a copy of `models/disconnectome.manifest.json`,
the one the app reads. `test/node.test.js` fails if they differ, and
`exes/nii2tvx/scripts/repoint_manifest.sh` writes both.

### Output

`<lesion>_<atlas>_disconnectome.tsv`, named after the lesion file without its
NIfTI extension: a header of `id` and the bundle names, and one row with the
lesion's name and each bundle's fraction, formatted as C's `printf("%g")`.
`nan` marks a bundle with no streamlines inside the volume. This is the web
app's download and the native `nii2tvx` table for the same lesion and atlas.

### Accuracy

`validation/cli-check.mjs` runs the command on the app's four pinned example
lesions against both atlases. Each table must be byte-identical to the
committed native output in `exes/nii2tvx/test/expected-examples-enigma.tsv`
and `expected-examples.tsv`: the header and that lesion's row. Those goldens are
what `make -C exes/nii2tvx test-real` diffs the C tool against, and what the
app's live end-to-end test compares its download with. The check also requires
the wrong-grid fixture to be refused with the app's advice and to write
nothing. Measured on the Linux x64 archive: all eight tables were identical,
for example 31 of 65 ENIGMA bundles disconnected by wM2017. Each run took
0.5 to 1.2 s and at most 440 MB of memory. Every release package must pass
this check on its own platform before release.
