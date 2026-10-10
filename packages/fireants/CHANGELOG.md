# @neurodesk/fireants

## 0.3.20261010

## 0.3.20261009

## 0.3.20261007

### Minor Changes

- 046ada7: Add the `fireants` command line. It runs the web app's CPU registration with Node, offers the Greedy and SyN presets and writes the web app's `<moving>_registered.nii.gz`. Portable Linux x64, Windows x64 and macOS arm64 archives bundle the Node runtime. Before release, each archive must reproduce the web app's own Greedy and SyN outputs on the pinned T1-to-MNI example voxel for voxel, on the fixed image's grid. The command line registers the given images: brain extract them first, for example with SynthStrip, until MindGrab has a Node runtime (#162). WebGPU stays in the web app.
