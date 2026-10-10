# @neurodesk/syncro

## 0.6.20261010

## 0.6.20261009

## 0.6.20261007

### Minor Changes

- d627aca: Add a macOS arm64 installer package for the `syncro` command line. It installs SYNcro in `/usr/local/lib/neurodesk/syncro` and the `syncro` command in `/usr/local/bin`, bundles Node and the models, and is signed with a Developer ID and notarized for release. The app no longer ships its own download dialog, which the shared bar's Standalone action had replaced, or the npm tarball that only that dialog linked.

### Patch Changes

- 6be20aa: Add the `topofit` command line: CPU reconstruction with ONNX Runtime Node, offline model installation with SHA-256 checks on every load, portable Linux x64 and Windows x64 archives, and a Developer ID signed, notarized macOS arm64 installer package that installs `/usr/local/bin/topofit`. Each bundles Node and the T1-weighted models, and each must match the OpenRecon end-to-end reference before release. SYNcro's portable archives are now built by the shared `exes/node-cli` packager; their contents and behaviour are unchanged apart from the launcher binary.

## 0.5.20261005

## 0.5.20261004

### Minor Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.

## 0.4.20261004

## 0.4.20261003

## 0.4.20260930

## 0.4.20260928

## 0.3.20260928

## 0.3.20260924

## 0.3.20260923

## 0.3.20260920

## 0.3.20260918

## 0.3.20260916

## 0.3.20260915

## 0.2.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.

## 0.2.20260910
