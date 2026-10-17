---
"dicomview": patch
---

Downloaded and displayed BIDS sidecars are anonymised by dcm2niix: they no longer carry the patient's name, ID or birth date.

Files without the DICOM preamble that start with their file meta group, including Implicit VR ones, and Deflated Explicit VR Little Endian files are now indexed and their headers shown.

Protocol summaries send dicompare only each file's header, up to its pixel data, and move rather than copy those bytes into its worker, so a large folder no longer needs all its pixel data in memory twice.

Cancelling while an image loads now stops the job in the status bar and keeps that image off screen; View loads it again.

A compliance check that dicompare could not run for some or all acquisitions now ends with an error in the status bar instead of a success.

The extra "Or choose a folder" field is gone; choose a folder from the input menu's "Choose folder…".

Downloaded images and sidecars are named from the series number and description, such as `series2_t1_mpr.nii`, instead of dcm2niix's default, which carries the input folder name and the study date and time.
