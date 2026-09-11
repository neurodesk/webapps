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
| Easy MP2RAGE | Task selection sits beside input. Sequence parameters and the example image start collapsed. Parameter families follow the selected task, and denoising hides sequence parameters. About contains the full methods and credits. Tutorial and Reset sit beside input. Validation reveals its fields and log; the tutorial opens the panel containing its target. |
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
- Easy MP2RAGE parameter-family selection, tutorial targets, NIfTI denoising, downloads, and About.
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
