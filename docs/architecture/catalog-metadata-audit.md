# Catalog metadata audit

Audit of the landing-page metadata in `registry/apps.yml` (title, description,
categories, keywords) against what each app does, 2026-10-18, updated for the
38-app catalog. Facts come from each app's `automation.json`, `examples.json`,
README, `registry/app-information.yml` and `registry/standalone.json`.

## How the catalog used the metadata

- A card showed the category of its section, the title, the description and the
  first 3 keywords as tags.
- Search matched the title, description, category titles and all keywords.
- `description` is also the app bar subtitle in every app (`site/app-shell.js`),
  part of the Cite reference, and the About text when an app has no About
  paragraphs. The registry limits it to 60 characters, because the app bar
  hides a longer one at 1440 px.

## Findings

### Tags

- Only the first 3 keywords were visible. On many cards one of them was `MRI`.
- Several first-3 sets repeated the title or named tools, not tasks:
  SYNcro `SYNcro, SynthSR, MindGrab`, SynthSeg `SynthSeg, MRI, CT`,
  TopoFit `TopoFit, cortical surface, MRI`.
- Case was inconsistent: Brain2Print had `mri` and `3d-printing`.
- No card told a visitor what they most often need to choose an app: the input
  format, the anatomy, whether the app needs WebGPU, and whether a command line
  exists.

### Descriptions

- The 60-character pass removed "in the browser", but many descriptions still
  name a method or an output, not the task: "Automated MRI segmentation and
  image-quality metrics" (BrowserQC), "Carotid artery flow curves from
  phase-contrast MRI", "Brain extraction with BET, MindGrab or SynthStrip".
- MuscleMap still said "Browser-based", and fastprep "in the browser".
- CALMaR only expanded its acronym; it did not say that it maps stroke lesions.

### Categories

- Normalization had 1 app and Surfaces 2.
- Brain2Print and TopoFit were under Visualization; they reconstruct meshes and
  surfaces.
- LCModel (spectroscopy) was under Quantitative Imaging.
- Disconnectome and CALMaR (lesion-to-network mapping) were under
  Segmentation & Analysis with muscle, vessel and prostate segmentation.
- SynthSR and NeSVoR (image synthesis and reconstruction) were under Data
  Preparation & Privacy with defacing.

### Titles (not changed in this pass)

Titles reach each app's `index.html`, `automation.json` and shell code, so
changing them is per-app work. Proposals:

| App | Current | Proposed | Reason |
| --- | --- | --- | --- |
| brain-extraction | Brain extraction | Brain Extraction | Title Case like most titles |
| white-matter-lesions | White matter lesions | White Matter Lesions | Same |
| easy-mp2rage | Easy MP2RAGE T1 Map | Easy MP2RAGE | The app also makes B1 maps and denoised UNI images |
| mri2vid | MRI2VID | renamed from `dicom2vid` (#387) | The id now matches the title; the app also accepts CT |

Lower-case upstream names (dicompare, dwi2trx, elastix, fastprep) stay as their
projects write them.

### Source discrepancies found during the audit

These findings record the audit and subsequent integration fixes.

1. **WebGPU gates that NiiVue does not need.** Deface, BrowserQC, EdgeReg,
   Greedy, ANTs and Brain2Print refuse to start without `navigator.gpu`, but
   every pinned NiiVue 1.0 rc falls back to WebGL2 and MindGrab's `auto` falls
   back to WebGL2 or the CPU. Resolved by #384 and the coordinated integration:
   the catalog now shows "WebGPU optional" for Deface, BrowserQC, Brain2Print,
   Greedy and ANTs, and "No GPU needed" for EdgeReg.
2. **CALMaR "Reporting".** The title promises reporting; the app downloads CSV
   and NIfTI only, with no report document.
3. **SynthSR input formats.** The README says NIfTI only; `automation.json` and
   the app accept DICOM through dcm2niix.
4. **FireANTs without WebGPU.** The README says CPU registration and viewing
   work without WebGPU; the NiiVue fallback makes this true, but it has no
   test.
5. **Spinal Cord Toolbox task count.** The model manifest lists 21 tasks; 5 run
   in the browser.
6. **NeSVoR default mode.** The README leads with the remote GPU server; the
   app defaults to experimental browser WebGPU.
7. **SeedSeg** is the only app without a built-in example (`examples.json` is
   empty), against the example contract in the interface standard.
8. **Stale description copies.** `apps/easy-mp2rage/package.json`,
   `apps/surfannotate/index.html` (meta) and `apps/calmar/web/index.html` hold
   old copies of the catalog description.

## Proposal

### Description rule

One sentence, at most 60 characters (the registry limit), task first and
method second, plain words for a mixed audience of researchers, clinicians and
students. Name the input (contrast or format) when it limits use. Do not say
"in the browser" or "locally": the page says it once for every app. Where the
60-character text already named the task (Greedy, ANTs, FireANTs, elastix,
NeSVoR, SynthSR, MRI2VID, DICOM View, White matter lesions) it is kept.

### Categories

Ten categories, each with at least two apps. Ids changed only where the meaning
changed.

| Id | Title | Apps (secondary in italics) |
| --- | --- | --- |
| segmentation | Segmentation | MuscleMap, VesselBoost, Spinal Cord Toolbox, SeedSeg, SynthSeg, Brain extraction, White matter lesions |
| lesion-mapping | Lesion Mapping | CALMaR, *SYNcro*, Disconnectome, *White matter lesions* |
| quantitative-mri | Quantitative MRI & Spectroscopy | QSMbly, Easy MP2RAGE T1 Map, Carotid Flow, LCModel |
| diffusion-imaging | Diffusion & Tractography | dwi2trx, *Disconnectome*, NODDI, *Degibbs*, *N4*, *Dwidenoise* |
| registration | Registration & Normalization | SYNcro, EdgeReg, Greedy, ANTs, FireANTs, elastix |
| reconstruction | Reconstruction & Synthesis | SynthSR, NeSVoR |
| surfaces | Surfaces & Meshes | SurfAnnotate, Brain2Print, TopoFit |
| image-processing | Processing & Privacy | Deface, NiiMath, *Brain extraction*, fastprep, Degibbs, N4, DICOM to BIDS, Dwidenoise |
| visualization | Visualization | MRI2VID, *SurfAnnotate*, ZARRo, DICOM View |
| quality-control | Quality Control | dicompare, BrowserQC, *DICOM View* |

### Facets

Typed fields in `registry/apps.yml`, validated in `scripts/lib/apps-registry.mjs`
and shown as card badges and search terms:

| Field | Values | Badge |
| --- | --- | --- |
| `anatomy` | brain, spinal-cord, whole-body, prostate, neck, any | "Brain", "Spinal cord", … ("any" shows nothing) |
| `modalities` | mri, ct, mrs, microscopy, surface | "MRI", "CT", "MRS", … |
| `inputs` | dicom, nifti, mgz, ome-zarr, tiff, itk, gifti, freesurfer, mesh, mrs-raw | "DICOM", "NIfTI", … |
| `hardware` | cpu, webgpu-optional, webgpu-required | "No GPU needed", "WebGPU optional", "Needs WebGPU" |
| `remote_compute` | true (optional) | "Compute server option" (Spinal Cord Toolbox, NeSVoR) |

The **Command line** badge comes from `registry/standalone.json` (a `cli`
download), not from a new field, so it cannot drift. An "Example data" badge was
considered and dropped: 37 of 38 apps have one, so it would not help a visitor
choose.

`hardware` records the supported startup paths, including the resolved gates in finding 1.

Keywords stay, for search only: they are no longer shown, so their order no
longer matters. They now carry plain-language synonyms (skull stripping, stroke,
fetal, 3D printing, functional MRI) and no longer repeat the title.

### Per-app result

| App | Description | Anatomy | Modality | Inputs | Hardware | CLI |
| --- | --- | --- | --- | --- | --- | --- |
| MuscleMap | Segment muscles in MRI or CT and measure fat. | Whole body | MRI, CT | DICOM, NIfTI | WebGPU optional | yes |
| VesselBoost | Segment brain blood vessels in TOF or SWI images. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| Spinal Cord Toolbox | Segment and measure the spinal cord, lesions and vertebrae. | Spinal cord | MRI, CT | DICOM, NIfTI | WebGPU optional, compute server | yes |
| CALMaR | Map a stroke lesion to the brain networks it affects. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| QSMbly | Make QSM, R2* and SWI maps from multi-echo MRI. | Brain | MRI | DICOM, NIfTI | No GPU needed | yes |
| SeedSeg | Find gold fiducial markers in prostate MRI. | Prostate | MRI | DICOM, NIfTI | No GPU needed | yes |
| dicompare | Check DICOM acquisitions against a reference protocol. | Any anatomy | MRI | DICOM | No GPU needed | yes |
| Deface | Remove facial features from head MRI for sharing. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| Easy MP2RAGE T1 Map | Make B1-corrected T1 maps and denoised MP2RAGE images. | Brain | MRI | DICOM, NIfTI | No GPU needed | yes |
| NiiMath | Apply image maths, filters and meshing with niimath. | Any anatomy | MRI, CT | DICOM, NIfTI | No GPU needed | yes |
| MRI2VID | Convert DICOM, NIfTI or MGZ volumes into scrolling videos. | Any anatomy | MRI, CT | DICOM, NIfTI, MGZ | No GPU needed | yes |
| BrowserQC | Measure MRIQC-style quality metrics on T1-weighted MRI. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| SurfAnnotate | View cortical surfaces and draw regions of interest. | Brain | Surfaces | FreeSurfer, GIfTI, STL/OBJ/PLY | No GPU needed | – |
| ZARRo | Stream, view and measure large OME-Zarr images. | Any anatomy | Microscopy | OME-Zarr | No GPU needed | – |
| SynthSR | Synthesize a 1 mm T1-weighted image from brain MRI or CT. | Brain | MRI, CT | DICOM, NIfTI | WebGPU optional | yes |
| SynthSeg | Label brain structures in MRI or CT of any contrast. | Brain | MRI, CT | DICOM, NIfTI | Needs WebGPU | yes |
| SYNcro | Normalize brain scans and lesion masks to MNI space. | Brain | MRI, CT | DICOM, NIfTI | WebGPU optional | yes |
| dwi2trx | Fit diffusion tensors and track white-matter streamlines. | Brain | MRI | DICOM, NIfTI | Needs WebGPU | yes |
| EdgeReg | Align two brain images with fast affine registration. | Brain | MRI | DICOM, NIfTI | No GPU needed | yes |
| Disconnectome | Find which white-matter bundles a lesion disconnects. | Brain | MRI | DICOM, NIfTI | No GPU needed | yes |
| Greedy | Affine and deformable MRI registration with Greedy. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| ANTs | Affine and SyN diffeomorphic MRI registration with ANTs. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| Brain2Print | Make a 3D-printable brain model from an MRI scan. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| TopoFit | Reconstruct white and pial cortical surfaces from T1 MRI. | Brain | MRI | DICOM, NIfTI | No GPU needed | yes |
| FireANTs | Register brain images with CPU or WebGPU FireANTs. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| Brain extraction | Remove the skull with BET, MindGrab or SynthStrip. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| Carotid Flow | Measure carotid blood flow from phase-contrast MRI. | Neck | MRI | DICOM, NIfTI | No GPU needed | yes |
| LCModel | Measure brain metabolites from single-voxel MRS. | Brain | MRS | DICOM, NIfTI, Vendor MRS | No GPU needed | yes |
| White matter lesions | Segment white matter lesions on FLAIR with FLAMeS. | Brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| NeSVoR | Reconstruct a 3D fetal or neonatal brain from 2D MRI stacks. | Brain | MRI | DICOM, NIfTI | WebGPU optional, compute server | – |
| elastix | Rigid, affine and B-spline registration with elastix. | Any anatomy | MRI, CT, Microscopy | DICOM, NIfTI, OME-Zarr, TIFF, NRRD/MHA/MINC | No GPU needed | yes |
| DICOM View | Browse DICOM series, images, headers and protocol. | Any anatomy | MRI, CT | DICOM | No GPU needed | – |
| fastprep | Preprocess fMRI BOLD runs in the style of fMRIPrep. | Brain | MRI | NIfTI | WebGPU optional | – |
| NODDI | Fit diffusion tensor and NODDI maps from diffusion MRI. | Brain | MRI | DICOM, NIfTI | WebGPU optional | – |
| Degibbs | Remove Gibbs ringing from MRI scans. | Any anatomy | MRI | DICOM, NIfTI | No GPU needed | – |
| N4 | Correct intensity bias fields in MRI scans. | Any anatomy | MRI | DICOM, NIfTI | WebGPU optional | – |
| DICOM to BIDS | Convert scanner DICOM exports to anatomical and DWI BIDS. | Any anatomy | MRI | DICOM | No GPU needed | – |
| Dwidenoise | Denoise diffusion MRI with Patch2Self. | Brain | MRI | DICOM, NIfTI | No GPU needed | – |

## Follow-up

- 29 of 38 cards read "DICOM, NIfTI". If that row reads as noise on the live
  site, show only formats beyond that pair and say once, above the catalog,
  that apps accept DICOM and NIfTI unless a card says otherwise.
- Filter chips for the hardware and command-line facets, once the badges have
  been reviewed on the live site.
- Per-app `<meta name="description">` and JSON-LD `SoftwareApplication` entries
  generated from the same fields.
- Unresolved findings 2–8 above.
