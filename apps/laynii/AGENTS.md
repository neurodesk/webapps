# laynii instructions

- The app runs `@neurodesk/laynii`'s own module worker (`?worker&url`), one fresh worker and WASM module instance per run, terminated on completion or cancellation to reclaim WASM memory and keep C state isolated.
- `packages/laynii/wasm/laynii.{mjs,wasm}` is a single-threaded non-pthread Emscripten build of LayNii v2.10.0 (`LN2_LAYERS` and `LN2_PROFILE`) built reproducibly via `packages/laynii/scripts/build.sh` (pinned `itkwasm/emscripten` digest, `--network none`, zero `SharedArrayBuffer` dependency).
- Keep the pre-allocation volume budget (`MAX_VOXELS = 12_000_000`), rim label validation (`0..3`), and signal-to-rim grid validation before invoking WASM: upstream `LN2_PROFILE` does not check grid equality.
- The app has no separate command line of its own: the Standalone dialog lists the Neurodesk `laynii/2.10.0` container (`registry/standalone-exceptions.json`), whose `LN2_LAYERS` and `LN2_PROFILE` outputs the WebAssembly build reproduces bit for bit.
