# @neurodesk/laynii

LayNii v2.10.0 (`LN2_LAYERS` and `LN2_PROFILE`) compiled to single-threaded WebAssembly (no `SharedArrayBuffer` required).

## Reproducible WebAssembly build

```bash
bash packages/laynii/scripts/build.sh /storage/tmp/laynii-build
bash packages/laynii/scripts/build.sh --check /storage/tmp/laynii-build
```

Uses the pinned `itkwasm/emscripten` toolchain digest and pinned LayNii commit `9febedf0157740dc7987fa5098f3e53e70a1c915` with `--network none`.

## Offline unit tests

```bash
pnpm --filter @neurodesk/laynii test
```
