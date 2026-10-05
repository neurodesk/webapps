# @neurodesk/fireants

A command line for the FireANTs web app's registration, and the registered
image's file name, which the web app imports from here.

## Command line

`fireants` runs the web app's `register` operation on the CPU with Node. It uses
the same `@fireants/fireants` WebAssembly build as the browser and needs no
browser, GPU or network.

### Install

Download the release for your platform from the web app's Standalone dialog:
Linux x64, Windows x64 or macOS on Apple silicon. Each contains a private
Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf fireants-VERSION-linux-x64.tar.gz
./fireants-VERSION-linux-x64/fireants self-check
```

On Windows, use `Expand-Archive` and `fireants.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs FireANTs in `/usr/local/lib/neurodesk/fireants`
and the `fireants` command in `/usr/local/bin`:

```bash
sudo installer -pkg fireants-VERSION-macos-arm64.pkg -target /
fireants self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/fireants` and
`/usr/local/bin/fireants`, then run `sudo pkgutil --forget org.neurodesk.fireants`.

From a checkout of this repository:

```bash
pnpm install
node packages/fireants/bin/fireants.js --help
```

### Commands

```bash
fireants moving.nii.gz fixed.nii.gz results                  # Greedy, all cores
fireants moving.nii.gz fixed.nii.gz results --transform syn --threads 8
fireants self-check
```

`download-models` exists for the shared packager and does nothing: FireANTs
uses no model files.

The options follow the `register` operation in `apps/fireants/automation.json`:

| Option | Automation parameter | Meaning |
| --- | --- | --- |
| `--transform` | `transform` | `greedy` (default) or `syn` |
| (none) | `backend` | Always `cpu`. WebGPU needs a browser |
| `--threads` | (none) | CPU threads, default `SLURM_CPUS_PER_TASK` or all cores |
| `--verbose` | (none) | Log every iteration instead of one line per stage |

Each run applies moments, rigid and affine alignment before the deformable
preset, as in the web app. The engine logs the similarity (NCC) after each
stage on stderr. More negative is better.

The command line leaves out two parts of the web app:

- MindGrab brain extraction has no Node runtime yet. Brain extract both images
  first, for example in the web app, when they still contain scalp.
- DICOM import. Convert DICOM with dcm2niix first.

The output directory must be new or empty.

### Outputs

`results/<moving>_registered.nii.gz` is the moving image resliced onto the
fixed grid, with the web app's download name.

### Accuracy

`validation/cli-check.mjs` is the release gate. It registers the web app's
pinned example (`t1-mni`, a T1 brain to the MNI152 1 mm template) with the
command line on 4 threads. It compares the result with
`validation/t1-mni-reference.json`, which `--write-reference` records from the
web app's own `register()` call, made in-process with the same build and
thread count. The final Greedy NCC must agree within 0.001, and the registered
image's correlation with the fixed brain within 0.0005.

The limits allow for float rounding on other CPUs and operating systems. The
threaded engine splits its sums by thread. On Linux x64, 8 threads instead of
4 changed voxels but not the reported NCC (-0.8586), and moved the correlation
by 2e-6. With 4 threads, the packaged command line reproduced the reference
voxel for voxel.

```bash
node packages/fireants/validation/cli-check.mjs
node packages/fireants/validation/cli-check.mjs --executable path/to/fireants
node packages/fireants/validation/cli-check.mjs --write-reference
```

Regenerate the reference with `--write-reference` when `@fireants/fireants`
changes; the check refuses a reference recorded with another engine version.
A Greedy registration of the example took 12 to 15 minutes on 4 threads of the
shared Linux test host.
