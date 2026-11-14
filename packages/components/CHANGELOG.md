# @neurodesk/webapp-components

## 0.28.0

### Minor Changes

- 3ae3eb4: CALMaR preserves the drawing and Undo history of an open lesion-mask review when a superseded image, seed or viewer stack finishes loading. Superseded loads are decoded away from NiiVue and refused before insertion, so they cannot replace the review's image or drawing. Late failures also leave replacement inputs, layers and results untouched.

  `ViewerController.loadBaseVolume`, `loadOverlay` and `loadVolumeStack` accept `assertCurrent` for two-phase loading. The controller checks ownership immediately before synchronously inserting and recording decoded images, ending with `onCommit`. Each decode owns its object URL. Failed or superseded stacks release decoded members without waiting for pending members. `replaceStage` replaces an overlay during the commit. Calls without `assertCurrent` retain their previous behavior.

  Start over and Clear results release the viewer queue immediately, even when an older decode never settles. A partial clear reloads the retained input and preserves layer visibility. Repeated layer loads and threshold previews keep one tracked overlay per stage.

  An open mask review keeps its native image and grid. Registration QC, subject-atlas and blend controls stay disabled until review ends; prealignment is refused unless confirmation requests it. Deferred threshold previews resume when the review ends. A failed review releases its base lock and can be retried, including failures during seed preparation.

  Review preparation and confirmation now run through one ownership gate before every asynchronous continuation, including failure handlers. Replaced reviews cannot enable drawing tools, publish wand restrictions, launch preparation work, save an old drawing or open a review on a replacement subject. The same owner follows nested prealignment, segmentation, viewer preparation and worker commands. Replacing a review cancels its preparation worker and settles pending waits.

  Worker waits are released on preparation failure and cancellation, including before dispatch and during initialization. Commands recheck ownership after initialization, and initialization waits cannot borrow readiness from a replacement worker. Replacing unfinished review preparation releases its base and render locks immediately. Cleanup removes only its own waits and preserves a still-current shared worker. QC, layer, patient-atlas and automation preparation continuations keep their original owner through rendering.

  Checked viewer commits release uninserted decoded images and unused object URLs even when synchronous NiiVue insertion or configuration throws.

  Replacing unfinished review preparation also detaches its viewer queue, so a drawing decode that never settles cannot block a replacement review of the same subject.

  Cancellation releases unfinished review locks and prevents its late drawing from opening. Superseded result computations cannot publish after cancellation or overwrite replacement download progress, and late evidence metadata cannot undo a newer selection. Removed or unsuccessfully inserted checked viewer images are also released from NiiVue's URL map.

- 3f0eab6: Loading the RELION tutorial example in Cryo-EM now shows the next step only in the status bar (connect a server with the movies, choose a project or import) instead of only "…loaded.". An example selector's `onLoad` can replace its loaded message through the new `setMessage` context call and hide its inline copy when routing it to the footer.

  Refresh the footer when the server disconnects or the selected project changes so tutorial readiness cannot outlive its prerequisites.

  Invalidate late project, tutorial and job responses when their context changes. Show submission progress immediately, keep Run disabled while opening a project and prevent example loading from replacing a running job's status.

  Derive idle guidance from the current connection, project, processing step and movie selection. Restore tutorial readiness when its selection is restored, cancel superseded example imports, and ignore project mutations that finish after leaving their context. Render footer state in one place through ProgressManager and keep its messages within 90 characters.

  Ignore superseded output views and errors after downloading, decoding or initializing the viewer, so detached output work cannot replace the current view or footer.

  Ignore a completed run's delayed project snapshots and refresh errors once a newer run starts.

  Order overlapping requests within the same project and run through one currency guard, including errors. Preserve a newer job selection after deletion, invalidate deleted-job views and superseded downloads, and restore the committed image when NiiVue finishes a detached decode. Handle refresh failures separately from rejected submissions and observe follower failures immediately.

  Invalidate a deleted job's output work even when the user left and reselected that job while its deletion was pending. Reconcile successful deletions after newer mutations or runs without overwriting their guidance.

## 0.27.0

### Minor Changes

- d643e8d: Add Deconvolution, a microscopy app that sharpens one widefield or confocal stack in the browser with Richardson-Lucy, optionally regularised by total variation (Dey et al. 2006), using a theoretical Gibson-Lanni PSF for the objective or a measured bead stack. It reads TIFF, OME-TIFF, ImageJ TIFF and NIfTI with their voxel size, and downloads the deconvolved stack as calibrated TIFF and NIfTI with the PSF used. `@neurodesk/deconvolution` holds the Rust core as committed WebAssembly: its Richardson-Lucy equals scikit-image's to 2e-14 and its PSF equals adaptive quadrature of the Gibson-Lanni integral to 2e-7 and psfmodels within 8e-5. The shared TIFF reader (`@neurodesk/webapp-components/file-io/tiff`) now reads an ImageJ 8-bit palette stack as intensity, the grey sample of grey + alpha pages and inverted WhiteIsZero integers, skips reduced-resolution pages, follows OME TiffData plane mapping (refusing planes in other files, and taking an interleaved RGB or grey + alpha channel, which OME counts as several in SizeC, as one page per plane), leaves a plain TIFF's page axis unknown rather than calling its pages time points, and `imagejDescription` describes a calibrated z stack.

  Refuse a NIfTI whose decoded image is over the limit from its header, before inflating it, bound decompression against a header that understates its data, reject oversized source files before reading them, and check cancellation around input decoding.

- 3beb743: Add Histology to MRI, a browser app that registers 2D histology sections (RGB or greyscale TIFF, PNG or JPEG) to an MRI volume. The user gives the slice axis and an approximate slice; the app samples the MRI on that plane, chooses the section's orientation, registers it rigidly and affinely with Greedy's NMI metric, optionally searches the plane's offset and tilt, and finishes with a Greedy stationary-velocity warp, all in one worker per run. It downloads the section warped onto the MRI plane (RGBA NIfTI), the sections drawn into the MRI grid, and Greedy-compatible affine and warp files in world coordinates, and overlays the result on the MRI with adjustable opacity. On a synthetic test (an MRI slice deformed by a known affine and smooth warp and re-coloured as H&E) the mean landmark error falls from 7.5 mm (12.5 voxels of 0.6 mm) to 0.21 mm (0.35 voxels); on the AHEAD example it falls from 6.8 mm (11.3 voxels) to 1.8 mm (3.0 voxels) at six manual landmarks, where the plane search and warp did not reduce it (the affine alone gives 1.7 mm).

  `@neurodesk/webapp-components/file-io/tiff` gains `readTiffImage`, which reads one greyscale or colour image (RGB with alpha dropped, white-is-zero inverted, palette, YCbCr, CMYK and CIELab converted to RGB) and refuses stacks, channel stacks and over-budget images before decoding. The new `@neurodesk/webapp-components/file-io/raster-image` reads PNG and JPEG sizes from their headers (walking JPEG segments) and decodes them to RGBA without EXIF rotation.

  `@neurodesk/greedy`'s `registerAffineGreedy` and `registerRigidGreedy` take an optional `initial` matrix, and the package exports its single-threaded build as `@neurodesk/greedy/wasm-single` for bundled workers.

- a2675b9: Add Light-sheet atlas, a microscopy app that registers a cleared mouse brain to the Allen Mouse Brain CCFv3 (50 µm, from the BrainGlobe Atlas API) with Greedy and counts cell candidates per brain region, following BrainGlobe's brainreg and cellfinder. It reads TIFF stacks and OME-Zarr images plane by plane, detects candidates with a port of cellfinder's classical detection (identical to cellfinder 1.10.1 on its test crop: every thresholded plane and all 38 candidates), and writes the registered atlas labels, the candidate list and a per-region table of candidate counts, volumes and densities. Counts are of unclassified candidates. The Allen atlas is for research and noncommercial use only. On BrainGlobe's test brain its labels agree with brainreg's with a whole-brain Dice of 0.97.

  `@neurodesk/webapp-components` gains `file-io/microscopy-stack`, plane-by-plane readers for TIFF stacks (multi-page or one file per plane, with OME-XML and ImageJ voxel sizes read by the shared `file-io/tiff` parsers; a single OME-TIFF's z planes are the pages its TiffData maps, and a mapping the reader cannot follow, such as planes in another file, is refused before any pixel is decoded; OME-TIFF folders and files with several image series are refused) and OME-Zarr folders. `micrometresPerUnit` also reads the NGFF spellings meter and centimeter. `@neurodesk/greedy` exports its single-threaded WebAssembly glue as `@neurodesk/greedy/wasm-single` for bundlers.

- 8fca61b: `@neurodesk/webapp-components/file-io/tiff` reads the planes of a 2D image TIFF (`openTiffPlanes`: RGB, palette as colour or as indices, multi-sample and one-page-per-channel images, pyramid levels and alpha left out), names OME pages by their channels through TiffData (`omePageChannels`), and writes label TIFFs (`writeLabelTiff`). StarDist and micro-sam read and write TIFF through it instead of their own copies. StarDist now names OME channels by their TiffData mapping and refuses the TiffData layouts micro-sam refuses.
- 83f5bb1: Add OME-Zarr Converter, which converts a microscopy TIFF, OME-TIFF, ImageJ hyperstack, TIFF/PNG/JPEG sequence or NIfTI image to a multiscale OME-Zarr in the browser: OME-NGFF 0.5 (Zarr v3, an RFC-9 .ozx archive) or 0.4 (Zarr v2), or straight into a folder. It keeps each axis's voxel size and unit, the channels and their names and colours, and builds a mean or nearest XY pyramid. On the OME retina example the nearest pyramid equals bioformats2raw 0.14.0's byte for byte with the same chunks, axes, scales and channel windows, the mean pyramid equals NumPy's, and both versions pass the OME-NGFF strict image schemas. `@neurodesk/webapp-components/file-io/tiff` gains `openTiffPages`, a page-at-a-time reader that keeps RGB samples apart, skips reduced-resolution pages and hands OME-TIFF to fiff, and its OME attribute parser reads single-quoted attributes and character references.

### Patch Changes

- 65a2e2b: Move the complex FFT (radix-2 with Bluestein for other lengths, in any number of dimensions) to `@neurodesk/webapp-components/fft` and use it from calcium imaging and stitching, replacing their two app copies. Results are unchanged.

## 0.26.0

### Minor Changes

- 6ca6f49: Add `@neurodesk/cryo-em`, the RELION 5.1.1 job definition shared by the Cryo-EM app, the Node reference server and `neurodesk-compute`: validation, command lines that equal RELION's own `note.txt` (checked with `relion_pipeliner`), outputs and progress. The compute client gains projects, data-root listings and project-relative output names for single-owner servers.

## 0.25.0

### Minor Changes

- fbe693d: Add Calcium imaging, a browser app for two-photon calcium imaging preprocessing. It loads a multi-page or OME-TIFF movie, corrects motion rigidly or piecewise rigidly (NoRMCorre-style patches) with sub-pixel Fourier cross-correlation or phase correlation, computes mean, max and local-correlation images, detects active cells from the correlation image (users can add or remove ROIs at the cursor), extracts neuropil-corrected ΔF/F and deconvolves spikes with OASIS AR(1), all in web workers. On the DANDI 000249 example its rigid shifts equal CaImAn's for every frame given the same template, and its OASIS matches the reference implementation on test traces.

  `@neurodesk/webapp-components/file-io/tiff` reads greyscale TIFF, ImageJ and OME-TIFF stacks with geotiff (refusing multi-sample and palette pages and over-budget stacks before decoding) and writes uncompressed ImageJ-compatible TIFF stacks.

- 8327887: Add Tile stitching, a browser app that stitches overlapping 2D or 3D microscopy tiles (TIFF or OME-TIFF) from a grid layout, a Fiji TileConfiguration file or OME stage positions. Pairs are registered by phase correlation with cross-correlation checks of the strongest peaks (after Preibisch et al. 2009), positions are optimised by weighted least squares with outlier rejection, and the tiles are fused with linear blending into TIFF and zipped OME-Zarr, with Fiji's TileConfiguration.registered.txt. On the NIST MIST example every tile is within 0.31 px of Fiji's Grid/Collection stitching.

  `@neurodesk/webapp-components/file-io/tiff` now reads OME stage positions (`stagePosition`, micrometres, from the first image's first plane (TheZ = TheC = TheT = 0); null otherwise; always present).

  Compute Pearson correlation with stable incremental covariance so high-offset uint32 and float64 tiles retain correct matching scores.

  Reject source tile selections over the input budget before reading, check cancellation between file reads, and escape CSV fields so punctuation in filenames preserves report columns.

  Refresh the registered-position text reference after stable correlation changes its final floating-point digits; the example's fused TIFF and recorded Fiji accuracy comparison are unchanged.

  Require compatible tile calibration for translation-only stitching, allowing one part per million of metadata rounding, and convert relative stage displacement with a shared pixel size so absolute stage origins cannot distort placement.

  Share checksum-pinned Blosc and Zstd codec chunks in the composite runtime store to keep the catalogue within its duplicate-content budget. Standalone bundles retain their codecs.

  Resolve Vite preload-table paths from the app base when projecting catalogue sites so shared codecs are included alongside ordinary module imports.

- 6102c59: Add Structure Tensor, a fibre orientation app for microscopy using the OrientationJ method. It takes a 2D image or a 3D stack (TIFF, NIfTI, PNG, JPEG, or 2D slices) and computes Gaussian-derivative structure-tensor maps in the browser: orientation, coherency and energy, OrientationJ's HSB colour survey, an orientation distribution CSV and a dominant-direction summary. In 3D it also gives the fibre azimuth and elevation, a fibre coherency and an RGB direction map, with the fibre vectors as NIfTI. On the SHG collagen example the maps equal a scipy.ndimage reference to 1e-13°, and synthetic gratings and cylinder lattices give their true angles within 0.01°. The shared file-io gains `createRgb24Nifti` for colour NIfTI images.

  `@neurodesk/webapp-components/file-io/tiff` can inspect a Blob or File range by range (only its page directories and description are read), read RGB pages as the mean of red, green and blue with `rgb: 'mean'`, reports `samplesPerPixel`, and writes RGB pages with `rgb: true`. Structure Tensor reads and writes TIFF through it.

### Patch Changes

- af1bc1e: Allow input owners to explicitly cancel pending folder traversal and withdraw Undo when clearing inputs, while preserving Undo during ordinary loaded-file updates.
- 7539ad5: Add NeuroMorph, a browser app for neuron morphology from SWC reconstructions. It reads one or more SWC files or a folder, reports and repairs common SWC faults, draws each neuron as tubes coloured by soma, axon, basal and apical dendrite, and measures total length, branch and terminal points, path and radial distance, branch and Strahler order, bifurcation angles, surface area, volume and the Sholl profile with a configurable step, with CSV downloads. On both NeuroMorpho.Org examples and NeuroM's test morphologies every value agrees with NeuroM 4.0.6 to one part in a million and every Sholl count is identical.

  `writeMz3` takes optional per-vertex RGBA colours, and the example selector offers **Load folder…** for any input marked `data-neurodesk-folder`.

- aa722fe: Add an opt-in native NiiVue wand adapter that sets intensity bounds from image contrast, handles signed seeds and NIfTI intensity scaling, and preserves connectivity, radius, previews and Undo. Restore the original viewer method when the adapter is removed. Existing viewers do not opt in automatically.

  Support an optional RAS brain mask as a connectivity barrier, reject outside seeds, and convert matching native NIfTI masks using the viewer signed axis permutation.

  Add a synchronous drawing-to-native voxel-order conversion with base-grid checks for native mask export and confirmation.

## 0.24.0

### Minor Changes

- Add checksum-pinned SOOP and ISLES 2022 DWI/ADC examples to CALMaR, preserving original release terms, attribution and provenance in the offline bundle. Add an acute-example choice that alternates cases after successful imports, while keeping each scan directly selectable. Clear prior subject results and demographic context when replacing inputs, and verify real segmentation and native-mask downloads for both datasets.

  Support optional example rotations in the shared selector. Loading messages identify the actual case, failed or cancelled imports retain the same next case, and replacing a catalogue resets its rotation.

## 0.23.0

### Minor Changes

- 491c3ce: SDC adds SyN-SDC to its method selector: sdcflows 2.17.1's fieldmap-less correction from one DWI series and a T1w (`@neurodesk/sdc/syn`), run in a worker in the browser. MindGrab masks the mean b0 and the T1w on its CPU modules unless masks are uploaded. The sidebar asks for the phase-encoding direction and the total readout time only when no sidecar has them, and a run without them is refused. The app writes the corrected DWI series with its bval, bvec and sidecar, the field map in Hz, its B-spline coefficients, the displacement field and the brain mask, shows the field over the corrected mean b0, and logs per-stage times and field QC in the console. The new example is the ds005134 slab with the full T1w; its outputs equal the Node pipeline's byte for byte. `createNiivueVolumePreview` draws an optional signed overlay on its image and clears the viewer when given `null`. The SyN-SDC N4 worker (`@neurodesk/sdc/syn/n4-worker`) takes the kernel's `wasm` URL as optional: without it the module loads the `n4-bias.wasm` beside it, so the composite site serves one N4 binary to N4 and SDC (runtime family `n4-wasm`). SDC stages only MindGrab's CPU modules, the only ones it runs. A new file-input kind, `mask`, marks an optional mask beside a scan input: the shell's page drop never fills it and never makes it the primary input. SDC's two mask fields use it, carry visible labels and are disabled while PyHySCO is selected, so a dropped DWI series stays with its T1w and a dropped AP/PA pair stays together. A flat BIDS-named DWI with a T1w that has no BIDS name (or a DICOM T1w) is read as loose files.

## 0.22.4

### Patch Changes

- 8e9346d: Fail a download whose headers or next body chunk do not arrive within 30 s, instead of leaving it pending for ever when the host accepts the connection and then goes silent. `fetchModel` and `fetchWithRetry` apply the stall guard to every model and example download; the waits between HTTP 429 retries are not counted, and a user's cancel still reports as a cancel. The example selector reports a stalled download as "The download of <file> stalled (no data for 30 s). Load the example again to retry."
- 239dedd: Add SamSrf, which maps population receptive fields and connective fields on the cortical surface from GIfTI time series: a forward-model pRF fit, reverse-correlation pRF and reverse-correlation connective fields, with SamSrf's model presets, its GIfTI map set and the maps drawn on the inflated surface with an R² threshold. Shared components gain `writeMz3Scalars`, a scalar-only mz3 that NiiVue loads as a mesh layer, and `readFreeSurferCurv`.

## 0.22.3

### Patch Changes

- d8ac48c: Convert DICOM with @niivue/dcm2niix 1.4.20261029 in every app and command line. The shared client is a thin layer over its `convert`, which pairs sidecars and gradients, times out and terminates its worker; bundler-less apps stage the same JPEG build (JPEG-LS and JPEG 2000) from npm instead of a committed 1.3 copy, and all apps share one WASM. A conversion that yields some images now keeps them; dcm2niix's last log line is reported when none are produced. Output names drop the `input_` prefix and never include the input folder, whose name can identify a patient.
- b84a269: The Standalone dialog lists macOS Intel archives and, for a command line released by another repository, its prerequisite notes and release links instead of the models note.

## 0.22.2

### Patch Changes

- Retry interrupted response bodies when validation downloads opt into transient network recovery, while rejecting permanent HTTP and integrity failures immediately.

## 0.22.1

### Patch Changes

- Retry bounded transient CI download failures without weakening checksums, handle Windows lockfile line endings, and improve NODDI input mismatch diagnostics. Add early catalog integration checks and register generated app offline workflows and standalone exceptions.

## 0.22.0

### Minor Changes

- bd5f3a8: Style the `LabelLegend` rows in the shared imaging workspace: a colour swatch, the label name and its volume on one line, from tokens only.

## 0.21.1

### Patch Changes

- 0066f60: Reject missing, empty, or non-string step labels in `outputNames` and `derivativeSidecar` with a `TypeError`. Valid labels keep the same filenames and sidecar content.
- Retain the HMC workspace controls, diffusion workflow artifact metadata and selected-button hover contrast alongside the reviewed agent connection support.

## 0.21.0

### Minor Changes

- 941884c: Add `bidsDiffusionSeries`, `chosenBidsRun` and `chooseBidsRun` to `file-io/bids`. `bidsDiffusionSeries` gives each DWI run of a dropped BIDS folder as a diffusion series (image, bval, bvec and the merged JSON sidecar), in the shape of `readDiffusionSeries`. The `require` option names the gradient tables that the app needs; a run without one of them lists it in `missing`. It returns null for loose files, so an app reads them as before. `chooseBidsRun` remembers the loaded run, so the same files (for example on Undo) load that run again. `readBidsDiffusion` now orders runs by number, so run-2 comes before run-10.
- a028e96: Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.
- 650ce5f: Share the DWI apps' input helpers. `@neurodesk/webapp-components/file-io/brain-mask` reads a user's brain mask (`readBrainMask`: decode, same grid as the image, one 3D volume, binarised) for noddi, n4 and the noddi command line, and `@neurodesk/webapp-components/volume/mean` holds `meanVolumes`. `@neurodesk/dwi2trx/gradients` adds `parseBval` (the bval half of `parseBvalBvec`, with an optional volume-count check), `B0_THRESHOLD`, `isB0` and `b0Volumes` (b < 50 s/mm², the rule of the `exes/dwi/gradients` crate, which a shared test case file now checks on both sides). dwidenoise and n4 parse their b-values with it, and dwidenoise's own `parseBvals` is removed. Outputs are unchanged; some bval error messages now use the shared wording.
- 343c256: Dwidenoise solves each Patch2Self volume in a worker. The page no longer runs a group solve, the NIfTI writer or gzip on its own thread, so it stays responsive and the footer × stops a run between two volumes. The status bar shows the Gram, solve and prediction passes, weighted by their cost. The workers write the result straight into the output NIfTI and find its `cal_max`, and a worker compresses the file without a copy. On the full-brain ds005134 DWI (509 MB as Float32), the renderer's peak memory went from about 3040 MB to about 2610 MB and the longest main-thread task from about 15 s to less than 0.5 s (packages/dwidenoise README). The output is the same, bit for bit, on the e2e fixtures, the slab and the full brain. Dwidenoise also refuses a DWI above the shared 2 GB input limit before decoding it.

  `@neurodesk/dwidenoise` adds `solveVolume` (one row of `solve`, from the new `solve_volume` WebAssembly export), `denoiseChunks` (the app's worker schedule in one thread) and `CHUNK_VOXELS`. `solve` and `solveVolume` refuse a group of fewer than 2 volumes with a message that says so. `scripts/check-slab.mjs --app OUTPUT.nii.gz` requires app outputs to equal `denoiseChunks` bit for bit.

  `@neurodesk/webapp-components/file-io` adds `allocateNifti`, the file `createNiftiFromData` writes with a typed view of its voxels to fill in place, so a page that writes a large image holds one copy of it. Its declaration types `ArrayType` as a view constructor (`NiftiViewConstructor`), as the function calls it.

### Patch Changes

- 941884c: A BIDS diffusion dataset (a folder with a `sub-*/[ses-*/]dwi/*_dwi.nii[.gz]` image) dropped on the page now stays together at the primary input. Before, its DWI runs filled the empty image slots, so a second run went to an app's mask input. Other drops, BIDS anatomical pairs included, fill the image slots as before.

## 0.20.1

### Patch Changes

- 328cb77: Add a browser workspace and Node command line for GP and trivial diffusion head-motion correction, with pinned CPU brain masking, explicit worker controls, BIDS derivatives and effective-mask provenance. Verify the hosts against actual production-browser reference outputs.

## 0.20.0

### Minor Changes

- 3a7e5bb: The desktop MCP server also offers NiiVue's own agent tools (`@niivue/nv-mcp`): each retained NiiVue viewer is a tab, so `list_tabs`, `where_am_i`, `go_to_point`, `set_view`, `screenshot` and the rest act on it through its session. Viewers register a `niivue` capability and answer the new `viewers.niivue` command. Loading tools can also load a local file or another URL once a person approves it in a dialog, or when it is listed in `NEURODESK_APPROVED_SOURCES`, for that viewer only; `NEURODESK_SOURCE_APPROVAL=deny` refuses without asking. An address with a user name or password is refused before anyone is asked, however it is written. The new `sessions_grant` tool approves a file or any http(s) URL ahead of time, and each approval or refusal is recorded under `sources` in the run record.
- 72cbb8d: Hosted apps can hand their NiiVue viewer to an AI agent on the same computer. `automation.agentConnection()` and `createAgentControl()` connect the page to a local nv-mcp server only after the person chooses **Connect an agent**, and report the connection in the app's status bar. The new `neurodesk-mcp` command (`@neurodesk/agent-server`) is that server for Node, accepting pages from `https://webapps.neurodesk.org` and localhost. It refuses a malformed request or frame without stopping, keeps serving when a client resets its socket, and closes a refused socket once it has answered. Brain Extraction shows the control as a preview when opened with `?agent` (or `?agent=<port>`). Its Privacy text says what a connected agent can read: screenshots of the viewer, and the names, dimensions, intensity statistics and display settings of the loaded images. An agent that runs on a cloud model sends what it reads to its provider. Chrome asks to allow local network access, and Safari cannot connect. Firefox connected without a prompt in one test on macOS. App builds bundle nv-mcp's browser client, which loads only when an agent connects or calls it. The components list nv-mcp as a devDependency, so command-line installs of the components carry neither nv-mcp nor the MCP server stack, and the components' type declarations compile without it.
- 14a8b29: Add `bidsDiffusionSeries`, `chosenBidsRun` and `chooseBidsRun` to `file-io/bids`. `bidsDiffusionSeries` gives each DWI run of a dropped BIDS folder as a diffusion series (image, bval, bvec and the merged JSON sidecar), in the shape of `readDiffusionSeries`. The `require` option names the gradient tables that the app needs; a run without one of them lists it in `missing`. It returns null for loose files, so an app reads them as before. `chooseBidsRun` remembers the loaded run, so the same files (for example on Undo) load that run again. `readBidsDiffusion` now orders runs by number, so run-2 comes before run-10.
- a028e96: Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.
- 650ce5f: Share the DWI apps' input helpers. `@neurodesk/webapp-components/file-io/brain-mask` reads a user's brain mask (`readBrainMask`: decode, same grid as the image, one 3D volume, binarised) for noddi, n4 and the noddi command line, and `@neurodesk/webapp-components/volume/mean` holds `meanVolumes`. `@neurodesk/dwi2trx/gradients` adds `parseBval` (the bval half of `parseBvalBvec`, with an optional volume-count check), `B0_THRESHOLD`, `isB0` and `b0Volumes` (b < 50 s/mm², the rule of the `exes/dwi/gradients` crate, which a shared test case file now checks on both sides). dwidenoise and n4 parse their b-values with it, and dwidenoise's own `parseBvals` is removed. Outputs are unchanged; some bval error messages now use the shared wording.
- 343c256: Dwidenoise solves each Patch2Self volume in a worker. The page no longer runs a group solve, the NIfTI writer or gzip on its own thread, so it stays responsive and the footer × stops a run between two volumes. The status bar shows the Gram, solve and prediction passes, weighted by their cost. The workers write the result straight into the output NIfTI and find its `cal_max`, and a worker compresses the file without a copy. On the full-brain ds005134 DWI (509 MB as Float32), the renderer's peak memory went from about 3040 MB to about 2610 MB and the longest main-thread task from about 15 s to less than 0.5 s (packages/dwidenoise README). The output is the same, bit for bit, on the e2e fixtures, the slab and the full brain. Dwidenoise also refuses a DWI above the shared 2 GB input limit before decoding it.

  `@neurodesk/dwidenoise` adds `solveVolume` (one row of `solve`, from the new `solve_volume` WebAssembly export), `denoiseChunks` (the app's worker schedule in one thread) and `CHUNK_VOXELS`. `solve` and `solveVolume` refuse a group of fewer than 2 volumes with a message that says so. `scripts/check-slab.mjs --app OUTPUT.nii.gz` requires app outputs to equal `denoiseChunks` bit for bit.

  `@neurodesk/webapp-components/file-io` adds `allocateNifti`, the file `createNiftiFromData` writes with a typed view of its voxels to fill in place, so a page that writes a large image holds one copy of it. Its declaration types `ArrayType` as a view constructor (`NiftiViewConstructor`), as the function calls it.

### Patch Changes

- 941884c: A BIDS diffusion dataset (a folder with a `sub-*/[ses-*/]dwi/*_dwi.nii[.gz]` image) dropped on the page now stays together at the primary input. Before, its DWI runs filled the empty image slots, so a second run went to an app's mask input. Other drops, BIDS anatomical pairs included, fill the image slots as before.

## 0.19.3

### Patch Changes

- Keep selected secondary buttons readable when hovered in light and dark themes.

## 0.19.2

### Patch Changes

- Pair acquisition JSON and gradient inputs by automation role so metadata survives diffusion pipelines. Split DWI Correct and SDC inputs into single-image roles, require explicit acquisition values for automated correction, and expose correction settings. Export a corrected mean-b0 image for downstream brain masks. Use a generic single-volume error for shared image readers.

## 0.19.1

### Patch Changes

- 3fc9cf2: DWI Correct is a new app that corrects a diffusion MRI series in the browser, as FSL eddy does: head motion, eddy-current distortion, susceptibility distortion and slices that lost signal are estimated together, and each volume is resampled once with Jacobian modulation. Drop the series with its bval, bvec and JSON sidecar, as loose files or a BIDS folder, with an optional reverse phase-encoding b0, topup `_fieldcoef` image or field map in Hz. Each volume is registered to a prediction from the others (3dSHORE for 72 or more diffusion-weighted volumes, else a Gaussian process); slices far below their prediction are replaced, tested as single slices and as multiband groups. The field comes from the reverse-PE b0 through the SDC app's PyHySCO port and the brain mask from MindGrab. The outputs are BIDS derivatives: the corrected series with its bval, rotated bvec and sidecar, the movement and outliers per volume, the mask, the field, a before/after GIF and the log. The example is OpenNeuro ds006676 sub-001 (CC0), a multiband 3 series of 141 volumes with a PA b0.

  `@neurodesk/shoreline` holds the threaded and single-threaded WebAssembly builds of `exes/dwi/shoreline`, the Rust command line that the app runs on files held in memory. It is implemented from the eddy papers without FSL code.

  `@neurodesk/webapp-components`: numeric table cells do not wrap; a wide table scrolls instead. `parseNiftiHeader` gives the header's `intentCode`. `assertImageValues` refuses an image with NaN or infinite values, or with one value in every voxel, and names it in the message. The imaging workspace has `.nd-viewer-image`, an image shown in place of the viewer canvas, and `.nd-file-info-lines`, file information with one item per line and `.nd-file-info-gap` before a group.

## 0.19.0

### Minor Changes

- d32b485: Add NiiVue viewer tools to the desktop MCP server: `viewers_volumes` lists loaded volumes and their display settings, `viewers_display` sets slice type and per-volume colormap, display range, opacity and visibility, and `viewers_screenshot` returns the redrawn viewer as an MCP PNG image captured from the window.

## 0.18.0

### Minor Changes

- a36fde4: `@neurodesk/webapp-components/file-io` reads diffusion inputs from a BIDS folder. `readBidsDiffusion(files)` takes the files of a folder input or a dropped folder (each with its `webkitRelativePath`) and returns one record per `dwi/*_dwi.nii[.gz]` run: its `.bval`, `.bvec` and JSON sidecar, merged by BIDS inheritance from the dataset root down; the `fmap/*_epi` images whose `IntendedFor` names it, as a `bids::` URI or a subject-relative path; and the subject's `anat/*_T1w` image, from the same session first. Sessions and several runs are supported, and the dataset may sit below the dropped folder. A run without a `.bval` or `.bvec` carries an `error` that names the missing file. Files the reader cannot pair are listed with the reason. Types are at `@neurodesk/webapp-components/file-io/bids`.

- DICOM View's "Open in White matter lesions" button is now an "Open in another webapp"
  menu that lists every app of the site from the registry. Most apps receive the converted
  NIfTI image; apps the registry marks `handoff: dicom` (dicompare, QSMbly, dwi2trx, NODDI,
  Carotid Flow) receive the series' DICOM files, and `handoff: none` keeps an app that cannot
  use a single series (Zarro, FastPrep, SurfAnnotate, LCModel) out of the menu. The shared shell
  receives a handoff for every app the way a page drop opens files, through the app's own
  inputs; dicompare opens the files as reference acquisitions, and White matter lesions
  keeps its own receiver.

  A multiframe DICOM whose frames lie in different planes, such as a scanner's MPR head
  scout, which dcm2niix refuses, now shows each frame as its own correctly placed slice
  instead of failing with exit code 2. `readDicomFrames` in `@neurodesk/dicom2vid` reads a
  file's frames with their own position, orientation and pixel spacing.

  Dropping files or a folder on the image now opens them. FreeBrowse draws NiiVue inside a
  shadow root, so the page drop never saw the canvas and NiiVue swallowed the drop; the page
  drop now reads the event's composed path. It also no longer routes files to the
  automation contract's hidden input.

  DICOM View opens series in the ACS layout, without the 3D render, with FreeBrowse's
  panel closed.

### Patch Changes

- Cancel a pending shell handoff when the user chooses files, drops another input or starts an example. Stop the stored-file copy and input wait so an older handoff cannot replace the newer choice or its status.

- Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.

## 0.17.2

### Patch Changes

- NiiVue moves to 1.0.0-rc.26 in Brain Extraction, Carotid Flow, SYNcro, SynthSeg, White Matter Lesions, and, through the shared FreeBrowse viewer, Spinal Cord Toolbox, DICOM View and TopoFit. From rc.25, NiiVue places a loaded drawing on the right voxels of a sagittal or otherwise permuted image (niivue/mono#251), so the mask editor no longer probes and reverses NiiVue's load on opening a mask. Opening a mask for editing now takes one load instead of up to five on such images. MuscleMap, SeedSeg and VesselBoost run NiiVue 0.68, which already loaded drawings correctly; they pick up the simpler editor.

  From rc.22 NiiVue renders with WebGL2 by default, so the five apps that pinned rc.11 or rc.14 draw their viewer with WebGL2 even where WebGPU is available; segmentation and other processing keep their own WebGPU backends.

## 0.17.1

### Patch Changes

- c865c0c: Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.

- Add helpers for the dcm2niix app. `runDcm2niix` takes a `timeoutMs` conversion deadline and terminates a stalled worker. `clearNiftiText` removes NIfTI header text and extensions and keeps geometry and voxels. Editable report fields share the workflow field styling, and clearing a workspace releases its automation output.

## 0.17.0

### Minor Changes

- a36fde4: `@neurodesk/webapp-components/file-io` reads diffusion inputs from a BIDS folder. `readBidsDiffusion(files)` takes the files of a folder input or a dropped folder (each with its `webkitRelativePath`) and returns one record per `dwi/*_dwi.nii[.gz]` run: its `.bval`, `.bvec` and JSON sidecar, merged by BIDS inheritance from the dataset root down; the `fmap/*_epi` images whose `IntendedFor` names it, as a `bids::` URI or a subject-relative path; and the subject's `anat/*_T1w` image, from the same session first. Sessions and several runs are supported, and the dataset may sit below the dropped folder. A run without a `.bval` or `.bvec` carries an `error` that names the missing file. Files the reader cannot pair are listed with the reason. Types are at `@neurodesk/webapp-components/file-io/bids`.
- DICOM View's "Open in White matter lesions" button is now an "Open in another webapp"
  menu that lists every app of the site from the registry. Most apps receive the converted
  NIfTI image; apps the registry marks `handoff: dicom` (dicompare, QSMbly, dwi2trx, NODDI,
  Carotid Flow) receive the series' DICOM files, and `handoff: none` keeps an app that cannot
  use a single series (Zarro, FastPrep, SurfAnnotate, LCModel) out of the menu. The shared shell
  receives a handoff for every app the way a page drop opens files, through the app's own
  inputs; dicompare opens the files as reference acquisitions, and White matter lesions
  keeps its own receiver.

  A multiframe DICOM whose frames lie in different planes, such as a scanner's MPR head
  scout, which dcm2niix refuses, now shows each frame as its own correctly placed slice
  instead of failing with exit code 2. `readDicomFrames` in `@neurodesk/dicom2vid` reads a
  file's frames with their own position, orientation and pixel spacing.

  Dropping files or a folder on the image now opens them. FreeBrowse draws NiiVue inside a
  shadow root, so the page drop never saw the canvas and NiiVue swallowed the drop; the page
  drop now reads the event's composed path. It also no longer routes files to the
  automation contract's hidden input.

  DICOM View opens series in the ACS layout, without the 3D render, with FreeBrowse's
  panel closed.

- The input size limit moves from dwi2trx to `@neurodesk/webapp-components/file-io/input-limits` (`MAX_INPUT_BYTES`, `InputTooLargeError`, `formatBytes`, `assertInputSize`). It adds `decodedFloat32Bytes`, the size of the Float32 array an image decodes to (voxels × frames × 4), and `assertNiftiDecodedSize`, which refuses a NIfTI above the 2 GB limit from its header alone; `readNiftiHeader` stops gzip streaming after the header when supported. dwi2trx imports the shared module. NODDI and Degibbs refuse a DWI whose decoded image is above the limit before reading it, and the status bar names the size and the limit.

- 14db080: DICOM View's "Open in White matter lesions" button is now an "Open in another webapp"
  menu that lists every app of the site from the registry. Most apps receive the converted
  NIfTI image; apps the registry marks `handoff: dicom` (dicompare, QSMbly, dwi2trx, NODDI,
  Carotid Flow) receive the series' DICOM files, and `handoff: none` keeps an app that cannot
  use a single series (Zarro, FastPrep, SurfAnnotate, LCModel) out of the menu. The shared shell
  receives a handoff for every app the way a page drop opens files, through the app's own
  inputs; dicompare opens the files as reference acquisitions, and White matter lesions
  keeps its own receiver.

- a36fde4: `@neurodesk/webapp-components/file-io` reads diffusion inputs from a BIDS folder. `readBidsDiffusion(files)` takes the files of a folder input or a dropped folder (each with its `webkitRelativePath`) and returns one record per `dwi/*_dwi.nii[.gz]` run: its `.bval`, `.bvec` and JSON sidecar, merged by BIDS inheritance from the dataset root down; the `fmap/*_epi` images whose `IntendedFor` names it, as a `bids::` URI or a subject-relative path; and the subject's `anat/*_T1w` image, from the same session first. Sessions and several runs are supported, and the dataset may sit below the dropped folder. A run without a `.bval` or `.bvec` carries an `error` that names the missing file. Files the reader cannot pair are listed with the reason. Types are at `@neurodesk/webapp-components/file-io/bids`.

- DICOM View's "Open in White matter lesions" button is now an "Open in another webapp"
  menu that lists every app of the site from the registry. Most apps receive the converted
  NIfTI image; apps the registry marks `handoff: dicom` (dicompare, QSMbly, dwi2trx, NODDI,
  Carotid Flow) receive the series' DICOM files, and `handoff: none` keeps an app that cannot
  use a single series (Zarro, FastPrep, SurfAnnotate, LCModel) out of the menu. The shared shell
  receives a handoff for every app the way a page drop opens files, through the app's own
  inputs; dicompare opens the files as reference acquisitions, and White matter lesions
  keeps its own receiver.

### Patch Changes

- Cancel a pending shell handoff when the user chooses files, drops another input or starts an example. Stop the stored-file copy and input wait so an older handoff cannot replace the newer choice or its status.

- c865c0c: Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.

- Serialize ME-ICA previews and restore the previous image, overlay, frame and display window when an import fails or is cancelled. Replacement echoes clear stale echo times, superseded imports cannot replace newer inputs, and automation cancellation stops the processing worker. The shared queue retains the existing single-volume preview adapter.

## 0.16.3

### Patch Changes

- af2e8db: `takeHandoff` takes a `signal`: an abort stops the copy out of storage instead of
  letting it run on in the background, and rejects with the signal's reason. White
  matter lesions passes its load job's signal, so the footer × ends the copy of an
  image sent from another app. `copiesInPieces` is exported and pinned to the user
  agents Playwright's engines report.

- b3404ec: Read only the NIfTI header when loading a White matter lesions image, avoiding a full-image allocation just to display and check its dimensions.

- d9718cd: White matter lesions reads only the NIfTI header when an image is chosen. It used to copy the whole image into memory to read its dimensions, which added a second copy of a 1 GB FLAIR to the load. The shared `readNiftiHeader(file)` reads the first bytes of a plain or gzipped file, and `describeNiftiFile` is built on it.

## 0.16.2

### Patch Changes

- 7c0d201: Restore the last committed image after cancelled or failed viewer loads. Share queued volume previews across NODDI, Degibbs, N4 and Dwidenoise, retaining source files and calibrated map ranges while rollback finishes before controls unlock.

## 0.16.1

### Patch Changes

- 46935f7: Serialize example imports and file replacements so a cancelled image rollback finishes before the next load. Restore the primary picker when file actions are disabled and stream compressed NIfTI headers for image summaries. Tighten the ANTs example checks so "not brain extracted" cannot pass as "brain extracted".

## 0.16.0

### Minor Changes

- c1a4dda: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses a MindGrab brain mask of the mean b0, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

  `@neurodesk/noddi` holds the WebAssembly fit, built from the Rust crates in `exes/dwi`. Its NODDI fit is a port of AMICO 1.5.4, the last BSD-licensed release, and agrees with AMICO 1.5.4 to a median of 1e-4 in white matter. It rotates each atom exactly instead of through AMICO's 1° lookup table.

  `readDiffusionSeries` in `@neurodesk/runtime-support/dcm2niix-client` returns each image with its bval, bvec and sidecar, from NIfTI files or a converted DICOM series. FSL's `bvals` and `bvecs` files count as gradients, with or without a stem: the image readers no longer pass them to dcm2niix as DICOM, and a page drop sends them to an app's gradients input.

  `createNiftiFromData` writes a 4D map when `dims` has a fourth entry greater than 1, so a direction map can be saved as three frames.

- 3329c39: The registration apps load their images through one shared fixed/moving pair
  (`nd-image-pair`, `createImagePair`). Each app now says fixed and moving, never
  stationary. The fixed card comes first. Each card has explicit "Load fixed
  image…" / "Load moving image…" and "Folder…" pickers, a drop zone, a summary
  of size and spacing, a series select and a clear ×, and Swap exchanges the two.
  Examples fill the slots by role through the same path as a user's file, and a
  failed load keeps the previous image. The fixed card offers built-in templates from
  the new `registry/templates.json`: FSL MNI152 1 mm brain and head and the ICBM152
  avg152 2 mm head, downloaded and checked with `fetchModel`, and cited in each app.
  elastix offers them for 3D images only. SYNcro shows its MNI152 template as a
  locked fixed image, its scan is the moving image, and it fetches the template from
  the catalogue address. Brain extraction in ANTs, Greedy and FireANTs has its own
  Fixed and Moving buttons below the pair.

  Cancelling an example preserves the previous image even when the app supplies
  its own cancellation signal. Image summaries convert NIfTI spatial units to
  millimetres before showing voxel spacing.

- 0511cd7: NODDI is a new app that fits diffusion tensor and NODDI maps to a DWI in the browser. Load a DWI NIfTI with its bval and bvec, or a DICOM diffusion series, and choose Fit models. The tensor fit (weighted or ordinary least squares, on the b0 volumes and the shells up to b = 1200 s/mm², or the lowest shell when none is that low) gives FA, MD, AD, RD, S0 and the principal direction. With two or more shells, NODDI by AMICO gives ICVF, ISOVF, ODI and the fibre direction; with one shell the app says so and fits the tensor only. The fit uses an Otsu threshold of the mean b0 as the brain mask, or a mask you supply on the DWI grid, and runs in Web Workers with a cancel. Every map downloads with its BIDS diffusion derivative name, for example `sub-01_model-noddi_param-icvf_dwimap.nii.gz`.

### Patch Changes

- ea2a6d2: Deface and BrowserQC take the avg152 T1 2 mm template from the shared template
  catalogue (`registry/templates.json`) and download it with `fetchTemplateFile`,
  which checks its size and SHA-256 and caches it. Before, Deface fetched the template
  and its face mask with no checksum; the face mask now goes through `fetchModel` with
  its manifest checksum too. BrowserQC's air template, its manifest and Deface's
  manifest name the catalogue URL, so the offline bundle carries one copy of the file
  instead of three. BrowserQC cites the ICBM152 template paper. `fetchTemplateFile`
  names the template when its bytes do not match the pin.
- 3f1d770: `takeHandoff` takes a `signal`: an abort stops the copy out of storage instead of
  letting it run on in the background, and rejects with the signal's reason. White
  matter lesions passes its load job's signal, so the footer × ends the copy of an
  image sent from another app. `copiesInPieces` is exported and pinned to the user
  agents Playwright's engines report.
- d9718cd: White matter lesions reads only the NIfTI header when an image is chosen. It used to copy the whole image into memory to read its dimensions, which added a second copy of a 1 GB FLAIR to the load. The shared `readNiftiHeader(file)` reads the first bytes of a plain or gzipped file, and `describeNiftiFile` is built on it.
- 46935f7: Serialize example imports and file replacements so a cancelled image rollback finishes before the next load. Restore the primary picker when file actions are disabled and stream compressed NIfTI headers for image summaries. Tighten the ANTs example checks so "not brain extracted" cannot pass as "brain extracted".

- ea2a6d2: Deface and BrowserQC take the avg152 T1 2 mm template from the shared template
  catalogue (`registry/templates.json`) and download it with `fetchTemplateFile`,
  which checks its size and SHA-256 and caches it. Before, Deface fetched the template
  and its face mask with no checksum; the face mask now goes through `fetchModel` with
  its manifest checksum too. BrowserQC's air template, its manifest and Deface's
  manifest name the catalogue URL, so the offline bundle carries one copy of the file
  instead of three. BrowserQC cites the ICBM152 template paper. `fetchTemplateFile`
  names the template when its bytes do not match the pin.

- 3f1d770: `takeHandoff` takes a `signal`: an abort stops the copy out of storage instead of
  letting it run on in the background, and rejects with the signal's reason. White
  matter lesions passes its load job's signal, so the footer × ends the copy of an
  image sent from another app. `copiesInPieces` is exported and pinned to the user
  agents Playwright's engines report.

- d9718cd: White matter lesions reads only the NIfTI header when an image is chosen. It used to copy the whole image into memory to read its dimensions, which added a second copy of a 1 GB FLAIR to the load. The shared `readNiftiHeader(file)` reads the first bytes of a plain or gzipped file, and `describeNiftiFile` is built on it.

- 46935f7: Serialize example imports and file replacements so a cancelled image rollback finishes before the next load. Restore the primary picker when file actions are disabled and stream compressed NIfTI headers for image summaries. Tighten the ANTs example checks so "not brain extracted" cannot pass as "brain extracted".

## 0.15.1

### Patch Changes

- b67e4e9: Add dcm2niix (`dcm2niix`), a browser-only catalog app that runs dcm2niix on one MRI examination at a time. Accept files, folders and ZIP archives; review anatomical, diffusion and reverse phase encoding acquisitions; enter missing metadata; and download an organized BIDS dataset with an explicit identifying-metadata policy. Preserve separate acquisitions and image/gradient ordering, and link reverse EPI fieldmaps to their DWI targets.

  Share bounded conversion deadlines, NIfTI text removal, report-form styling and in-memory automation reset. Include a pinned DICOM example, Philips native-reference checks and offline/interface workflow coverage.

## 0.15.0

### Minor Changes

- b68209b: DICOM View can open the selected image in White matter lesions. Open in White matter lesions, under the series, sends the converted 3D image, named as its download is, and the same tab opens White matter lesions with the image loaded and ready to segment. A time series or a single slice keeps the button disabled and says why. Choosing another series while a send is in progress cancels it. DICOM View's automation contract now gives its image artifact the `application/x-nifti` media type.

  White matter lesions loads an image sent from DICOM View on opening and reports "Loaded <name> from DICOM View" in the status bar. It never starts segmentation itself.

  `@neurodesk/webapp-components/handoff` passes files between apps on one site: `sendHandoff` stores them in IndexedDB and opens the target app; `takeHandoff` claims them once and returns copies. An entry can be opened for 2 minutes, only by the tab that sent it, and is deleted when it is opened. The app shell deletes expired entries whenever an app opens.

  The cross-origin isolation service worker bootstrap publishes `coiWillReload`, which resolves once a page knows whether it is about to reload, and `coiHoldReloads`, which stops later automatic reloads. Pages that use neither behave as before.

## 0.14.4

### Patch Changes

- 2ae93ae: The input menu now reads "Load data or example…", and its file actions are **Load files…** and **Load folder…**. In Chrome and Edge on desktop they open the browser's Open and Select dialogs instead of the file input's, which asked to "Upload" files: nothing is uploaded, and the menu no longer says so. A folder's files keep their paths within it, as a dropped folder's do. Other browsers, and any browser where those dialogs fail, open the file input's picker as before.
- ccb2970: Remove closed class-toggled dialogs from the accessibility tree and keyboard navigation using synchronized inert and aria-hidden state, preserving fade transitions and focus restoration. This prevents repeated attempts to dismiss an already-closed SCT About dialog.
- 67a5a8f: Style report controls (`.nd-report-controls`): a sticky row of shared fields above a report shown in place of the canvas. Style dicompare compliance reports from design tokens in the shared stylesheet.

- 2ae93ae: The input menu now reads "Load data or example…", and its file actions are **Load files…** and **Load folder…**. In Chrome and Edge on desktop they open the browser's Open and Select dialogs instead of the file input's, which asked to "Upload" files: nothing is uploaded, and the menu no longer says so. A folder's files keep their paths within it, as a dropped folder's do. Other browsers, and any browser where those dialogs fail, open the file input's picker as before.

- ccb2970: Remove closed class-toggled dialogs from the accessibility tree and keyboard navigation using synchronized inert and aria-hidden state, preserving fade transitions and focus restoration. This prevents repeated attempts to dismiss an already-closed SCT About dialog.

- 67a5a8f: Style report controls (`.nd-report-controls`): a sticky row of shared fields above a report shown in place of the canvas. Style dicompare compliance reports from design tokens in the shared stylesheet.

## 0.14.3

### Patch Changes

- b547d52: CALMaR shows its result tables in a Results view in the viewer instead of the sidebar, so the Lesion % and Map % columns are no longer cut off. The Results tab opens once an analysis finishes and stays disabled until there is an atlas overlap, during lesion-mask review and after Start over. The separate Analysis log is gone: every message now appears once, in full and with its level, in the technical log. Captions above shared data tables are styled as muted, left-aligned notes.

## 0.14.2

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.

## 0.14.1

### Patch Changes

- 7443048: Failures of actions started from the interface (fiber colour, display mode, FA floor,
  the vector previews and generator, loading files) now appear in the status bar and the
  technical log instead of being lost as unhandled rejections. A tensor fit or tracking
  run whose input was replaced is logged without overwriting the newer input's status.
  Files chosen while the viewer is still starting no longer fail with
  "Cannot access … before initialization". Tensor maps and streamlines are unchanged.

  `@neurodesk/webapp-components` declares types for its `./file-io/nifti` export and adds a
  typed `./file-io/download` export, so TypeScript apps can import them without `allowJs`.

## 0.14.0

### Minor Changes

- dd65e6a: Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
  focus and selection only, a compact 48px app bar, sentence-case section titles
  and a quieter status bar. The example menu is now the input control: examples,
  then Choose files… and Choose folder…. The whole window, the viewer included,
  accepts dropped files; a drop mid-session replaces the inputs with Undo in the
  status bar. Before any input the status reads "Drag and drop files". MuscleMap
  drops its separate drop box and Add File(s) button.

  Page drops fill empty image slots in order while keeping DICOM series together.
  New selections supersede unfinished drop traversal, and registration apps load
  each dropped image in order. The shared drop handler also respects the different
  native input and file-field event contracts.
  Failed imports leave only successfully loaded slots occupied, and Undo can
  restore loaded examples.

### Patch Changes

- dcc74e7: Each app's Standalone dialog lists only that app's own command line, never the all-apps desktop suite or its model pack. The nightly suite release now announces itself to the standalone-catalog workflow, which writes its verified entry into `registry/standalone.json` instead of leaving it on 0.10.20260918. A contract test requires every app to ship a command line or state why it cannot.

## 0.13.0

### Minor Changes

- 27c9549: SynthSeg reports brain volumes against age. Segmentation now also returns the
  soft-posterior volumes of FreeSurfer's `mri_synthseg --vol`, within 0.03 % of
  FreeSurfer 8.2.0 on the T1 example in fast mode. A new Volumes view charts each
  structure's head-size-adjusted volume against the IXI reference cohort's 5th–95th
  and 25th–75th percentiles and median, with a table of volume, adjusted volume,
  z, percentile and a flag below the 5th or above the 95th percentile. Age and sex
  come from new Input fields, filled from the DICOM header when there is one. The
  reference norms are fetched from the neurocontainers SynthSeg recipe at a pinned
  commit and checked against their checksum. Research use only. Not for diagnostic
  use.

  - Fast mode is now the default processing mode in the app and the command line,
    because the norms were fitted on fast-mode volumes.
  - The Output section adds Download volumes (.csv). The run report and automation
    measurements carry the volumes and the volume report, and `segment` accepts
    optional `age` and `sex` parameters.
  - The `synthseg` command line writes `INPUT_synthseg_vol.csv` beside its other
    outputs. The native executable gains `--vol FILE.csv`.
  - `@neurodesk/runtime-support` adds `readImageSeries`, which pairs each converted
    or supplied NIfTI with its BIDS sidecar.
  - `@neurodesk/webapp-components` adds the `.nd-viewer-report` panel and the
    `.nd-chart` vocabulary for small-multiple SVG charts.

### Patch Changes

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.
- ad92e2f: Merge upstream astewartau/qsmbly 2f91e83..d2afebc:

  - One numerical path: total- and local-field maps and QSMART run through the same config-driven qsm-core stages as raw phase, so the same settings give the same numbers whichever input they start from (#142). Field strength is always required; TGV and MEDI on a field map ask for its echo time.
  - TGV's regularization level decides its alphas from the first run, and the exported command names the alphas that ran (#142). V-SHARP and iLSQR defaults come from the generated qsm-core defaults (#131).
  - Deep-learning tile patches are capped at 120 voxels so they fit browser memory (#137).
  - Gzipped NIfTI masks and field maps are decoded with their scaling, and field-map voxel sizes set the defaults (#130). A 4D mask is refused instead of silently truncated.
  - The WASM module failing to load is reported instead of hanging, and Cancel during loading settles (#128). Mask paths report errors that used to fail silently (#126).
  - File names are escaped in the mask list and the import triage (#132). dicompare loads on first use, so an unreachable dicompare.neurodesk.org only disables the report (#130).
  - Accessibility: labelled controls, hidden-attribute settings panels, and dialogs that take focus, trap Tab, close on Escape and return focus (#133, #139; the shared ModalManager now does this for every app). Tagify is pinned to 4.39.0 with subresource integrity.
  - The shared decodeNiftiBuffer can stop after the header (`{ maxBytes }`).

- 850e642: Remove code that nothing calls, found by the unused-code report and checked by
  repository-wide reference searches. The shared preview module no longer carries
  a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
  behaviour are unchanged.

- ad92e2f: Merge upstream astewartau/qsmbly 2f91e83..d2afebc:

## 0.12.3

### Patch Changes

- Expose qform and sform codes from the shared NIfTI header parser so diagnostic messages and image geometry use the same interpretation.

## 0.12.2

### Patch Changes

- Preserve original operation failures while draining GPU error scopes and reject failed DICOM field fallback tasks without hanging. Resolve correctness findings with switch scopes, safe own-property checks, equivalent regular expressions and documented optional cleanup/cache behavior. Surface actionable release, filesystem and schema preload failures; retain scientific literals and arithmetic.

## 0.12.1

### Patch Changes

- Reuse the shared NIfTI-1 reader in the CALMAR command line. Honour both byte orders and disable intercept scaling when the slope is zero; preserve source byte order in derived images.

## 0.12.0

### Minor Changes

- 66bf9e9: Add the `brain2print` command line: `brain2print IMAGE OUTPUT_DIR` runs the web app's create-mesh operation in Node, with MindGrab on the CPU and the same niimath WebAssembly, and writes the web app's three downloads under the same names. Its options are the app's automation parameters: `--model`, `--backend` (the command line always runs on the CPU), `--simplify`, `--smooth`, `--[no-]largest-only` and `--[no-]fill-bubbles`. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check runs the app's pinned example, the template of the app's CPU e2e test and the right- and left-handed test fixtures, and requires every file to match the web pipeline's output in Chromium byte for byte; the app's CPU e2e test is held to the same pins.

  The app's pipeline moves into `@neurodesk/brain2print`, which the app and the command line share. The app now gives MindGrab NIfTI files as stored rather than as NiiVue rewrites them, and uses MindGrab 0.1.20260925. Breaking for `@neurodesk/topofit`: `readMz3`, `writeMz3` and `writeStl` are no longer exported from `@neurodesk/topofit/results`; import them from `@neurodesk/webapp-components/file-io/mesh`. The package is not published to npm and no workspace consumer imports them from TopoFit any more.

- 501ea0c: Remove the `@neurodesk/webapp-components/example-images` subpath export (`NIFTI_EXAMPLES`, `NIIMATH_EXAMPLE_BASE_URL`). Importing it now fails. No app has used it since examples moved to `examples.json`, and it pointed at unpinned NiiVue demo images; declare examples in an app's `examples.json` instead.

## 0.11.1

### Patch Changes

- 22aa4bf: Merge upstream astewartau/qsmbly 6e01b15..2f91e83:

  - Load the uploaded mask instead of just listing it (#110)
  - Fix multi-echo DICOM imports, image classification, and gzip file filters (#111)
  - Fix the settings modal saving values no control ever supplied (#112)
  - Add explicit mask alignment repair and anatomical overlays (#114)
  - Classify BIDS part-mag/part-phase images (#113)
  - Automatically preview mismatched masks on the reference image (#115)
  - Bump qsmxt-config to v9.22.0 (#109)
  - Add mouse brain masking (RS2-Net, with voxel-scaled BET fallback) (#116)

  RS2-Net weights (63 MB, GPL-3.0) come through the shared downloader from the pinned
  qsmxt/qsm-onnx-weights revision and are listed in the offline inventory. The shared file-io
  module gains `classifyImageComponent` and `sameNiftiGrid`. The shared dcm2niix runtime moves to
  @niivue/dcm2niix 1.3.20260724, which converts enhanced multi-echo DICOM into one image per echo.

## 0.11.0

### Minor Changes

- SpinalCordToolbox now uses the FreeBrowse viewer (NiiVue 1.0) that TopoFit uses, through one shared mount helper in `@neurodesk/runtime-support/freebrowse-viewer`. Zoom and pan work in 2D and 3D with the wheel, right-drag and two-finger pinch, and a reset restores the view. FreeBrowse supplies layout, intensity window, opacity, colormap and image download, so SCT's duplicate toolbar controls are gone; the viewer is served from the app, not a CDN.

  The log below the viewer can be enlarged by dragging its top edge or from the keyboard, and keeps an Analysis log (tasks, parameters, result summaries, warnings) apart from the Technical log. The shared `nd-console` gained `resizable` and `channels`.

  Compare shows up to four loaded images side by side with linked layout, zoom, pan and crosshair (matched in scanner millimetres), which can be unlinked for unregistered follow-up scans. Each image keeps its own results, edits and analysis inputs when you switch between them.

  The shared mask editor now edits results on the FreeBrowse viewer; edited files are named `_edited` and the approximate browser lesion metrics are withdrawn when a mask they used is edited. The vertebral-labeling port and its PAM50 templates are removed; TotalSpineSeg provides disc labels. The SCT app is prepared for the MS lesion model (`lesion_ms`), which stays unavailable until the converted model is hosted.

## 0.10.2

### Patch Changes

- 70f2770: Space the technical log's Copy and Clear buttons apart by grouping them in the shared `nd-console-actions` row; they had run together as "CopyClear". Remove the unused legacy `.console-clear` styles.

## 0.10.1

### Patch Changes

- Add SCT cord morphometry and standalone lesion analysis for uploaded, generated or manually edited masks, without an anatomy image. Analysis runs in the browser by default, executing the pinned, unchanged SCT 7.3 Python in a Pyodide worker, or optionally on a paired Neurodesk compute server in the pinned SCT Docker image. Both keep SCT's CSV, XLSX, pickle and labeled NIfTI outputs and show where results were computed, because WebAssembly floating-point results can differ from native SCT. Server jobs can be recovered, cancelled and deleted; browser runs cancel by terminating their worker. Automatic browser lesion metrics stay labelled approximate. Shared compute connections support selected tools and explicit HTTPS reverse-proxy addresses.

## 0.10.0

### Minor Changes

- ec85a09: Add a shared editor for correcting masks and label maps in the viewer. The `nd-mask-editor` element (`createMaskEditor`) is a second viewer toolbar row with Draw, Erase and Fill tools, a Label select for label maps, brush size, Undo, Apply and Cancel. It edits through NiiVue's drawing layer in both the 0.x and 1.0 generations (`createDrawingAdapter` in `@neurodesk/webapp-components/viewer`). Apply returns the result on its own grid as a uint8 NIfTI with the result's name. `createResultList` shows an Edit button for results marked `editable` and labels edited results. On NiiVue 1.0 rc.11 to rc.14 the adapter corrects a NiiVue load error that put masks on the wrong voxels of images with permuted axes, such as sagittal acquisitions.

  Cancellation waits for pending editor work and prevents a cancelled export from applying to a replacement result. Removing the editor releases its drawing session and keyboard listener. Editing rejects masks whose voxel dimensions or affine differ from the displayed image, and exports preserve the source mask's header and extensions.

### Patch Changes

- 0204fe1: Style the `.nd-edit-btn` result action wherever it appears. Apps that build their own result rows, rather than using `createResultList`, now get the same Edit button as the shared list.

## 0.9.0

### Minor Changes

- Share SynthSR and SynthSeg worker model acquisition through fetchModel. Verify cached and downloaded weights before use, reject oversized streams early, and replace corrupt cached weights within the same run. Preserve SynthSR local model files, pinned hashes, progress allocation and worker cancellation. Restore app-specific connection and recovery guidance when model requests fail.

## 0.8.0

### Minor Changes

- Share operation parameter schemas across browser and desktop automation. Both callers now use the same defaults, enum values, bounds, recursive arrays, decimal multiples and safe integer rules. Preserve MCP parameter metadata and bundle the validator for native ESM development, standalone releases and the composite catalog.

## 0.7.0

### Minor Changes

- Add the shared remote compute client and connection panel for NeSVoR, including paired job ownership, recovery, cancellation and Linux/NVIDIA standalone server setup instructions. Keep credentials out of local storage and show the current webapp origin in server startup commands. Preserve the desktop automation input grants alongside the explicitly configured compute-server origins.

### Patch Changes

- Retry example downloads and OME-Zarr reads that the host rate-limits (HTTP 429), honouring Retry-After, instead of failing the example.

## 0.6.2

### Patch Changes

- Add White matter lesions: FLAMeS lesion segmentation of a single FLAIR image in the browser, after SynthStrip brain extraction, with a lesion mask, probability map and lesion table. Result lists can mark a result as not viewable, which keeps its row and disables View.

## 0.6.1

### Patch Changes

- Use portable underscore MCP tool names, explicit input cardinality, and declared SynthSeg browser geometry limits for preflight validation. Preserve duplicate DICOM filenames during conversion, release viewer sessions when their windows close, and prevent cancellation/retry races.

  Resolve QSM voxel-dependent defaults for supplied masks before reconstruction, so generated-mask and supplied-mask runs produce the same output. Add complete Mac scientific validation commands and evidence checks. The SynthSeg GPU buffer ceiling remains unchanged.

## 0.6.0

### Minor Changes

- Expose typed operations across the application catalog, including multiple inputs, DICOM series selection, variable artifacts and viewer workflows. Share awaited processing and cancellation between each app and its agent adapter. Publish verified result reports and scientific provenance.

  Add bounded desktop viewer sessions and MCP controls using public viewer APIs. Native SynthSeg now reports per-label counts and physical volumes. Include real-model CPU checks and a Mac runner for Metal, WebGPU and buffer-planning evidence without raising the validated SynthSeg limit.

### Patch Changes

- 93381e8: Remove the static bottom bar (version, privacy sentence, duplicate More Apps and GitHub links) from the six inference-workspace apps. The shared app bar already shows the version and links, and Privacy has its own dialog. The unused `.app-footer` and `.nd-app-footer` rules leave the shared stylesheets and the hosted theme.
- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

  The shared example selector shows one short line once an example loads; the description and expected result moved to a tooltip beside the Example label. NiiMath gained the shared layout tabs and About dialog and no longer ships app CSS.

- 93381e8: Remove the static bottom bar (version, privacy sentence, duplicate More Apps and GitHub links) from the six inference-workspace apps. The shared app bar already shows the version and links, and Privacy has its own dialog. The unused `.app-footer` and `.nd-app-footer` rules leave the shared stylesheets and the hosted theme.

- 93381e8: Every app now opens on its workspace and shows live status only in the bottom bar: a short message, a progress bar, elapsed time and a cancel × that appears while a run can be cancelled. Start pages, landing overlays and welcome modals are gone, and their copy moved to About. Every app has a technical log below the viewer that starts collapsed. Sidebar help longer than 90 characters moved into info tooltips or About, and each sidebar has one primary action. `ProgressManager` now drives the design-system footer, including the elapsed counter and the cancel button.

## 0.5.0

### Minor Changes

- Publish versioned app automation contracts and checksummed run reports for brain extraction and SynthSeg. Add shared run identities, explicit completion and cancellation, and SynthSeg label-volume summaries. Generate browser jobs from the contracts and expose discovery, validation, asynchronous execution, cancellation and artifact resources through the desktop's local MCP server, with an optional native SynthSeg engine.

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

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.

- 4add8da: Let TopoFit users show multiple cortical meshes together and reveal them inside the 3D volume with an adjustable X-ray control.

## 0.1.4

### Patch Changes

- Add optional TopoFit mid-surface normals and flat cortical patches, matching OpenRecon's atlas eligibility, geodesic search, plane-fit criteria and local ribbon geometry. Export native-grid patch-and-normal QC, individual patch surfaces, paired geometry JSON, normals CSV and measurements; support hemisphere, radius, count, quality and native-grid ROI settings. Pin the fsaverage atlas on Hugging Face. Compare the geometry with OpenRecon on both full-resolution validation hemispheres.

  Keep anatomical surfaces in 3-Plane view and give registration sphere files the FreeSurfer parser extension for display. Remove the repeated sidebar warning and single-option contrast selector. Suppress consecutive duplicate technical-log messages across apps, including QSMbly and CALMaR, and report model-download progress when its percentage changes.

## 0.1.3

### Patch Changes

- Apply the shared design system and the registry-driven About and Cite dialogs. Every app now states that it is developed and hosted by the Neurodesk team, lists the packages under the hood, names the lightning.org ecosystem, and cites one paper per implemented method plus the Neurodesk platform paper. SynthSR, SYNcro, Deface, BrowserQC and NiiMath use the shared workspace vocabulary (compact sections, one scan picker, shared toolbar, status bar and dialogs).
