# @neurodesk/webapp-components

## 0.4.5

### Patch Changes

- 39a9ea5: New app: Carotid Flow finds both carotid arteries in a gated phase-contrast neck slice and plots their flow over the cardiac cycle, with peak, time average and pulsatility index, a CSV of the curves and a NIfTI of the carotid labels. Signed velocity gives flow in ml/min: arteries are told from veins by direction and pulse, and each carotid is the artery carrying most flow on its side; on the open example (PCMCalculator's test data) the right carotid is within 6 % of PCMCalculator's manual measurement. Unsigned speed images go through a port of the requesting lab's MATLAB script, which names left and right from the image orientation where the script called the patient's right carotid the left one. Shared file I/O gains `readNiftiFrames`, which reads every frame of a 4D NIfTI.

## 0.4.4

### Patch Changes

- 4959500: Add an individual 3D View action for cortical surfaces, hide the MRI volume in surface scenes, and draw thin surface boundaries on the 2D slices. Keep visibility checkboxes for comparisons and STL export.

## 0.4.3

### Patch Changes

- Replace TopoFit's bare NiiVue viewer with FreeBrowse 2.5.0-next.1 and its matching NiiVue rc.13 event model. Keep mid-surface overlays, detected-patch RAS measurements, and STL exports synchronized with FreeBrowse's volume and surface controls. Add shared embedding styles for the existing application bar, theme, and phone layout.

## 0.4.2

### Patch Changes

- Style dialog inputs with the shared field controls and give them 44 px touch targets and 16 px text on phones. Verify TopoFit's STL settings at desktop and phone widths.

## 0.4.1

### Patch Changes

- Expose the example selector's resolved upload scope for interface auditing, complete the disabled-drop predicate type, preserve block layout before console and toolbar upgrades, and rename the drop helper module to match its API.

## 0.4.0

### Minor Changes

- Replace shared UI builders with light-DOM custom elements for consoles, file fields, result lists, viewer toolbars and example selectors. Migrate app callers, isolate control IDs and upload scopes, and preserve state while cleaning up listeners and cancelled downloads across component removal.

Result lists now render a visibility checkbox whenever a result has a boolean `visible` field, including when no factory `onVisibilityChange` callback is supplied. Handle `nd-visibility-change` or provide that callback to apply the change; otherwise omit `visible` to retain a View button. This supports declarative event listeners and differs from the previous callback-gated behavior.

## 0.3.1

### Patch Changes

- Move Easy MP2RAGE to the shared imaging workspace with an input and processing sidebar, persistent three-plane viewer, View/Download result rows, collapsed technical console and visible status. Keep BIDS sessions in the same viewer and restore reachable controls on desktop and phones. Add browser coverage for scrolling, the synthetic T1/B1 example, downloads and BIDS processing.

  Add shared raster-panel sizing, wrapping slice controls and scrollable file tables. Preserve primary-action and selected-button styling inside the sidebar.

## 0.3.0

### Minor Changes

- Standardize example selection across the app catalog with complete scientific input bundles, shared cancellation and retry, and explicit processing. Add missing examples, curate existing datasets, fix QSMbly retry and TopoFit cancellation, and require example manifests and browser coverage for every app and the generator.

## 0.2.2

### Patch Changes

- Add OpenRecon scanner-console package links to Standalone for MuscleMap, QSMbly via QSMxT, Spinal Cord Toolbox, SynthSeg, TopoFit and VesselBoost. Link to Siemens teamplay C2P for official packages and neurodesk/openrecon for builds.

## 0.2.1

### Patch Changes

- Offer desktop and HPC downloads both with and without models. Put official Neurodesk Docker and Apptainer downloads first, simplify installation details, and separate standalone choices into clear sections.

## 0.2.0

### Minor Changes

- Add a shared Standalone action and offline desktop packaging with included, checksum-verified models and runtime dependencies. Remove the lightNIIng topbar link while retaining its About statement.

## 0.1.5

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.
- 4add8da: Let TopoFit users show multiple cortical meshes together and reveal them inside the 3D volume with an adjustable X-ray control.

## 0.1.4

### Patch Changes

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

## 0.1.3

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
