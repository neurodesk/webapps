# @neurodesk/edgereg

## 0.4.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.
- Updated dependencies
  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

## 0.4.20261009

### Minor Changes

- 20e97ab: Add the `edgereg` command line: `edgereg MOVING FIXED OUTPUT_DIR [--robust-fov]` runs the web app's `register` operation in Node with the same niimath `-allineate` WebAssembly build, and writes the web app's download under the same name. The method now lives in `@neurodesk/edgereg`, which the web app imports. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check registers the pinned example and requires the output's header and voxels to hash identically to the web app's own download; native niimath built from source is held to measured limits.

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
