# @neurodesk/brain-extraction

## 0.4.20261009

### Minor Changes

- bb10737: Add the `brain-extraction` command line: SynthStrip on ONNX Runtime Node and BET on a single-threaded WebAssembly build of the same qsm-core BET the web app runs, writing the web app's brain image and mask under the same names. It takes `--method synthstrip|bet` and BET's `--fractional-intensity`; `--method mindgrab` explains that MindGrab follows with #162. The SynthStrip model is installed with SHA-256 checks on every load, and the command line ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the model. Each release must reproduce the web app's results on the pinned T1 example, as recorded in a browser: identical NIfTI headers, brain intensities and mask voxel counts, a BET mask identical bit for bit, and a SynthStrip mask Dice of 0.99995 or better. The web app now takes its download names and NIfTI writer from `@neurodesk/brain-extraction`, and its SynthStrip model pin from `@neurodesk/synthstrip/model`.
- 07f3a14: Add `--method mindgrab` to the `brain-extraction` command line. It runs `@brainchop/mindgrab`'s CPU module through the shared Node driver with the web app's options and writes the brain image and mask the web app downloads. The web app and the command line now both use `@brainchop/mindgrab` 0.1.20260925. Each release must reproduce the web app's MindGrab CPU result on the pinned T1 example bit for bit, as recorded in a browser, with identical NIfTI headers and brain intensities.

### Patch Changes

- Updated dependencies [bb10737]
- Updated dependencies [64ffefa]
  - @neurodesk/synthstrip@0.1.4
  - @neurodesk/runtime-support@0.3.0
  - @neurodesk/synthsr@0.6.20261009

## 0.1.23

### Patch Changes

- @neurodesk/synthsr@0.6.20261007

## 0.1.22

### Patch Changes

- @neurodesk/synthsr@0.6.20261007

## 0.1.21

### Patch Changes

- @neurodesk/synthsr@0.6.20261007

## 0.1.20

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261005

## 0.1.19

### Patch Changes

- Updated dependencies
  - @neurodesk/synthsr@0.6.20261004

## 0.1.18

### Patch Changes

- @neurodesk/synthsr@0.6.20261004

## 0.1.17

### Patch Changes

- @neurodesk/synthsr@0.6.20261004

## 0.1.16

### Patch Changes

- Updated dependencies [257192b]
  - @neurodesk/synthsr@0.6.20261004

## 0.1.15

### Patch Changes

- @neurodesk/synthsr@0.5.20261004

## 0.1.14

### Patch Changes

- @neurodesk/synthsr@0.5.20261003

## 0.1.13

### Patch Changes

- @neurodesk/synthsr@0.5.20260930

## 0.1.12

### Patch Changes

- @neurodesk/synthsr@0.5.20260930

## 0.1.11

### Patch Changes

- @neurodesk/synthsr@0.5.20260928

## 0.1.10

### Patch Changes

- @neurodesk/synthsr@0.5.20260928

## 0.1.9

### Patch Changes

- @neurodesk/synthsr@0.4.20260928

## 0.1.8

### Patch Changes

- @neurodesk/synthsr@0.4.20260924

## 0.1.7

### Patch Changes

- @neurodesk/synthsr@0.4.20260923

## 0.1.6

### Patch Changes

- @neurodesk/synthsr@0.4.20260920

## 0.1.5

### Patch Changes

- @neurodesk/synthsr@0.4.20260920

## 0.1.4

### Patch Changes

- @neurodesk/synthsr@0.4.20260920

## 0.1.3

### Patch Changes

- @neurodesk/synthsr@0.4.20260918

## 0.1.2

### Patch Changes

- @neurodesk/synthsr@0.4.20260918

## 0.1.1

### Patch Changes

- @neurodesk/synthsr@0.4.20260916
