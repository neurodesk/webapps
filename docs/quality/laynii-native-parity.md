# LayNii WebAssembly Native Parity Evidence

This note records how the reference hashes and laminar profile expectations in
`apps/laynii/e2e/expected.json` were produced and verified against native LayNii v2.10.0.

## Pinned sources

- **Upstream source:** `layerfMRI/LAYNII` v2.10.0 (`9febedf0157740dc7987fa5098f3e53e70a1c915`, BSD-3-Clause)
- **Native container oracle:** `vnmd/laynii_2.10.0:20261012` (`vnmd/laynii_2.10.0@sha256:9a9a287d08705e92ef4bf14165b2d1bef703cc7d4b148081bebe43b201eaa112`)
- **Emscripten build image:** `itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d` (`SOURCE_DATE_EPOCH=1772668800`)
- **Committed WebAssembly binary:** `packages/laynii/wasm/laynii.wasm` (SHA-256 `07e8f803ccae46b883554c488bae0eaee31292e0d95eb115010507e58ee5f766`, verified reproducible via `bash packages/laynii/scripts/build.sh --check`)
- **Pinned example dataset commit:** `neurodeskorg/webapps@d2449b9ed41ae4d1e7fd8caa4142a5a64186b1bc` (`laynii/examples/`)

## Native reference commands

Executed inside `docker run --rm --network none -v "$WORK:/work" vnmd/laynii_2.10.0@sha256:9a9a287d08705e92ef4bf14165b2d1bef703cc7d4b148081bebe43b201eaa112`:

1. **Occipital cortex default equidistant 3-layer (`default-equidist-3`):**
   ```sh
   LN2_LAYERS -rim /work/Ding2016_occip_rim.nii.gz -nr_layers 3 -output /work/eq.nii
   LN2_PROFILE -input /work/Ding2016_occip_T2star.nii.gz -layers /work/eq_layers_equidist.nii -output /work/eq_profile.txt
   ```
   - `eq_layers_equidist.nii` SHA-256: `e35f5f57b1b448ff2a27d62e91f1fd988bf7c059bb3cc7ff848b35ccfc6a1134`
   - `eq_metric_equidist.nii` SHA-256: `778b3aa4b5e8124234183b6e373a5e78c8f51205936a4a3345005a7a1667028f`
   - Profile (`layer, mean, std, voxels`):
     - Layer 1 (WM): `130.203`, `11.3132`, `319887`
     - Layer 2 (Mid): `131.667`, `11.0116`, `221900`
     - Layer 3 (CSF): `148.285`, `12.4714`, `215808`

2. **Occipital cortex equivolume + thickness (`equivol-thickness-3`):**
   ```sh
   LN2_LAYERS -rim /work/Ding2016_occip_rim.nii.gz -nr_layers 3 -equivol -iter_smooth 100 -thickness -output /work/ev.nii
   LN2_PROFILE -input /work/Ding2016_occip_T2star.nii.gz -layers /work/ev_layers_equivol.nii -output /work/ev_profile.txt
   ```
   - `ev_layers_equivol.nii` SHA-256: `e6c97a7da415aa6b1f8455079803f78874bf9618a76734625bd6d642b88687f0`
   - `ev_thickness.nii` SHA-256: `c014987eb111579c3f1c7a76be311e2a50d7e3937e73d598876d50da13c9f7b7`

Both cases produced **0 header byte differences, 0 voxel mismatches, and `maxAbsDiff = 0.000e+0`** between the native container and `@neurodesk/laynii` WebAssembly.
