# @neurodesk/ants

## 0.4.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/registration@0.1.1

## 0.4.20261009

### Minor Changes

- b4d7594: Add the `ants` command line: `ants MOVING FIXED OUTPUT_DIR` runs the web app's `register` operation in Node with the same ANTs 2.6.2 WebAssembly kernel and ANTsPy `SyN` schedule, and writes the web app's four downloads under the same names. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check registers the pinned 1 mm example and requires every output to match the web app's own downloads voxel for voxel. MindGrab brain extraction is not included until #162.
