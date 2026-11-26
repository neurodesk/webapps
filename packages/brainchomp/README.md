# @neurodesk/brainchomp

Rodent MRI brain extraction for browsers and portable Node.js command lines,
powered by the pinned `brainchomp-lib` CPU WebAssembly module (MIT License).

## Command line

Portable archives (Linux x64, Windows x64, macOS Apple silicon) bundle Node.js
and `brainchomp.wasm` (with model weights compiled directly into the module)
so they run completely offline:

```bash
brainchomp self-check
brainchomp rodent.nii.gz results
brainchomp rodent.nii.gz results --opening 4 --threads 4
```

Outputs written to `OUTPUT_DIR`:

- `<stem>_brainchomp_brain.nii` — skull-stripped rodent brain image on the input grid
- `<stem>_brainchomp_mask.nii` — binary brain mask on the input grid

## Tests

```bash
pnpm --filter @neurodesk/brainchomp lint
pnpm --filter @neurodesk/brainchomp test
unshare -rn sh -c 'ip link set lo up && pnpm --filter @neurodesk/brainchomp test'
```
