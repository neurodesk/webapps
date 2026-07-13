(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SCTProcessing = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function assertDims(dims) {
    if (!Array.isArray(dims) || dims.length !== 3 || dims.some(v => !Number.isInteger(v) || v <= 0)) {
      throw new Error('dims must be three positive integers');
    }
  }

  function voxelCount(dims) {
    assertDims(dims);
    return dims[0] * dims[1] * dims[2];
  }

  function assertVolume(data, dims, name = 'volume') {
    const expected = voxelCount(dims);
    if (!data || data.length !== expected) {
      throw new Error(`${name} length ${data?.length ?? 'null'} does not match dims ${dims.join('x')}`);
    }
  }

  function index3D(x, y, z, dims) {
    return x + y * dims[0] + z * dims[0] * dims[1];
  }

  function subtractVolumes(left, right, dims) {
    assertVolume(left, dims, 'left');
    assertVolume(right, dims, 'right');
    const out = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) out[i] = left[i] - right[i];
    return out;
  }

  function divideAfterRemovingZero(dividend, divisor, threshold, replacement = NaN) {
    if (!dividend || !divisor || dividend.length !== divisor.length) {
      throw new Error('dividend and divisor must have the same length');
    }
    const out = new Float32Array(dividend.length);
    for (let i = 0; i < dividend.length; i++) {
      if (divisor[i] === 0) {
        out[i] = replacement;
      } else {
        out[i] = Math.max(-threshold, Math.min(threshold, dividend[i] / divisor[i]));
      }
    }
    return out;
  }

  function computeMTR(mt0, mt1, dims, thresholdMtr = 100) {
    assertVolume(mt0, dims, 'mt0');
    assertVolume(mt1, dims, 'mt1');
    const dividend = new Float32Array(mt0.length);
    for (let i = 0; i < mt0.length; i++) dividend[i] = 100 * (mt0[i] - mt1[i]);
    return divideAfterRemovingZero(dividend, mt0, thresholdMtr);
  }

  function computeMTsat(mt, pd, t1, dims, params, b1map = null) {
    assertVolume(mt, dims, 'mt');
    assertVolume(pd, dims, 'pd');
    assertVolume(t1, dims, 't1');
    if (b1map) assertVolume(b1map, dims, 'b1map');
    for (const key of ['trMt', 'trPd', 'trT1', 'faMt', 'faPd', 'faT1']) {
      if (!Number.isFinite(params?.[key]) || params[key] <= 0) throw new Error(`${key} must be a positive number`);
    }

    const faMt = params.faMt * Math.PI / 180;
    const faPd = params.faPd * Math.PI / 180;
    const faT1 = params.faT1 * Math.PI / 180;
    const b1CorrectionFactor = 0.4;
    const r1Threshold = 0.01;
    const mtsatThreshold = 1;
    const mtsat = new Float32Array(mt.length);
    const t1map = new Float32Array(mt.length);

    for (let i = 0; i < mt.length; i++) {
      let r1 = 0.5 * safeDivide((faT1 / params.trT1) * t1[i] - (faPd / params.trPd) * pd[i], pd[i] / faPd - t1[i] / faT1);
      if (b1map) r1 *= b1map[i] * b1map[i];
      if (!Number.isFinite(r1)) r1 = 0;
      if (r1 < r1Threshold) r1 = Infinity;
      t1map[i] = 1 / r1;

      let a = (params.trPd * faT1 / faPd - params.trT1 * faPd / faT1)
        * safeDivide(pd[i] * t1[i], params.trPd * faT1 * t1[i] - params.trT1 * faPd * pd[i]);
      if (b1map) a = safeDivide(a, b1map[i]);

      let value = params.trMt * (faMt * safeDivide(a, mt[i]) - 1) * r1 - (faMt * faMt) / 2;
      if (!Number.isFinite(value) || Math.abs(value) > mtsatThreshold) value = 0;
      value *= 100;
      if (b1map) value = safeDivide(value * (1 - b1CorrectionFactor), 1 - b1CorrectionFactor * b1map[i]);
      mtsat[i] = Number.isFinite(value) ? value : 0;
    }

    return { mtsat, t1map };
  }

  function safeDivide(numerator, denominator) {
    return denominator === 0 ? NaN : numerator / denominator;
  }

  function meanTimeSeries(data, dims4) {
    if (!Array.isArray(dims4) || dims4.length !== 4 || dims4.some(v => !Number.isInteger(v) || v <= 0)) {
      throw new Error('dims4 must be four positive integers');
    }
    const [nx, ny, nz, nt] = dims4;
    const frameSize = nx * ny * nz;
    if (!data || data.length !== frameSize * nt) {
      throw new Error(`time series length ${data?.length ?? 'null'} does not match dims ${dims4.join('x')}`);
    }
    const out = new Float32Array(frameSize);
    for (let t = 0; t < nt; t++) {
      const frameOffset = t * frameSize;
      for (let i = 0; i < frameSize; i++) out[i] += data[frameOffset + i];
    }
    for (let i = 0; i < frameSize; i++) out[i] /= nt;
    return out;
  }

  function normalizeBvecs(bvecs) {
    if (!Array.isArray(bvecs) || !bvecs.length) throw new Error('bvecs must be a non-empty array');
    if (Array.isArray(bvecs[0]) && bvecs.length === 3 && bvecs[0].length !== 3) {
      return bvecs[0].map((_, i) => [bvecs[0][i], bvecs[1][i], bvecs[2][i]]);
    }
    return bvecs.map(row => {
      if (!Array.isArray(row) || row.length !== 3) throw new Error('bvec rows must have three components');
      return row.slice();
    });
  }

  function identifyB0Dwi({ bvecs, bvals = null, bvalMin = 100 }) {
    const vectors = normalizeBvecs(bvecs);
    const indexB0 = [];
    const indexDwi = [];
    if (bvals) {
      if (!Array.isArray(bvals) || bvals.length !== vectors.length) throw new Error('bvals length must match bvec count');
      for (let i = 0; i < bvals.length; i++) {
        (bvals[i] < bvalMin ? indexB0 : indexDwi).push(i);
      }
    } else {
      for (let i = 0; i < vectors.length; i++) {
        const norm = Math.sqrt(vectors[i][0] ** 2 + vectors[i][1] ** 2 + vectors[i][2] ** 2);
        (norm < 0.01 ? indexB0 : indexDwi).push(i);
      }
    }
    if (!indexB0.length) throw new Error('no b=0 images detected');
    return { indexB0, indexDwi };
  }

  function splitB0Dwi(data, dims4, options) {
    if (!Array.isArray(dims4) || dims4.length !== 4 || dims4.some(v => !Number.isInteger(v) || v <= 0)) {
      throw new Error('dims4 must be four positive integers');
    }
    const [nx, ny, nz, nt] = dims4;
    const frameSize = nx * ny * nz;
    if (!data || data.length !== frameSize * nt) throw new Error('data length does not match dims4');
    const { indexB0, indexDwi } = identifyB0Dwi(options);
    return {
      indexB0,
      indexDwi,
      b0: extractFrames(data, frameSize, indexB0),
      dwi: extractFrames(data, frameSize, indexDwi),
      b0Mean: meanSelectedFrames(data, frameSize, indexB0),
      dwiMean: meanSelectedFrames(data, frameSize, indexDwi)
    };
  }

  function extractFrames(data, frameSize, indices) {
    const out = new Float32Array(frameSize * indices.length);
    for (let i = 0; i < indices.length; i++) {
      out.set(data.subarray(indices[i] * frameSize, (indices[i] + 1) * frameSize), i * frameSize);
    }
    return out;
  }

  function meanSelectedFrames(data, frameSize, indices) {
    const out = new Float32Array(frameSize);
    if (!indices.length) return out;
    for (const index of indices) {
      const offset = index * frameSize;
      for (let i = 0; i < frameSize; i++) out[i] += data[offset + i];
    }
    for (let i = 0; i < frameSize; i++) out[i] /= indices.length;
    return out;
  }

  function computeDtiMetrics(data, dims4, bvals, bvecs) {
    if (!Array.isArray(dims4) || dims4.length !== 4 || dims4.some(v => !Number.isInteger(v) || v <= 0)) {
      throw new Error('dims4 must be four positive integers');
    }
    const [nx, ny, nz, nt] = dims4;
    const frameSize = nx * ny * nz;
    if (!data || data.length !== frameSize * nt) throw new Error('data length does not match dims4');
    if (!Array.isArray(bvals) || bvals.length !== nt) throw new Error('bvals length must match time dimension');
    const vectors = normalizeBvecs(bvecs);
    if (vectors.length !== nt) throw new Error('bvec count must match time dimension');

    const designRows = [];
    for (let t = 0; t < nt; t++) {
      if (bvals[t] <= 0) continue;
      const [gx, gy, gz] = vectors[t];
      designRows.push([
        -bvals[t] * gx * gx,
        -2 * bvals[t] * gx * gy,
        -2 * bvals[t] * gx * gz,
        -bvals[t] * gy * gy,
        -2 * bvals[t] * gy * gz,
        -bvals[t] * gz * gz
      ]);
    }
    if (designRows.length < 6) throw new Error('at least six diffusion-weighted directions are required');

    const designPinv = pseudoInverseDesign(designRows);
    const fa = new Float32Array(frameSize);
    const md = new Float32Array(frameSize);
    const rd = new Float32Array(frameSize);
    const ad = new Float32Array(frameSize);
    const b0Indices = bvals.map((b, i) => b <= 0 ? i : -1).filter(i => i >= 0);
    const dwiIndices = bvals.map((b, i) => b > 0 ? i : -1).filter(i => i >= 0);

    for (let voxel = 0; voxel < frameSize; voxel++) {
      let s0 = 0;
      for (const t of b0Indices) s0 += data[t * frameSize + voxel];
      s0 = b0Indices.length ? s0 / b0Indices.length : data[voxel];
      if (s0 <= 0) continue;
      const logSignals = dwiIndices.map(t => Math.log(Math.max(data[t * frameSize + voxel], 1e-6) / s0));
      const tensor = multiplyMatrixVector(designPinv, logSignals);
      const eig = eigenvaluesSymmetric3([
        [tensor[0], tensor[1], tensor[2]],
        [tensor[1], tensor[3], tensor[4]],
        [tensor[2], tensor[4], tensor[5]]
      ]).sort((a, b) => b - a);
      const l1 = Math.max(0, eig[0]);
      const l2 = Math.max(0, eig[1]);
      const l3 = Math.max(0, eig[2]);
      const mean = (l1 + l2 + l3) / 3;
      md[voxel] = mean;
      ad[voxel] = l1;
      rd[voxel] = (l2 + l3) / 2;
      const denom = l1 * l1 + l2 * l2 + l3 * l3;
      fa[voxel] = denom > 0
        ? Math.sqrt(1.5 * ((l1 - mean) ** 2 + (l2 - mean) ** 2 + (l3 - mean) ** 2) / denom)
        : 0;
    }
    return { fa, md, rd, ad };
  }

  function centerlineFromSegmentation(segmentation, dims) {
    assertVolume(segmentation, dims, 'segmentation');
    const [nx, ny, nz] = dims;
    const points = [];
    for (let z = 0; z < nz; z++) {
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (segmentation[index3D(x, y, z, dims)] > 0) {
            count++;
            sumX += x;
            sumY += y;
          }
        }
      }
      points.push(count ? { z, x: sumX / count, y: sumY / count, voxelCount: count } : null);
    }
    return interpolateMissingCenterline(points);
  }

  function interpolateMissingCenterline(points) {
    const out = points.map(point => point ? { ...point } : null);
    const known = out.map((point, index) => point ? index : -1).filter(index => index >= 0);
    if (!known.length) return out;

    for (let i = 0; i < out.length; i++) {
      if (out[i]) continue;
      const prev = [...known].reverse().find(index => index < i);
      const next = known.find(index => index > i);
      if (prev == null && next == null) continue;
      if (prev == null) {
        out[i] = { ...out[next], z: i, interpolated: true };
      } else if (next == null) {
        out[i] = { ...out[prev], z: i, interpolated: true };
      } else {
        const ratio = (i - prev) / (next - prev);
        out[i] = {
          z: i,
          x: out[prev].x + ratio * (out[next].x - out[prev].x),
          y: out[prev].y + ratio * (out[next].y - out[prev].y),
          voxelCount: 0,
          interpolated: true
        };
      }
    }
    return out;
  }

  function createCylinderMask(dims, spacing, centerline, radiusMm) {
    assertDims(dims);
    if (!Array.isArray(spacing) || spacing.length !== 3 || spacing.some(v => !Number.isFinite(v) || v <= 0)) {
      throw new Error('spacing must be three positive numbers');
    }
    if (!Array.isArray(centerline) || centerline.length !== dims[2]) {
      throw new Error('centerline length must match dims[2]');
    }
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) {
      throw new Error('radiusMm must be a positive number');
    }

    const [nx, ny, nz] = dims;
    const out = new Uint8Array(voxelCount(dims));
    const radiusSq = radiusMm * radiusMm;
    for (let z = 0; z < nz; z++) {
      const point = centerline[z];
      if (!point) continue;
      for (let y = 0; y < ny; y++) {
        const dy = (y - point.y) * spacing[1];
        for (let x = 0; x < nx; x++) {
          const dx = (x - point.x) * spacing[0];
          if (dx * dx + dy * dy <= radiusSq) out[index3D(x, y, z, dims)] = 1;
        }
      }
    }
    return out;
  }

  function boundingBoxFromMask(mask, dims, padding = 0) {
    assertVolume(mask, dims, 'mask');
    const [nx, ny, nz] = dims;
    let minX = nx, minY = ny, minZ = nz;
    let maxX = -1, maxY = -1, maxZ = -1;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (!mask[index3D(x, y, z, dims)]) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          minZ = Math.min(minZ, z);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          maxZ = Math.max(maxZ, z);
        }
      }
    }
    if (maxX < 0) return null;
    const pad = Math.max(0, Math.trunc(padding));
    return {
      origin: [Math.max(0, minX - pad), Math.max(0, minY - pad), Math.max(0, minZ - pad)],
      end: [Math.min(nx, maxX + pad + 1), Math.min(ny, maxY + pad + 1), Math.min(nz, maxZ + pad + 1)]
    };
  }

  function cropVolume(data, dims, bbox) {
    assertVolume(data, dims, 'volume');
    if (!bbox) throw new Error('bbox is required');
    const [ox, oy, oz] = bbox.origin;
    const [ex, ey, ez] = bbox.end;
    const outDims = [ex - ox, ey - oy, ez - oz];
    assertDims(outDims);
    const OutArray = data.constructor === Array ? Float32Array : data.constructor;
    const out = new OutArray(outDims[0] * outDims[1] * outDims[2]);
    for (let z = 0; z < outDims[2]; z++) {
      for (let y = 0; y < outDims[1]; y++) {
        const srcStart = index3D(ox, oy + y, oz + z, dims);
        const dstStart = index3D(0, y, z, outDims);
        out.set(data.subarray(srcStart, srcStart + outDims[0]), dstStart);
      }
    }
    return { data: out, dims: outDims, origin: bbox.origin.slice() };
  }

  function sliceMorphometry(segmentation, dims, spacing) {
    assertVolume(segmentation, dims, 'segmentation');
    if (!Array.isArray(spacing) || spacing.length !== 3 || spacing.some(v => !Number.isFinite(v) || v <= 0)) {
      throw new Error('spacing must be three positive numbers');
    }
    const [nx, ny, nz] = dims;
    const voxelArea = spacing[0] * spacing[1];
    const rows = [];
    for (let z = 0; z < nz; z++) {
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (segmentation[index3D(x, y, z, dims)] > 0) {
            count++;
            sumX += x;
            sumY += y;
          }
        }
      }
      const areaMm2 = count * voxelArea;
      rows.push({
        slice: z,
        voxelCount: count,
        areaMm2,
        equivalentDiameterMm: count ? Math.sqrt((4 * areaMm2) / Math.PI) : 0,
        centroidX: count ? sumX / count : null,
        centroidY: count ? sumY / count : null
      });
    }
    return rows;
  }

  function createLabelsFromVertBody(labeledSegmentation, dims, vertebralLevels) {
    assertVolume(labeledSegmentation, dims, 'labeledSegmentation');
    if (!Array.isArray(vertebralLevels) || !vertebralLevels.length) {
      throw new Error('vertebralLevels must be a non-empty array');
    }
    const centerline = centerlineFromSegmentation(labeledSegmentation, dims);
    const out = new Uint8Array(labeledSegmentation.length);
    for (const level of vertebralLevels) {
      const slices = [];
      for (let z = 0; z < dims[2]; z++) {
        let count = 0;
        for (let y = 0; y < dims[1]; y++) {
          for (let x = 0; x < dims[0]; x++) {
            if (Math.round(labeledSegmentation[index3D(x, y, z, dims)]) === level) count++;
          }
        }
        if (count > 0) slices.push(z);
      }
      if (!slices.length) continue;
      const z = slices[Math.floor((slices.length - 1) / 2)];
      const point = centerline[z];
      if (!point) continue;
      const x = Math.max(0, Math.min(dims[0] - 1, Math.round(point.x)));
      const y = Math.max(0, Math.min(dims[1] - 1, Math.round(point.y)));
      out[index3D(x, y, z, dims)] = level;
    }
    return out;
  }

  function smoothAlongAxis(data, dims, spacing, sigmaMm, axis = 2) {
    assertVolume(data, dims, 'volume');
    if (!Array.isArray(spacing) || spacing.length !== 3 || spacing.some(v => !Number.isFinite(v) || v <= 0)) {
      throw new Error('spacing must be three positive numbers');
    }
    if (!Number.isFinite(sigmaMm) || sigmaMm <= 0) throw new Error('sigmaMm must be positive');
    if (![0, 1, 2].includes(axis)) throw new Error('axis must be 0, 1, or 2');
    const sigmaVox = sigmaMm / spacing[axis];
    const radius = Math.max(1, Math.ceil(3 * sigmaVox));
    const kernel = [];
    let kernelSum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const value = Math.exp(-(offset * offset) / (2 * sigmaVox * sigmaVox));
      kernel.push(value);
      kernelSum += value;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= kernelSum;

    const out = new Float32Array(data.length);
    const coords = [0, 0, 0];
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          coords[0] = x; coords[1] = y; coords[2] = z;
          let value = 0;
          let weight = 0;
          for (let k = -radius; k <= radius; k++) {
            const src = coords.slice();
            src[axis] += k;
            if (src[axis] < 0 || src[axis] >= dims[axis]) continue;
            const w = kernel[k + radius];
            value += data[index3D(src[0], src[1], src[2], dims)] * w;
            weight += w;
          }
          out[index3D(x, y, z, dims)] = weight > 0 ? value / weight : data[index3D(x, y, z, dims)];
        }
      }
    }
    return out;
  }

  function extractMetricByLabels(metric, atlas, dims, labels, options = {}) {
    assertVolume(metric, dims, 'metric');
    assertVolume(atlas, dims, 'atlas');
    if (!Array.isArray(labels) || !labels.length) throw new Error('labels must be a non-empty array');
    const method = options.method || 'map';
    const discardNegVal = !!options.discardNegVal;
    const rows = [];
    for (const label of labels) {
      let weightedSum = 0;
      let weightSum = 0;
      let count = 0;
      for (let i = 0; i < metric.length; i++) {
        const atlasValue = atlas[i];
        const matches = Number.isInteger(label)
          ? Math.round(atlasValue) === label
          : atlasValue === label;
        if (!matches) continue;
        const value = metric[i];
        if (!Number.isFinite(value) || (discardNegVal && value < 0)) continue;
        const weight = method === 'wa' ? Math.max(0, atlasValue) : 1;
        if (weight === 0) continue;
        weightedSum += value * weight;
        weightSum += weight;
        count++;
      }
      rows.push({
        label,
        method,
        voxelCount: count,
        mean: weightSum ? weightedSum / weightSum : null
      });
    }
    return rows;
  }

  function metricRowsToCsv(rows) {
    const header = 'label,method,voxel_count,mean';
    const body = rows.map(row => [
      row.label,
      row.method,
      row.voxelCount,
      row.mean == null ? '' : formatNumber(row.mean)
    ].join(','));
    return [header, ...body].join('\n') + '\n';
  }

  function createQcReportHtml(entries) {
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    const rows = entries.map(entry => (
      `<tr><td>${escapeHtml(entry.process || '')}</td><td>${escapeHtml(entry.input || '')}</td><td>${escapeHtml(entry.output || '')}</td></tr>`
    )).join('');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>SCT QC Report</title></head>'
      + '<body><h1>SCT QC Report</h1><table><thead><tr><th>Process</th><th>Input</th><th>Output</th></tr></thead>'
      + `<tbody>${rows}</tbody></table></body></html>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getSctExampleDataManifest() {
    return {
      id: 'sct_example_data',
      sourceUrl: 'https://github.com/spinalcordtoolbox/sct_example_data',
      browserLocalOnly: true,
      sections: ['t1', 't2', 't2s', 'mt', 'dmri', 'fmri']
    };
  }

  function getBrowserModelInstallPlan(manifest, taskId) {
    const task = manifest?.tasks?.find(item => item.id === taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    return {
      taskId,
      displayName: task.displayName,
      supportStatus: task.supportStatus,
      assets: (task.modelAssets || []).map(asset => ({
        id: asset.id,
        filename: asset.filename || null,
        conversionStatus: asset.conversionStatus,
        cacheKey: asset.cacheKey || `${taskId}:${asset.id || 'asset'}:${asset.sourceVersion || 'unknown'}`
      }))
    };
  }

  function labelVertebraeFromSegmentation(segmentation, dims, options = {}) {
    assertVolume(segmentation, dims, 'segmentation');
    const startLevel = options.startLevel ?? 1;
    const slicesPerLevel = options.slicesPerLevel ?? 1;
    if (!Number.isInteger(startLevel) || startLevel <= 0) throw new Error('startLevel must be a positive integer');
    if (!Number.isInteger(slicesPerLevel) || slicesPerLevel <= 0) throw new Error('slicesPerLevel must be a positive integer');
    const out = new Uint8Array(segmentation.length);
    let firstSlice = null;
    for (let z = 0; z < dims[2]; z++) {
      if (sliceHasForeground(segmentation, dims, z)) {
        firstSlice = z;
        break;
      }
    }
    if (firstSlice == null) return out;
    for (let z = firstSlice; z < dims[2]; z++) {
      if (!sliceHasForeground(segmentation, dims, z)) continue;
      const level = startLevel + Math.floor((z - firstSlice) / slicesPerLevel);
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          const idx = index3D(x, y, z, dims);
          if (segmentation[idx] > 0) out[idx] = level;
        }
      }
    }
    return out;
  }

  function sliceHasForeground(data, dims, z) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        if (data[index3D(x, y, z, dims)] > 0) return true;
      }
    }
    return false;
  }

  function centerOfMass(data, dims) {
    assertVolume(data, dims, 'volume');
    const sum = [0, 0, 0];
    let weightSum = 0;
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          const value = Math.max(0, data[index3D(x, y, z, dims)]);
          if (!value) continue;
          sum[0] += x * value;
          sum[1] += y * value;
          sum[2] += z * value;
          weightSum += value;
        }
      }
    }
    if (!weightSum) return [(dims[0] - 1) / 2, (dims[1] - 1) / 2, (dims[2] - 1) / 2];
    return sum.map(value => value / weightSum);
  }

  function registerByCenterOfMass(source, sourceDims, destination, destinationDims) {
    const srcCom = centerOfMass(source, sourceDims);
    const dstCom = centerOfMass(destination, destinationDims);
    return {
      type: 'translation',
      offset: dstCom.map((value, index) => value - srcCom[index]),
      sourceCenter: srcCom,
      destinationCenter: dstCom
    };
  }

  function applyTranslation(data, dims, offset, options = {}) {
    assertVolume(data, dims, 'volume');
    if (!Array.isArray(offset) || offset.length !== 3) throw new Error('offset must contain three numbers');
    const interpolation = options.interpolation || 'linear';
    const fillValue = options.fillValue ?? 0;
    const out = new data.constructor(data.length);
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          const sx = x - offset[0];
          const sy = y - offset[1];
          const sz = z - offset[2];
          out[index3D(x, y, z, dims)] = interpolation === 'nearest'
            ? sampleNearest(data, dims, sx, sy, sz, fillValue)
            : sampleLinear(data, dims, sx, sy, sz, fillValue);
        }
      }
    }
    return out;
  }

  function sampleNearest(data, dims, x, y, z, fillValue) {
    const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= dims[0] || iy >= dims[1] || iz >= dims[2]) return fillValue;
    return data[index3D(ix, iy, iz, dims)];
  }

  function sampleLinear(data, dims, x, y, z, fillValue) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const dx = x - x0, dy = y - y0, dz = z - z0;
    let value = 0;
    for (let oz = 0; oz <= 1; oz++) {
      for (let oy = 0; oy <= 1; oy++) {
        for (let ox = 0; ox <= 1; ox++) {
          const wx = ox ? dx : 1 - dx;
          const wy = oy ? dy : 1 - dy;
          const wz = oz ? dz : 1 - dz;
          value += sampleNearest(data, dims, x0 + ox, y0 + oy, z0 + oz, fillValue) * wx * wy * wz;
        }
      }
    }
    return value;
  }

  function warpTemplate(template, dims, transform, options = {}) {
    if (!transform || transform.type !== 'translation') throw new Error('only translation transforms are supported');
    return applyTranslation(template, dims, transform.offset, options);
  }

  function detectPmj(image, dims) {
    assertVolume(image, dims, 'image');
    let best = { x: 0, y: 0, z: 0, value: -Infinity };
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          const value = image[index3D(x, y, z, dims)];
          if (value > best.value) best = { x, y, z, value };
        }
      }
    }
    return best.value === -Infinity ? null : best;
  }

  function flattenSagittal(volume, dims, segmentation) {
    assertVolume(volume, dims, 'volume');
    assertVolume(segmentation, dims, 'segmentation');
    const centerline = centerlineFromSegmentation(segmentation, dims);
    const valid = centerline.filter(Boolean);
    if (!valid.length) return new Float32Array(volume);
    const targetX = valid.reduce((sum, point) => sum + point.x, 0) / valid.length;
    const out = new Float32Array(volume.length);
    for (let z = 0; z < dims[2]; z++) {
      const point = centerline[z] || { x: targetX };
      const shift = targetX - point.x;
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          out[index3D(x, y, z, dims)] = sampleLinear(volume, dims, x - shift, y, z, 0);
        }
      }
    }
    return out;
  }

  function motionCorrectTimeSeries(data, dims4, mask = null) {
    if (!Array.isArray(dims4) || dims4.length !== 4 || dims4.some(v => !Number.isInteger(v) || v <= 0)) {
      throw new Error('dims4 must be four positive integers');
    }
    const [nx, ny, nz, nt] = dims4;
    const dims = [nx, ny, nz];
    const frameSize = nx * ny * nz;
    if (!data || data.length !== frameSize * nt) throw new Error('data length does not match dims4');
    if (mask) assertVolume(mask, dims, 'mask');
    const corrected = new Float32Array(data.length);
    const transforms = [];
    const reference = data.subarray(0, frameSize);
    const referenceCom = centerOfMass(mask ? multiplyByMask(reference, mask) : reference, dims);
    for (let t = 0; t < nt; t++) {
      const frame = data.subarray(t * frameSize, (t + 1) * frameSize);
      const frameCom = centerOfMass(mask ? multiplyByMask(frame, mask) : frame, dims);
      const offset = referenceCom.map((value, index) => value - frameCom[index]);
      transforms.push({ type: 'translation', offset });
      corrected.set(applyTranslation(frame, dims, offset), t * frameSize);
    }
    return { data: corrected, transforms };
  }

  function multiplyByMask(data, mask) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = mask[i] ? data[i] : 0;
    return out;
  }

  function morphometryToCsv(rows) {
    const header = 'slice,voxel_count,area_mm2,equivalent_diameter_mm,centroid_x,centroid_y';
    const body = rows.map(row => [
      row.slice,
      row.voxelCount,
      formatNumber(row.areaMm2),
      formatNumber(row.equivalentDiameterMm),
      row.centroidX == null ? '' : formatNumber(row.centroidX),
      row.centroidY == null ? '' : formatNumber(row.centroidY)
    ].join(','));
    return [header, ...body].join('\n') + '\n';
  }

  function formatNumber(value) {
    return Number.isInteger(value) ? String(value) : Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }

  function pseudoInverseDesign(rows) {
    const xtx = Array.from({ length: 6 }, () => Array(6).fill(0));
    for (const row of rows) {
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 6; c++) xtx[r][c] += row[r] * row[c];
      }
    }
    const inv = invertMatrix(xtx);
    return inv.map(invRow => rows.map(row => invRow.reduce((sum, value, i) => sum + value * row[i], 0)));
  }

  function multiplyMatrixVector(matrix, vector) {
    return matrix.map(row => row.reduce((sum, value, i) => sum + value * vector[i], 0));
  }

  function invertMatrix(matrix) {
    const n = matrix.length;
    const aug = matrix.map((row, i) => [
      ...row,
      ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)
    ]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) pivot = row;
      }
      if (Math.abs(aug[pivot][col]) < 1e-12) throw new Error('design matrix is singular');
      if (pivot !== col) [aug[pivot], aug[col]] = [aug[col], aug[pivot]];
      const pivotValue = aug[col][col];
      for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivotValue;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = aug[row][col];
        for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
      }
    }
    return aug.map(row => row.slice(n));
  }

  function eigenvaluesSymmetric3(m) {
    const p1 = m[0][1] ** 2 + m[0][2] ** 2 + m[1][2] ** 2;
    if (p1 === 0) return [m[0][0], m[1][1], m[2][2]];
    const q = (m[0][0] + m[1][1] + m[2][2]) / 3;
    const p2 = (m[0][0] - q) ** 2 + (m[1][1] - q) ** 2 + (m[2][2] - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    const b = [
      [(m[0][0] - q) / p, m[0][1] / p, m[0][2] / p],
      [m[1][0] / p, (m[1][1] - q) / p, m[1][2] / p],
      [m[2][0] / p, m[2][1] / p, (m[2][2] - q) / p]
    ];
    const r = determinant3(b) / 2;
    const phi = r <= -1 ? Math.PI / 3 : (r >= 1 ? 0 : Math.acos(r) / 3);
    return [
      q + 2 * p * Math.cos(phi),
      q + 2 * p * Math.cos(phi + (2 * Math.PI / 3)),
      q + 2 * p * Math.cos(phi + (4 * Math.PI / 3))
    ];
  }

  function determinant3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }

  return {
    index3D,
    subtractVolumes,
    computeMTR,
    computeMTsat,
    meanTimeSeries,
    identifyB0Dwi,
    splitB0Dwi,
    computeDtiMetrics,
    centerlineFromSegmentation,
    createCylinderMask,
    boundingBoxFromMask,
    cropVolume,
    sliceMorphometry,
    morphometryToCsv,
    createLabelsFromVertBody,
    smoothAlongAxis,
    extractMetricByLabels,
    metricRowsToCsv,
    createQcReportHtml,
    getSctExampleDataManifest,
    getBrowserModelInstallPlan,
    labelVertebraeFromSegmentation,
    registerByCenterOfMass,
    applyTranslation,
    warpTemplate,
    detectPmj,
    flattenSagittal,
    motionCorrectTimeSeries
  };
});
