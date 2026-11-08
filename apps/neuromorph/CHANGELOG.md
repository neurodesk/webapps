# neuromorph

## 0.1.20261108

### Minor Changes

- 7539ad5: Add NeuroMorph, a browser app for neuron morphology from SWC reconstructions. It reads one or more SWC files or a folder, reports and repairs common SWC faults, draws each neuron as tubes coloured by soma, axon, basal and apical dendrite, and measures total length, branch and terminal points, path and radial distance, branch and Strahler order, bifurcation angles, surface area, volume and the Sholl profile with a configurable step, with CSV downloads. On both NeuroMorpho.Org examples and NeuroM's test morphologies every value agrees with NeuroM 4.0.6 to one part in a million and every Sholl count is identical.

  `writeMz3` takes optional per-vertex RGBA colours, and the example selector offers **Load folder…** for any input marked `data-neurodesk-folder`.

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
