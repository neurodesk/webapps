/*
 * Spinal cord morphometry: a port of SCT 7.3 `sct_process_segmentation`.
 *
 * `computeShape` follows `spinalcordtoolbox.process_seg.compute_shape` and
 * `_properties2d` step by step (centerline angle correction, 0.1 mm
 * resampling, second-moment ellipse, convex hull, rotated AP diameter), and
 * `aggregateMetrics` / `toCsv` follow `aggregate_slicewise` including its CSV
 * column layout. `levelsFromDiscs` is the `-discfile` path
 * (`project_centerline` then `label_regions_from_reference`).
 *
 * Not ported: the image-based metrics behind `-anat` (HOG angle, quadrant
 * areas, symmetry), `-pmj`, `-normalize`, `-normalize-PAM50`, the
 * `polyfit`/`linear`/`nurbs` centerline fits and a separate `-centerline`
 * image.
 *
 * Volumes are RPI (see sct-centerline.js). Every function takes plain arrays,
 * so a mask from inference, from a file or from manual editing is measured by
 * the same code.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SCTMorphometry = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const NEAR_ZERO_THRESHOLD = 1e-6;
  // SCT's KEYS_DEFAULT; this order is also the CSV column order.
  const METRIC_KEYS = Object.freeze([
    'area',
    'angle_AP',
    'angle_RL',
    'diameter_AP',
    'diameter_AP_ellipse',
    'diameter_RL',
    'length_anterior',
    'length_posterior',
    'eccentricity',
    'orientation',
    'solidity',
    'length'
  ]);
  const CSV_PREFIX_COLUMNS = Object.freeze([
    'Timestamp',
    'SCT Version',
    'Filename',
    'Slice (I->S)',
    'VertLevel',
    'DistancePMJ'
  ]);
  const UPSAMPLED_PIXEL_MM = 0.1;
  const AP_AVERAGING_EXTENT = 30;
  const CROP_PADDING = 3;

  function centerlineApi() {
    const api = root.SCTCenterline;
    if (!api) throw new Error('SCTCenterline must be loaded before SCTMorphometry is used.');
    return api;
  }

  function assertVolume(data, dims, name) {
    if (!Array.isArray(dims) || dims.length !== 3 || dims.some(v => !Number.isInteger(v) || v <= 0)) {
      throw new Error('dims must be three positive integers');
    }
    if (!data || data.length !== dims[0] * dims[1] * dims[2]) {
      throw new Error(`${name} length ${data?.length ?? 'null'} does not match dims ${dims.join('x')}`);
    }
  }

  function pairwiseSum(values, start, count) {
    return centerlineApi().pairwiseSum(values, start, count);
  }

  // ==================== 2D resampling (scikit-image / SciPy) ====================

  /**
   * `skimage.transform.warp(patch, AffineTransform(scale=(sx, sy)).inverse,
   * order=1)`: bilinear, zero outside. `patch` is [rows = x][cols = y] stored
   * row-major; sx scales columns, sy scales rows.
   */
  function warpScale(patch, rows, cols, sx, sy) {
    const out = new Float64Array(rows * cols);
    const invX = 1 / sx;
    const invY = 1 / sy;
    const pixel = (r, c) => (r < 0 || r >= rows || c < 0 || c >= cols ? 0 : patch[r * cols + c]);
    for (let r = 0; r < rows; r++) {
      const rr = invY * r;
      const minr = Math.floor(rr);
      const maxr = Math.ceil(rr);
      const dr = rr - minr;
      for (let c = 0; c < cols; c++) {
        const cc = invX * c;
        const minc = Math.floor(cc);
        const maxc = Math.ceil(cc);
        const dc = cc - minc;
        const top = (1 - dc) * pixel(minr, minc) + dc * pixel(minr, maxc);
        const bottom = (1 - dc) * pixel(maxr, minc) + dc * pixel(maxr, maxc);
        out[r * cols + c] = (1 - dr) * top + dr * bottom;
      }
    }
    return out;
  }

  /**
   * `scipy.ndimage.zoom(a, zoom, order=1, mode='grid-constant',
   * grid_mode=True)`: linear interpolation on pixel-centre grids with zeros
   * outside the array.
   */
  function zoomLinear(src, rows, cols, zoomRows, zoomCols) {
    const round = centerlineApi().roundHalfEven;
    const outRows = round(rows * zoomRows);
    const outCols = round(cols * zoomCols);
    const stepR = rows / outRows;
    const stepC = cols / outCols;
    const out = new Float64Array(outRows * outCols);
    const colIndex = new Int32Array(outCols);
    const colFrac = new Float64Array(outCols);
    for (let c = 0; c < outCols; c++) {
      const cc = (c + 0.5) * stepC - 0.5;
      const base = Math.floor(cc);
      colIndex[c] = base;
      colFrac[c] = cc - base;
    }
    const value = (r, c) => (r < 0 || r >= rows || c < 0 || c >= cols ? 0 : src[r * cols + c]);
    for (let r = 0; r < outRows; r++) {
      const rr = (r + 0.5) * stepR - 0.5;
      const r0 = Math.floor(rr);
      const fr = rr - r0;
      for (let c = 0; c < outCols; c++) {
        const c0 = colIndex[c];
        const fc = colFrac[c];
        const top = (1 - fc) * value(r0, c0) + fc * value(r0, c0 + 1);
        const bottom = (1 - fc) * value(r0 + 1, c0) + fc * value(r0 + 1, c0 + 1);
        out[r * outCols + c] = (1 - fr) * top + fr * bottom;
      }
    }
    return { data: out, rows: outRows, cols: outCols };
  }

  /** `scipy.ndimage.map_coordinates(a, [r, c], order=1)`: zero outside. */
  function sampleBilinearConstant(src, rows, cols, r, c) {
    if (r < 0 || r > rows - 1 || c < 0 || c > cols - 1) return 0;
    const r0 = Math.floor(r);
    const c0 = Math.floor(c);
    const fr = r - r0;
    const fc = c - c0;
    const r1 = Math.min(r0 + 1, rows - 1);
    const c1 = Math.min(c0 + 1, cols - 1);
    const top = (1 - fc) * src[r0 * cols + c0] + fc * src[r0 * cols + c1];
    const bottom = (1 - fc) * src[r1 * cols + c0] + fc * src[r1 * cols + c1];
    return (1 - fr) * top + fr * bottom;
  }

  /**
   * Centre of mass of the pixels that round to non-zero, as SCT's
   * `compute_pca` returns it. `test` decides membership.
   */
  function centroidWhere(data, rows, cols, test) {
    let count = 0;
    let sumR = 0;
    let sumC = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (test(data[r * cols + c])) {
          count += 1;
          sumR += r;
          sumC += c;
        }
      }
    }
    return count ? [sumR / count, sumC / count] : null;
  }

  /** `_rotate_segmentation_by_angle`. */
  function rotateAboutCentroid(src, rows, cols, angle) {
    // np.round: a pixel belongs to the object when its value rounds to 1.
    const centre = centroidWhere(src, rows, cols, value => value > 0.5);
    const out = new Float64Array(rows * cols);
    if (!centre) return out;
    const [y0, x0] = centre;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let r = 0; r < rows; r++) {
      const yc = r - y0;
      for (let c = 0; c < cols; c++) {
        const xc = c - x0;
        const xr = xc * cos - yc * sin + x0;
        const yr = xc * sin + yc * cos + y0;
        out[r * cols + c] = sampleBilinearConstant(src, rows, cols, yr, xr);
      }
    }
    return out;
  }

  // ==================== Region properties (scikit-image) ====================

  /**
   * Pixels of the convex hull image: every pixel is a diamond of four
   * half-pixel points, the hull is taken over those, and grid points inside
   * or on it are counted (`convex_hull_image`, `include_borders=True`).
   * Coordinates are doubled so every test is exact integer arithmetic.
   */
  function convexHullPixelCount(mask, rows, cols) {
    const points = [];
    for (let r = 0; r < rows; r++) {
      let first = -1;
      let last = -1;
      for (let c = 0; c < cols; c++) {
        if (mask[r * cols + c]) {
          if (first < 0) first = c;
          last = c;
        }
      }
      if (first < 0) continue;
      for (const c of first === last ? [first] : [first, last]) {
        points.push([2 * r - 1, 2 * c], [2 * r + 1, 2 * c], [2 * r, 2 * c - 1], [2 * r, 2 * c + 1]);
      }
    }
    if (points.length === 0) return 0;
    points.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of points) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));

    let count = 0;
    for (let r = 0; r < rows; r++) {
      const u = 2 * r;
      let lo = 0;
      let hi = 2 * (cols - 1);
      let empty = false;
      for (let i = 0; i < hull.length && !empty; i++) {
        const p = hull[i];
        const q = hull[(i + 1) % hull.length];
        const du = q[0] - p[0];
        const dv = q[1] - p[1];
        // Inside: du * (v - p.v) - dv * (u - p.u) >= 0.
        if (du === 0) {
          if (-dv * (u - p[0]) < 0) empty = true;
          continue;
        }
        const bound = p[1] + dv * (u - p[0]) / du;
        if (du > 0) lo = Math.max(lo, bound);
        else hi = Math.min(hi, bound);
      }
      if (empty) continue;
      const cMin = Math.max(0, Math.ceil(lo / 2 - 1e-9));
      const cMax = Math.min(cols - 1, Math.floor(hi / 2 + 1e-9));
      if (cMax >= cMin) count += cMax - cMin + 1;
    }
    return count;
  }

  /** The `skimage.measure.regionprops` values SCT reads from a binary mask. */
  function regionProperties(mask, rows, cols) {
    let m00 = 0;
    let m10 = 0;
    let m01 = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (mask[r * cols + c]) {
          m00 += 1;
          m10 += r;
          m01 += c;
        }
      }
    }
    const rBar = m10 / m00;
    const cBar = m01 / m00;
    let mu20 = 0;
    let mu02 = 0;
    let mu11 = 0;
    for (let r = 0; r < rows; r++) {
      const dr = r - rBar;
      for (let c = 0; c < cols; c++) {
        if (!mask[r * cols + c]) continue;
        const dc = c - cBar;
        mu20 += dr * dr;
        mu02 += dc * dc;
        mu11 += dr * dc;
      }
    }
    // inertia_tensor: [[a, b], [b, c]].
    const a = mu02 / m00;
    const b = -mu11 / m00;
    const c = mu20 / m00;
    const mean = (a + c) / 2;
    const spread = Math.sqrt(((a - c) / 2) * ((a - c) / 2) + b * b);
    const l1 = Math.max(mean + spread, 0);
    const l2 = Math.max(mean - spread, 0);
    let orientation;
    if (a - c === 0) orientation = b < 0 ? Math.PI / 4 : -Math.PI / 4;
    else orientation = 0.5 * Math.atan2(-2 * b, c - a);
    return {
      area: m00,
      centroid: [rBar, cBar],
      orientation,
      majorAxisLength: 4 * Math.sqrt(l1),
      minorAxisLength: 4 * Math.sqrt(l2),
      eccentricity: l1 === 0 ? 0 : Math.sqrt(1 - l2 / l1),
      solidity: m00 / convexHullPixelCount(mask, rows, cols)
    };
  }

  /** `fix_orientation`: degrees in [0, 90]. */
  function fixOrientation(orientation) {
    let value = orientation * 180 / Math.PI;
    if (Math.abs(value) >= 360 && Math.abs(value) <= 540) value = 540 - Math.abs(value);
    if (Math.abs(value) >= 180 && Math.abs(value) <= 360) value = 360 - Math.abs(value);
    if (Math.abs(value) >= 90 && Math.abs(value) <= 180) value = 180 - Math.abs(value);
    return Math.abs(value);
  }

  /** `_measure_ap_diameter` on the rotated 0.1 mm segmentation. */
  function measureApDiameter(rotated, rows, cols) {
    const round = centerlineApi().roundHalfEven;
    const centre = centroidWhere(rotated, rows, cols, value => value > 0.5);
    if (!centre) {
      return { diameter_AP: NaN, length_anterior: NaN, length_posterior: NaN };
    }
    const rl0 = round(centre[0]);
    const ap0 = round(centre[1]);
    const half = Math.floor(AP_AVERAGING_EXTENT / 2);
    const rowIndices = [];
    for (let r = rl0 - half; r < rl0 + half; r++) {
      if (r >= 0 && r < rows) rowIndices.push(r);
    }
    const apMean = new Float64Array(cols);
    for (const r of rowIndices) {
      for (let c = 0; c < cols; c++) apMean[c] += rotated[r * cols + c];
    }
    for (let c = 0; c < cols; c++) apMean[c] /= rowIndices.length;
    const split = Math.max(0, Math.min(cols, ap0));
    const lengthPosterior = pairwiseSum(apMean, 0, split) * UPSAMPLED_PIXEL_MM;
    const lengthAnterior = pairwiseSum(apMean, split, cols - split) * UPSAMPLED_PIXEL_MM;
    return {
      diameter_AP: lengthPosterior + lengthAnterior,
      length_anterior: lengthAnterior,
      length_posterior: lengthPosterior
    };
  }

  /**
   * `_properties2d`: shape of one axial patch ([rows = x][cols = y], values in
   * [0, 1] after angle correction). Returns null for an empty slice.
   */
  function properties2d(seg, rows, cols, px, py) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] < min) min = seg[i];
      if (seg[i] > max) max = seg[i];
    }
    if (max < NEAR_ZERO_THRESHOLD) return null;
    const range = max - min;
    let minR = rows;
    let maxR = -1;
    let minC = cols;
    let maxC = -1;
    const norm = new Float64Array(seg.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const value = (seg[r * cols + c] - min) / range;
        norm[r * cols + c] = value;
        if (value > NEAR_ZERO_THRESHOLD) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    if (maxR < 0) return null;
    const r0 = Math.max(minR - CROP_PADDING, 0);
    const r1 = Math.min(maxR + 1 + CROP_PADDING, rows);
    const c0 = Math.max(minC - CROP_PADDING, 0);
    const c1 = Math.min(maxC + 1 + CROP_PADDING, cols);
    const cropRows = r1 - r0;
    const cropCols = c1 - c0;
    const crop = new Float64Array(cropRows * cropCols);
    for (let r = 0; r < cropRows; r++) {
      for (let c = 0; c < cropCols; c++) crop[r * cropCols + c] = norm[(r + r0) * cols + (c + c0)];
    }

    const zoomed = zoomLinear(crop, cropRows, cropCols, px / UPSAMPLED_PIXEL_MM, py / UPSAMPLED_PIXEL_MM);
    const binary = new Uint8Array(zoomed.data.length);
    for (let i = 0; i < binary.length; i++) binary[i] = zoomed.data[i] > 0.5 ? 1 : 0;
    const region = regionProperties(binary, zoomed.rows, zoomed.cols);
    if (region.area === 0) return null;

    const area = pairwiseSum(zoomed.data) * UPSAMPLED_PIXEL_MM * UPSAMPLED_PIXEL_MM;
    const orientationDeg = fixOrientation(region.orientation);
    const apIsMinor = orientationDeg >= 0 && orientationDeg < 45;
    const diameterApEllipse = (apIsMinor ? region.minorAxisLength : region.majorAxisLength) * UPSAMPLED_PIXEL_MM;
    const diameterRl = (apIsMinor ? region.majorAxisLength : region.minorAxisLength) * UPSAMPLED_PIXEL_MM;
    const rotated = rotateAboutCentroid(zoomed.data, zoomed.rows, zoomed.cols, -region.orientation);
    const ap = measureApDiameter(rotated, zoomed.rows, zoomed.cols);

    return {
      area,
      diameter_AP: ap.diameter_AP,
      diameter_AP_ellipse: diameterApEllipse,
      diameter_RL: diameterRl,
      length_anterior: ap.length_anterior,
      length_posterior: ap.length_posterior,
      eccentricity: region.eccentricity,
      orientation: region.orientation * 180 / Math.PI,
      solidity: region.solidity
    };
  }

  // ==================== compute_shape ====================

  /**
   * `compute_shape`: one value per axial slice for every key in METRIC_KEYS
   * (NaN where the slice has no mask).
   *
   * @param {ArrayLike<number>} seg RPI mask, binary or in [0, 1]
   * @param {number[]} dims [nx, ny, nz]
   * @param {number[]} spacing [px, py, pz] in mm
   * @param {{ angleCorrection?: boolean, smooth?: number, onProgress?: Function }} options
   *   `onProgress(done, total)` is called after every measured slice.
   */
  function computeShape(seg, dims, rawSpacing, options = {}) {
    assertVolume(seg, dims, 'segmentation');
    const [nx, ny, nz] = dims;
    const spacing = centerlineApi().sctSpacing(rawSpacing);
    const [px, py, pz] = spacing;
    const angleCorrection = options.angleCorrection !== false;
    const metrics = {};
    for (const key of METRIC_KEYS) metrics[key] = new Float64Array(nz).fill(NaN);

    let zMin = -1;
    let zMax = -1;
    for (let z = 0; z < nz; z++) {
      const base = z * nx * ny;
      let any = false;
      for (let i = 0; i < nx * ny; i++) {
        if (seg[base + i] > NEAR_ZERO_THRESHOLD) {
          any = true;
          break;
        }
      }
      if (any) {
        if (zMin < 0) zMin = z;
        zMax = z;
      }
    }
    if (zMin < 0) throw new Error('The mask is empty: there is nothing to measure.');

    let centerline = null;
    const derivByZ = new Map();
    if (angleCorrection) {
      centerline = centerlineApi().getCenterline(seg, dims, spacing, {
        smooth: options.smooth ?? 30,
        minmax: true
      });
      centerline.zRef.forEach((z, index) => derivByZ.set(z, [centerline.dx[index], centerline.dy[index]]));
    }

    const patch = new Float64Array(nx * ny);
    for (let z = zMin; z <= zMax; z++) {
      const base = z * nx * ny;
      // patch[x][y]: rows are RL, columns are PA.
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) patch[x * ny + y] = seg[base + y * nx + x];
      }
      let angleAp = 0;
      let angleRl = 0;
      let scaled = patch;
      if (angleCorrection) {
        const deriv = derivByZ.get(z);
        if (!deriv) {
          throw new Error(`The centerline does not cover slice ${z}; disable angle correction or fix the mask.`);
        }
        angleAp = Math.atan2(deriv[0] * px, pz);
        angleRl = Math.atan2(deriv[1] * py, pz);
        scaled = warpScale(patch, nx, ny, Math.cos(angleRl), Math.cos(angleAp));
      }
      const properties = properties2d(scaled, nx, ny, px, py);
      options.onProgress?.(z - zMin + 1, zMax - zMin + 1);
      if (!properties) continue;
      properties.angle_AP = angleAp * 180 / Math.PI;
      properties.angle_RL = angleRl * 180 / Math.PI;
      properties.length = pz / (Math.cos(angleAp) * Math.cos(angleRl));
      for (const key of METRIC_KEYS) metrics[key][z] = properties[key];
    }
    return { metrics, zMin, zMax, centerline };
  }

  // ==================== Vertebral levels from disc labels ====================

  /**
   * One point per disc label value: the rounded centre of mass of its voxels
   * (SCT's `-discfile` expects single-voxel labels; TotalSpineSeg markers in
   * this app are small spheres around that voxel).
   */
  function discPointsFromLabels(labels, dims) {
    assertVolume(labels, dims, 'disc labels');
    const round = centerlineApi().roundHalfEven;
    const [nx, ny, nz] = dims;
    const sums = new Map();
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const row = (z * ny + y) * nx;
        for (let x = 0; x < nx; x++) {
          const value = labels[row + x];
          if (!value) continue;
          let entry = sums.get(value);
          if (!entry) {
            entry = { value, count: 0, x: 0, y: 0, z: 0 };
            sums.set(value, entry);
          }
          entry.count += 1;
          entry.x += x;
          entry.y += y;
          entry.z += z;
        }
      }
    }
    return [...sums.values()]
      .sort((a, b) => a.value - b.value)
      .map(entry => ({
        value: entry.value,
        x: round(entry.x / entry.count),
        y: round(entry.y / entry.count),
        z: round(entry.z / entry.count)
      }));
  }

  /**
   * Index of the point nearest to `target` in millimetres. With isotropic
   * voxels a voxel is often equally far from the centerline voxel of its own
   * slice and from a neighbour's. SCT leaves such ties to floating-point
   * rounding of the affine (so they can differ between machines);
   * `preferSameSlice` settles them on the target's own slice, which is what
   * SCT returned on every reference case.
   */
  function nearestIndex(points, target, spacing, preferSameSlice = false) {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = (points[i][0] - target[0]) * spacing[0];
      const dy = (points[i][1] - target[1]) * spacing[1];
      const dz = (points[i][2] - target[2]) * spacing[2];
      const distance = dx * dx + dy * dy + dz * dz;
      const tie = preferSameSlice && Math.abs(distance - bestDistance) <= 1e-9 * bestDistance;
      if (tie ? points[i][2] === target[2] : distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  /**
   * SCT's `-discfile` path. Disc points are projected onto the fitted
   * centerline (`project_centerline`), then every centerline voxel takes the
   * level of the region between two projected discs
   * (`label_regions_from_reference(..., centerline=True)`).
   *
   * SCT rounds and truncates centerline coordinates in the image's stored
   * orientation, so `nativeFlips` says, per RPI axis, whether the stored axis
   * runs the other way. Distances use voxel index times spacing, which equals
   * SCT's physical distance for an affine without shear.
   *
   * @returns {{ levelBySlice: Int32Array, projected: object[] }} level 0 = none
   */
  function levelsFromDiscs(seg, dims, rawSpacing, discPoints, options = {}) {
    assertVolume(seg, dims, 'segmentation');
    const { getCenterline, roundHalfEven, sctSpacing } = centerlineApi();
    const spacing = sctSpacing(rawSpacing);
    const flips = options.nativeFlips || [false, false, false];
    const inNative = (axis, value, op) => (flips[axis] ? (dims[axis] - 1) - op((dims[axis] - 1) - value) : op(value));
    const clip = (axis, value) => Math.max(0, Math.min(dims[axis] - 1, value));
    const centerline = getCenterline(seg, dims, spacing, { smooth: 20, minmax: true });
    const count = centerline.zRef.length;
    const floatPoints = [];
    const intPoints = [];
    for (let i = 0; i < count; i++) {
      const point = [centerline.x[i], centerline.y[i], centerline.zRef[i]];
      floatPoints.push(point);
      intPoints.push([
        inNative(0, point[0], Math.trunc),
        inNative(1, point[1], Math.trunc),
        point[2]
      ]);
    }

    // project_centerline: nearest fitted point, rounded to a voxel.
    const projected = new Map();
    for (const disc of discPoints) {
      const index = nearestIndex(floatPoints, [disc.x, disc.y, disc.z], spacing);
      const voxel = [
        clip(0, inNative(0, floatPoints[index][0], roundHalfEven)),
        clip(1, inNative(1, floatPoints[index][1], roundHalfEven)),
        clip(2, floatPoints[index][2])
      ];
      // Two discs on one voxel: the later one overwrites, as in SCT.
      projected.set(voxel.join(','), { voxel, value: disc.value });
    }

    // label_regions_from_reference: region boundaries along the centerline.
    const regions = [...projected.values()]
      .map(entry => ({ ...entry, index: nearestIndex(intPoints, entry.voxel, spacing, true) }))
      .sort((a, b) => a.index - b.index);
    const levelBySlice = new Int32Array(dims[2]);
    if (regions.length === 0) return { levelBySlice, projected: [] };
    const regionValues = regions.map(region => region.value);
    regionValues.push(regionValues[regionValues.length - 1] - 1);
    for (let i = 0; i < count; i++) {
      let position = 0;
      while (position < regions.length && regions[position].index < i) position += 1;
      // The labelled centerline is stored in the mask's integer type.
      levelBySlice[centerline.zRef[i]] = Math.max(0, Math.round(regionValues[position]));
    }
    return { levelBySlice, projected: regions };
  }

  // ==================== Aggregation (aggregate_slicewise) ====================

  /** `parse_num_list`: "2:5", "1;3;5", "4" to a list of integers. */
  function parseNumList(text) {
    const source = String(text ?? '').trim();
    if (!source) return [];
    const out = [];
    for (const element of source.split(/[;,]/)) {
      const token = element.trim();
      let match = /^(\d+)$/.exec(token);
      if (match) {
        const value = Number(match[1]);
        if (!out.includes(value)) out.push(value);
        continue;
      }
      match = /^(\d+):(\d+)$/.exec(token);
      if (match) {
        for (let value = Number(match[1]); value <= Number(match[2]); value++) {
          if (!out.includes(value)) out.push(value);
        }
        continue;
      }
      throw new Error(`"${token}" is not a number or a range such as 2:5`);
    }
    return out;
  }

  /** `parse_num_list_inv`: [1, 2, 3, 5] to "1:3;5". */
  function numListToString(list) {
    if (!list || list.length === 0) return '';
    const sorted = [...list].sort((a, b) => a - b);
    let text = String(sorted[0]);
    let colon = false;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] + 1) {
        if (colon) text = text.slice(0, text.length - String(sorted[i - 1]).length) + String(sorted[i]);
        else {
          text += `:${sorted[i]}`;
          colon = true;
        }
      } else {
        text += `;${sorted[i]}`;
        colon = false;
      }
    }
    return text;
  }

  function aggregateGroup(values, slices, sumOnly) {
    // Non-finite entries are zeroed in the data and in the weights, so they
    // drop out of the mean; a group with no finite value has no result.
    const padded = new Float64Array(slices.length);
    let finiteCount = 0;
    let cursor = 0;
    for (const slice of slices) {
      const value = values[slice];
      if (Number.isFinite(value)) finiteCount += 1;
      padded[cursor++] = Number.isFinite(value) ? value : 0;
    }
    if (finiteCount === 0) return { sum: null, mean: null, std: null };
    const sum = pairwiseSum(padded);
    if (sumOnly) return { sum };
    const mean = sum / finiteCount;
    cursor = 0;
    for (const slice of slices) {
      const value = values[slice];
      padded[cursor++] = Number.isFinite(value) ? (value - mean) * (value - mean) : 0;
    }
    return { mean, std: Math.sqrt(pairwiseSum(padded) / finiteCount) };
  }

  /**
   * `aggregate_per_slice_or_level` for every metric, merged into rows.
   *
   * @param {Record<string, Float64Array>} metrics from computeShape
   * @param {object} options
   * @param {number[]} [options.slices] `-z`; empty = every slice
   * @param {number[]} [options.levels] `-vert`; needs `levelBySlice`
   * @param {boolean} [options.perslice] `-perslice 1`
   * @param {boolean} [options.perlevel] `-perlevel 1`; needs `levels`
   * @param {Int32Array} [options.levelBySlice] from levelsFromDiscs
   * @returns {{ slices: number[], vertLevel: number[]|null, values: Record<string, number|null> }[]}
   */
  function aggregateMetrics(metrics, options = {}) {
    const nz = metrics[METRIC_KEYS[0]].length;
    const levelBySlice = options.levelBySlice || null;
    const levels = options.levels || [];
    const perslice = Boolean(options.perslice);
    const perlevel = Boolean(options.perlevel);
    let slices = options.slices && options.slices.length ? [...options.slices] : null;
    if (slices) {
      const outside = slices.filter(slice => !Number.isInteger(slice) || slice < 0 || slice >= nz);
      if (outside.length) throw new Error(`Slice ${outside[0]} is outside the image (0 to ${nz - 1}).`);
    } else {
      slices = Array.from({ length: nz }, (_, index) => index);
    }
    if (levels.length && !levelBySlice) {
      throw new Error('Vertebral levels need disc labels for the same image.');
    }
    const levelOf = slice => (levelBySlice && levelBySlice[slice] ? levelBySlice[slice] : null);

    let groups;
    if (levels.length) {
      const selected = new Set(slices);
      const perLevel = levels.map(level => {
        const members = [];
        for (let z = 0; z < nz; z++) {
          if (levelBySlice[z] === level && selected.has(z)) members.push(z);
        }
        return members;
      });
      if (perlevel) {
        groups = perLevel.map((members, index) => ({ slices: members, vertLevel: [levels[index]] }));
      } else if (perslice) {
        groups = perLevel.flat().map(slice => ({ slices: [slice], vertLevel: [levelOf(slice)] }));
      } else {
        groups = [{ slices: perLevel.flat(), vertLevel: [...levels] }];
      }
    } else if (perslice) {
      groups = slices.map(slice => ({ slices: [slice], vertLevel: levelBySlice ? [levelOf(slice)] : null }));
    } else {
      groups = [{ slices, vertLevel: null }];
    }

    const rows = [];
    const seen = new Set();
    for (const group of groups) {
      if (group.slices.length === 0) continue;
      const key = group.slices.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const vertLevel = group.vertLevel && group.vertLevel[0] !== null ? group.vertLevel : null;
      const values = {};
      for (const metric of METRIC_KEYS) {
        if (metric === 'length') {
          values['SUM(length)'] = aggregateGroup(metrics[metric], group.slices, true).sum;
        } else {
          const { mean, std } = aggregateGroup(metrics[metric], group.slices, false);
          values[`MEAN(${metric})`] = mean;
          values[`STD(${metric})`] = std;
        }
      }
      rows.push({ slices: [...group.slices].sort((a, b) => a - b), vertLevel, values });
    }
    rows.sort((a, b) => a.slices[0] - b.slices[0]);
    return rows;
  }

  // ==================== CSV (save_as_csv) ====================

  function metricColumns() {
    const columns = [];
    for (const key of METRIC_KEYS) {
      if (key !== 'length') columns.push(`MEAN(${key})`, `STD(${key})`);
    }
    columns.push('SUM(length)');
    return columns;
  }

  function pythonFloatRepr(value) {
    return centerlineApi().pythonFloatRepr(value);
  }

  function quote(text) {
    return `"${String(text).replace(/"/g, '""')}"`;
  }

  function formatTimestamp(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * SCT's `save_as_csv` layout: six leading columns, then MEAN/STD of every
   * metric and SUM(length). Text is quoted and numbers are not
   * (`csv.QUOTE_NONNUMERIC`); an undefined value is an empty quoted field.
   */
  function toCsv(rows, info = {}) {
    const columns = metricColumns();
    const timestamp = info.timestamp || formatTimestamp(new Date());
    const lines = [[...CSV_PREFIX_COLUMNS, ...columns].join(',')];
    for (const row of rows) {
      const fields = [
        quote(timestamp),
        quote(info.version || ''),
        quote(info.filename || ''),
        quote(numListToString(row.slices)),
        quote(row.vertLevel ? numListToString(row.vertLevel) : ''),
        quote('')
      ];
      for (const column of columns) {
        const value = row.values[column];
        fields.push(value === null || value === undefined ? quote('') : pythonFloatRepr(value));
      }
      lines.push(fields.join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  // ==================== sct_process_segmentation ====================

  const AGGREGATIONS = Object.freeze(['all', 'slice', 'level', 'levels']);

  /**
   * The whole command on one RPI mask.
   *
   * `aggregate`: 'all' (one row over the selected slices, SCT's default),
   * 'slice' (`-perslice 1`), 'level' (`-vert … -perlevel 1`) or 'levels'
   * (`-vert …`, one row across the chosen levels). `discs` is an RPI label
   * volume or a list of `{ x, y, z, value }` points; it fills VertLevel and is
   * required for the two level modes.
   */
  function processSegmentation(input) {
    const { seg, dims, spacing } = input;
    const aggregate = input.aggregate || 'all';
    if (!AGGREGATIONS.includes(aggregate)) throw new Error(`Unknown aggregation "${aggregate}"`);
    const angleCorrection = input.angleCorrection !== false;
    const slices = Array.isArray(input.slices) ? input.slices : parseNumList(input.slices);
    let levels = Array.isArray(input.levels) ? input.levels : parseNumList(input.levels);

    let levelBySlice = null;
    let discPoints = null;
    if (input.discs) {
      discPoints = Array.isArray(input.discs) ? input.discs : discPointsFromLabels(input.discs, dims);
      if (discPoints.length === 0) throw new Error('The disc label image has no labels.');
      levelBySlice = levelsFromDiscs(seg, dims, spacing, discPoints, { nativeFlips: input.nativeFlips }).levelBySlice;
    }
    const byLevel = aggregate === 'level' || aggregate === 'levels';
    if (byLevel && !levelBySlice) {
      throw new Error('Per-level morphometry needs disc labels: run TotalSpineSeg on this image first.');
    }
    if (!byLevel && levels.length) {
      throw new Error('Vertebral levels apply to the per-level and across-levels aggregations.');
    }
    if (byLevel && levels.length === 0) {
      levels = [...new Set(Array.from(levelBySlice).filter(level => level > 0))].sort((a, b) => a - b);
    }
    if (byLevel && levels.length === 0) {
      throw new Error('No vertebral level could be assigned to the mask from the disc labels.');
    }

    const shape = computeShape(seg, dims, spacing, { angleCorrection, smooth: input.smooth, onProgress: input.onProgress });
    const rows = aggregateMetrics(shape.metrics, {
      slices,
      levels: byLevel ? levels : [],
      perslice: aggregate === 'slice',
      perlevel: aggregate === 'level',
      levelBySlice
    });
    if (rows.length === 0) {
      throw new Error('No slice matches the requested slices and vertebral levels.');
    }

    const command = ['sct_process_segmentation', '-i', input.filename || 'mask.nii.gz'];
    if (slices.length) command.push('-z', numListToString(slices));
    if (levelBySlice) command.push('-discfile', input.discFilename || 'discs.nii.gz');
    if (byLevel) command.push('-vert', numListToString(levels));
    if (aggregate === 'level') command.push('-perlevel', '1');
    if (aggregate === 'slice') command.push('-perslice', '1');
    if (!angleCorrection) command.push('-angle-corr', '0');

    const overall = aggregateMetrics(shape.metrics, { slices })[0];
    const summary = {
      aggregate,
      row_count: rows.length,
      slice_range: `${shape.zMin}:${shape.zMax}`,
      mean_area_mm2: overall.values['MEAN(area)'],
      mean_diameter_AP_mm: overall.values['MEAN(diameter_AP)'],
      mean_diameter_RL_mm: overall.values['MEAN(diameter_RL)'],
      length_mm: overall.values['SUM(length)'],
      angle_correction: angleCorrection,
      levels: levelBySlice ? numListToString([...new Set(Array.from(levelBySlice).filter(level => level > 0))]) : '',
      command: command.join(' ')
    };
    const csv = toCsv(rows, { filename: input.filename, timestamp: input.timestamp, version: input.version });
    const tableRows = rows.map(row => ({
      slices: numListToString(row.slices),
      vert_level: row.vertLevel ? numListToString(row.vertLevel) : '',
      ...row.values
    }));
    return { rows: tableRows, summary, csv, columns: metricColumns(), perSlice: shape.metrics, levelBySlice, discPoints };
  }

  return {
    METRIC_KEYS,
    AGGREGATIONS,
    CSV_PREFIX_COLUMNS,
    computeShape,
    properties2d,
    levelsFromDiscs,
    discPointsFromLabels,
    aggregateMetrics,
    metricColumns,
    parseNumList,
    numListToString,
    pythonFloatRepr,
    pairwiseSum,
    toCsv,
    processSegmentation
  };
});
