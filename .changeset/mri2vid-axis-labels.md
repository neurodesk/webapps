---
"mri2vid": patch
"@neurodesk/mri2vid": patch
---

Label the orientations Axis 1, 2 and 3 instead of axial, coronal and sagittal. They are array-axis reslices, so the plane names were only right for sagittal acquisitions. The orientation keys, command line values and automation parameters are unchanged. Downloads are named by axis.

Raise the video bitrate to 1 bit per pixel with a 2 Mbps floor (was 0.12 with a 1 Mbps floor). This reduces compression smoothing, most of all for upscaled frames.

Add licence notices for the bundled NiiVue and its dependencies, and the MIT text for the muxers.
