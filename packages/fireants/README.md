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

- Brain extraction. The command line registers the given images as they are,
  because MindGrab has no Node runtime yet
  ([#162](https://github.com/neurodesk/webapps/issues/162)). Brain extract both
  images first, for example with SynthStrip, when they still contain scalp.
- DICOM import. Convert DICOM with dcm2niix first.

The output directory must be new or empty.

### Outputs

`results/<moving>_registered.nii.gz` is the moving image resliced onto the
fixed grid, with the web app's download name.

### Accuracy

`validation/cli-check.mjs` is the release gate. It registers the web app's
pinned example (`t1-mni`, a T1 brain to the MNI152 1 mm template) with the
command line on 4 threads, once with `--transform greedy` and once with
`--transform syn`. It compares each result with
`validation/t1-mni-reference.json`, which holds two recordings per preset:

- `browser`: the web app's own download, recorded by
  `apps/fireants/e2e/reference.spec.js` through the built app, its automation
  and its registration worker, in Chromium on 4 cores.
- `inProcess`: the engine's `register()` called in Node with `worker: false`,
  recorded by `cli-check.mjs --write-reference`.

For each preset the output's header geometry (dims, pixdim, qform, sform) must
equal the fixed image's and the browser reference's. Its voxels must hash
identically to both references. Its voxel mean and std must agree with the
browser reference within 1e-4 (relative) and its correlation with the fixed
brain within 1e-4. Its final NCC must agree with the in-process reference
within 0.001.

On 4 threads the output is deterministic. The web app in Chromium, the engine
in-process and the packaged command line on Linux x64, Windows x64 and macOS
arm64 all produced the same voxels for Greedy, and the web app and the engine
produced the same voxels for SyN. Another thread count changes the float
rounding. On Linux x64, 8 threads instead of 4 changed the Greedy voxels, moved
the mean by 1.5e-6, the std by 7.6e-7 and the correlation by 1.6e-6, and left
the NCC at -0.8586. The statistics limits are about 60 times those shifts. They
show how far a differing output is; the voxel hash is the gate.

```bash
node packages/fireants/validation/cli-check.mjs
node packages/fireants/validation/cli-check.mjs --executable path/to/fireants
node packages/fireants/validation/cli-check.mjs --transform syn
node packages/fireants/validation/cli-check.mjs --write-reference
FIREANTS_BROWSER_REFERENCE=write taskset -c 0-3 pnpm --filter fireants exec playwright test e2e/reference.spec.js
```

Regenerate both recordings when `@fireants/fireants` changes; the check refuses
a reference recorded with another engine version. The `web-app-reference` job
in `fireants-native.yml` reruns the browser recording with
`FIREANTS_BROWSER_REFERENCE=check` on a 4-core runner. The browser run needs
exactly 4 CPUs, because the app uses every core the browser reports. Each
preset takes 15 to 35 minutes on 4 threads.
