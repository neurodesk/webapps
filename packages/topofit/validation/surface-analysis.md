# Surface-analysis comparison, 14 September 2026

The JavaScript geometry was compared directly with the OpenRecon recipe using
`scripts/verify_patch_parity.py`. Both full-resolution controlled browser
hemispheres from the pinned TopoFit validation dataset passed. Each hemisphere
has 245,762 vertices and 491,520 faces.

The comparison requires local unit normals within 1e-10, identical mapped and
eroded cortex masks, identical selected vertex indices, and plane normals, RMS,
area and signed normal coherence within 1e-9. Three synthetic planes also check
triangle-to-voxel masks exactly. Curved synthetic cases require exact patch
membership. A perfectly planar case permits different rankings of numerically
tied candidates.

## Real reconstructed cortex

| Patch | Area, mm² | RMS, mm | Normal coherence |
| --- | ---: | ---: | ---: |
| LH01 | 149.511432 | 0.407652 | 0.959485628 |
| LH02 | 138.111057 | 0.320317 | 0.947653275 |
| LH03 | 168.316613 | 0.383922 | 0.948872109 |
| RH01 | 164.808119 | 0.314698 | 0.949394178 |
| RH02 | 155.059072 | 0.336236 | 0.948110412 |
| RH03 | 157.530376 | 0.374494 | 0.948343200 |

The complete analysis facade also wrote the paired geometry, normals CSV files,
patch surfaces and source-grid QC for this scan. These outputs stay in scratch
storage; no scan, subject surface or model is committed.

## Reference identity

Source recipe: https://github.com/neurodesk/neurocontainers/tree/main/recipes/topofit

| Source file | SHA-256 |
| --- | --- |
| topofit_core.py | `5f0524b571745595fb936365a4b978f503000474a691441c47a5f62bd90ed9e2` |
| topofit_geometry.py | `57514654ed4b64fe0fd706fd97beabec58f95e38482c09bd6eea6dd2e64390f4` |

The input surfaces are under `topofit/0.5.1/onnx-20260911/validation/browser/controlled/`
at Hugging Face revision `b438d1162e7192ca425ca47282b06fe62340c85a`.
`cortex-atlas.manifest.json` pins the packed atlas and original source checksums.

This validates the added geometry against OpenRecon on one reference scan. It
does not rerun or extend the existing neural-reconstruction validation. The browser
uses JSON instead of NPZ for local geometry and draws patch IDs in selectable
result rows rather than in the QC raster. Sulcal-middepth analysis is not added.

## Browser and interface checks

The production Chromium suite passed all 12 checks, including a replay of the
real reconstruction with the computed patch outputs. It verifies both registration
spheres, anatomical 3-Plane views, measured patch centering, native-grid QC,
CSV downloads, retained settings and invalid-input recovery. Desktop and phone
screenshots were inspected. The full 22-app build, interface audit, mobile suite,
shared workflow suite and real DICOM upload checks passed.

# Named search regions, 19 November 2026

`validation/region-check.mjs` maps both region atlases (`cortex-regions.manifest.json`)
onto the same controlled reconstruction and fails unless the mapping agrees with
anatomy and with itself. Wang 2015 and Desikan-Killiany are independent atlases,
so their agreement checks vertex order and hemisphere handling:

```bash
node packages/topofit/validation/region-check.mjs "$TMPDIR/topofit-region-check" \
  --output packages/topofit/validation/results/ds000001-regions.json
```

It downloads the pinned surfaces, the controlled input (for the QC grid) and both
atlases, and checks every SHA-256. The full run took 11 minutes on one core.

| Check | Gate | Left | Right |
| --- | --- | ---: | ---: |
| Wang V1 vertices | | 5,377 | 4,973 |
| Dice, Wang V1 vs DK pericalcarine | ≥ 0.30 | 0.431 | 0.505 |
| Same Dice on fsaverage itself | reported | 0.431 | 0.517 |
| V1 vertices in the DK occipital lobe | ≥ 0.95 | 1.000 | 1.000 |
| V1 centroid, fraction of the hemisphere's anterior-posterior extent from the back | ≤ 0.25 | 0.079 | 0.090 |
| V1 centroid distance from the midline, mm (hemisphere centroid) | less than hemisphere | 8.9 (28.8) | 6.1 (28.8) |
| V1 mid-surface centroid, scanner RAS mm | | (−11.8, −84.0, −33.0) | (3.2, −80.9, −33.1) |

Pericalcarine is the calcarine fundus strip while V1 extends onto the cuneus and
lingual gyrus, so the Dice is moderate on fsaverage too; the subject values match
fsaverage's within 0.012. On fsaverage, left V1 and right V1 share no vertex index,
so a hemisphere swap would drop the Dice to near 0. The script also requires:

- the whole-cortex search to reproduce the six patches tabulated above to 5e-7
  mm and mm² (the shared nearest-vertex lookup did not change the cortex mask);
- every vertex of every V1 patch to map to V1v or V1d (5 patches: LH 2, RH 3,
  areas 79–132 mm², RMS 0.27–0.48 mm);
- `lh.wang2015.annot` and `rh.wang2015.annot` to encode exactly the mapped labels.
  nibabel 5.3.3 reads both, with 26 colour-table entries and the same V1 counts.

Patches found per region at the defaults (10 mm radius, 3 per hemisphere, RMS
≤ 0.5 mm, area ≥ 25 % of the disc), left + right:

| Region | Patches | Region | Patches |
| --- | ---: | --- | ---: |
| Visual cortex (all mapped areas) | 3 + 3 | FEF | 1 + 0 |
| V1 | 2 + 3 | V1v / V1d | 1 + 2 / 1 + 0 |
| V2 | 1 + 1 | V2v / V2d | 0 + 1 / 1 + 0 |
| V3 | 1 + 1 | V3v / V3d | 1 + 1 / 0 + 0 |
| hV4 | 0 + 1 | VO1 | 0 + 0 |
| VO2 | 0 + 1 | PHC1 | 0 + 0 |
| PHC2 | 0 + 2 | TO1 | 1 + 0 |
| TO2 | 0 + 0 | LO1 | 0 + 1 |
| LO2 | 0 + 1 | V3A | 1 + 0 |
| V3B | 0 + 0 | IPS0 | 1 + 0 |
| IPS1 | 0 + 1 | IPS2 | 0 + 0 |
| IPS3 | 2 + 1 | IPS4, IPS5, SPL1 | 0 + 0 |
| Every lobe but the insula | 3 + 3 | Insula | 1 + 2 |
| Frontal pole, paracentral | 0 + 0 | Pericalcarine | 0 + 2 |

The other Desikan-Killiany regions give 1–3 patches per hemisphere
(`results/ds000001-regions.json`). No region failed for lack of eligible cortex;
the zeros are areas narrower than a 10 mm-radius patch that also passes the flatness
and 25 % area gates, so V3B and the small visual areas need a smaller radius.
A region's patch is limited by the region's edge, so its accepted area is often
near the 78.5 mm² minimum.

# Region views, 20 November 2026

The production app ran the hosted example (`sub-01_T1w.nii.gz`) in headless
Chromium with Search region V1 at the default patch settings. `topofit_region_mask.nii`
is unsigned 8-bit on the source grid (160 × 192 × 192):

| Label | Voxels | Centroid, scanner RAS mm |
| --- | ---: | --- |
| Left V1 (1) | 3,779 | (−10.9, −83.7, −31.9) |
| Right V1 (2) | 3,499 | (2.6, −80.3, −32.3) |

Both centroids lie within 1.4 mm of the V1 mid-surface centroids of the region
check above, at the occipital pole on each side of the midline. Viewing the
parcellation centred the crosshair on (−12, −84, −33) and (3, −81, −33). The
whole-cortex re-analysis after it listed the same outputs as before the mask was
added, without a mask or annotation. In the package tests the mask fills exactly
the ribbon of a flat sheet. Run against the previous commit on a synthetic sheet,
`cortex` and ROI searches, the QC images and every other file of a named-region
search were byte-identical.
