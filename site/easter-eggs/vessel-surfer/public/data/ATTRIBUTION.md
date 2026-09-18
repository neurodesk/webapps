# Human pial artery data — Bollmann et al. (2022)

Subject 02, whole-brain 7T time-of-flight angiography at 140 µm isotropic resolution, pial artery segmentation.

Source file: `arteries_seg_TOF_hm_xpace_140um_MoCoOn_20200220145234_7_biasCor_noiseCor_VT450_lVT370_VENP10.nii.gz` from the OSF project "Imaging of the Pial Arterial Vasculature", folder `Subject_02/seg`.
https://doi.org/10.17605/OSF.IO/NR6GC

Citation:
- Saskia Bollmann, Hendrik Mattern, Michaël Bernier, Simon D. Robinson, Daniel Park, Oliver Speck, Jonathan R. Polimeni. "Imaging of the pial arterial vasculature of the human brain in vivo using high-resolution 7T time-of-flight angiography." *eLife* 2022;11:e71186. https://doi.org/10.7554/eLife.71186

License: the OSF project does not declare a data license. The eLife article is published under CC BY 4.0. Please consult the OSF project for the data terms. This is a processed segmentation of anonymised human MRA data collected with informed consent for public sharing, not a clinically exact anatomical model, and no endorsement by the authors is implied.

Changes for Vessel Surfer: canonical RAS reorientation and display-axis conversion; crop to foreground bounds; Gaussian smoothing with sigma 0.5 voxel; quantization to an 8-bit density field of the largest connected component at native 140 µm resolution; surface extraction at 127.5 for the three largest components; skeletonization of the largest connected region; rejection of links that leave the lumen; junction grouping and constrained smoothing of route coordinates. Navigation samples are additionally refined against the rendered triangles with a 0.015 mm inward margin and branches too thin to hold that clearance are excluded from the route graph; this moves only the navigation route, not the vessel geometry. No dilation, invented branches or connections across gaps. Smaller disconnected components are visible in the overview but are not part of the navigable route graph.

The original segmentation is retained in the pinned Hugging Face dataset as `source.nii.gz`. `brain.json` records the source checksum, geometry dimensions and processing. The reproducible conversion script is `scripts/prepare-human-network.py` in the app source.
