---
"dicomview": minor
"dicompare": patch
"white-matter-lesions": patch
"@neurodesk/webapp-components": minor
"@neurodesk/dicom2vid": patch
---

DICOM View's "Open in White matter lesions" button is now an "Open in another webapp"
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
