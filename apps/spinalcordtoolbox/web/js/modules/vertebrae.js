(function initVertebraeModule(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      fs: require('node:fs'),
      zlib: require('node:zlib')
    });
  } else {
    root.SCTVertebrae = factory({});
  }
})(typeof self !== 'undefined' ? self : globalThis, function createVertebraeModule(deps) {
  'use strict';

  const DEFAULT_LEVEL_RANGE = Object.freeze({ top: 11, bottom: 1 });
  const HOG_EPS = 1e-6;

  function index3D(x, y, z, dims) {
    return x + y * dims[0] + z * dims[0] * dims[1];
  }

  function assertVolume(data, dims, name) {
    if (!data || data.length !== dims[0] * dims[1] * dims[2]) {
      throw new Error(`${name || 'volume'} length does not match dimensions`);
    }
  }

  function decompressNiftiBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    if (deps.zlib) return deps.zlib.gunzipSync(bytes);
    if (typeof nifti !== 'undefined' && nifti.decompress) {
      return new Uint8Array(nifti.decompress(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    }
    throw new Error('Gzipped NIfTI detected but no decompressor is available');
  }

  function parseNifti(input) {
    const bytes = decompressNiftiBytes(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getInt32(0, true) !== 348) throw new Error('Only little-endian NIfTI-1 is supported');
    const dims = [view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)];
    const datatype = view.getInt16(70, true);
    const voxOffset = Math.ceil(view.getFloat32(108, true));
    const slopeRaw = view.getFloat32(112, true);
    const interRaw = view.getFloat32(116, true);
    const slope = Number.isFinite(slopeRaw) && slopeRaw !== 0 ? slopeRaw : 1;
    const inter = Number.isFinite(interRaw) ? interRaw : 0;
    const n = dims[0] * dims[1] * dims[2];
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (datatype === 2) data[i] = bytes[voxOffset + i] * slope + inter;
      else if (datatype === 4) data[i] = view.getInt16(voxOffset + i * 2, true) * slope + inter;
      else if (datatype === 8) data[i] = view.getInt32(voxOffset + i * 4, true) * slope + inter;
      else if (datatype === 16) data[i] = view.getFloat32(voxOffset + i * 4, true) * slope + inter;
      else if (datatype === 64) data[i] = view.getFloat64(voxOffset + i * 8, true) * slope + inter;
      else if (datatype === 512) data[i] = view.getUint16(voxOffset + i * 2, true) * slope + inter;
      else throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
    }
    return { data, dims, datatype };
  }

  function isRemoteAssetUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  async function loadBinaryAsset(url) {
    if (deps.fs && !isRemoteAssetUrl(url)) return deps.fs.readFileSync(url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function loadTextAsset(url) {
    if (deps.fs && !isRemoteAssetUrl(url)) return deps.fs.readFileSync(url, 'utf8');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    return response.text();
  }

  async function loadPam50Levels(url) {
    const bytes = await loadBinaryAsset(url);
    return parseNifti(bytes);
  }

  function extractCenterlineLevelRanges(levelData, dims) {
    const [nx, ny, nz] = dims;
    const xc = Math.round(nx / 2);
    const yc = Math.round(ny / 2);
    const ranges = new Map();
    for (let z = 0; z < nz; z++) {
      const value = Math.round(levelData[index3D(xc, yc, z, dims)]);
      if (value <= 0) continue;
      if (!ranges.has(value)) ranges.set(value, { minZ: z, maxZ: z });
      else ranges.get(value).maxZ = z;
    }
    return ranges;
  }

  function foregroundZRange(segmentation, dims) {
    assertVolume(segmentation, dims, 'segmentation');
    const [nx, ny, nz] = dims;
    let minZ = nz;
    let maxZ = -1;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (segmentation[index3D(x, y, z, dims)] > 0) {
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
      }
    }
    return maxZ < minZ ? null : { minZ, maxZ };
  }

  function parseOpenCvHogSvm(text) {
    const svmMatch = text.match(/SVMDetector:\s*\[([\s\S]*?)\]\s*ps0:/);
    if (!svmMatch) throw new Error('Could not find SVMDetector in OpenCV HOG YAML');
    const detector = svmMatch[1]
      .split(/[\s,]+/)
      .map(value => value.trim())
      .filter(Boolean)
      .map(Number);
    if (detector.some(value => !Number.isFinite(value))) throw new Error('Invalid numeric value in SVMDetector');
    const bias = detector.length === 577 ? detector[576] : 0;
    const weights = detector.length === 577 ? detector.slice(0, 576) : detector;
    if (weights.length !== 576) throw new Error(`Expected 576 HOG weights, found ${weights.length}`);
    return {
      winSize: [32, 32],
      blockSize: [8, 8],
      blockStride: [8, 8],
      cellSize: [4, 4],
      nbins: 9,
      signedGradient: true,
      weights: Float32Array.from(weights),
      bias
    };
  }

  function gradientAt(patch, width, height, x, y) {
    const xm = Math.max(0, x - 1);
    const xp = Math.min(width - 1, x + 1);
    const ym = Math.max(0, y - 1);
    const yp = Math.min(height - 1, y + 1);
    const dx = patch[xp + y * width] - patch[xm + y * width];
    const dy = patch[x + yp * width] - patch[x + ym * width];
    return { dx, dy };
  }

  function computeHogDescriptor32(patch, model) {
    const width = 32;
    const height = 32;
    const cellsX = 8;
    const cellsY = 8;
    const bins = model.nbins;
    const cellHist = new Float32Array(cellsX * cellsY * bins);
    const binSize = (model.signedGradient ? 360 : 180) / bins;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const { dx, dy } = gradientAt(patch, width, height, x, y);
        const mag = Math.hypot(dx, dy);
        if (mag <= 0) continue;
        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (model.signedGradient) {
          if (angle < 0) angle += 360;
        } else {
          if (angle < 0) angle += 180;
          if (angle >= 180) angle -= 180;
        }
        const bin = angle / binSize;
        const b0 = Math.floor(bin) % bins;
        const b1 = (b0 + 1) % bins;
        const w1 = bin - Math.floor(bin);
        const cellX = Math.min(cellsX - 1, Math.floor(x / 4));
        const cellY = Math.min(cellsY - 1, Math.floor(y / 4));
        const off = (cellX + cellY * cellsX) * bins;
        cellHist[off + b0] += mag * (1 - w1);
        cellHist[off + b1] += mag * w1;
      }
    }

    const descriptor = new Float32Array(4 * 4 * 4 * bins);
    let out = 0;
    for (let by = 0; by < 4; by++) {
      for (let bx = 0; bx < 4; bx++) {
        const block = new Float32Array(4 * bins);
        let k = 0;
        for (let cy = 0; cy < 2; cy++) {
          for (let cx = 0; cx < 2; cx++) {
            const off = ((bx * 2 + cx) + (by * 2 + cy) * cellsX) * bins;
            for (let b = 0; b < bins; b++) block[k++] = cellHist[off + b];
          }
        }
        normalizeBlock(block);
        descriptor.set(block, out);
        out += block.length;
      }
    }
    return descriptor;
  }

  function normalizeBlock(block) {
    let norm = HOG_EPS * HOG_EPS;
    for (let i = 0; i < block.length; i++) norm += block[i] * block[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < block.length; i++) block[i] = Math.min(block[i] / norm, 0.2);
    norm = HOG_EPS * HOG_EPS;
    for (let i = 0; i < block.length; i++) norm += block[i] * block[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < block.length; i++) block[i] /= norm;
  }

  function getNormalizedPatch2D(image, width, height, x0, y0, size) {
    const patch = new Float32Array(size * size);
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = image[(x0 + x) + (y0 + y) * width];
        patch[x + y * size] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    const range = max - min || 1;
    for (let i = 0; i < patch.length; i++) patch[i] = Math.sqrt(Math.max(0, (patch[i] - min) / range));
    return patch;
  }

  function sagittalAverage(anatomy, dims, halfWidth = 3) {
    assertVolume(anatomy, dims, 'anatomy');
    const [nx, ny, nz] = dims;
    const midX = Math.round(nx / 2);
    const x0 = Math.max(0, midX - halfWidth);
    const x1 = Math.min(nx - 1, midX + halfWidth);
    const out = new Float32Array(ny * nz);
    const count = x1 - x0 + 1;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        let sum = 0;
        for (let x = x0; x <= x1; x++) sum += anatomy[index3D(x, y, z, dims)];
        out[y + z * ny] = sum / count;
      }
    }
    return { data: out, dims: [ny, nz] };
  }

  function centerlineYByZ(segmentation, dims) {
    const [nx, ny, nz] = dims;
    const centers = new Float32Array(nz);
    centers.fill(NaN);
    for (let z = 0; z < nz; z++) {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (segmentation[index3D(x, y, z, dims)] > 0) {
            sum += y;
            count++;
          }
        }
      }
      if (count) centers[z] = sum / count;
    }
    return centers;
  }

  function detectC2C3(anatomy, segmentation, dims, model, options = {}) {
    assertVolume(anatomy, dims, 'anatomy');
    assertVolume(segmentation, dims, 'segmentation');
    const sag = sagittalAverage(anatomy, dims, options.sagittalHalfWidth ?? 3);
    const width = sag.dims[0];
    const height = sag.dims[1];
    const centers = centerlineYByZ(segmentation, dims);
    const zRange = foregroundZRange(segmentation, dims);
    if (!zRange) throw new Error('Cannot detect C2-C3 without a spinal cord segmentation');
    const maskHalfSize = Math.max(3, Math.round((options.maskHalfSizeMm ?? 25) / (options.apSpacing ?? 1)));
    const stride = options.stride ?? 2;
    let best = { score: -Infinity, y: NaN, z: NaN };

    for (let z0 = 0; z0 <= height - 32; z0 += stride) {
      const zc = z0 + 16;
      if (zc < zRange.minZ || zc > zRange.maxZ) continue;
      const centerY = centers[zc];
      if (!Number.isFinite(centerY)) continue;
      const yStart = Math.max(0, Math.floor(centerY - maskHalfSize - 16));
      const yEnd = Math.min(width - 32, Math.ceil(centerY + maskHalfSize - 16));
      for (let y0 = yStart; y0 <= yEnd; y0 += stride) {
        const patch = getNormalizedPatch2D(sag.data, width, height, y0, z0, 32);
        const desc = computeHogDescriptor32(patch, model);
        let score = model.bias;
        for (let i = 0; i < desc.length; i++) score += desc[i] * model.weights[i];
        if (score > best.score) best = { score, y: y0 + 16, z: zc };
      }
    }

    const fallbackZ = zRange.minZ + Math.max(1, Math.round((zRange.maxZ - zRange.minZ) * 0.03));
    if (!Number.isFinite(best.z)) {
      best = { score: -Infinity, y: centers[fallbackZ], z: fallbackZ, fallback: true };
    } else {
      best.fallback = best.score < (options.minScore ?? -Infinity);
    }
    if (best.fallback) best.z = fallbackZ;
    return best;
  }

  function createDiscBoundariesFromPam50(anchorZ, segRange, levelRanges, options = {}) {
    const topLevel = options.topLevel ?? DEFAULT_LEVEL_RANGE.top;
    const bottomLevel = options.bottomLevel ?? DEFAULT_LEVEL_RANGE.bottom;
    const anchorLevel = options.anchorLevel ?? topLevel;
    const anchorRange = levelRanges.get(anchorLevel);
    const bottomRange = levelRanges.get(bottomLevel);
    if (!anchorRange || !bottomRange) throw new Error('PAM50 levels do not contain required vertebral levels');
    const templateAnchor = anchorRange.maxZ;
    const templateBottom = bottomRange.maxZ;
    const scale = options.scaleDist ?? ((segRange.maxZ - anchorZ) / Math.max(1, templateBottom - templateAnchor));
    const boundaries = [];
    boundaries.push({ z: Math.round(anchorZ), superiorLabel: topLevel, inferiorLabel: topLevel - 1 });
    for (let level = topLevel - 1; level > bottomLevel; level--) {
      const range = levelRanges.get(level);
      if (!range) continue;
      boundaries.push({
        z: Math.round(anchorZ + (range.maxZ - templateAnchor) * scale),
        superiorLabel: level,
        inferiorLabel: level - 1
      });
    }
    return boundaries
      .filter(boundary => boundary.z >= segRange.minZ - 1 && boundary.z <= segRange.maxZ + 1)
      .sort((a, b) => a.z - b.z);
  }

  function labelSegmentationFromBoundaries(segmentation, dims, boundaries, options = {}) {
    assertVolume(segmentation, dims, 'segmentation');
    const topLabel = options.topLabel ?? DEFAULT_LEVEL_RANGE.top;
    const bottomLabel = options.bottomLabel ?? DEFAULT_LEVEL_RANGE.bottom;
    const out = new Uint8Array(segmentation.length);
    const sorted = boundaries.slice().sort((a, b) => a.z - b.z);
    const [nx, ny, nz] = dims;
    for (let z = 0; z < nz; z++) {
      let label = topLabel;
      for (let i = 0; i < sorted.length; i++) {
        if (z > sorted[i].z) label = sorted[i].inferiorLabel;
      }
      label = Math.max(bottomLabel, Math.min(topLabel, label));
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const idx = index3D(x, y, z, dims);
          if (segmentation[idx] > 0) out[idx] = label;
        }
      }
    }
    return out;
  }

  async function labelVertebrae(options) {
    const { anatomy, segmentation, dims, c2c3ModelUrl, pam50LevelsUrl } = options;
    const modelText = await loadTextAsset(c2c3ModelUrl);
    const model = parseOpenCvHogSvm(modelText);
    const levels = await loadPam50Levels(pam50LevelsUrl);
    const levelRanges = extractCenterlineLevelRanges(levels.data, levels.dims);
    const detected = detectC2C3(anatomy, segmentation, dims, model, {
      apSpacing: options.spacing?.[1] || 1,
      stride: options.detectorStride ?? 2,
      minScore: options.detectorMinScore ?? 0.1
    });
    const segRange = foregroundZRange(segmentation, dims);
    const boundaries = createDiscBoundariesFromPam50(detected.z, segRange, levelRanges, {
      scaleDist: options.scaleDist ?? 0.55,
      topLevel: options.topLevel,
      bottomLevel: options.bottomLevel,
      anchorLevel: options.anchorLevel
    });
    const labels = labelSegmentationFromBoundaries(segmentation, dims, boundaries, options);
    return { labels, detected, boundaries };
  }

  return {
    index3D,
    parseNifti,
    parseOpenCvHogSvm,
    computeHogDescriptor32,
    detectC2C3,
    loadPam50Levels,
    extractCenterlineLevelRanges,
    foregroundZRange,
    createDiscBoundariesFromPam50,
    labelSegmentationFromBoundaries,
    labelVertebrae
  };
});
