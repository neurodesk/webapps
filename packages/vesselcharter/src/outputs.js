// Deterministic output serializers shared identically by the browser app and CLI:
// summary.json, graph.json, segments.csv, junctions.csv, diameter-bins.csv,
// diameter-map.nii.gz, skeleton-labels.nii.gz, and 3D tubular vessel-tree.mz3.
import { writeMz3 } from '@neurodesk/webapp-components/file-io/mesh';
import { writeNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti-volume';
import { gzipBytes } from './volume.js';

function csvCell(value) {
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    return '';
  }
  const str = typeof value === 'number' ? Number(value.toFixed(6)).toString() : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (let i = 0; i < rows.length; i += 1) {
    lines.push(columns.map((col) => csvCell(rows[i][col])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function formatSegmentsCsv(segments) {
  const columns = [
    'segment_id',
    'component_id',
    'kind',
    'node_a',
    'node_b',
    'is_closed_loop',
    'touches_fov_boundary',
    'length_mm',
    'raw_length_mm',
    'chord_mm',
    'dm_tortuosity',
    'soam_rad_per_mm',
    'mean_diameter_mm',
    'median_diameter_mm',
    'iqr_diameter_mm',
    'min_diameter_mm',
    'max_diameter_mm',
    'sd_diameter_mm',
    'equiv_diameter_mm',
    'volume_mm3',
    'voxel_count',
    'sampled_length_mm',
    'crop_censored',
    'resolution_limited',
    'midpoint_x_mm',
    'midpoint_y_mm',
    'midpoint_z_mm',
  ];
  const rows = segments.map((s) => ({
    segment_id: s.id,
    component_id: s.componentId,
    kind: s.kind,
    node_a: s.nodeA,
    node_b: s.nodeB,
    is_closed_loop: s.isClosedLoop,
    touches_fov_boundary: s.touchesFovBoundary,
    length_mm: s.lengthMm,
    raw_length_mm: s.rawLengthMm,
    chord_mm: s.chordMm,
    dm_tortuosity: s.dmTortuosity,
    soam_rad_per_mm: s.soamRadPerMm,
    mean_diameter_mm: s.meanDiameterMm,
    median_diameter_mm: s.medianDiameterMm,
    iqr_diameter_mm: s.iqrDiameterMm,
    min_diameter_mm: s.minDiameterMm,
    max_diameter_mm: s.maxDiameterMm,
    sd_diameter_mm: s.sdDiameterMm,
    equiv_diameter_mm: s.equivDiameterMm,
    volume_mm3: s.volumeMm3,
    voxel_count: s.voxelCount,
    sampled_length_mm: s.sampledLengthMm,
    crop_censored: s.cropCensored,
    resolution_limited: s.resolutionLimited,
    midpoint_x_mm: s.midpointWorldMm[0],
    midpoint_y_mm: s.midpointWorldMm[1],
    midpoint_z_mm: s.midpointWorldMm[2],
  }));
  return toCsv(columns, rows);
}

export function formatJunctionsCsv(junctions) {
  const columns = [
    'junction_id',
    'component_id',
    'degree',
    'world_x_mm',
    'world_y_mm',
    'world_z_mm',
    'radius_mm',
    'touches_fov_boundary',
    'incident_segment_ids',
    'min_angle_deg',
    'max_angle_deg',
    'mean_angle_deg',
    'parent_inferred_from_caliber',
    'daughter_angle_deg',
    'area_expansion_ratio',
    'asymmetry_ratio',
    'murray_ratio_cubed',
  ];
  const rows = junctions.map((j) => ({
    junction_id: j.id,
    component_id: j.componentId,
    degree: j.degree,
    world_x_mm: j.worldMm[0],
    world_y_mm: j.worldMm[1],
    world_z_mm: j.worldMm[2],
    radius_mm: j.radiusMm,
    touches_fov_boundary: j.touchesFovBoundary,
    incident_segment_ids: j.incidentSegmentIds.join(';'),
    min_angle_deg: j.minAngleDeg,
    max_angle_deg: j.maxAngleDeg,
    mean_angle_deg: j.meanAngleDeg,
    parent_inferred_from_caliber: j.parentInferredFromCaliber,
    daughter_angle_deg: j.daughterAngleDeg,
    area_expansion_ratio: j.areaExpansionRatio,
    asymmetry_ratio: j.asymmetryRatio,
    murray_ratio_cubed: j.murrayRatioCubed,
  }));
  return toCsv(columns, rows);
}

export function formatDiameterBinsCsv(diameterBins) {
  const columns = [
    'bin_label',
    'min_mm',
    'max_mm',
    'segment_count',
    'total_length_mm',
    'length_fraction',
    'volume_mm3',
    'volume_fraction',
    'mean_dm_tortuosity',
    'resolution_limited',
  ];
  const rows = diameterBins.map((b) => ({
    bin_label: b.label,
    min_mm: b.minMm,
    max_mm: b.maxMm,
    segment_count: b.segmentCount,
    total_length_mm: b.totalLengthMm,
    length_fraction: b.lengthFraction,
    volume_mm3: b.volumeMm3,
    volume_fraction: b.volumeFraction,
    mean_dm_tortuosity: b.meanDmTortuosity,
    resolution_limited: b.resolutionLimited,
  }));
  return toCsv(columns, rows);
}

export function formatGraphJson(graph, segments, junctions, summary) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      directed: false,
      multigraph: true,
      units: 'mm',
      parameters: summary.parameters,
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        degree: n.degree,
        componentId: n.componentId,
        worldMm: n.worldMm.map((v) => Number(v.toFixed(4))),
        radiusMm: Number(n.maxEdtMm.toFixed(4)),
        touchesFovBoundary: n.touchesFov,
        incidentSegmentIds: n.incidentSegmentIds,
      })),
      edges: segments.map((s) => ({
        id: s.id,
        componentId: s.componentId,
        kind: s.kind,
        nodeA: s.nodeA,
        nodeB: s.nodeB,
        isClosedLoop: s.isClosedLoop,
        touchesFovBoundary: s.touchesFovBoundary,
        lengthMm: Number(s.lengthMm.toFixed(4)),
        rawLengthMm: Number(s.rawLengthMm.toFixed(4)),
        chordMm: Number(s.chordMm.toFixed(4)),
        dmTortuosity: s.dmTortuosity === null ? null : Number(s.dmTortuosity.toFixed(4)),
        soamRadPerMm: s.soamRadPerMm === null ? null : Number(s.soamRadPerMm.toFixed(5)),
        meanDiameterMm: Number(s.meanDiameterMm.toFixed(4)),
        medianDiameterMm: Number(s.medianDiameterMm.toFixed(4)),
        equivDiameterMm: Number(s.equivDiameterMm.toFixed(4)),
        volumeMm3: Number(s.volumeMm3.toFixed(4)),
        resolutionLimited: s.resolutionLimited,
        cropCensored: s.cropCensored,
        polylineWorldMm: s.worldPointsMm.map((p) => [
          Number(p[0].toFixed(3)),
          Number(p[1].toFixed(3)),
          Number(p[2].toFixed(3)),
        ]),
        radiiMm: s.sampleRadiiMm.map((r) => Number(r.toFixed(3))),
      })),
      junctions: junctions.map((j) => ({
        id: j.id,
        degree: j.degree,
        pairwiseAnglesDeg: j.pairwiseAnglesDeg.map((a) => Number(a.toFixed(2))),
        parentInferredFromCaliber: j.parentInferredFromCaliber,
        daughterAngleDeg: j.daughterAngleDeg === null ? null : Number(j.daughterAngleDeg.toFixed(2)),
        murrayRatioCubed: j.murrayRatioCubed === null ? null : Number(j.murrayRatioCubed.toFixed(4)),
      })),
    },
    null,
    2,
  ) + '\n';
}

// NiiVue's built-in perceptually smooth Turbo colormap control points so the
// standalone 3D mesh, 2D/3D NIfTI diameter map, and legend share one exact ramp.
export const TURBO_COLORMAP = Object.freeze({
  R: [48, 48, 64, 70, 65, 25, 132, 195, 244, 254, 218, 122],
  G: [18, 18, 64, 107, 150, 226, 255, 241, 199, 158, 57, 4],
  B: [59, 59, 162, 227, 255, 187, 81, 52, 58, 47, 7, 3],
  I: [0, 1, 16, 32, 49, 83, 118, 140, 164, 181, 219, 255],
});

export function sampleColormapRgba(cmap, t) {
  if (!cmap || !Array.isArray(cmap.R) || cmap.R.length === 0) {
    return [128, 128, 128, 255];
  }
  const indices = Array.isArray(cmap.I) && cmap.I.length === cmap.R.length
    ? cmap.I
    : cmap.R.map((_, i) => (cmap.R.length > 1 ? (i * 255) / (cmap.R.length - 1) : 0));
  const maxI = indices[indices.length - 1] || 255;
  const position = Math.max(0, Math.min(1, t)) * maxI;
  let high = 1;
  while (high < indices.length - 1 && indices[high] < position) {
    high += 1;
  }
  const low = Math.max(0, high - 1);
  const span = Math.max(1e-9, indices[high] - indices[low]);
  const u = Math.max(0, Math.min(1, (position - indices[low]) / span));
  return [
    Math.round(cmap.R[low] + u * (cmap.R[high] - cmap.R[low])),
    Math.round(cmap.G[low] + u * (cmap.G[high] - cmap.G[low])),
    Math.round(cmap.B[low] + u * (cmap.B[high] - cmap.B[low])),
    255,
  ];
}

function diameterColorRgba(diamMm, minD, maxD) {
  const span = Math.max(1e-6, maxD - minD);
  const t = (diamMm - minD) / span;
  return sampleColormapRgba(TURBO_COLORMAP, t);
}

function sortedQuantile(sorted, q) {
  if (sorted.length === 0) {
    return 0;
  }
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, Math.ceil(pos));
  const frac = pos - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

function roundSignificant(value, digits = 3) {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }
  return Number(value.toPrecision(digits));
}

/**
 * Computes a scale-invariant, outlier-robust display window [minMm, maxMm] for
 * vessel diameter maps and 3D trees. Keeps minMm strictly positive (and <= the
 * smallest positive sample) so 0 mm background stays transparent in NiiVue
 * without hiding real thin vessels, and caps maxMm at p95 only when extreme
 * upper outliers (> 1.5x p95) exist.
 */
export function computeDiameterDisplayRange(segments = [], diameterMap = null) {
  const values = [];
  for (let s = 0; s < segments.length; s += 1) {
    const radii = segments[s]?.sampleRadiiMm;
    if (!radii) continue;
    for (let i = 0; i < radii.length; i += 1) {
      const d = radii[i] * 2;
      if (Number.isFinite(d) && d > 0) {
        values.push(d);
      }
    }
  }
  if (values.length === 0 && diameterMap) {
    for (let i = 0; i < diameterMap.length; i += 1) {
      const d = diameterMap[i];
      if (Number.isFinite(d) && d > 0) {
        values.push(d);
      }
    }
  }
  if (values.length === 0) {
    return { minMm: 0.1, maxMm: 1, dataMinMm: 0, dataMaxMm: 1 };
  }
  values.sort((a, b) => a - b);
  const dataMinMm = values[0];
  const dataMaxMm = values[values.length - 1];
  const p02 = sortedQuantile(values, 0.02);
  const p95 = sortedQuantile(values, 0.95);
  const rawMin = Math.max(1e-4, Math.min(dataMinMm, p02 * 0.5));
  const rawMax = dataMaxMm > p95 * 1.5 ? p95 : dataMaxMm;
  const minMm = Math.max(1e-4, Math.min(rawMin, roundSignificant(rawMin, 3)));
  const maxMm = roundSignificant(Math.max(rawMax, minMm + 1e-3), 3);
  return {
    minMm,
    maxMm: maxMm > minMm ? maxMm : minMm + 1e-3,
    dataMinMm,
    dataMaxMm,
  };
}

function setNiftiDisplayRange(buffer, calMin, calMax) {
  if (!Number.isFinite(calMin) || !Number.isFinite(calMax) || calMax <= calMin) {
    return;
  }
  const view = new DataView(buffer);
  if (view.getInt32(0, true) === 540) {
    // NIfTI-2 header: cal_max at offset 192, cal_min at offset 200 (float64).
    view.setFloat64(192, calMax, true);
    view.setFloat64(200, calMin, true);
  } else {
    // NIfTI-1 header: cal_max at offset 124, cal_min at offset 128 (float32).
    view.setFloat32(124, calMax, true);
    view.setFloat32(128, calMin, true);
  }
}

function normalize3(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n <= 1e-9) {
    return [1, 0, 0];
  }
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Builds a compact 6-sided tubular 3D mesh (.mz3 with per-vertex RGBA diameter colors)
 * along all smoothed vessel centerlines for direct NiiVue 3D rendering.
 */
export function buildVesselTreeMz3(segments, { sides = 6, displayRange = null } = {}) {
  const validSegments = segments.filter((s) => s.worldPointsMm && s.worldPointsMm.length >= 2);
  if (validSegments.length === 0) {
    return null;
  }

  const range = displayRange ?? computeDiameterDisplayRange(validSegments);
  const minD = range.minMm;
  const maxD = range.maxMm;
  let totalRings = 0;
  let totalQuads = 0;

  for (let s = 0; s < validSegments.length; s += 1) {
    const seg = validSegments[s];
    const pts = seg.worldPointsMm;
    totalRings += pts.length;
    totalQuads += (pts.length - 1) * sides;
  }

  const vertices = new Float32Array(totalRings * sides * 3);
  const colors = new Uint8Array(totalRings * sides * 4);
  const faces = new Int32Array(totalQuads * 2 * 3);

  const cosA = new Float64Array(sides);
  const sinA = new Float64Array(sides);
  for (let k = 0; k < sides; k += 1) {
    const ang = (2 * Math.PI * k) / sides;
    cosA[k] = Math.cos(ang);
    sinA[k] = Math.sin(ang);
  }

  let vIdx = 0;
  let fIdx = 0;

  for (let s = 0; s < validSegments.length; s += 1) {
    const seg = validSegments[s];
    const pts = seg.worldPointsMm;
    const radii = seg.sampleRadiiMm;
    const baseRingStart = vIdx;
    let prevU = null;

    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const pPrev = pts[Math.max(0, i - 1)];
      const pNext = pts[Math.min(pts.length - 1, i + 1)];
      const tang = normalize3([pNext[0] - pPrev[0], pNext[1] - pPrev[1], pNext[2] - pPrev[2]]);

      let u;
      if (!prevU) {
        const ref = Math.abs(tang[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        u = normalize3(cross3(tang, ref));
      } else {
        // Parallel-transport frame to avoid tube twist along curves.
        const dot = prevU[0] * tang[0] + prevU[1] * tang[1] + prevU[2] * tang[2];
        const proj = [prevU[0] - dot * tang[0], prevU[1] - dot * tang[1], prevU[2] - dot * tang[2]];
        if (Math.hypot(proj[0], proj[1], proj[2]) < 1e-6) {
          const ref = Math.abs(tang[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
          u = normalize3(cross3(tang, ref));
        } else {
          u = normalize3(proj);
        }
      }
      prevU = u;
      const v = normalize3(cross3(tang, u));

      const rawRadius = radii[Math.min(i, radii.length - 1)] ?? seg.medianDiameterMm * 0.5;
      const tubeRadius = Math.max(0.12, rawRadius);
      const rgba = diameterColorRgba(rawRadius * 2, minD, maxD);

      for (let k = 0; k < sides; k += 1) {
        const ca = cosA[k] * tubeRadius;
        const sa = sinA[k] * tubeRadius;
        const vx = p[0] + ca * u[0] + sa * v[0];
        const vy = p[1] + ca * u[1] + sa * v[1];
        const vz = p[2] + ca * u[2] + sa * v[2];
        const vOff = vIdx * 3;
        vertices[vOff] = vx;
        vertices[vOff + 1] = vy;
        vertices[vOff + 2] = vz;
        const cOff = vIdx * 4;
        colors[cOff] = rgba[0];
        colors[cOff + 1] = rgba[1];
        colors[cOff + 2] = rgba[2];
        colors[cOff + 3] = rgba[3];
        vIdx += 1;
      }

      if (i > 0) {
        const r0 = baseRingStart + (i - 1) * sides;
        const r1 = baseRingStart + i * sides;
        for (let k = 0; k < sides; k += 1) {
          const kn = (k + 1) % sides;
          faces[fIdx] = r0 + k;
          faces[fIdx + 1] = r1 + k;
          faces[fIdx + 2] = r1 + kn;
          faces[fIdx + 3] = r0 + k;
          faces[fIdx + 4] = r1 + kn;
          faces[fIdx + 5] = r0 + kn;
          fIdx += 6;
        }
      }
    }
  }

  return new Uint8Array(writeMz3(vertices, faces, colors));
}

/**
 * Returns per-vertex local vessel diameter (mm) in the exact vertex order of
 * `buildVesselTreeMz3`, for interactive colormap and range updates in NiiVue.
 */
export function buildVesselTreeScalars(segments, { sides = 6 } = {}) {
  const validSegments = segments.filter((s) => s.worldPointsMm && s.worldPointsMm.length >= 2);
  if (validSegments.length === 0) {
    return null;
  }
  let totalRings = 0;
  for (let s = 0; s < validSegments.length; s += 1) {
    totalRings += validSegments[s].worldPointsMm.length;
  }
  const scalars = new Float32Array(totalRings * sides);
  let vIdx = 0;
  for (let s = 0; s < validSegments.length; s += 1) {
    const seg = validSegments[s];
    const pts = seg.worldPointsMm;
    const radii = seg.sampleRadiiMm;
    for (let i = 0; i < pts.length; i += 1) {
      const rawRadius = radii[Math.min(i, radii.length - 1)] ?? seg.medianDiameterMm * 0.5;
      const diamMm = Math.max(0, rawRadius * 2);
      for (let k = 0; k < sides; k += 1) {
        scalars[vIdx] = diamMm;
        vIdx += 1;
      }
    }
  }
  return scalars;
}

export function stemFromFilename(name = 'vessels.nii.gz') {
  return String(name)
    .replace(/\.nii\.gz$/i, '')
    .replace(/\.nii$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_') || 'vessels';
}

/**
 * Serializes all VesselCharter artifacts (byte-identical between browser and CLI).
 */
export async function buildOutputArtifacts(result, { baseName = 'vessels' } = {}) {
  const stem = stemFromFilename(baseName);
  const { summary, graph, segments, junctions, diameterMap, skeletonLabels, inputHeader, inputSpatial } = result;
  const dims = summary.input.dimensions;

  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  const graphText = formatGraphJson(graph, segments, junctions, summary);
  const segmentsCsv = formatSegmentsCsv(segments);
  const junctionsCsv = formatJunctionsCsv(junctions);
  const diameterBinsCsv = formatDiameterBinsCsv(summary.diameterBins);

  const displayRange = computeDiameterDisplayRange(segments, diameterMap);
  const diameterNiiRaw = writeNiftiVolume(
    {
      data: diameterMap,
      dims,
      affine: inputSpatial.rawAffine,
      transforms: inputHeader.transforms,
      version: inputHeader.version,
    },
    'VesselCharter diameter map (mm)',
  );
  setNiftiDisplayRange(diameterNiiRaw, displayRange.minMm, displayRange.maxMm);
  const diameterNiiGz = await gzipBytes(diameterNiiRaw);

  const skeletonNiiRaw = writeNiftiVolume(
    {
      data: skeletonLabels,
      dims,
      affine: inputSpatial.rawAffine,
      transforms: inputHeader.transforms,
      version: inputHeader.version,
    },
    'VesselCharter skeleton labels (1=seg,2=junc,3=end,4=iso)',
  );
  setNiftiDisplayRange(skeletonNiiRaw, 0.5, 4);
  const skeletonNiiGz = await gzipBytes(skeletonNiiRaw);

  const meshMz3 = buildVesselTreeMz3(segments, { displayRange });

  const encoder = new TextEncoder();
  const artifacts = {
    summary: {
      role: 'summary',
      name: `${stem}_vesselcharter_summary.json`,
      mediaType: 'application/json',
      bytes: encoder.encode(summaryText),
      text: summaryText,
    },
    graph: {
      role: 'graph',
      name: `${stem}_vesselcharter_graph.json`,
      mediaType: 'application/json',
      bytes: encoder.encode(graphText),
      text: graphText,
    },
    segments: {
      role: 'segments',
      name: `${stem}_vesselcharter_segments.csv`,
      mediaType: 'text/csv',
      bytes: encoder.encode(segmentsCsv),
      text: segmentsCsv,
    },
    junctions: {
      role: 'junctions',
      name: `${stem}_vesselcharter_junctions.csv`,
      mediaType: 'text/csv',
      bytes: encoder.encode(junctionsCsv),
      text: junctionsCsv,
    },
    diameterBins: {
      role: 'diameter-bins',
      name: `${stem}_vesselcharter_diameter_bins.csv`,
      mediaType: 'text/csv',
      bytes: encoder.encode(diameterBinsCsv),
      text: diameterBinsCsv,
    },
    diameterMap: {
      role: 'diameter-map',
      name: `${stem}_vesselcharter_diameter.nii.gz`,
      mediaType: 'application/gzip',
      bytes: diameterNiiGz,
    },
    skeletonLabels: {
      role: 'skeleton-labels',
      name: `${stem}_vesselcharter_skeleton.nii.gz`,
      mediaType: 'application/gzip',
      bytes: skeletonNiiGz,
    },
  };

  if (meshMz3) {
    artifacts.vesselMesh = {
      role: 'vessel-mesh',
      name: `${stem}_vesselcharter_tree.mz3`,
      mediaType: 'application/octet-stream',
      bytes: meshMz3,
    };
  }

  return artifacts;
}
