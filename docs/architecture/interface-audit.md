# Interface consistency audit

All 16 registered apps were reviewed on 9 September 2026, starting from `e6ef75e`. The identified interface changes are implemented. Production workspaces were checked at 1440 × 900 and 390 × 844, with additional narrow-phone, landscape, and tablet checks.

## Changes by app

| App | Implemented behavior |
| --- | --- |
| QSMbly | Native buttons replace mouse-only headings, including Refine Mask. Accordion grouping and workflow-driven expansion remain. The technical log starts collapsed and opens for errors or the mobile Console tab. |
| MuscleMap | Inference tuning and the technical log start collapsed. Section buttons support keyboard activation and retain inputs. Shared navigation replaces repeated footer links. |
| VesselBoost | Optional downsampling, bias correction, denoising, and brain extraction start collapsed. Segmentation remains available. Section controls and the technical log use the shared accessible binding. Footer navigation is consolidated. |
| Spinal Cord Toolbox | Task selection and Run remain available. Advanced segmentation settings and later processing start collapsed. Disabled steps are inert. Threshold values survive closing and reopening after import. Footer navigation is consolidated. |
| CALMaR | Empty Results start collapsed, open after analysis, and close on reset. Section buttons support keyboard activation. Existing advanced settings and detailed log remain collapsible. Footer navigation is consolidated. |
| SeedSeg | Compact inference defaults remain. Native section buttons replace mouse-only headings, the technical log starts collapsed, and footer navigation is consolidated. |
| dicompare | Runtime status occupies normal document space instead of covering the phone workspace. Loading details start collapsed. Workflow cards expose expanded state, and acquisition titles are keyboard-accessible buttons with truncated long names. |
| Deface | Shared input picker, workflow sections, information dialogs and a console below the viewer. Output opens when processing completes. App CSS is empty. |
| Easy MP2RAGE | Shared imaging workspace with Input, Processing and Output in the sidebar, persistent three-plane viewer, slice controls, collapsed histogram and technical console, and status footer. Sequence parameters, output settings and workflow help start closed. BIDS sessions use the same viewer. Results use shared View/Download rows; About and Privacy use the shared dialog. Browser coverage exercises ordinary scrolling, the pinned example, T1/B1 maps, downloads and desktop/phone layouts. |
| NiiMath | Input and Processing use native disclosures. Overlay appearance, Output, and Example images start closed. Processing reveals Output on success. The shared About action retains the scientific documentation handler. |
| MRI2VID / dicom2vid | Compact input instructions keep file and folder pickers distinct. Extended credits and privacy text live in dialogs connected to the shared bar. Dialogs scroll and close on phones. |
| BrowserQC | Shared workflow sections, scan picker, information dialogs and console below the viewer. Results open on completion or QC failure. Only scientific metric styles remain. |
| SurfAnnotate | Surfaces stay open. Overlay, annotation, ROI, and export controls start collapsed. The first surface opens overlay and annotation controls; ROI creation or filling reveals export. Panels use shared spacing and full sidebar width. |
| ZARRo | Source selection stays open. Navigate, Display, and Measure & Export start collapsed. The first loaded volume opens Navigate and Display. Advanced settings remain collapsed, and touch measurement and export remain available. |
| SynthSR | Rebuilt on the shared design-system vocabulary (10 September 2026): three sidebar sections (Input image, Synthesis, Output), the shared `.nd-file` picker with a visible example selector, processing settings and model weights nested under one collapsed disclosure, one primary action, results as View/Download rows, shared layout tabs above the viewer, a collapsed technical log below it, the shared status bar with a × cancel, and one information dialog for About, Cite, Privacy and Standalone. The marketing empty state, eyebrow labels, result badge and all 44 hardcoded colours are gone; the app stylesheet is empty. |
| SYNcro | Rebuilt on the shared design-system vocabulary (10 September 2026): the bare file inputs became `.nd-file` pickers, section titles use the shared compact style, the primary action is visibly primary, results are View/Download rows in the sidebar instead of a toolbar select, layout tabs and the overlay opacity share the toolbar, help icons use the shared tooltip binding, and About, Cite, Privacy and Standalone open one shared dialog. The duplicated console, tooltip, dialog and citation CSS was deleted; the app stylesheet is empty. |

## Rules and enforcement

About and Cite were reviewed across all 16 apps on 10 September 2026: no app stated who built the web application, none mentioned the lightNIIng ecosystem (lightniing.org), none cited the Neurodesk platform paper, and seven had no method citations at all. `registry/app-information.yml` now holds each app's packages, builder credits and one citation per implemented method (nnU-Net, SCIsegV2, TotalSpineSeg and PAM50 for SCT; N4, non-local means and bilateral filtering for VesselBoost; DeepISLES, Neurosynth, the MNI152NLin2009cAsym template and the Nilearn development-fMRI dataset for CALMaR; MRIQC and Brainchop for BrowserQC; niimath, MindGrab and the ICBM template for Deface; and so on). The shared shell renders Cite from it for every app and appends the shared About block to every app dialog. `test/app-information.test.mjs` enforces completeness.

[The design system](design-system.md) records why the catalog drifted and defines the one vocabulary every `imaging-workspace` app is built from. `test/design-system.test.mjs` enforces it: vocabulary apps have token-only app CSS within a 40-line budget, no restyled shared selectors, no free headings, inline styles or app-owned dialogs, and use the shared console, toolbar and dialog builders; legacy shell apps (NiiMath, Deface, BrowserQC, SurfAnnotate, ZARRo) are ratcheted so their colour literals and CSS size can only fall.

Scan fields now accept NIfTI and DICOM through the same multi-file picker, including extensionless DICOM instances. SynthSR converts locally, provides a series selector, and supports cancellation and retry. NiiMath, Deface, and BrowserQC share the bundled image importer. Easy MP2RAGE routes its main picker through its existing DICOM parser and rejects mixed series instead of assembling unrelated scans. CALMaR's structural, lesion, DWI, ADC, and manual-mask fields and QSMbly's mask field support conversion. SeedSeg and QSMbly no longer filter out DICOM filename variants.

Static apps retain a checksum-verified DICOM runtime inside each app's service-worker scope. GitHub Pages does not supply isolation headers for workers outside that scope. The DICOM browser suite serves the site without isolation headers and waits for the service-worker reload, reproducing the deployed environment instead of masking this requirement with local-server headers.

Every file input declares its scientific purpose. Scan fields are checked by `audit:interfaces` for multi-file selection and unrestricted filenames. Surface and per-vertex overlays in SurfAnnotate, acquisition protocols in dicompare, and OME-Zarr datasets in ZARRo retain their specialized inputs. Model weights, BIDS directories, schemas, and gradient tables remain separate input types.

Root `AGENTS.md` requires [the interface standard](interface-standard.md) for existing and new apps. The standard defines navigation ownership, disclosure defaults, state preservation, touch controls, and completion checks.

The shared shell hides registered duplicate information triggers while retaining their handlers and standalone fallbacks. It provides consistent About, Cite and Privacy actions, plus an optional Standalone action for apps with a command-line distribution. Shared fallback dialogs are centered; rich app-owned dialogs remain responsible for matching the same QSMbly modal geometry. Shared native disclosures and `bindSectionDisclosures` preserve control identity, synchronize workflow expansion, and remove closed content from keyboard navigation. The canonical new-app template uses these components and a collapsed technical log; documentation links to that executable source instead of maintaining a copy.

`pnpm audit:interfaces` derives coverage from the canonical app registry. Every app must have one unclipped shared bar, no exact duplicate navigation actions, working disclosure keyboard controls, and zero mouse-only heading handlers. There are no per-app exceptions. CI also runs mobile and representative data-workflow checks and retains desktop and phone screenshots plus JSON.

## Verification

Release verification includes SynthSR and SYNcro. The catalog audit passes all 32 desktop and phone cases across 16 apps with zero legacy heading handlers. Repository and shared-component tests cover the registry, template, shell, native disclosures, and class-driven disclosure state. Mobile checks cover narrow phones, tablets, landscape layouts, navigation, dialogs, and imaging interaction.

Data workflows exercised for this change include:

- `pnpm test:image-uploads` imports a generated four-slice DICOM series through the main scan picker in SynthSR, NiiMath, CALMaR, VesselBoost, SCT, MuscleMap, SeedSeg, QSMbly, Easy MP2RAGE, and MRI2VID. It also checks CALMaR DWI/ADC inputs, QSMbly mask conversion, and Easy MP2RAGE mixed-series rejection. CI runs this suite alongside the interface audit.
- SynthSR's browser suite checks extensionless and `.IMA` DICOM, multiple converted series, return to NIfTI, invalid-input state preservation, cancellation, and retry.

- SynthSR compact input bounds, shared examples, failed-download state preservation, and real `chris_t1` loading at 188 × 256 × 190 voxels. All 19 shared example URLs returned HTTP 200.
- Easy MP2RAGE parameter-family selection, parameter retention, NIfTI denoising, downloads, and About.
- MRI2VID NIfTI import and the About and Privacy dialogs.
- SCT NIfTI import and threshold preservation across disclosure changes.
- SurfAnnotate surface loading, curvature overlays, ROI filling, and exported labels using cortical fixtures, plus initial panel states using a small OBJ file.
- ZARRo volume loading, measurement, contrast, share links, and large NIfTI export progress and cancellation.
- dicompare keyboard workflow cards and runtime status positioning.
- NiiMath processing and export of a generated 16 × 16 × 16 NIfTI. Every voxel changed from 20 to 40 after `-mul 2`, and the command survived keyboard collapse and reopen.

Deface and BrowserQC passed their unsupported-WebGPU and About workflows in the headless browser. Their GPU processing was not exercised. This review does not validate every scientific pipeline. QSMbly's external ecosystem navigation is stubbed in the local smoke server and is outside this audit.

After a fresh production build, reproduce the screenshots and measurements with `INTERFACE_ARTIFACTS="$TMPDIR/interface-audit" pnpm audit:interfaces`. Run `pnpm test:interface-workflows` for the small local-data workflows and `pnpm test:mobile` for layout and touch checks. CI retains the screenshots and measurements as the `interface-audit` artifact.

The September 10 pull-request review adds dwi2trx and SynthSeg on the shared vocabulary. dwi2trx retains vector-generator settings across dialog closure and exports a Siemens scheme in its browser test. SynthSeg tests cancellation ownership and keeps unabortable local parsing busy. Full GPU inference remains a separate hardware validation gate.

## Brain2Print review, 11 September 2026

Brain2Print uses the shared folder picker, viewer toolbar, console and information
shell, with one primary action. Loading a replacement invalidates the previous
segmentation and mesh, and selecting an image cancels the startup example download.
The review covers delayed downloads, failed replacements, DICOM conversion and
retained mesh settings. Desktop and phone layouts were inspected; the 19-app
interface, mobile and shared workflow suites pass. Full MindGrab-to-STL tests
remain hardware-GPU gates and are skipped on the software adapter.

## EdgeReg and Greedy review, 11 September 2026

Both registration apps use the shared download helper. Greedy exposes native
command-line instructions through the shared Standalone action. Method changes
hold the busy state while clearing results, and cancellation closes only the
worker belonging to that run. Real DICOM checks cover extensionless slices,
multiple converted series and selecting the second series in both apps. Browser
checks also exercise registration, downloaded NIfTI results and shell dialogs.

## TopoFit surface analysis and shared logging, 14 September 2026

TopoFit keeps anatomical surfaces in 3-Plane view and loads registration files
through NiiVue's FreeSurfer reader. Surface analysis is optional and collapsed.
Patch count, radius, hemisphere, quality thresholds and native-grid ROI settings
survive disclosure changes. Invalid settings reopen their section. The sidebar
omits the repeated warning and single-option contrast selector.

The shared console suppresses consecutive identical messages without suppressing
changed levels or later workflow stages. QSMbly uses that console; CALMaR applies
the same rule while retaining its level and source fields. Model downloads emit
changed percentages. The shared section grid lets long result labels shrink so
View and Download remain inside the sidebar.

TopoFit's 12 browser checks include the six surface products, parameter transfer,
invalid inputs, computed normals downloads, and the real full-resolution reference
surfaces with six selected patches. Desktop and phone screenshots were reviewed
in dark and light themes. Real patch QC opens at the first selected patch; a patch
row centers the viewer on its measured RAS location. The separate scientific
comparison is recorded in `packages/topofit/validation/surface-analysis.md`.

The fresh 22-app production build passed `pnpm audit:interfaces`,
`pnpm test:mobile`, `pnpm test:interface-workflows` and `pnpm test:image-uploads`.

## TopoFit output cleanup, 14 September 2026

The browser output list omits both registration spheres. Patch rows and the
viewer caption use labels such as "Left flat patch 1" and "Right flat patch 3".
Meshes are clipped to a 1 mm band around each slice. A rendered-pixel regression
check confirms a selected patch is visible on its own slice and disappears after
scrolling away. The processing manifest, QC header and About content no longer
include motion-clearance or prescription wording.

All 13 TopoFit browser checks passed, including the full-resolution surface replay.
Desktop and phone screenshots were reviewed in dark and light themes.
The fresh 24-app production build passed `pnpm audit:interfaces`,
`pnpm test:mobile` and `pnpm test:interface-workflows`.

## TopoFit analysis after reconstruction, 14 September 2026

A secondary **Run surface analysis** action becomes available after reconstruction.
It reuses the current scan's retained surface geometry in a separate worker.
Normals, patch settings and native-grid ROI inputs remain in the existing
collapsible analysis section. A successful run replaces analysis outputs;
cancellation or failure retains the previous results. Selecting another scan
clears the reconstruction and disables the action.

Selected flat patches use yellow, two-sided slice intersections. The default
shaded mesh could blend into the scan or be hidden by depth testing and back-face
culling after slice clipping was enabled. The patch keeps the 1 mm clipping band;
its highlight belongs only to slices that intersect it. Browser checks count
highlighted pixels on synthetic and real cortical patches and verify that the
highlight disappears when scrolling away.

All 14 production browser checks passed, including a new right-hemisphere patch
search on full-resolution reference surfaces, repeated normals analysis without
ONNX requests, cancellation, atlas failure recovery and scan replacement.
Desktop and phone screenshots were reviewed in dark and light themes.
The fresh 24-app build passed `pnpm audit:interfaces`, `pnpm test:mobile`
and `pnpm test:interface-workflows`.

## Standalone rollout, 15 September 2026

All 24 current apps use the shared Standalone control. The lightNIIng topbar link is removed; its ecosystem statement remains in About. One registry supplies released binary URLs, checksums and available upstream Neurodesk container options. The complete offline suite supplies apps without a separate native CLI, including VesselBoost. Source-build instructions are not shown in the shared dialog.

Production checks passed at desktop and phone sizes. The phone suite now opens Standalone at 320-pixel portrait and 844-pixel landscape widths. See [standalone validation](standalone-validation.md) for real offline workflows and release gates.

### Standalone download choices

All 24 apps share the simplified download dialog. Neurodesk Docker and official Apptainer downloads come first, then the webapp suite archive for each platform, then the optional model pack for offline use. Bordered shared sections separate the choices. Hashes and upstream preparation boilerplate are absent; multipart extraction commands are collapsed. TopoFit's Docker link is labeled as a candidate build because that is the only published Docker tag; its official Apptainer image is listed separately.

MuscleMap, QSMbly, Spinal Cord Toolbox, SynthSeg, TopoFit and VesselBoost also show an OpenRecon section between the Neurodesk containers and webapp downloads. It links to the official Siemens teamplay C2P exchange, the OpenRecon build repository and the app's recipe. QSMbly maps to the QSMxT container. Availability is explicit data in `registry/standalone.json`; apps without a registered scanner package omit this section. The deployed Standalone smoke test checks both links and visibility across the catalog.


## Universal examples migration (2026-09-16)

All 25 apps now declare examples and render the shared Example selector in their input workflow. Bundles preserve companion inputs for QSM, diffusion, registration, lesion review, and MP2RAGE. Examples no longer load or process automatically. The manifest validator has no legacy exemption. The template and interface audit enforce the same control for future apps.

The shared lifecycle replaces QSMbly's disabled-after-failure button and TopoFit's uncancellable fetch. SynthSR now offers curated FLAIR, T1, T2 and head CT examples. SYNcro's tutorial bundles and TopoFit's scan are registered in the offline inventories.

SeedSeg's synthetic phantom is generated by a source-only export script and served from the same pinned dataset as other examples. It demonstrates software operation only. Real seed42 inference on it produced no detections at the default threshold. It is not a positive marker-detection or accuracy example. A representative, approved prostate scan with implanted markers remains desirable.

Verification results and remaining environment/data-source constraints are recorded in `docs/architecture/examples-verification.md`.
