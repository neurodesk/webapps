# RL-TV against DeconvolutionLab2

A qualitative check of the RL-TV regulariser against an independent implementation:
DeconvolutionLab2 (Sage et al. 2017; GPL-3.0, run in a container as an external
reference, nothing of it ships). `run.sh` regenerates `../rltv-dl2.json`.

1. `phantom.py` draws a 36 × 56 × 56 phantom (three spheres and a bar, zero background
   so the boundary condition cannot matter), blurs it with this package's Gibson-Lanni
   widefield PSF (NA 1.4, 520 nm, 100 nm × 200 nm voxels, 13 × 15 × 15) and adds Poisson
   noise with a fixed seed.
2. `ours.mjs` runs RL and RL-TV with the committed WebAssembly module.
3. DeconvolutionLab2 runs RL and RLTV on the same TIFFs with `-norm 1`. Its PSF origin is
   one voxel from scipy's `mode="same"` centre, so it is given the PSF rolled by one voxel
   per axis; it starts from the image instead of a constant.
4. `compare.py` reports, inside the PSF half-width of the border, the correlation of the
   two results and each one's RMSE against the phantom.

The two do not agree voxel for voxel (different starting estimate and boundary handling);
the check is that both regularise the same way: RL-TV lowers the error against the
phantom in both, by similar amounts at 30 iterations.

Requirements: Docker, Node 22, and the Python packages in `../requirements.txt`.
