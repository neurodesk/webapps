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

// Perceptually uniform Plasma-inspired RGB ramp (5 stops) for 3D diameter coloring.
const COLOR_STOPS = [
  [0.0, 28, 72, 180],
  [0.25, 42, 165, 195],
  [0.5, 92, 200, 118],
  [0.75, 245, 188, 52],
  [1.0, 232, 68, 48],
];

function diameterColorRgba(diamMm, minD, maxD) {
  const span = Math.max(1e-6, maxD - minD);
  const t = Math.max(0, Math.min(1, (diamMm - minD) / span));
  for (let i = 1; i < COLOR_STOPS.length; i += 1) {
    if (t <= COLOR_STOPS[i][0]) {
      const a = COLOR_STOPS[i - 1];
      const b = COLOR_STOPS[i];
      const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
      return [
        Math.round(a[1] + u * (b[1] - a[1])),
        Math.round(a[2] + u * (b[2] - a[2])),
        Math.round(a[3] + u * (b[3] - a[3])),
        255,
      ];
    }
  }
  return [232, 68, 48, 255];
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
export function buildVesselTreeMz3(segments, { sides = 6 } = {}) {
  const validSegments = segments.filter((s) => s.worldPointsMm && s.worldPointsMm.length >= 2);
  if (validSegments.length === 0) {
    return null;
  }

  let minD = Infinity;
  let maxD = 0;
  let totalRings = 0;
  let totalQuads = 0;

  for (let s = 0; s < validSegments.length; s += 1) {
    const seg = validSegments[s];
    const pts = seg.worldPointsMm;
    totalRings += pts.length;
    totalQuads += (pts.length - 1) * sides;
    for (let i = 0; i < seg.sampleRadiiMm.length; i += 1) {
      const d = seg.sampleRadiiMm[i] * 2;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
  }
  if (!Number.isFinite(minD)) {
    minD = 0;
  }
  if (maxD <= minD) {
    maxD = minD + 1;
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

      const r = Math.max(0.12, radii[Math.min(i, radii.length - 1)] ?? seg.medianDiameterMm * 0.5);
      const rgba = diameterColorRgba(r * 2, minD, maxD);

      for (let k = 0; k < sides; k += 1) {
        const ca = cosA[k] * r;
        const sa = sinA[k] * r;
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
  const skeletonNiiGz = await gzipBytes(skeletonNiiRaw);

  const meshMz3 = buildVesselTreeMz3(segments);

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
