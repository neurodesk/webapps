# @neurodesk/brain2print

## 0.5.20261009

### Minor Changes

- 66bf9e9: Add the `brain2print` command line: `brain2print IMAGE OUTPUT_DIR` runs the web app's create-mesh operation in Node, with MindGrab on the CPU and the same niimath WebAssembly, and writes the web app's three downloads under the same names. Its options are the app's automation parameters: `--model`, `--backend` (the command line always runs on the CPU), `--simplify`, `--smooth`, `--[no-]largest-only` and `--[no-]fill-bubbles`. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check runs the app's pinned example, the template of the app's CPU e2e test and the right- and left-handed test fixtures, and requires every file to match the web pipeline's output in Chromium byte for byte; the app's CPU e2e test is held to the same pins.

  The app's pipeline moves into `@neurodesk/brain2print`, which the app and the command line share. The app now gives MindGrab NIfTI files as stored rather than as NiiVue rewrites them, and uses MindGrab 0.1.20260925. Breaking for `@neurodesk/topofit`: `readMz3`, `writeMz3` and `writeStl` are no longer exported from `@neurodesk/topofit/results`; import them from `@neurodesk/webapp-components/file-io/mesh`. The package is not published to npm and no workspace consumer imports them from TopoFit any more.

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
