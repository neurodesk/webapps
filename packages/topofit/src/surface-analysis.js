import { erodeCortex, findPatches, surfaceNormals, validatePatchOptions } from './patches.js';
import { mapCortex, readCortexAtlas } from './cortex-atlas.js';
import { patchQc } from './analysis-qc.js';
import { roundEven } from './qc.js';
import { inverseAffine, readVolume } from './volume.js';
import { writeFreeSurfer } from './results.js';

const encoder = new TextEncoder();
const rows = (values, indices) => indices.map((i) => Array.from(values.subarray(i * 3, i * 3 + 3)));
const jsonFile = (id, name, value) => ({ id, name, mediaType: 'application/json', bytes: encoder.encode(`${JSON.stringify(value)}\n`).buffer });

export function readPatchRoi(buffer, source) {
  if (!buffer) return null;
  const roi = readVolume(buffer);
  if (roi.dims.some((size, i) => size !== source.dims[i]) || roi.affine.some((row, i) => row.some((v, j) => Math.abs(v - source.affine[i][j]) > 1e-5))) {
    throw new Error('Patch ROI must have the same shape and affine as the input scan.');
  }
  return roi;
}

export async function analyzeSurfaces({ source, vertices, faces, estimateNormals, patches: patchOptions, roi = null, loadAtlas, onProgress = () => {} }) {
  const files = [];
  const flatPatches = {};
  const geometries = {};
  const settings = patchOptions ? validatePatchOptions(patchOptions) : null;
  const atlas = settings ? readCortexAtlas(await loadAtlas()) : null;
  let eligibleFaceCount = 0;
  for (const hemisphere of ['lh', 'rh']) {
    const white = vertices[`${hemisphere}.white`];
    const pial = vertices[`${hemisphere}.pial`];
    const { middle, normals } = surfaceNormals(white, pial, faces[hemisphere]);
    if (estimateNormals) {
      const csv = ['vertex,x_ras_mm,y_ras_mm,z_ras_mm,nx_ras,ny_ras,nz_ras'];
      for (let i = 0; i < middle.length / 3; i += 1) csv.push([i, ...middle.subarray(i * 3, i * 3 + 3), ...normals.subarray(i * 3, i * 3 + 3)].join(','));
      files.push({ id: `${hemisphere}-normals`, name: `${hemisphere}.mid.normals.csv`, mediaType: 'text/csv', bytes: encoder.encode(`${csv.join('\n')}\n`).buffer });
    }
    if (!settings || !['both', hemisphere].includes(settings.hemisphere)) continue;
    onProgress(`Finding ${hemisphere === 'lh' ? 'left' : 'right'} cortical patches…`);
    let eligible = mapCortex(vertices[`${hemisphere}.registration`], atlas, hemisphere);
    eligible = erodeCortex(middle, faces[hemisphere], eligible);
    const inverse = roi ? inverseAffine(roi.affine) : null;
    for (let i = 0; i < eligible.length; i += 1) {
      if (Math.hypot(...[0, 1, 2].map((axis) => pial[i * 3 + axis] - white[i * 3 + axis])) < 0.5) eligible[i] = 0;
      if (roi && eligible[i]) {
        const voxel = inverse.slice(0, 3).map((row) => roundEven(row[3] + row.slice(0, 3).reduce((sum, v, axis) => sum + v * middle[i * 3 + axis], 0)));
        const inside = voxel.every((v, axis) => v >= 0 && v < roi.dims[axis]);
        if (!inside || !(roi.data[voxel[0] + roi.dims[0] * (voxel[1] + roi.dims[1] * voxel[2])] > 0)) eligible[i] = 0;
      }
    }
    for (let f = 0; f < faces[hemisphere].length; f += 3) {
      if (faces[hemisphere].subarray(f, f + 3).every((i) => eligible[i])) eligibleFaceCount += 1;
    }
    const candidates = findPatches(middle, faces[hemisphere], eligible, settings);
    for (const [index, patch] of candidates.entries()) {
      const id = `${hemisphere.toUpperCase()}${String(index + 1).padStart(2, '0')}`;
      const separation = patch.indices.map((i) => Math.hypot(...[0, 1, 2].map((axis) => pial[i * 3 + axis] - white[i * 3 + axis]))).sort((a, b) => a - b);
      const direction = [0, 1, 2].map((axis) => patch.indices.reduce((sum, i) => sum + pial[i * 3 + axis] - white[i * 3 + axis], 0));
      const sign = patch.normal.reduce((sum, v, axis) => sum + v * direction[axis], 0) < 0 ? -1 : 1;
      const normal = patch.normal.map((v) => v * sign);
      flatPatches[id] = {
        patch_id: id,
        surface: `${hemisphere}.mid`,
        center_ras_mm: patch.center,
        center_vertex_index: patch.centerVertexIndex,
        normal_ras: normal,
        center_lps_mm: patch.center.map((v, axis) => axis < 2 ? -v : v),
        normal_lps: normal.map((v, axis) => axis < 2 ? -v : v),
        radius_mm: settings.radius,
        area_mm2: patch.area,
        rms_distance_mm: patch.rms,
        normal_coherence: patch.coherence,
        score: patch.score,
        vertex_count: patch.indices.length,
        median_ribbon_separation_mm: (separation[Math.floor((separation.length - 1) / 2)] + separation[Math.floor(separation.length / 2)]) / 2,
      };
      const local = new Map(patch.indices.map((v, i) => [v, i]));
      const localFaces = Int32Array.from(patch.faces, (v) => local.get(v));
      geometries[id] = {
        vertex_indices: patch.indices,
        faces: Array.from({ length: localFaces.length / 3 }, (_, i) => Array.from(localFaces.subarray(i * 3, i * 3 + 3))),
        white_ras_mm: rows(white, patch.indices),
        mid_ras_mm: rows(middle, patch.indices),
        pial_ras_mm: rows(pial, patch.indices),
        normals_ras: rows(normals, patch.indices),
        ribbon_separation_mm: patch.indices.map((i) => Math.hypot(...[0, 1, 2].map((axis) => pial[i * 3 + axis] - white[i * 3 + axis]))),
      };
      files.push({ id, name: `${id}.mid.white`, mediaType: 'application/vnd.freesurfer.surface', bytes: writeFreeSurfer(Float64Array.from(geometries[id].mid_ras_mm.flat()), localFaces) });
    }
  }
  if (settings && !eligibleFaceCount) throw new Error(roi ? 'ROI contains no eligible cortical patch.' : 'No eligible cortical faces in the requested hemisphere.');
  const analysis = {
    depth_fraction: 0.5,
    coordinate_system: 'Scanner RAS (positions in mm; normals dimensionless)',
    patch_center_method: 'Mid-surface member vertex nearest the area-weighted patch centroid',
    patch_normal_method: 'Unit fitted-plane normal, oriented white-to-pial',
    normal_method: 'Area-weighted mid-surface vertex normals, oriented white-to-pial',
    flat_patch_definition: settings ? { schema_version: 2, ...settings, cortex_mask: 'fsaverage_cortex_via_registration', medial_wall_margin_mm: 5, min_ribbon_separation_mm: 0.5, min_normal_coherence: 0.9, region: roi ? 'roi' : 'cortex' } : null,
    flat_patch_status: settings ? Object.keys(flatPatches).length ? 'PATCHES_FOUND' : 'NO_PATCH_MEETS_CRITERIA' : 'NOT_REQUESTED',
    flat_patches: flatPatches,
  };
  if (settings) {
    const csv = ['patch_id,surface,center_vertex_index,x_ras_mm,y_ras_mm,z_ras_mm,nx_ras,ny_ras,nz_ras,area_mm2,rms_distance_mm'];
    for (const patch of Object.values(flatPatches)) {
      csv.push([patch.patch_id, patch.surface, patch.center_vertex_index, ...patch.center_ras_mm, ...patch.normal_ras, patch.area_mm2, patch.rms_distance_mm].join(','));
    }
    files.push({ id: 'patch-coordinates', name: 'topofit_patch_coordinates_ras.csv', mediaType: 'text/csv', bytes: encoder.encode(`${csv.join('\n')}\n`).buffer });
    files.push(jsonFile('patch-geometry', 'topofit_patch_geometry.json', { depth_fraction: 0.5, patches: geometries }));
    if (Object.keys(flatPatches).length) {
      files.push({ id: 'patch-qc', name: 'topofit_patch_qc.nii', mediaType: 'application/nifti', bytes: patchQc(source, geometries, flatPatches) });
    }
  }
  files.push(jsonFile('surface-analysis', 'topofit_surface_analysis.json', analysis));
  return { files, analysis };
}
