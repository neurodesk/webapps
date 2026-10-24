# pipeline-builder

## 0.1.20261024

### Minor Changes

- 6b704d9: Add Pipeline builder, a new app in the Pipelines category. It chains Neurodesk app operations into a NeuroFlow workflow, offers only the bindings the vendored NeuroFlow WebAssembly validator accepts, and exports `.workflow.json` files that `neuroflow-mcp` runs. The page publishes the generated tool catalog under `neuroflow/` as a NeuroFlow registry, and ships a T1 segmentation template (N4 → brain extraction → SynthSeg).

### Patch Changes

- Updated dependencies [bd5f3a8]
  - @neurodesk/webapp-components@0.22.0
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- 39604c4: Changing a step's binding now drops a workflow input once no step reads it, so an exported workflow never declares an input that `neuroflow-mcp` would require and nothing uses. When the tool catalog cannot load, the automation `validate` operation fails with the load error and the drop zone accepts no workflow. Exported workflows need NeuroFlow 0.2.0 or later.
