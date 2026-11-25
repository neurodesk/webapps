# @neurodesk/brainchop

Whole-brain T1-weighted MRI segmentation and GM/WM/CSF tissue fraction maps
for browsers and portable Node.js command lines, powered by `@brainchop/core`
(MIT License).

## Command line

Portable archives (Linux x64, Windows x64, macOS Apple silicon) bundle Node.js
and `@brainchop/core`'s CPU WebAssembly modules (with all model weights compiled
directly into the modules) so they run completely offline:

```bash
brainchop self-check
brainchop t1.nii.gz results
brainchop t1.nii.gz results --model mindsnap --threads 4
brainchop t1.nii.gz results --model tissue-fractions
```

Available models (`--model`):

- `mindmap` (default) — 18-class cortical and subcortical segmentation (MindMap-24)
- `mindmap-fast` — lightweight 18-class preview (MindMap-16)
- `mindsnap` — 104-region Desikan-Killiany atlas (MindSnap-104)
- `tissue-fractions` — continuous GM, WM, CSF and brain partial-volume fraction maps

## Tests

```bash
pnpm --filter @neurodesk/brainchop lint
pnpm --filter @neurodesk/brainchop test
unshare -rn sh -c 'ip link set lo up && pnpm --filter @neurodesk/brainchop test'
```
