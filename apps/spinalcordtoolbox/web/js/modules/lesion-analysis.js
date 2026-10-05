/*
 * Lesion analysis: a port of SCT 7.3 `sct_analyze_lesion -m lesion -s cord`
 * (optionally `-i image`).
 *
 * Follows `AnalyzeLesion` method by method: 18-connected lesion labelling,
 * restriction to the cord, cord-angle correction from the fitted centerline,
 * the interpolated midsagittal slice, and tissue bridges. The CSV has the
 * columns of SCT's `measures` sheet, in SCT's order.
 *
 * Without a cord mask (lesion-only models such as lesion_ms) SCT computes the
 * volume only; the app also reports length, width and equivalent diameter
 * without angle correction (there is no cord to take angles from) and leaves
 * every cord-relative column empty. See `analyzeLesionsWithoutCord`.
 *
 * Not ported: `-f` (lesion distribution over a registered PAM50 atlas, which
 * needs template registration), `-perslice` (only meaningful with `-f`),
 * `-nli-slice` and the QC report. Where SCT stops with an error (no lesion,
 * or a lesion entirely outside the cord) this returns what can be measured
 * and says so in `warnings`.
 *
 * Volumes are RPI (see sct-centerline.js) and plain arrays, so masks from any
 * task, a file or manual editing are measured by the same code.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SCTLesionAnalysis = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const BASE_COLUMNS = Object.freeze([
    'label',
    'volume [mm3]',
    'length [mm]',
    'width [mm]',
    'max_equivalent_diameter [mm]',
    'max_axial_damage_ratio []'
  ]);
  const CORD_COLUMNS = Object.freeze([
    'interpolated_midsagittal_slice',
    'length_interpolated_midsagittal_slice [mm]',
    'width_interpolated_midsagittal_slice [mm]',
    'interpolated_dorsal_bridge_width [mm]',
    'interpolated_ventral_bridge_width [mm]',
    'interpolated_total_bridge_width [mm]',
    'dorsal_bridge_ratio [%]',
    'ventral_bridge_ratio [%]'
  ]);

  function centerlineApi() {
    const api = root.SCTCenterline;
    if (!api) throw new Error('SCTCenterline must be loaded before SCTLesionAnalysis is used.');
    return api;
  }

  function sum(values) {
    return centerlineApi().pairwiseSum(values);
  }

  /**
   * `skimage.measure.label(mask, connectivity=2)` on an RPI volume: voxels
   * sharing a face or an edge are one lesion, and labels are numbered in the
   * order NumPy scans the array (x slowest, z fastest).
   */
  function labelLesions(mask, dims) {
    const [nx, ny, nz] = dims;
    const labels = new Int32Array(mask.length);
    const offsets = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const order = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (order === 1 || order === 2) offsets.push([dx, dy, dz]);
        }
      }
    }
    let count = 0;
    const queue = [];
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
          const start = x + y * nx + z * nx * ny;
          if (!mask[start] || labels[start]) continue;
          count += 1;
          labels[start] = count;
          queue.length = 0;
          queue.push(start);
          for (let head = 0; head < queue.length; head++) {
            const index = queue[head];
            const qx = index % nx;
            const qy = Math.floor(index / nx) % ny;
            const qz = Math.floor(index / (nx * ny));
            for (const [dx, dy, dz] of offsets) {
              const x2 = qx + dx;
              const y2 = qy + dy;
              const z2 = qz + dz;
              if (x2 < 0 || x2 >= nx || y2 < 0 || y2 >= ny || z2 < 0 || z2 >= nz) continue;
              const neighbour = x2 + y2 * nx + z2 * nx * ny;
              if (!mask[neighbour] || labels[neighbour]) continue;
              labels[neighbour] = count;
              queue.push(neighbour);
            }
          }
        }
      }
    }
    return { labels, count };
  }

  /** `angle_correction`: centerline over every slice (`minmax=False`). */
  function cordAngles(spinalCord, dims, spacing) {
    const [px, py, pz] = spacing;
    const centerline = centerlineApi().getCenterline(spinalCord, dims, spacing, { smooth: 20, minmax: false });
    const angles3d = new Float64Array(dims[2]);
    const anglesSagittal = new Float64Array(dims[2]);
    for (let z = 0; z < dims[2]; z++) {
      const tx = centerline.dx[z] * px;
      const ty = centerline.dy[z] * py;
      angles3d[z] = Math.acos(pz / Math.sqrt(tx * tx + ty * ty + pz * pz));
      anglesSagittal[z] = Math.acos(pz / Math.sqrt(ty * ty + pz * pz));
    }
    return { angles3d, anglesSagittal };
  }

  function csvValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return '';
      return centerlineApi().pythonFloatRepr(value);
    }
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // The label is an integer in SCT's table; every measure is a float.
  function buildCsv(rows, columns) {
    const header = columns.map(csvValue).join(',');
    const cell = (row, column) => (column === 'label' ? String(row[column]) : csvValue(row[column]));
    return [header, ...rows.map(row => columns.map(column => cell(row, column)).join(','))].join('\n') + '\n';
  }

  /**
   * @param {object} input
   * @param {ArrayLike<number>} input.lesion RPI binary lesion mask
   * @param {ArrayLike<number>} [input.spinalCord] RPI cord mask; without
   *   it only lesion geometry is measured
   * @param {number[]} input.dims [nx, ny, nz]
   * @param {number[]} input.spacing voxel size in mm
   * @param {boolean[]} [input.nativeFlips] per RPI axis, whether the stored
   *   image axis runs the other way; SCT reports sagittal slice numbers in
   *   the stored orientation
   * @param {ArrayLike<number>} [input.image] RPI image for mean/std inside
   *   each lesion (`-i`)
   * @param {string} [input.imageName] names the mean_/std_ columns
   */
  function analyzeLesions(input) {
    const { lesion, spinalCord, dims } = input;
    if (!lesion || !dims) {
      throw new Error('lesion and dims are required');
    }
    const [nx, ny, nz] = dims;
    const voxels = nx * ny * nz;
    if (lesion.length !== voxels || (spinalCord && spinalCord.length !== voxels)) {
      throw new Error(`Mask length mismatch for dims ${dims.join('x')}`);
    }
    if (input.image && input.image.length !== voxels) {
      throw new Error(`Image length mismatch for dims ${dims.join('x')}`);
    }
    const { roundHalfEven, sctSpacing } = centerlineApi();
    const spacing = sctSpacing(Array.isArray(input.spacing) ? input.spacing.map(value => Number(value) || 1) : [1, 1, 1]);
    const [px, py, pz] = spacing;
    const flips = input.nativeFlips || [false, false, false];
    const storedSagittal = slice => (flips[0] ? nx - 1 - slice : slice);
    const at = (x, y, z) => x + y * nx + z * nx * ny;
    const warnings = [];

    const imageColumns = input.image
      ? [`mean_${input.imageName || 'image'}`, `std_${input.imageName || 'image'}`]
      : [];
    const columns = [...BASE_COLUMNS, ...imageColumns];
    const emptySummary = { lesion_count: 0, total_volume_mm3: 0, total_length_mm: 0, max_width_mm: 0 };
    if (!spinalCord) return analyzeLesionsWithoutCord(input, { spacing, columns, imageColumns, emptySummary });

    // label_lesion, then measure(): the labels come from the whole mask, the
    // measures from its part inside the cord.
    const { labels, count: labelledCount } = labelLesions(lesion, dims);
    const voxelsByLabel = Array.from({ length: labelledCount + 1 }, () => []);
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
          const index = at(x, y, z);
          if (labels[index] && spinalCord[index]) voxelsByLabel[labels[index]].push([x, y, z]);
          else labels[index] = 0;
        }
      }
    }
    const labelList = [];
    for (let label = 1; label <= labelledCount; label++) {
      if (voxelsByLabel[label].length) labelList.push(label);
      else warnings.push(`Lesion ${label} lies outside the cord mask and was not measured (SCT stops here).`);
    }
    if (labelList.length === 0) {
      warnings.push('No lesion inside the cord mask (SCT stops here unless -nli-slice is given).');
      return {
        rows: [],
        columns: [...columns, ...CORD_COLUMNS],
        summary: emptySummary,
        csv: buildCsv([], [...columns, ...CORD_COLUMNS]),
        warnings,
        componentLabels: labels,
        cordRestricted: true
      };
    }

    const { angles3d, anglesSagittal } = cordAngles(spinalCord, dims, spacing);
    const rows = labelList.map(label => ({ label }));

    // get_midsagittal_slice: volumes first, then the slice through the cord
    // centre around the largest lesion.
    let largest = 0;
    rows.forEach((row, index) => {
      row['volume [mm3]'] = voxelsByLabel[row.label].length * px * py * pz;
      if (row['volume [mm3]'] > rows[largest]['volume [mm3]']) largest = index;
    });
    let zSum = 0;
    for (const voxel of voxelsByLabel[rows[largest].label]) zSum += voxel[2];
    const zCenter = roundHalfEven(zSum / voxelsByLabel[rows[largest].label].length);
    const cordCentres = [];
    for (let z = zCenter - 2; z <= zCenter + 2; z++) {
      if (z < 0 || z >= nz) continue;
      let weight = 0;
      let weighted = 0;
      for (let x = 0; x < nx; x++) {
        for (let y = 0; y < ny; y++) {
          const value = spinalCord[at(x, y, z)];
          if (value) {
            weight += value;
            weighted += value * x;
          }
        }
      }
      if (weight) cordCentres.push(weighted / weight);
    }
    const midSlice = sum(cordCentres) / cordCentres.length;
    const slice1 = Math.floor(midSlice);
    const slice2 = Math.ceil(midSlice);
    const factor = midSlice - Math.trunc(midSlice);
    // _interpolate_values on two numbers; NaN stands for "not present".
    const interpolate = (a, b) => {
      const first = Number.isNaN(a) ? b : a;
      const second = Number.isNaN(b) ? a : b;
      return (1 - factor) * first + factor * second;
    };
    const cordColumn = (x, z) => {
      let first = -1;
      let last = -1;
      let count = 0;
      for (let y = 0; y < ny; y++) {
        if (spinalCord[at(x, y, z)]) {
          if (first < 0) first = y;
          last = y;
          count += 1;
        }
      }
      return { first, last, count };
    };

    const sliceColumns = [];
    for (const row of rows) {
      const lesionVoxels = voxelsByLabel[row.label];
      const isLesion = new Uint8Array(voxels);
      for (const [x, y, z] of lesionVoxels) isLesion[at(x, y, z)] = 1;
      const countByZ = new Int32Array(nz);
      const minYByZ = new Int32Array(nz).fill(ny);
      const maxYByZ = new Int32Array(nz).fill(-1);
      const sagittalSlices = new Set();
      for (const [x, y, z] of lesionVoxels) {
        countByZ[z] += 1;
        if (y < minYByZ[z]) minYByZ[z] = y;
        if (y > maxYByZ[z]) maxYByZ[z] = y;
        sagittalSlices.add(x);
      }
      const lesionSlices = [];
      for (let z = 0; z < nz; z++) if (countByZ[z]) lesionSlices.push(z);

      row.interpolated_midsagittal_slice = storedSagittal(midSlice);

      // _measure_length, _measure_width, _measure_diameter.
      row['length [mm]'] = sum(lesionSlices.map(z => pz / Math.cos(angles3d[z])));
      row['width [mm]'] = Math.max(...lesionSlices.map(z => (maxYByZ[z] - minYByZ[z] + 1) * py * Math.cos(anglesSagittal[z])));
      let maxArea = -Infinity;
      for (let z = 0; z < nz; z++) {
        const area = countByZ[z] * Math.cos(angles3d[z]) * px * py;
        if (area > maxArea) maxArea = area;
      }
      row['max_equivalent_diameter [mm]'] = 2 * Math.sqrt(maxArea / Math.PI);

      // _measure_axial_damage_ratio.
      let maxRatio = -Infinity;
      for (const z of lesionSlices) {
        let cordSum = 0;
        for (let x = 0; x < nx; x++) {
          for (let y = 0; y < ny; y++) cordSum += spinalCord[at(x, y, z)];
        }
        const ratio = (countByZ[z] * px * py) / (cordSum * px * py);
        if (ratio > maxRatio) maxRatio = ratio;
      }
      row['max_axial_damage_ratio []'] = maxRatio;

      // _measure_length_midsagittal_slice, _measure_width_midsagittal_slice.
      const lengths = [];
      let midWidth = 0;
      let hasMidWidth = false;
      const inside = slice => slice >= 0 && slice < nx;
      for (let z = 0; z < nz; z++) {
        let total = 0;
        let nonzero = 0;
        for (let y = 0; y < ny; y++) {
          const a = inside(slice1) ? isLesion[at(slice1, y, z)] : 0;
          const b = inside(slice2) ? isLesion[at(slice2, y, z)] : 0;
          const value = (1 - factor) * a + factor * b;
          if (value !== 0) {
            total += value;
            nonzero += 1;
          }
        }
        if (nonzero === 0) continue;
        lengths.push((total / nonzero) * pz / Math.cos(anglesSagittal[z]));
        const width = py * Math.cos(anglesSagittal[z]) * total;
        if (!hasMidWidth || width > midWidth) midWidth = width;
        hasMidWidth = true;
      }
      row['length_interpolated_midsagittal_slice [mm]'] = sum(lengths);
      row['width_interpolated_midsagittal_slice [mm]'] = hasMidWidth ? midWidth : 0;

      // _measure_tissue_bridges: spared cord dorsal (posterior, low y) and
      // ventral (anterior, high y) to the lesion, per sagittal slice.
      const sagittalList = [...sagittalSlices].sort((a, b) => a - b);
      const bridges = new Map();
      for (const x of sagittalList) {
        const perSlice = new Map();
        for (let z = 0; z < nz; z++) {
          let first = -1;
          let last = -1;
          for (let y = 0; y < ny; y++) {
            if (isLesion[at(x, y, z)]) {
              if (first < 0) first = y;
              last = y;
            }
          }
          if (first < 0) continue;
          const cord = cordColumn(x, z);
          perSlice.set(z, {
            dorsal: Math.max(0, first - cord.first),
            ventral: Math.max(0, cord.last - last)
          });
        }
        bridges.set(x, perSlice);
      }

      // _measure_interpolated_tissue_bridges.
      const midAxial = new Set();
      for (const x of new Set([slice1, slice2])) {
        for (const z of bridges.get(x)?.keys() || []) midAxial.add(z);
      }
      let dorsal;
      let ventral;
      let total;
      if (midAxial.size === 0) {
        // Parasagittal lesion: half the narrowest cord AP diameter each.
        let diameter = NaN;
        for (const z of lesionSlices) {
          if (!inside(slice1) || !inside(slice2)) continue;
          const c1 = cordColumn(slice1, z).count;
          const c2 = cordColumn(slice2, z).count;
          if (!c1 || !c2) continue;
          const value = interpolate(c1, c2) * py * Math.cos(anglesSagittal[z]);
          if (Number.isNaN(diameter) || value < diameter) diameter = value;
        }
        dorsal = diameter / 2;
        ventral = diameter / 2;
        total = diameter;
        warnings.push(`Lesion ${row.label} is not on the midsagittal slice; bridges use the cord AP diameter.`);
      } else {
        dorsal = Infinity;
        ventral = Infinity;
        for (const z of [...midAxial].sort((a, b) => a - b)) {
          const b1 = bridges.get(slice1)?.get(z);
          const b2 = bridges.get(slice2)?.get(z);
          const scale = py * Math.cos(anglesSagittal[z]);
          dorsal = Math.min(dorsal, interpolate(b1 ? b1.dorsal : NaN, b2 ? b2.dorsal : NaN) * scale);
          ventral = Math.min(ventral, interpolate(b1 ? b1.ventral : NaN, b2 ? b2.ventral : NaN) * scale);
        }
        total = dorsal + ventral;
      }
      row['interpolated_dorsal_bridge_width [mm]'] = dorsal;
      row['interpolated_ventral_bridge_width [mm]'] = ventral;
      row['interpolated_total_bridge_width [mm]'] = total;
      row['dorsal_bridge_ratio [%]'] = total > 0 ? (dorsal / total) * 100 : 0;
      row['ventral_bridge_ratio [%]'] = total > 0 ? (ventral / total) * 100 : 0;

      for (const x of sagittalList) {
        let minDorsal = Infinity;
        let minVentral = Infinity;
        for (const [z, bridge] of bridges.get(x)) {
          const scale = py * Math.cos(anglesSagittal[z]);
          minDorsal = Math.min(minDorsal, bridge.dorsal * scale);
          minVentral = Math.min(minVentral, bridge.ventral * scale);
        }
        const prefix = `slice_${storedSagittal(x)}`;
        for (const [suffix, value] of [
          ['dorsal_bridge_width [mm]', minDorsal],
          ['ventral_bridge_width [mm]', minVentral],
          ['total_bridge_width [mm]', minDorsal + minVentral]
        ]) {
          const column = `${prefix}_${suffix}`;
          if (!sliceColumns.includes(column)) sliceColumns.push(column);
          row[column] = value;
        }
      }

      // _measure_within_im: image statistics inside the lesion, zeros excluded.
      if (input.image) {
        const values = [];
        for (const [x, y, z] of lesionVoxels) {
          const value = input.image[at(x, y, z)];
          if (value !== 0) values.push(value);
        }
        const mean = values.length ? sum(values) / values.length : NaN;
        const variance = values.length ? sum(values.map(value => (value - mean) * (value - mean))) / values.length : NaN;
        row[imageColumns[0]] = mean;
        row[imageColumns[1]] = Math.sqrt(variance);
      }
    }

    const allColumns = [...columns, ...CORD_COLUMNS, ...sliceColumns];
    const summary = {
      lesion_count: rows.length,
      total_volume_mm3: sum(rows.map(row => row['volume [mm3]'])),
      total_length_mm: sum(rows.map(row => row['length [mm]'])),
      max_width_mm: Math.max(...rows.map(row => row['width [mm]']))
    };
    return {
      rows,
      columns: allColumns,
      summary,
      csv: buildCsv(rows, allColumns),
      warnings,
      componentLabels: labels,
      cordRestricted: true
    };
  }

  /**
   * `sct_analyze_lesion -m lesion [-i image]` without `-s`. SCT measures the
   * volume only. Length, width and equivalent diameter are added here with
   * the cord angle taken as zero, because a lesion-only model has no cord to
   * correct by. The cord-relative columns are not written at all, as in SCT.
   */
  function analyzeLesionsWithoutCord(input, { spacing, columns, imageColumns, emptySummary }) {
    const { lesion, dims } = input;
    const [nx, ny, nz] = dims;
    const [px, py, pz] = spacing;
    const at = (x, y, z) => x + y * nx + z * nx * ny;
    const { labels, count } = labelLesions(lesion, dims);
    const voxelsByLabel = Array.from({ length: count + 1 }, () => []);
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
          const label = labels[at(x, y, z)];
          if (label) voxelsByLabel[label].push([x, y, z]);
        }
      }
    }
    const warnings = ['No cord mask: cord-relative metrics are empty and lengths are not angle-corrected.'];
    const rows = [];
    for (let label = 1; label <= count; label++) {
      const lesionVoxels = voxelsByLabel[label];
      const countByZ = new Int32Array(nz);
      const minYByZ = new Int32Array(nz).fill(ny);
      const maxYByZ = new Int32Array(nz).fill(-1);
      for (const [, y, z] of lesionVoxels) {
        countByZ[z] += 1;
        if (y < minYByZ[z]) minYByZ[z] = y;
        if (y > maxYByZ[z]) maxYByZ[z] = y;
      }
      const lesionSlices = [];
      for (let z = 0; z < nz; z++) if (countByZ[z]) lesionSlices.push(z);
      const maxCount = Math.max(...lesionSlices.map(z => countByZ[z]));
      const row = {
        label,
        'volume [mm3]': lesionVoxels.length * px * py * pz,
        'length [mm]': lesionSlices.length * pz,
        'width [mm]': Math.max(...lesionSlices.map(z => (maxYByZ[z] - minYByZ[z] + 1) * py)),
        'max_equivalent_diameter [mm]': 2 * Math.sqrt((maxCount * px * py) / Math.PI)
      };
      if (input.image) {
        const values = lesionVoxels.map(([x, y, z]) => input.image[at(x, y, z)]).filter(value => value !== 0);
        const mean = values.length ? sum(values) / values.length : NaN;
        row[imageColumns[0]] = mean;
        row[imageColumns[1]] = values.length ? Math.sqrt(sum(values.map(value => (value - mean) * (value - mean))) / values.length) : NaN;
      }
      rows.push(row);
    }
    const summary = rows.length
      ? {
          lesion_count: rows.length,
          total_volume_mm3: sum(rows.map(row => row['volume [mm3]'])),
          total_length_mm: sum(rows.map(row => row['length [mm]'])),
          max_width_mm: Math.max(...rows.map(row => row['width [mm]']))
        }
      : emptySummary;
    if (!rows.length) warnings.push('No lesion in the mask.');
    return { rows, columns, summary, csv: buildCsv(rows, columns), warnings, componentLabels: labels, cordRestricted: false };
  }

  return {
    analyzeLesions,
    buildCsv,
    labelLesions,
    BASE_COLUMNS,
    CORD_COLUMNS,
    // Columns that need a cord mask: empty in a lesion-only table.
    CORD_RELATIVE_COLUMNS: Object.freeze(['max_axial_damage_ratio []', ...CORD_COLUMNS])
  };
});
