# dicomview

## 0.4.20261020

### Minor Changes

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

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/dicom2vid@0.5.20261020
  - @neurodesk/runtime-support@0.8.1

## 0.3.20261020

### Patch Changes

- 894b3a1: The Open in White matter lesions check reads a gzipped NIfTI's header through the shared streaming decoder instead of a fixed 64 KB prefix, so a valid `.nii.gz` whose header lies past the first 64 KB of compressed data is no longer refused as uncheckable.
- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [14b8248]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [1f4aecd]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]
- Updated dependencies [d1fa022]
  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/dicom2vid@0.5.20261020

## 0.3.20261018

### Minor Changes

- b68209b: DICOM View can open the selected image in White matter lesions. Open in White matter lesions, under the series, sends the converted 3D image, named as its download is, and the same tab opens White matter lesions with the image loaded and ready to segment. A time series or a single slice keeps the button disabled and says why. Choosing another series while a send is in progress cancels it. DICOM View's automation contract now gives its image artifact the `application/x-nifti` media type.

  White matter lesions loads an image sent from DICOM View on opening and reports "Loaded <name> from DICOM View" in the status bar. It never starts segmentation itself.

  `@neurodesk/webapp-components/handoff` passes files between apps on one site: `sendHandoff` stores them in IndexedDB and opens the target app; `takeHandoff` claims them once and returns copies. An entry can be opened for 2 minutes, only by the tab that sent it, and is deleted when it is opened. The app shell deletes expired entries whenever an app opens.

  The cross-origin isolation service worker bootstrap publishes `coiWillReload`, which resolves once a page knows whether it is about to reload, and `coiHoldReloads`, which stops later automatic reloads. Pages that use neither behave as before.

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/dicom2vid@0.5.20261018

## 0.2.20261018

### Minor Changes

- b8b37d6: A series conversion keeps running when another series is chosen; only a new input or the footer × ends it, so browsing a folder converts each series once instead of again on every switch.

  Convert all, in the Series section, converts every series one after another in the background, with progress in the status bar; the chosen series goes ahead of the queue and a converted series is marked in the list.

  Converted images and their anonymised sidecars are saved in the browser's origin private file system, keyed by a fingerprint of the series' content, so the same folder opens without dcm2niix after a reload. Clear saved removes them; a browser without that storage keeps the conversions in memory for the session. Privacy and About describe the saved images.

- b8b37d6: DICOM View shows the selected series in FreeBrowse instead of a bare NiiVue canvas. Its Volumes panel sets the contrast range (window and level), opacity and colormap, and its header switches between axial, coronal, sagittal, 3D and multiplanar layouts and between contrast and pan for right-drag. The panel starts open where it leaves the image uncovered and closed on narrow screens. The Image, Header and Protocol tabs above the viewer replace the 3-Plane, Axial, Coronal and Sagittal tabs. The image is listed under its download name, which carries no study date.

  The shared FreeBrowse viewer now runs FreeBrowse's development build (commit eae80a127f, vendored because it is not on npm) on NiiVue 1.0.0-rc.17. Wand fills in the Drawing panel can be undone. A volume's name in the Volumes and Surfaces panels is a button that Enter or Space selects, and the contrast, opacity and frame sliders are named for assistive technology. The eye button still hides a volume through its opacity, and now restores the opacity it had, until NiiVue releases volume visibility (niivue/mono#224).

### Patch Changes

- 67a5a8f: Downloaded and displayed BIDS sidecars are anonymised by dcm2niix: they no longer carry the patient's name, ID or birth date.

  Files without the DICOM preamble that start with their file meta group, including Implicit VR ones, and Deflated Explicit VR Little Endian files are now indexed and their headers shown.

  Protocol summaries send dicompare only each file's header, up to its pixel data, and move rather than copy those bytes into its worker, so a large folder no longer needs all its pixel data in memory twice.

  Cancelling while an image loads now stops the job in the status bar and keeps that image off screen; View loads it again.

  A compliance check that dicompare could not run for some or all acquisitions now ends with an error in the status bar instead of a success.

  The extra "Or choose a folder" field is gone; load a folder from the input menu's "Load folder…".

  Downloaded images and sidecars are named from the series number and description, such as `series2_t1_mpr.nii`, instead of dcm2niix's default, which carries the input folder name and the study date and time. Two series that would share a name, such as the same series from two studies, also get a short hash of their series UID.

  A protocol summary stops with an error naming the file count and size when the headers it would send dicompare pass 512 MB, and files that share a path no longer overwrite each other in dicompare.

  Choosing another series while an image still loads clears that image before the new one loads.

- Updated dependencies [67a5a8f]
- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/dicom2vid@0.5.20261018
  - @neurodesk/webapp-components@0.14.4

## 0.1.20261017

### Minor Changes

- New app: DICOM View opens a folder of DICOM files, lists its series, converts the chosen series with dcm2niix and shows it in NiiVue, explores every header element (nested sequences, private tags, the fields that vary across a series, the BIDS sidecar), and summarises the protocol or checks it against a dicompare schema in the browser.
