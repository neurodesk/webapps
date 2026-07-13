/*
 * Browser-local subset of SCT lesion analysis for SCIseg outputs.
 *
 * The worker passes RAS-space binary masks. Metrics are computed after
 * restricting the lesion mask to the spinal-cord mask, matching the relevant
 * `sct_analyze_lesion -m lesion -s cord` contract for browser use.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SCTLesionAnalysis = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE_COLUMNS = [
    'row_type',
    'lesion_id',
    'voxel_count',
    'volume_mm3',
    'length_mm',
    'max_width_mm',
    'max_equivalent_diameter_mm',
    'max_axial_damage_ratio',
    'midsagittal_x',
    'midsagittal_length_mm',
    'midsagittal_width_mm',
    'dorsal_bridge_width_mm',
    'ventral_bridge_width_mm',
    'total_bridge_width_mm',
    'dorsal_bridge_ratio',
    'ventral_bridge_ratio',
    'total_bridge_ratio',
    'lesion_count',
    'total_volume_mm3',
    'total_length_mm',
    'summary_max_width_mm'
  ];

  function idx(x, y, z, dims) {
    return x + y * dims[0] + z * dims[0] * dims[1];
  }

  function roundMetric(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 1e6) / 1e6;
  }

  function restrictLesionToCord(lesion, spinalCord) {
    const out = new Uint8Array(lesion.length);
    for (let i = 0; i < lesion.length; i++) {
      if (lesion[i] > 0 && spinalCord[i] > 0) out[i] = 1;
    }
    return out;
  }

  function connectedComponents3D(binaryMask, dims) {
    const [nx, ny, nz] = dims;
    const labels = new Int32Array(binaryMask.length);
    let nextLabel = 0;
    const queue = [];
    const offsets = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          offsets.push([dx, dy, dz]);
        }
      }
    }

    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const start = idx(x, y, z, dims);
          if (!binaryMask[start] || labels[start]) continue;
          nextLabel++;
          labels[start] = nextLabel;
          queue.length = 0;
          queue.push([x, y, z]);
          for (let qi = 0; qi < queue.length; qi++) {
            const [qx, qy, qz] = queue[qi];
            for (const [dx, dy, dz] of offsets) {
              const nx2 = qx + dx;
              const ny2 = qy + dy;
              const nz2 = qz + dz;
              if (nx2 < 0 || nx2 >= nx || ny2 < 0 || ny2 >= ny || nz2 < 0 || nz2 >= nz) continue;
              const nIdx = idx(nx2, ny2, nz2, dims);
              if (!binaryMask[nIdx] || labels[nIdx]) continue;
              labels[nIdx] = nextLabel;
              queue.push([nx2, ny2, nz2]);
            }
          }
        }
      }
    }

    return { labels, numComponents: nextLabel };
  }

  function cordAreaBySlice(spinalCord, dims) {
    const [nx, ny, nz] = dims;
    const areas = new Int32Array(nz);
    for (let z = 0; z < nz; z++) {
      let count = 0;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (spinalCord[idx(x, y, z, dims)] > 0) count++;
        }
      }
      areas[z] = count;
    }
    return areas;
  }

  function estimateMidsagittalX(spinalCord, dims, zMin, zMax) {
    const [nx, ny] = dims;
    let sumX = 0;
    let count = 0;
    for (let z = zMin; z <= zMax; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (spinalCord[idx(x, y, z, dims)] > 0) {
            sumX += x;
            count++;
          }
        }
      }
    }
    return count > 0 ? sumX / count : (nx - 1) / 2;
  }

  function sagittalLesionExtent(labels, component, dims, x, z) {
    const ny = dims[1];
    let yMin = Infinity;
    let yMax = -Infinity;
    let count = 0;
    for (let y = 0; y < ny; y++) {
      if (labels[idx(x, y, z, dims)] === component) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
        count++;
      }
    }
    return count > 0 ? { yMin, yMax, count } : null;
  }

  function sagittalCordExtent(spinalCord, dims, x, z) {
    const ny = dims[1];
    let yMin = Infinity;
    let yMax = -Infinity;
    let count = 0;
    for (let y = 0; y < ny; y++) {
      if (spinalCord[idx(x, y, z, dims)] > 0) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
        count++;
      }
    }
    return count > 0 ? { yMin, yMax, count } : null;
  }

  function interpolateBridge(columns, xMid) {
    if (columns.length === 0) return null;
    const sorted = [...columns].sort((a, b) => a.x - b.x);
    let lower = sorted[0];
    let upper = sorted[sorted.length - 1];
    for (const column of sorted) {
      if (column.x <= xMid) lower = column;
      if (column.x >= xMid) {
        upper = column;
        break;
      }
    }
    if (lower.x === upper.x) return lower;
    const frac = (xMid - lower.x) / (upper.x - lower.x);
    const lerp = (a, b) => a + frac * (b - a);
    return {
      x: xMid,
      dorsal: lerp(lower.dorsal, upper.dorsal),
      ventral: lerp(lower.ventral, upper.ventral),
      total: lerp(lower.total, upper.total),
      cordWidth: lerp(lower.cordWidth, upper.cordWidth)
    };
  }

  function computeBridgeColumns(labels, component, spinalCord, dims, spacing, zMin, zMax) {
    const [nx] = dims;
    const sy = spacing[1] || 1;
    const columns = [];
    for (let x = 0; x < nx; x++) {
      let dorsal = Infinity;
      let ventral = Infinity;
      let total = Infinity;
      let cordWidth = Infinity;
      let hasLesion = false;
      for (let z = zMin; z <= zMax; z++) {
        const lesionExtent = sagittalLesionExtent(labels, component, dims, x, z);
        if (!lesionExtent) continue;
        const cordExtent = sagittalCordExtent(spinalCord, dims, x, z);
        if (!cordExtent) continue;
        hasLesion = true;
        const d = Math.max(0, lesionExtent.yMin - cordExtent.yMin) * sy;
        const v = Math.max(0, cordExtent.yMax - lesionExtent.yMax) * sy;
        const width = (cordExtent.yMax - cordExtent.yMin + 1) * sy;
        dorsal = Math.min(dorsal, d);
        ventral = Math.min(ventral, v);
        total = Math.min(total, d + v);
        cordWidth = Math.min(cordWidth, width);
      }
      if (hasLesion) {
        columns.push({ x, dorsal, ventral, total, cordWidth });
      }
    }
    return columns;
  }

  function computeMidsagittalMetrics(labels, component, dims, spacing, xMid, zMin, zMax) {
    const nearestX = Math.max(0, Math.min(dims[0] - 1, Math.round(xMid)));
    const sy = spacing[1] || 1;
    const sz = spacing[2] || 1;
    let sliceCount = 0;
    let maxWidth = 0;
    for (let z = zMin; z <= zMax; z++) {
      const extent = sagittalLesionExtent(labels, component, dims, nearestX, z);
      if (!extent) continue;
      sliceCount++;
      maxWidth = Math.max(maxWidth, (extent.yMax - extent.yMin + 1) * sy);
    }
    return {
      midsagittalLength: sliceCount * sz,
      midsagittalWidth: maxWidth
    };
  }

  function analyzeComponent(labels, component, spinalCord, dims, spacing, cordAreas) {
    const [nx, ny, nz] = dims;
    const [sx, sy, sz] = spacing;
    const voxelVolume = (sx || 1) * (sy || 1) * (sz || 1);
    const axialArea = (sx || 1) * (sy || 1);
    const sliceCounts = new Int32Array(nz);
    let count = 0;
    let zMin = Infinity;
    let zMax = -Infinity;
    let yWidthBySlice = new Map();

    for (let z = 0; z < nz; z++) {
      let yMin = Infinity;
      let yMax = -Infinity;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (labels[idx(x, y, z, dims)] !== component) continue;
          count++;
          sliceCounts[z]++;
          if (z < zMin) zMin = z;
          if (z > zMax) zMax = z;
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
      }
      if (sliceCounts[z] > 0) {
        yWidthBySlice.set(z, (yMax - yMin + 1) * (sy || 1));
      }
    }

    let maxWidth = 0;
    let maxAxialVoxels = 0;
    let maxAxialDamageRatio = 0;
    let zSliceCount = 0;
    for (let z = 0; z < nz; z++) {
      if (sliceCounts[z] === 0) continue;
      zSliceCount++;
      maxWidth = Math.max(maxWidth, yWidthBySlice.get(z) || 0);
      maxAxialVoxels = Math.max(maxAxialVoxels, sliceCounts[z]);
      if (cordAreas[z] > 0) {
        maxAxialDamageRatio = Math.max(maxAxialDamageRatio, sliceCounts[z] / cordAreas[z]);
      }
    }

    const xMid = estimateMidsagittalX(spinalCord, dims, zMin, zMax);
    const bridgeColumns = computeBridgeColumns(labels, component, spinalCord, dims, spacing, zMin, zMax);
    const bridge = interpolateBridge(bridgeColumns, xMid) || { dorsal: 0, ventral: 0, total: 0, cordWidth: 0 };
    const midsagittal = computeMidsagittalMetrics(labels, component, dims, spacing, xMid, zMin, zMax);

    const row = {
      row_type: 'lesion',
      lesion_id: component,
      voxel_count: count,
      volume_mm3: roundMetric(count * voxelVolume),
      length_mm: roundMetric(zSliceCount * (sz || 1)),
      max_width_mm: roundMetric(maxWidth),
      max_equivalent_diameter_mm: roundMetric(2 * Math.sqrt((maxAxialVoxels * axialArea) / Math.PI)),
      max_axial_damage_ratio: roundMetric(maxAxialDamageRatio),
      midsagittal_x: roundMetric(xMid),
      midsagittal_length_mm: roundMetric(midsagittal.midsagittalLength),
      midsagittal_width_mm: roundMetric(midsagittal.midsagittalWidth),
      dorsal_bridge_width_mm: roundMetric(bridge.dorsal),
      ventral_bridge_width_mm: roundMetric(bridge.ventral),
      total_bridge_width_mm: roundMetric(bridge.total),
      dorsal_bridge_ratio: roundMetric(bridge.cordWidth > 0 ? bridge.dorsal / bridge.cordWidth : 0),
      ventral_bridge_ratio: roundMetric(bridge.cordWidth > 0 ? bridge.ventral / bridge.cordWidth : 0),
      total_bridge_ratio: roundMetric(bridge.cordWidth > 0 ? bridge.total / bridge.cordWidth : 0)
    };

    for (const column of bridgeColumns) {
      const prefix = `sagittal_x_${column.x}`;
      row[`${prefix}_dorsal_bridge_width_mm`] = roundMetric(column.dorsal);
      row[`${prefix}_ventral_bridge_width_mm`] = roundMetric(column.ventral);
      row[`${prefix}_total_bridge_width_mm`] = roundMetric(column.total);
    }

    return row;
  }

  function buildCsv(rows, summary) {
    const dynamicColumns = [...new Set(rows.flatMap(row => Object.keys(row).filter(key => key.startsWith('sagittal_x_'))))]
      .sort((a, b) => {
        const ax = Number(a.match(/^sagittal_x_(\d+)/)?.[1] || 0);
        const bx = Number(b.match(/^sagittal_x_(\d+)/)?.[1] || 0);
        return ax === bx ? a.localeCompare(b) : ax - bx;
      });
    const columns = [...BASE_COLUMNS, ...dynamicColumns];
    const summaryRow = {
      row_type: 'summary',
      lesion_count: summary.lesion_count,
      total_volume_mm3: summary.total_volume_mm3,
      total_length_mm: summary.total_length_mm,
      summary_max_width_mm: summary.max_width_mm
    };
    const allRows = [...rows, summaryRow];
    const escapeCsv = value => {
      if (value == null) return '';
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [
      columns.join(','),
      ...allRows.map(row => columns.map(column => escapeCsv(row[column])).join(','))
    ].join('\n');
  }

  function analyzeLesions({ lesion, spinalCord, dims, spacing }) {
    if (!lesion || !spinalCord || !dims) {
      throw new Error('lesion, spinalCord, and dims are required');
    }
    const voxelCount = dims[0] * dims[1] * dims[2];
    if (lesion.length !== voxelCount || spinalCord.length !== voxelCount) {
      throw new Error(`Mask length mismatch for dims ${dims.join('x')}`);
    }
    const safeSpacing = Array.isArray(spacing) ? spacing.map(value => Number(value) || 1) : [1, 1, 1];
    const restricted = restrictLesionToCord(lesion, spinalCord);
    const { labels, numComponents } = connectedComponents3D(restricted, dims);
    const cordAreas = cordAreaBySlice(spinalCord, dims);
    const rows = [];
    for (let component = 1; component <= numComponents; component++) {
      rows.push(analyzeComponent(labels, component, spinalCord, dims, safeSpacing, cordAreas));
    }

    const lesionSlices = new Set();
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          if (labels[idx(x, y, z, dims)] > 0) lesionSlices.add(z);
        }
      }
    }
    const summary = {
      lesion_count: rows.length,
      total_volume_mm3: roundMetric(rows.reduce((sum, row) => sum + row.volume_mm3, 0)),
      total_length_mm: roundMetric(lesionSlices.size * safeSpacing[2]),
      max_width_mm: roundMetric(rows.reduce((max, row) => Math.max(max, row.max_width_mm), 0))
    };
    const csv = buildCsv(rows, summary);
    return { rows, summary, csv, restrictedLesion: restricted, componentLabels: labels };
  }

  return {
    analyzeLesions,
    buildCsv,
    connectedComponents3D,
    restrictLesionToCord,
    BASE_COLUMNS
  };
}));
