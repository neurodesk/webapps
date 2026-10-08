# @neurodesk/brain2print

Printable brain meshes from a T1-weighted MRI: MindGrab segmentation, a niimath
mesh, then a manifold and winding check. The Brain2Print web app
(`apps/brain2print`) and the `brain2print` command line both run this code, so
they write the same files.

- `src/pipeline.js` is the pipeline. It takes the MindGrab and niimath runtimes
  as arguments: `segmentBrain` (the grey plus white matter fraction for `pve`,
  a label map otherwise), `buildMesh` (niimath's mesh, read from mz3 and
  oriented), `meshFiles` (STL and MZ3) and `createMesh`, which chains them.
- `src/mesh.js` is the edge census and signed volume behind the manifold and
  winding check.
- `src/browser.js` holds the app's runtimes: MindGrab's published wrapper in a
  module worker, and niimath's WebAssembly worker.
- `src/node.js` and `bin/brain2print.js` are the command line. They use the
  MindGrab CPU and niimath drivers in `@neurodesk/runtime-support/node`.

## Command line

The `brain2print` command runs the web app's create-mesh operation on your own
computer with Node.js. It needs no browser, GPU, network or model files:
MindGrab's weights are compiled into its WebAssembly modules.

### Install

Download the release for your platform from the Brain2Print app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf brain2print-VERSION-linux-x64.tar.gz
./brain2print-VERSION-linux-x64/brain2print self-check
```

On Windows, use `Expand-Archive` and `brain2print.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs Brain2Print in
`/usr/local/lib/neurodesk/brain2print` and the `brain2print` command in
`/usr/local/bin`:

```bash
sudo installer -pkg brain2print-VERSION-macos-arm64.pkg -target /
brain2print self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/brain2print` and
`/usr/local/bin/brain2print`, then run
`sudo pkgutil --forget org.neurodesk.brain2print`.

### Commands

```text
brain2print IMAGE.nii[.gz] OUTPUT_DIR [settings]
brain2print self-check
brain2print --help
```

The settings are the app's automation parameters:

| Setting | Default | Meaning |
| --- | --- | --- |
| `--model pve\|16chan18cls\|mindmap\|mindsnap` | `pve` | `pve` meshes MindMap's grey plus white matter fraction at 0.5, a sub-voxel surface. The others mesh a label map at its boundary. |
| `--simplify N` | 20 | Percentage of mesh faces to keep, 5 to 100. |
| `--smooth N` | 0 | Mesh smoothing iterations, 0 to 20. |
| `--[no-]largest-only` | on | Keep only the largest connected component. |
| `--[no-]fill-bubbles` | on | Fill internal cavities before meshing. |

`self-check` meshes a right- and a left-handed test ball with the bundled
niimath and loads MindGrab, without running inference.

Input is NIfTI only. Convert DICOM with dcm2niix first, or use the web app.

### Outputs

`OUTPUT_DIR` must be new or empty. It receives the web app's downloads:

- `brain-fraction.nii` (for `pve`) or `segmentation.nii`: the image the mesh is
  built from, on the input grid.
- `brain2print.stl`: binary STL in world millimetres, with outward unit
  normals.
- `brain2print.mz3`: the same triangles and vertices, for NiiVue and Surfice.

The command prints a JSON report on standard output: the mesh checks
(`manifold`, `consistent`, `signedVolume` in mm³, `windingCorrected`,
`triangles`) and provenance (settings, MindGrab model, version and backend,
niimath version and mesh options, run time). A mesh that is closed and
consistently wound but encloses a negative volume has its winding flipped, so
the normals face outward whatever the image's handedness.

Segmentation takes about a minute on eight cores and up to 4 GB of memory.

### Accuracy

The release check, `validation/cli-check.mjs`, runs the command line on four
cases: the app's pinned example with the default settings, the e2e fixture
as stored and mirrored into left-handed storage (`pve`, smoothing 5), and the
fixture with `16chan18cls`. It holds every file to
`validation/browser-reference.json`, which records what the web app's pipeline
wrote in Chromium. In the browser, MindGrab ran in its published wrapper on its
CPU backend and niimath ran in its WebAssembly worker. The check measures the
files with its own parsers (`validation/measure.mjs`). It requires identical
NIfTI headers, voxel statistics, vertex and face counts, enclosed volume and
bounds, a closed manifold with consistent winding and outward normals, and
identical bytes. The command line reproduces the browser byte for byte, so the
check allows no tolerance.

`validation/browser-reference.mjs --check` reruns the browser side. Without
`--check` it rewrites the reference. The app's hardware-GPU e2e tests run
MindGrab on WebGPU and are not held to these CPU numbers.
