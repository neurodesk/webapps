# Human brain vessel data — IXI322

Subject: IXI322-IOP-0891-MRA.

Source: IXI vascular segmentation Dataset, Žiga Bizjak and colleagues.
https://github.com/zbizjak/IXI-vascular-segmentation-Dataset/tree/8f5f632fd0567e8770b09acd9057bdbb1a2ac6b9

The source segmentation and all derived IXI322 assets in this directory are licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International**.
https://creativecommons.org/licenses/by-nc-sa/4.0/

Citations:
- Žiga Bizjak, Aichi Chien, Iza Burnik, Žiga Špiclin. “Novel dataset and evaluation of state-of-the-art vessel segmentation methods.” Proc. SPIE 12032, Medical Imaging 2022: Image Processing, 120322X (2022). https://doi.org/10.1117/12.2611756
- Jannik Sobisch, Žiga Bizjak, Aichi Chien, Žiga Špiclin. “Automated intracranial vessel labeling with learning boosted by vessel connectivity, radii and spatial context.” PMLR 194:34–44 (2022). https://proceedings.mlr.press/v194/sobisch22a.html
- Original IXI acquisition project: https://brain-development.org/ixi-dataset/

Changes for Vessel Surfer: foreground binarization, canonical RAS reorientation and display-axis conversion; crop to foreground bounds; Gaussian smoothing with sigma 0.5 voxel; quantization to an 8-bit density field; surface extraction at 127.5; skeletonization of the largest connected region; rejection of links that leave the lumen; junction grouping and constrained smoothing of route coordinates. Navigation samples are additionally refined against the rendered triangles with a 0.015 mm inward margin; this moves only the navigation route, not the vessel geometry. No dilation, invented branches or connections across gaps. Smaller disconnected components are visible in the overview but are not part of the navigable route graph. This is a processed segmentation of human MRA data, not a clinically exact anatomical model.

The original segmentation is retained in `ixi322-vessels.nii.gz`. `ixi322.json` records the source checksum, geometry dimensions and processing. The reproducible conversion script is `scripts/prepare-human-network.py` in the app source. The derived assets retain this same CC BY-NC-SA 4.0 license. No endorsement by the dataset authors is implied.
