# @neurodesk/brain-extraction

Brain extraction shared by the brain extraction web app, SYNcro and the
`brain-extraction` command line. It holds the BET and MindGrab adapters, the
output names and NIfTI writer of the web app's downloads, and the command line.
SynthStrip itself is `@neurodesk/synthstrip`.

## Command line

`brain-extraction` runs SynthStrip or BET on the CPU and writes the two files
the web app downloads, `INPUT_METHOD_brain.nii` and `INPUT_METHOD_mask.nii`, on
the input grid:

```sh
brain-extraction head.nii.gz results                  # SynthStrip
brain-extraction head.nii.gz results --method bet --fractional-intensity 0.4
brain-extraction download-models                      # SynthStrip model, once
brain-extraction self-check
```

| Option | Meaning |
| --- | --- |
| `--method synthstrip\|bet` | SynthStrip (default) or BET. `mindgrab` reports that it is not available yet ([#162](https://github.com/neurodesk/webapps/issues/162)). |
| `--fractional-intensity F` | BET threshold from 0 to 1, default 0.5 as in the web app. Lower values give larger masks. |
| `--threads N` | SynthStrip ONNX Runtime threads, default `SLURM_CPUS_PER_TASK` or all cores. |
| `--cache-dir DIR`, `--offline` | Model directory and no-download mode. |

The output directory must be new or empty. The command prints a JSON report
with the mask voxel count and the provenance, including the method, its
settings and the model's SHA-256.

SynthStrip loads the browser graph the web app loads (`@neurodesk/synthstrip/model`)
on ONNX Runtime Node, with the CPU memory arena off: the T1 example then peaks
at 2.6 GB instead of 4.4 GB. BET runs `wasm/bet.wasm`, qsm-core's BET compiled
for WebAssembly without threads or generated glue. The web app runs the same
qsm-core BET from QSMbly's threaded bundle; BET has no parallel code paths, so
both compute the same mask.

The portable archives are built by `exes/node-cli` and
`.github/workflows/brain-extraction-native.yml`. Each must pass
`validation/cli-check.mjs`, which runs both methods on the app's pinned T1
example and holds the files to the browser run recorded in
`apps/brain-extraction/validation/browser-reference.json`: NIfTI headers, mask
voxels, mask Dice and brain intensities. BET must match the browser's mask bit
for bit. SynthStrip must reach Dice 0.9999; when its mask is not the browser's
exactly, the Dice is taken against `validation/web-reference.mjs`, the app's
ONNX Runtime Web path, after that reference reproduces the browser's mask.

## BET WebAssembly

`wasm/bet.wasm` is committed. `bet-wasm/` pins the qsm-core revision that
`apps/qsmbly/rust-wasm/Cargo.lock` locks, and `test/bet-wasm.test.js` fails
when they differ. After a qsm-core update, rebuild with Rust 1.98.0 and commit
the result:

```sh
pnpm --filter @neurodesk/brain-extraction build:wasm
```

The `wasm-source` job rebuilds it with `scripts/build-bet-wasm.sh --check` and
fails when the committed bytes differ.
