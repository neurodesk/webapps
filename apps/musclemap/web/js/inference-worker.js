/**
 * MuscleMap Inference Worker
 *
 * Runs ONNX model inference for 2D slice-by-slice muscle segmentation.
 * Pipeline: NIfTI parse → orient → resample → normalize → crop → 2D sliding window → postprocess → output
 */

/* global importScripts, ort, localforage, nifti */

importScripts('../wasm/ort.webgpu.min.js');
importScripts('https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js');
importScripts('../nifti-js/index.js');

// ==================== Message Helpers ====================

function postProgress(value, text) {
  self.postMessage({ type: 'progress', value, text });
}

function postLog(message) {
  self.postMessage({ type: 'log', message });
}

function postError(message) {
  self.postMessage({ type: 'error', message });
}

function postComplete() {
  self.postMessage({ type: 'complete' });
}

function postStageData(stage, niftiData, description) {
  self.postMessage(
    { type: 'stageData', stage, niftiData, description },
    [niftiData]
  );
}

function postDetectedLabels(labels) {
  self.postMessage({ type: 'detectedLabels', labels });
}

function postMetrics(metrics) {
  self.postMessage({ type: 'metrics', metrics });
}

// ==================== NIfTI Parsing ====================

function decompressIfNeeded(data) {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof nifti !== 'undefined' && nifti.isCompressed) {
      if (nifti.isCompressed(bytes.buffer)) {
        return new Uint8Array(nifti.decompress(bytes.buffer));
      }
    }
    throw new Error('Gzipped NIfTI detected but decompression not available');
  }
  return bytes;
}

function parseNiftiInput(arrayBuffer) {
  const data = decompressIfNeeded(arrayBuffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const dims = [];
  for (let i = 0; i < 8; i++) dims.push(view.getInt16(40 + i * 2, true));
  const nx = dims[1], ny = dims[2], nz = dims[3];

  const pixDims = [];
  for (let i = 0; i < 8; i++) pixDims.push(view.getFloat32(76 + i * 4, true));

  const datatype = view.getInt16(70, true);
  const voxOffset = view.getFloat32(108, true);
  const sclSlope = view.getFloat32(112, true) || 1;
  const sclInter = view.getFloat32(116, true) || 0;
  const dataStart = Math.ceil(voxOffset);
  const nTotal = nx * ny * nz;

  const imageData = new Float32Array(nTotal);
  switch (datatype) {
    case 2:
      for (let i = 0; i < nTotal; i++) imageData[i] = data[dataStart + i] * sclSlope + sclInter;
      break;
    case 4:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getInt16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    case 8:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getInt32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 16:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getFloat32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 64:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getFloat64(dataStart + i * 8, true) * sclSlope + sclInter;
      break;
    case 512:
      for (let i = 0; i < nTotal; i++) imageData[i] = view.getUint16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }

  // Extract affine matrix (prefer sform)
  const affine = extractAffine(view);

  const headerSize = dataStart;
  const headerBytes = new ArrayBuffer(headerSize);
  new Uint8Array(headerBytes).set(data.slice(0, headerSize));

  return {
    imageData,
    dims: [nx, ny, nz],
    voxelSize: [Math.abs(pixDims[1]) || 1, Math.abs(pixDims[2]) || 1, Math.abs(pixDims[3]) || 1],
    headerBytes,
    affine
  };
}

function extractAffine(view) {
  const sformCode = view.getInt16(254, true);
  const qformCode = view.getInt16(252, true);

  if (sformCode > 0) {
    const affine = [new Float64Array(4), new Float64Array(4), new Float64Array(4), new Float64Array([0, 0, 0, 1])];
    for (let i = 0; i < 4; i++) {
      affine[0][i] = view.getFloat32(280 + i * 4, true);
      affine[1][i] = view.getFloat32(296 + i * 4, true);
      affine[2][i] = view.getFloat32(312 + i * 4, true);
    }
    return affine;
  }

  if (qformCode > 0) {
    const pixDims = [];
    for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
    const qb = view.getFloat32(256, true);
    const qc = view.getFloat32(260, true);
    const qd = view.getFloat32(264, true);
    const qx = view.getFloat32(268, true);
    const qy = view.getFloat32(272, true);
    const qz = view.getFloat32(276, true);
    const sqr = qb * qb + qc * qc + qd * qd;
    const qa = sqr > 1.0 ? 0.0 : Math.sqrt(1.0 - sqr);
    const R = [
      [qa*qa+qb*qb-qc*qc-qd*qd, 2*(qb*qc-qa*qd), 2*(qb*qd+qa*qc)],
      [2*(qb*qc+qa*qd), qa*qa+qc*qc-qb*qb-qd*qd, 2*(qc*qd-qa*qb)],
      [2*(qb*qd-qa*qc), 2*(qc*qd+qa*qb), qa*qa+qd*qd-qb*qb-qc*qc]
    ];
    const qfac = pixDims[0] < 0 ? -1 : 1;
    return [
      new Float64Array([R[0][0]*pixDims[1], R[0][1]*pixDims[2], R[0][2]*pixDims[3]*qfac, qx]),
      new Float64Array([R[1][0]*pixDims[1], R[1][1]*pixDims[2], R[1][2]*pixDims[3]*qfac, qy]),
      new Float64Array([R[2][0]*pixDims[1], R[2][1]*pixDims[2], R[2][2]*pixDims[3]*qfac, qz]),
      new Float64Array([0, 0, 0, 1])
    ];
  }

  const pixDims = [];
  for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
  return [
    new Float64Array([pixDims[1] || 1, 0, 0, 0]),
    new Float64Array([0, pixDims[2] || 1, 0, 0]),
    new Float64Array([0, 0, pixDims[3] || 1, 0]),
    new Float64Array([0, 0, 0, 1])
  ];
}

// ==================== NIfTI Output ====================

function createOutputNifti(uint8Data, sourceHeader, dims) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const buffer = new ArrayBuffer(headerSize + uint8Data.length);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Set datatype to UINT8
  destView.setInt16(70, 2, true);
  destView.setInt16(72, 8, true);

  // Update dims if provided
  if (dims) {
    destView.setInt16(40, 3, true);
    destView.setInt16(42, dims[0], true);
    destView.setInt16(44, dims[1], true);
    destView.setInt16(46, dims[2], true);
    destView.setInt16(48, 1, true);
  }

  destView.setFloat32(112, 1, true);  // scl_slope
  destView.setFloat32(116, 0, true);  // scl_inter

  // Set cal_min/cal_max so NiiVue maps label values 1:1 to colormap indices
  destView.setFloat32(124, 255, true);  // cal_max
  destView.setFloat32(128, 0, true);    // cal_min

  new Uint8Array(buffer, headerSize).set(uint8Data);
  return buffer;
}

// ==================== Preprocessing ====================

function getOrientationTransform(affine) {
  const mat = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]]
  ];

  const perm = [0, 0, 0];
  const flip = [false, false, false];
  const used = [false, false, false];

  for (let outAxis = 0; outAxis < 3; outAxis++) {
    let bestAxis = -1;
    let bestVal = -1;
    for (let inAxis = 0; inAxis < 3; inAxis++) {
      if (used[inAxis]) continue;
      const val = Math.abs(mat[outAxis][inAxis]);
      if (val > bestVal) {
        bestVal = val;
        bestAxis = inAxis;
      }
    }
    perm[outAxis] = bestAxis;
    flip[outAxis] = mat[outAxis][bestAxis] < 0;
    used[bestAxis] = true;
  }

  return { perm, flip };
}

function orientToRAS(data, dims, perm, flip) {
  const [nx, ny, nz] = dims;
  const srcDims = [nx, ny, nz];
  const dstDims = [srcDims[perm[0]], srcDims[perm[1]], srcDims[perm[2]]];
  const [dx, dy, dz] = dstDims;
  const result = new Float32Array(dx * dy * dz);

  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dstDims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = src[0] + src[1] * nx + src[2] * nx * ny;
        const dstIdx = ox + oy * dx + oz * dx * dy;
        result[dstIdx] = data[srcIdx];
      }
    }
  }

  return { data: result, dims: dstDims };
}

function resampleVolume(data, dims, srcSpacing, tgtSpacing) {
  const [nx, ny, nz] = dims;
  const actualTarget = tgtSpacing.map((t, i) => t < 0 ? srcSpacing[i] : t);

  const newDims = [
    Math.round(nx * srcSpacing[0] / actualTarget[0]),
    Math.round(ny * srcSpacing[1] / actualTarget[1]),
    Math.round(nz * srcSpacing[2] / actualTarget[2])
  ];
  const [nnx, nny, nnz] = newDims;
  const result = new Float32Array(nnx * nny * nnz);

  const scaleX = (nx - 1) / Math.max(nnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(nny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(nnz - 1, 1);

  for (let z = 0; z < nnz; z++) {
    const sz = z * scaleZ;
    const z0 = Math.floor(sz);
    const z1 = Math.min(z0 + 1, nz - 1);
    const wz = sz - z0;
    for (let y = 0; y < nny; y++) {
      const sy = y * scaleY;
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, ny - 1);
      const wy = sy - y0;
      for (let x = 0; x < nnx; x++) {
        const sx = x * scaleX;
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = sx - x0;

        const c000 = data[x0 + y0*nx + z0*nx*ny];
        const c100 = data[x1 + y0*nx + z0*nx*ny];
        const c010 = data[x0 + y1*nx + z0*nx*ny];
        const c110 = data[x1 + y1*nx + z0*nx*ny];
        const c001 = data[x0 + y0*nx + z1*nx*ny];
        const c101 = data[x1 + y0*nx + z1*nx*ny];
        const c011 = data[x0 + y1*nx + z1*nx*ny];
        const c111 = data[x1 + y1*nx + z1*nx*ny];

        const c00 = c000*(1-wx) + c100*wx;
        const c01 = c001*(1-wx) + c101*wx;
        const c10 = c010*(1-wx) + c110*wx;
        const c11 = c011*(1-wx) + c111*wx;
        const c0 = c00*(1-wy) + c10*wy;
        const c1 = c01*(1-wy) + c11*wy;

        result[x + y*nnx + z*nnx*nny] = c0*(1-wz) + c1*wz;
      }
    }
  }

  return { data: result, dims: newDims, spacing: actualTarget };
}

function zScoreNormalizeNonzero(data) {
  const n = data.length;
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] !== 0) { sum += data[i]; count++; }
  }
  if (count === 0) return new Float32Array(n);
  const mean = sum / count;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] !== 0) { const d = data[i] - mean; sumSq += d * d; }
  }
  const std = Math.sqrt(sumSq / count) || 1;
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (data[i] !== 0) result[i] = (data[i] - mean) / std;
  }
  return result;
}

function cropForeground(data, dims, margin) {
  const [nx, ny, nz] = dims;
  let minX = nx, maxX = 0, minY = ny, maxY = 0, minZ = nz, maxZ = 0;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (data[x + y*nx + z*nx*ny] !== 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
  }

  if (maxX < minX) return { data: new Float32Array(0), dims: [0,0,0], origin: [0,0,0] };

  const ox = Math.max(0, minX - margin);
  const oy = Math.max(0, minY - margin);
  const oz = Math.max(0, minZ - margin);
  const ex = Math.min(nx, maxX + margin + 1);
  const ey = Math.min(ny, maxY + margin + 1);
  const ez = Math.min(nz, maxZ + margin + 1);
  const cnx = ex - ox, cny = ey - oy, cnz = ez - oz;

  const result = new Float32Array(cnx * cny * cnz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = (z+oz)*nx*ny + (y+oy)*nx + ox;
      const dstOff = z*cnx*cny + y*cnx;
      result.set(data.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }

  return { data: result, dims: [cnx, cny, cnz], origin: [ox, oy, oz] };
}

// ==================== Sliding Window ====================

function computeGaussianWeightMap(h, w) {
  const sigma = Math.min(h, w) / 8;
  const weights = new Float32Array(h * w);
  const cy = (h - 1) / 2;
  const cx = (w - 1) / 2;
  const s2 = 2 * sigma * sigma;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dy = y - cy, dx = x - cx;
      weights[y * w + x] = Math.exp(-(dy*dy + dx*dx) / s2);
    }
  }
  return weights;
}

function computeTilePositions(imgH, imgW, patchH, patchW, overlap) {
  const stepH = Math.max(1, Math.round(patchH * (1 - overlap)));
  const stepW = Math.max(1, Math.round(patchW * (1 - overlap)));

  const numY = Math.max(1, Math.ceil((imgH - patchH) / stepH) + 1);
  const numX = Math.max(1, Math.ceil((imgW - patchW) / stepW) + 1);

  const positions = [];
  const seen = new Set();

  for (let iy = 0; iy < numY; iy++) {
    let y = iy * stepH;
    if (y + patchH > imgH) y = Math.max(0, imgH - patchH);
    for (let ix = 0; ix < numX; ix++) {
      let x = ix * stepW;
      if (x + patchW > imgW) x = Math.max(0, imgW - patchW);
      const key = `${y},${x}`;
      if (!seen.has(key)) {
        seen.add(key);
        positions.push({ y, x });
      }
    }
  }

  return positions;
}

// ==================== Postprocessing ====================

function connectedComponents3D(binaryMask, dims) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const labels = new Int32Array(n);
  let nextLabel = 1;
  const parent = [0];
  const rank = [0];

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }

  function union(a, b) {
    a = find(a); b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }

  const neighborOffsets = [];
  for (let dz = -1; dz <= 0; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && dy === 0 && dx >= 0) continue;
        neighborOffsets.push([dx, dy, dz]);
      }

  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const idx = z*ny*nx + y*nx + x;
        if (!binaryMask[idx]) continue;
        const neighborLabels = [];
        for (let i = 0; i < neighborOffsets.length; i++) {
          const nx2 = x+neighborOffsets[i][0], ny2 = y+neighborOffsets[i][1], nz2 = z+neighborOffsets[i][2];
          if (nx2<0||nx2>=nx||ny2<0||ny2>=ny||nz2<0||nz2>=nz) continue;
          const nIdx = nz2*ny*nx + ny2*nx + nx2;
          if (labels[nIdx] > 0) neighborLabels.push(labels[nIdx]);
        }
        if (neighborLabels.length === 0) {
          labels[idx] = nextLabel;
          parent.push(nextLabel);
          rank.push(0);
          nextLabel++;
        } else {
          let minLabel = find(neighborLabels[0]);
          for (let i = 1; i < neighborLabels.length; i++) {
            const c = find(neighborLabels[i]);
            if (c < minLabel) minLabel = c;
          }
          labels[idx] = minLabel;
          for (let i = 0; i < neighborLabels.length; i++) union(minLabel, neighborLabels[i]);
        }
      }

  const canonicalMap = new Map();
  let finalLabel = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] === 0) continue;
    const root = find(labels[i]);
    if (!canonicalMap.has(root)) canonicalMap.set(root, ++finalLabel);
    labels[i] = canonicalMap.get(root);
  }
  return { labels, numComponents: finalLabel };
}

function perLabelLargestComponent(labelVolume, dims, numLabels, progressBase = 0.85, progressSpan = 0.10) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const result = new Uint8Array(n);
  const labelCounts = new Int32Array(numLabels + 1);
  const minX = new Int32Array(numLabels + 1);
  const minY = new Int32Array(numLabels + 1);
  const minZ = new Int32Array(numLabels + 1);
  const maxX = new Int32Array(numLabels + 1);
  const maxY = new Int32Array(numLabels + 1);
  const maxZ = new Int32Array(numLabels + 1);

  minX.fill(nx);
  minY.fill(ny);
  minZ.fill(nz);
  maxX.fill(-1);
  maxY.fill(-1);
  maxZ.fill(-1);

  for (let z = 0; z < nz; z++) {
    const zOff = z * nx * ny;
    for (let y = 0; y < ny; y++) {
      const rowOff = zOff + y * nx;
      for (let x = 0; x < nx; x++) {
        const label = labelVolume[rowOff + x];
        if (label <= 0 || label > numLabels) continue;

        labelCounts[label]++;
        if (x < minX[label]) minX[label] = x;
        if (x > maxX[label]) maxX[label] = x;
        if (y < minY[label]) minY[label] = y;
        if (y > maxY[label]) maxY[label] = y;
        if (z < minZ[label]) minZ[label] = z;
        if (z > maxZ[label]) maxZ[label] = z;
      }
    }
  }

  const activeLabels = [];
  for (let label = 1; label <= numLabels; label++) {
    if (labelCounts[label] > 0) {
      activeLabels.push(label);
    }
  }

  const totalActive = activeLabels.length;
  if (totalActive === 0) {
    return result;
  }

  for (let activeIdx = 0; activeIdx < totalActive; activeIdx++) {
    const label = activeLabels[activeIdx];
    const boxNx = maxX[label] - minX[label] + 1;
    const boxNy = maxY[label] - minY[label] + 1;
    const boxNz = maxZ[label] - minZ[label] + 1;
    const boxN = boxNx * boxNy * boxNz;
    const mask = new Uint8Array(boxN);

    for (let z = minZ[label]; z <= maxZ[label]; z++) {
      const srcZOff = z * nx * ny;
      const localZOff = (z - minZ[label]) * boxNx * boxNy;
      for (let y = minY[label]; y <= maxY[label]; y++) {
        const srcRowOff = srcZOff + y * nx;
        const localRowOff = localZOff + (y - minY[label]) * boxNx;
        for (let x = minX[label]; x <= maxX[label]; x++) {
          if (labelVolume[srcRowOff + x] === label) {
            mask[localRowOff + (x - minX[label])] = 1;
          }
        }
      }
    }

    const { labels: ccLabels, numComponents } = connectedComponents3D(mask, [boxNx, boxNy, boxNz]);

    if (numComponents <= 1) {
      for (let z = minZ[label]; z <= maxZ[label]; z++) {
        const dstZOff = z * nx * ny;
        const localZOff = (z - minZ[label]) * boxNx * boxNy;
        for (let y = minY[label]; y <= maxY[label]; y++) {
          const dstRowOff = dstZOff + y * nx;
          const localRowOff = localZOff + (y - minY[label]) * boxNx;
          for (let x = minX[label]; x <= maxX[label]; x++) {
            if (mask[localRowOff + (x - minX[label])]) {
              result[dstRowOff + x] = label;
            }
          }
        }
      }
    } else {
      const sizes = new Int32Array(numComponents + 1);
      for (let i = 0; i < boxN; i++) {
        if (ccLabels[i] > 0) sizes[ccLabels[i]]++;
      }
      let best = 1, bestSize = 0;
      for (let c = 1; c <= numComponents; c++) {
        if (sizes[c] > bestSize) { bestSize = sizes[c]; best = c; }
      }
      for (let z = minZ[label]; z <= maxZ[label]; z++) {
        const dstZOff = z * nx * ny;
        const localZOff = (z - minZ[label]) * boxNx * boxNy;
        for (let y = minY[label]; y <= maxY[label]; y++) {
          const dstRowOff = dstZOff + y * nx;
          const localRowOff = localZOff + (y - minY[label]) * boxNx;
          for (let x = minX[label]; x <= maxX[label]; x++) {
            if (ccLabels[localRowOff + (x - minX[label])] === best) {
              result[dstRowOff + x] = label;
            }
          }
        }
      }
    }

    if (activeIdx % 5 === 0 || activeIdx === totalActive - 1) {
      postProgress(
        progressBase + progressSpan * ((activeIdx + 1) / totalActive),
        `Cleaning label ${activeIdx + 1}/${totalActive}...`
      );
    }
  }

  return result;
}

// ==================== Inverse Transform ====================

function uncrop(croppedData, croppedDims, fullDims, origin) {
  const [nx, ny, nz] = fullDims;
  const [cnx, cny, cnz] = croppedDims;
  const [ox, oy, oz] = origin;
  const result = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const srcOff = z*cnx*cny + y*cnx;
      const dstOff = (z+oz)*nx*ny + (y+oy)*nx + ox;
      result.set(croppedData.subarray(srcOff, srcOff + cnx), dstOff);
    }
  }
  return result;
}

function resampleLabelsNearest(data, dims, tgtDims) {
  const [nx, ny, nz] = dims;
  const [tnx, tny, tnz] = tgtDims;
  const result = new Uint8Array(tnx * tny * tnz);
  const scaleX = (nx - 1) / Math.max(tnx - 1, 1);
  const scaleY = (ny - 1) / Math.max(tny - 1, 1);
  const scaleZ = (nz - 1) / Math.max(tnz - 1, 1);
  for (let z = 0; z < tnz; z++) {
    const sz = Math.round(z * scaleZ);
    for (let y = 0; y < tny; y++) {
      const sy = Math.round(y * scaleY);
      for (let x = 0; x < tnx; x++) {
        const sx = Math.round(x * scaleX);
        result[x + y*tnx + z*tnx*tny] = data[sx + sy*nx + sz*nx*ny];
      }
    }
  }
  return result;
}

function inverseOrient(data, dims, perm, flip, origDims) {
  const [dx, dy, dz] = dims;
  const [nx, ny, nz] = origDims;
  const result = new Uint8Array(nx * ny * nz);
  for (let oz = 0; oz < dz; oz++) {
    for (let oy = 0; oy < dy; oy++) {
      for (let ox = 0; ox < dx; ox++) {
        const coords = [ox, oy, oz];
        const src = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          src[perm[i]] = flip[i] ? (dims[i] - 1 - coords[i]) : coords[i];
        }
        const srcIdx = ox + oy*dx + oz*dx*dy;
        const dstIdx = src[0] + src[1]*nx + src[2]*nx*ny;
        result[dstIdx] = data[srcIdx];
      }
    }
  }
  return result;
}

function applyInverseTransforms(labels, workingDims, resampledDims, cropOrigin, needsResample, rasDims, isIdentity, perm, flip, origDims) {
  let outputLabels = uncrop(labels, workingDims, resampledDims, cropOrigin);

  if (needsResample) {
    outputLabels = resampleLabelsNearest(outputLabels, resampledDims, rasDims);
  }

  if (!isIdentity) {
    outputLabels = inverseOrient(outputLabels, rasDims, perm, flip, origDims);
  }

  return outputLabels;
}

// ==================== Model Loading ====================

async function fetchModel(url, modelName, progressBase, progressSpan) {
  const displayName = modelName || url.split('/').pop();
  const cacheKey = `${url}?v=${self._appVersion || ''}`;

  try {
    const cached = await localforage.getItem(cacheKey);
    if (cached && cached.byteLength > 1000000) {
      postLog(`Model loaded from cache: ${displayName}`);
      postProgress(progressBase + progressSpan, `Cached: ${displayName}`);
      return cached;
    }
  } catch (e) { /* cache miss */ }

  postLog(`Downloading: ${displayName}...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);

  const contentLength = parseInt(response.headers.get('content-length'), 10);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength) {
      const dlProgress = received / contentLength;
      const mb = (received / 1048576).toFixed(1);
      const totalMb = (contentLength / 1048576).toFixed(0);
      postProgress(progressBase + dlProgress * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
    }
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }

  try {
    await localforage.setItem(cacheKey, data.buffer);
  } catch (e) {
    postLog('Warning: Could not cache model (storage full?)');
  }

  postLog(`Downloaded: ${displayName} (${(received / 1048576).toFixed(1)} MB)`);
  return data.buffer;
}

// ==================== Chunk Size Resolution ====================

function resolveChunkSize(setting, numClasses, roiH, roiW) {
  if (typeof setting === 'number' && [1, 2, 4, 8].includes(setting)) {
    return setting;
  }
  // Auto mode: detect device memory
  const deviceMemory = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
  const availableMB = deviceMemory * 1024 * 0.3; // use 30% of total
  const perChunkMB = (numClasses * roiH * roiW * 4) / (1024 * 1024);
  const chunkSize = Math.min(8, Math.max(1, Math.floor(availableMB / perChunkMB)));
  return chunkSize;
}

function getOptimalWasmThreads() {
  const hardwareThreads = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, hardwareThreads);
}

// ==================== Intramuscular Fat Metrics ====================

function normalizeImfSettings(settings = {}) {
  const mode = settings.mode === 'dixon' || settings.mode === 'both'
    ? settings.mode
    : 'threshold';
  return {
    enabled: !!settings.enabled,
    mode,
    method: settings.method === 'gmm' ? 'gmm' : 'kmeans',
    components: Number(settings.components) === 3 ? 3 : 2
  };
}

function imfUsesThreshold(settings) {
  return settings.mode !== 'dixon';
}

function imfUsesDixon(settings) {
  return settings.mode === 'dixon' || settings.mode === 'both';
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getRange1D(values) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    sumSq += value * value;
  }

  const mean = values.length ? sum / values.length : 0;
  const variance = values.length ? Math.max(sumSq / values.length - mean * mean, 0) : 0;
  return { min, max, mean, variance };
}

function initializeCenters1D(values, components) {
  const { min, max } = getRange1D(values);
  const centers = new Float64Array(components);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    centers.fill(Number.isFinite(min) ? min : 0);
    return centers;
  }

  for (let c = 0; c < components; c++) {
    centers[c] = min + (max - min) * (c / Math.max(components - 1, 1));
  }
  return centers;
}

function runKMeans1D(values, components, maxIterations = 100) {
  const labels = new Uint8Array(values.length);
  const centers = initializeCenters1D(values, components);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0;
    const sums = new Float64Array(components);
    const counts = new Int32Array(components);

    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      let bestCluster = 0;
      let bestDistance = Infinity;

      for (let c = 0; c < components; c++) {
        const distance = Math.abs(value - centers[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = c;
        }
      }

      if (labels[i] !== bestCluster) changed++;
      labels[i] = bestCluster;
      sums[bestCluster] += value;
      counts[bestCluster]++;
    }

    let shift = 0;
    for (let c = 0; c < components; c++) {
      if (counts[c] === 0) continue;
      const nextCenter = sums[c] / counts[c];
      shift += Math.abs(nextCenter - centers[c]);
      centers[c] = nextCenter;
    }

    if (changed === 0 || shift < 0.001) break;
  }

  return { labels, centers };
}

function gaussianPdf1D(value, mean, variance, minVariance) {
  const safeVariance = Math.max(variance, minVariance);
  const diff = value - mean;
  return Math.exp(-0.5 * diff * diff / safeVariance) / Math.sqrt(2 * Math.PI * safeVariance);
}

function initializeGaussianMixture(values, components) {
  const initial = runKMeans1D(values, components, 50);
  const { variance: globalVariance } = getRange1D(values);
  const minVariance = Math.max(globalVariance * 1e-6, 1e-6);
  const means = new Float64Array(components);
  const variances = new Float64Array(components);
  const weights = new Float64Array(components);
  const sums = new Float64Array(components);
  const sumSquares = new Float64Array(components);
  const counts = new Int32Array(components);

  for (let i = 0; i < values.length; i++) {
    const cluster = initial.labels[i];
    const value = values[i];
    sums[cluster] += value;
    sumSquares[cluster] += value * value;
    counts[cluster]++;
  }

  for (let c = 0; c < components; c++) {
    if (counts[c] > 0) {
      means[c] = sums[c] / counts[c];
      variances[c] = Math.max(sumSquares[c] / counts[c] - means[c] * means[c], minVariance);
      weights[c] = counts[c] / values.length;
    } else {
      means[c] = initial.centers[c];
      variances[c] = Math.max(globalVariance, minVariance);
      weights[c] = 1 / components;
    }
  }

  return { means, variances, weights, minVariance };
}

function runGaussianMixture1D(values, components, maxIterations = 100) {
  const labels = new Uint8Array(values.length);
  const { means, variances, weights, minVariance } = initializeGaussianMixture(values, components);
  const probabilities = new Float64Array(components);
  let previousLogLikelihood = -Infinity;

  for (let iter = 0; iter < maxIterations; iter++) {
    const nk = new Float64Array(components);
    const sums = new Float64Array(components);
    const sumSquares = new Float64Array(components);
    let logLikelihood = 0;

    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      let totalProbability = 0;

      for (let c = 0; c < components; c++) {
        const probability = weights[c] * gaussianPdf1D(value, means[c], variances[c], minVariance);
        probabilities[c] = probability;
        totalProbability += probability;
      }

      if (totalProbability <= 0 || !Number.isFinite(totalProbability)) {
        let nearest = 0;
        let bestDistance = Infinity;
        for (let c = 0; c < components; c++) {
          const distance = Math.abs(value - means[c]);
          if (distance < bestDistance) {
            bestDistance = distance;
            nearest = c;
          }
        }
        probabilities.fill(0);
        probabilities[nearest] = 1;
        totalProbability = 1;
      }

      logLikelihood += Math.log(totalProbability);

      for (let c = 0; c < components; c++) {
        const responsibility = probabilities[c] / totalProbability;
        nk[c] += responsibility;
        sums[c] += responsibility * value;
        sumSquares[c] += responsibility * value * value;
      }
    }

    for (let c = 0; c < components; c++) {
      if (nk[c] <= 0) continue;
      means[c] = sums[c] / nk[c];
      variances[c] = Math.max(sumSquares[c] / nk[c] - means[c] * means[c], minVariance);
      weights[c] = nk[c] / values.length;
    }

    if (Math.abs(logLikelihood - previousLogLikelihood) < 1e-4 * Math.max(values.length, 1)) {
      break;
    }
    previousLogLikelihood = logLikelihood;
  }

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    let bestCluster = 0;
    let bestProbability = -Infinity;

    for (let c = 0; c < components; c++) {
      const probability = weights[c] * gaussianPdf1D(value, means[c], variances[c], minVariance);
      if (probability > bestProbability) {
        bestProbability = probability;
        bestCluster = c;
      }
    }
    labels[i] = bestCluster;
  }

  return { labels, centers: means };
}

function calculateThresholdsFromClusters(values, labels, components) {
  const counts = new Int32Array(components);
  const sums = new Float64Array(components);
  const mins = new Float64Array(components);
  const maxs = new Float64Array(components);
  mins.fill(Infinity);
  maxs.fill(-Infinity);

  for (let i = 0; i < values.length; i++) {
    const cluster = labels[i];
    const value = values[i];
    counts[cluster]++;
    sums[cluster] += value;
    if (value < mins[cluster]) mins[cluster] = value;
    if (value > maxs[cluster]) maxs[cluster] = value;
  }

  for (let c = 0; c < components; c++) {
    if (counts[c] === 0) return null;
  }

  const sortedClusters = Array.from({ length: components }, (_, cluster) => ({
    cluster,
    mean: sums[cluster] / counts[cluster]
  })).sort((a, b) => a.mean - b.mean);

  if (components === 2) {
    const muscleCluster = sortedClusters[0].cluster;
    return {
      muscleMax: maxs[muscleCluster],
      fatMin: null
    };
  }

  const muscleCluster = sortedClusters[0].cluster;
  const fatCluster = sortedClusters[2].cluster;
  return {
    muscleMax: maxs[muscleCluster],
    fatMin: mins[fatCluster]
  };
}

function calculateThresholdMetricValues(values, thresholds, components, voxelVolMl) {
  const totalVoxels = values.length;
  const totalVolumeMl = totalVoxels * voxelVolMl;

  if (components === 2) {
    let muscleVoxels = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] <= thresholds.muscleMax) muscleVoxels++;
    }
    const fatVoxels = totalVoxels - muscleVoxels;
    return {
      musclePercentage: 100 * muscleVoxels / totalVoxels,
      fatPercentage: 100 * fatVoxels / totalVoxels,
      totalVolumeMl,
      fatVolumeMl: fatVoxels * voxelVolMl,
      muscleVolumeMl: muscleVoxels * voxelVolMl,
      undefinedPercentage: null,
      undefinedVolumeMl: null
    };
  }

  let musclePercentageVoxels = 0;
  let undefinedPercentageVoxels = 0;
  let fatVoxels = 0;
  let muscleVolumeVoxels = 0;
  let undefinedVolumeVoxels = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];

    if (value < thresholds.muscleMax) {
      musclePercentageVoxels++;
    } else if (value >= thresholds.fatMin) {
      fatVoxels++;
    } else {
      undefinedPercentageVoxels++;
    }

    if (value <= thresholds.muscleMax) {
      muscleVolumeVoxels++;
    } else if (value > thresholds.muscleMax && value < thresholds.fatMin) {
      undefinedVolumeVoxels++;
    }
  }

  return {
    musclePercentage: 100 * musclePercentageVoxels / totalVoxels,
    fatPercentage: 100 * fatVoxels / totalVoxels,
    totalVolumeMl,
    fatVolumeMl: fatVoxels * voxelVolMl,
    muscleVolumeMl: muscleVolumeVoxels * voxelVolMl,
    undefinedPercentage: 100 * undefinedPercentageVoxels / totalVoxels,
    undefinedVolumeMl: undefinedVolumeVoxels * voxelVolMl
  };
}

function collectLabelIntensityValues(sourceData, outputLabels, detectedIndices, labelCounts) {
  const valuesByLabel = {};
  const offsets = {};
  let skippedNonFinite = 0;

  for (const label of detectedIndices) {
    valuesByLabel[label] = new Float32Array(labelCounts[label]);
    offsets[label] = 0;
  }

  for (let i = 0; i < outputLabels.length; i++) {
    const label = outputLabels[i];
    const values = valuesByLabel[label];
    if (!values) continue;

    const value = sourceData[i];
    if (Number.isFinite(value)) {
      values[offsets[label]++] = value;
    } else {
      skippedNonFinite++;
    }
  }

  for (const label of detectedIndices) {
    valuesByLabel[label] = valuesByLabel[label].subarray(0, offsets[label]);
  }

  return { valuesByLabel, skippedNonFinite };
}

function calculateImfMetrics(sourceData, outputLabels, detectedIndices, labelCounts, voxelVolMm3, settings) {
  const voxelVolMl = voxelVolMm3 / 1000;
  const { valuesByLabel, skippedNonFinite } = collectLabelIntensityValues(
    sourceData,
    outputLabels,
    detectedIndices,
    labelCounts
  );

  const result = {
    mode: 'threshold',
    method: settings.method,
    components: settings.components,
    labelMusclePercentages: {},
    labelFatPercentages: {},
    labelUndefinedPercentages: {},
    labelTotalVolumesMl: {},
    labelFatVolumesMl: {},
    labelMuscleVolumesMl: {},
    labelUndefinedVolumesMl: {},
    thresholds: {},
    skippedLabels: [],
    skippedNonFinite,
    totalMeasuredVolumeMl: 0,
    totalFatVolumeMl: 0,
    totalMuscleVolumeMl: 0,
    totalUndefinedVolumeMl: 0,
    totalFatPercentage: NaN,
    totalMusclePercentage: NaN,
    totalUndefinedPercentage: NaN
  };

  for (const label of detectedIndices) {
    const values = valuesByLabel[label];
    if (!values || values.length < settings.components) {
      result.skippedLabels.push(label);
      continue;
    }

    const clustering = settings.method === 'gmm'
      ? runGaussianMixture1D(values, settings.components)
      : runKMeans1D(values, settings.components);
    const thresholds = calculateThresholdsFromClusters(values, clustering.labels, settings.components);
    if (!thresholds) {
      result.skippedLabels.push(label);
      continue;
    }

    const metrics = calculateThresholdMetricValues(values, thresholds, settings.components, voxelVolMl);
    result.thresholds[label] = thresholds;
    result.labelMusclePercentages[label] = roundTo(metrics.musclePercentage, 2);
    result.labelFatPercentages[label] = roundTo(metrics.fatPercentage, 2);
    result.labelTotalVolumesMl[label] = metrics.totalVolumeMl;
    result.labelFatVolumesMl[label] = metrics.fatVolumeMl;
    result.labelMuscleVolumesMl[label] = metrics.muscleVolumeMl;

    if (settings.components === 3) {
      result.labelUndefinedPercentages[label] = roundTo(metrics.undefinedPercentage, 2);
      result.labelUndefinedVolumesMl[label] = metrics.undefinedVolumeMl;
      result.totalUndefinedVolumeMl += metrics.undefinedVolumeMl;
    }

    result.totalMeasuredVolumeMl += metrics.totalVolumeMl;
    result.totalFatVolumeMl += metrics.fatVolumeMl;
    result.totalMuscleVolumeMl += metrics.muscleVolumeMl;
  }

  if (result.totalMeasuredVolumeMl > 0) {
    result.totalFatPercentage = roundTo(100 * result.totalFatVolumeMl / result.totalMeasuredVolumeMl, 2);
    result.totalMusclePercentage = roundTo(100 * result.totalMuscleVolumeMl / result.totalMeasuredVolumeMl, 2);
    if (settings.components === 3) {
      result.totalUndefinedPercentage = roundTo(100 * result.totalUndefinedVolumeMl / result.totalMeasuredVolumeMl, 2);
    }
  }

  return result;
}

function calculateDixonImfMetrics(fatData, waterData, outputLabels, detectedIndices, labelCounts, voxelVolMm3) {
  const voxelVolMl = voxelVolMm3 / 1000;
  const sums = {};
  const counts = {};

  for (const label of detectedIndices) {
    sums[label] = 0;
    counts[label] = 0;
  }

  let skippedNonFinite = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    const label = outputLabels[i];
    if (!sums.hasOwnProperty(label)) continue;

    const fat = fatData[i];
    const water = waterData[i];
    if (!Number.isFinite(fat) || !Number.isFinite(water)) {
      skippedNonFinite++;
      continue;
    }

    const denom = fat + water;
    const fraction = denom !== 0 ? fat / denom : 0;
    sums[label] += fraction;
    counts[label]++;
  }

  const result = {
    mode: 'dixon',
    method: 'dixon',
    components: null,
    labelMusclePercentages: {},
    labelFatPercentages: {},
    labelUndefinedPercentages: {},
    labelTotalVolumesMl: {},
    labelFatVolumesMl: {},
    labelMuscleVolumesMl: {},
    labelUndefinedVolumesMl: {},
    thresholds: {},
    skippedLabels: [],
    skippedNonFinite,
    totalMeasuredVolumeMl: 0,
    totalFatVolumeMl: 0,
    totalMuscleVolumeMl: 0,
    totalUndefinedVolumeMl: 0,
    totalFatPercentage: NaN,
    totalMusclePercentage: NaN,
    totalUndefinedPercentage: NaN
  };

  for (const label of detectedIndices) {
    const count = counts[label] || 0;
    if (count === 0) {
      result.skippedLabels.push(label);
      continue;
    }

    const meanFatFraction = sums[label] / count;
    const totalVolumeMl = (labelCounts[label] || count) * voxelVolMl;
    const fatVolumeMl = totalVolumeMl * meanFatFraction;
    const muscleVolumeMl = Math.max(0, totalVolumeMl - fatVolumeMl);

    result.labelFatPercentages[label] = roundTo(meanFatFraction * 100, 2);
    result.labelMusclePercentages[label] = roundTo((1 - meanFatFraction) * 100, 2);
    result.labelTotalVolumesMl[label] = totalVolumeMl;
    result.labelFatVolumesMl[label] = fatVolumeMl;
    result.labelMuscleVolumesMl[label] = muscleVolumeMl;

    result.totalMeasuredVolumeMl += totalVolumeMl;
    result.totalFatVolumeMl += fatVolumeMl;
    result.totalMuscleVolumeMl += muscleVolumeMl;
  }

  if (result.totalMeasuredVolumeMl > 0) {
    result.totalFatPercentage = roundTo(100 * result.totalFatVolumeMl / result.totalMeasuredVolumeMl, 2);
    result.totalMusclePercentage = roundTo(100 * result.totalMuscleVolumeMl / result.totalMeasuredVolumeMl, 2);
  }

  return result;
}

function toLabelArray(imageData) {
  const labels = new Uint8Array(imageData.length);
  for (let i = 0; i < imageData.length; i++) {
    const label = Math.round(imageData[i]);
    labels[i] = label > 0 && label < 256 ? label : 0;
  }
  return labels;
}

function dimsMatch(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function consolidateLabelVolumes(labelVolumes) {
  if (labelVolumes.length === 1) return labelVolumes[0];

  const voxelCount = labelVolumes[0].length;
  const output = new Uint8Array(voxelCount);

  for (let i = 0; i < voxelCount; i++) {
    let bestLabel = 0;
    let bestCount = 0;

    for (let j = 0; j < labelVolumes.length; j++) {
      const candidate = labelVolumes[j][i];
      if (candidate === 0) continue;

      let count = 0;
      for (let k = 0; k < labelVolumes.length; k++) {
        if (labelVolumes[k][i] === candidate) count++;
      }

      if (count > bestCount) {
        bestLabel = candidate;
        bestCount = count;
      }
    }

    output[i] = bestLabel;
  }

  return output;
}

function getSliceCountingInfo(dims, voxelSize) {
  const [onx, ony] = dims;
  const maxSpacing = Math.max(...voxelSize);
  const minSpacing = Math.min(...voxelSize);
  const sliceAxis = (maxSpacing / minSpacing < 1.01)
    ? 2
    : voxelSize.indexOf(maxSpacing);
  const nSlices = dims[sliceAxis];
  const getSliceIndex = sliceAxis === 0
    ? (i) => i % onx
    : sliceAxis === 1
      ? (i) => Math.floor(i / onx) % ony
      : (i) => Math.floor(i / (onx * ony));

  return { sliceAxis, nSlices, getSliceIndex };
}

function countLabelSlices(outputLabels, detectedIndices, dims, voxelSize) {
  const { sliceAxis, nSlices, getSliceIndex } = getSliceCountingInfo(dims, voxelSize);
  const sliceLabelSets = new Array(nSlices);
  for (let s = 0; s < nSlices; s++) sliceLabelSets[s] = new Set();
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) sliceLabelSets[getSliceIndex(i)].add(outputLabels[i]);
  }

  const labelSliceCounts = {};
  for (const idx of detectedIndices) {
    let count = 0;
    for (let s = 0; s < nSlices; s++) {
      if (sliceLabelSets[s].has(idx)) count++;
    }
    labelSliceCounts[idx] = count;
  }

  return { labelSliceCounts, sliceAxis, nSlices };
}

function computeVolumetricMetrics(outputLabels, origDims, origVoxelSize, numClasses) {
  const classCount = numClasses || 256;
  const labelCounts = new Int32Array(classCount);
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0 && outputLabels[i] < classCount) {
      labelCounts[outputLabels[i]]++;
    }
  }

  const detectedIndices = [];
  for (let i = 1; i < classCount; i++) {
    if (labelCounts[i] > 0) detectedIndices.push(i);
  }

  const voxelVolMm3 = origVoxelSize[0] * origVoxelSize[1] * origVoxelSize[2];
  const labelVolumes = {};
  let totalVolumeMl = 0;

  for (const idx of detectedIndices) {
    const volMl = labelCounts[idx] * voxelVolMm3 / 1000;
    labelVolumes[idx] = volMl;
    totalVolumeMl += volMl;
  }

  const { labelSliceCounts, sliceAxis, nSlices } = countLabelSlices(
    outputLabels,
    detectedIndices,
    origDims,
    origVoxelSize
  );

  return {
    labelCounts,
    detectedIndices,
    voxelVolMm3,
    labelVolumes,
    labelSliceCounts,
    sliceAxis,
    nSlices,
    totalVolumeMl
  };
}

function parseSegmentationLabelVolumes(segmentationDataList, emptyMessage) {
  if (!segmentationDataList.length) {
    throw new Error(emptyMessage);
  }

  const parsedSegmentations = segmentationDataList.map(data => parseNiftiInput(data));
  const firstSegmentation = parsedSegmentations[0];
  const labelVolumes = [];

  for (const parsed of parsedSegmentations) {
    if (!dimsMatch(parsed.dims, firstSegmentation.dims)) {
      throw new Error('All segmentation label maps must have identical dimensions');
    }
    labelVolumes.push(toLabelArray(parsed.imageData));
  }

  return { firstSegmentation, labelVolumes };
}

function detectLabelIndices(outputLabels, numClasses) {
  const labelCounts = new Int32Array(numClasses);
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0 && outputLabels[i] < numClasses) {
      labelCounts[outputLabels[i]]++;
    }
  }

  const detectedIndices = [];
  for (let i = 1; i < numClasses; i++) {
    if (labelCounts[i] > 0) detectedIndices.push(i);
  }
  return detectedIndices;
}

async function runMetricExtraction(config) {
  const {
    segmentationDataList = [],
    metricSourceData = null,
    dixonFatData = null,
    dixonWaterData = null,
    settings = {}
  } = config;

  postProgress(0.05, 'Reading segmentation...');
  const { firstSegmentation, labelVolumes } = parseSegmentationLabelVolumes(
    segmentationDataList,
    'No segmentation data provided for metrics'
  );

  const outputLabels = settings.consolidateSegmentations
    ? consolidateLabelVolumes(labelVolumes)
    : labelVolumes[0];

  const metricsBase = computeVolumetricMetrics(
    outputLabels,
    firstSegmentation.dims,
    firstSegmentation.voxelSize,
    settings.numClasses || 256
  );

  postLog(`Detected ${metricsBase.detectedIndices.length} muscles`);
  postDetectedLabels(metricsBase.detectedIndices);

  let imfThreshold = null;
  let imfDixon = null;
  const imfSettings = normalizeImfSettings(settings.imfMetrics || {});
  if (imfSettings.enabled) {
    postProgress(0.35, 'Calculating IMF...');
    if (imfUsesThreshold(imfSettings)) {
      if (!metricSourceData) {
        throw new Error('Threshold IMF metrics require one source image');
      }
      const source = parseNiftiInput(metricSourceData);
      if (!dimsMatch(source.dims, firstSegmentation.dims)) {
        throw new Error('Metric source image and segmentation must have identical dimensions');
      }
      imfThreshold = calculateImfMetrics(
        source.imageData,
        outputLabels,
        metricsBase.detectedIndices,
        metricsBase.labelCounts,
        metricsBase.voxelVolMm3,
        imfSettings
      );
      postLog(`Threshold IMF metrics complete for ${metricsBase.detectedIndices.length - imfThreshold.skippedLabels.length}/${metricsBase.detectedIndices.length} labels`);
    }
    if (imfUsesDixon(imfSettings)) {
      if (!dixonFatData || !dixonWaterData) {
        throw new Error('Dixon IMF metrics require fat and water images');
      }
      const fat = parseNiftiInput(dixonFatData);
      const water = parseNiftiInput(dixonWaterData);
      if (!dimsMatch(fat.dims, firstSegmentation.dims) || !dimsMatch(water.dims, firstSegmentation.dims)) {
        throw new Error('Dixon fat, water, and segmentation images must have identical dimensions');
      }
      imfDixon = calculateDixonImfMetrics(
        fat.imageData,
        water.imageData,
        outputLabels,
        metricsBase.detectedIndices,
        metricsBase.labelCounts,
        metricsBase.voxelVolMm3
      );
      postLog(`Dixon fat metrics complete for ${metricsBase.detectedIndices.length - imfDixon.skippedLabels.length}/${metricsBase.detectedIndices.length} labels`);
    }
  }

  const metrics = {
    labelVolumes: metricsBase.labelVolumes,
    labelSliceCounts: metricsBase.labelSliceCounts,
    totalVolumeMl: metricsBase.totalVolumeMl,
    voxelSizeMm: firstSegmentation.voxelSize,
    totalSlices: metricsBase.nSlices,
    sliceAxis: metricsBase.sliceAxis
  };
  if (imfThreshold) {
    metrics.imf = imfThreshold;
    metrics.imfThreshold = imfThreshold;
  }
  if (imfDixon) {
    if (!metrics.imf) metrics.imf = imfDixon;
    metrics.imfDixon = imfDixon;
  }

  const outputNifti = createOutputNifti(outputLabels, firstSegmentation.headerBytes, firstSegmentation.dims);
  postStageData(
    'segmentation',
    outputNifti,
    settings.consolidateSegmentations ? 'Consolidated muscle segmentation' : 'Muscle segmentation'
  );
  postMetrics(metrics);
  postProgress(1.0, 'Complete');
  postComplete();
}

async function runConsolidationOnly(config) {
  const {
    segmentationDataList = [],
    settings = {}
  } = config;

  if (segmentationDataList.length < 2) {
    throw new Error('At least two segmentation label maps are required for consolidation');
  }

  postProgress(0.05, 'Reading segmentations...');
  const { firstSegmentation, labelVolumes } = parseSegmentationLabelVolumes(
    segmentationDataList,
    'No segmentation data provided for consolidation'
  );

  postProgress(0.45, 'Consolidating segmentations...');
  const outputLabels = consolidateLabelVolumes(labelVolumes);
  const detectedIndices = detectLabelIndices(outputLabels, settings.numClasses || 256);
  postLog(`Detected ${detectedIndices.length} muscles in consolidated segmentation`);
  postDetectedLabels(detectedIndices);

  const outputNifti = createOutputNifti(outputLabels, firstSegmentation.headerBytes, firstSegmentation.dims);
  postStageData('segmentation', outputNifti, 'Consolidated muscle segmentation');
  postProgress(1.0, 'Complete');
  postComplete();
}

// ==================== Main Inference Pipeline ====================

async function runInference(config) {
  const { inputData, settings } = config;
  const {
    modelName = 'musclemap-wholebody.onnx',
    numClasses: numClassesSetting,
    roiSize: roiSizeSetting,
    overlap = 0.5,
    chunkSize: chunkSizeSetting = 'auto',
    modelBaseUrl,
    useWebGPU: useWebGPUSetting,
    sliceThickness = -1,
    lowRes = false,
    calculateMetrics = false,
    imfMetrics = {}
  } = settings;

  // Override WebGPU setting per-run (user may have toggled the checkbox)
  const useWebGPU = self._useWebGPU && (useWebGPUSetting !== false);
  if (!useWebGPU && self._useWebGPU) {
    // User forced WASM — use max threads
    const maxThreads = getOptimalWasmThreads();
    ort.env.wasm.numThreads = maxThreads;
    postLog(`Forcing WASM backend with ${maxThreads} threads`);
  }

  const NUM_CLASSES = numClassesSetting || 100;
  const [ROI_H, ROI_W] = roiSizeSetting || [256, 256];
  const TARGET_SPACING = [1.0, 1.0, (sliceThickness > 0) ? sliceThickness : -1];
  const CROP_MARGIN = 20;
  const normalizedImfSettings = normalizeImfSettings(imfMetrics);

  // 1. Parse NIfTI
  postLog('Parsing input volume...');
  postProgress(0.02, 'Reading NIfTI...');
  const { imageData, dims, voxelSize, headerBytes, affine } = parseNiftiInput(inputData);
  const [nx, ny, nz] = dims;
  postLog(`Volume: ${nx}x${ny}x${nz}, spacing: ${voxelSize.map(v => v.toFixed(2)).join('x')}mm`);

  const origDims = [...dims];
  const origVoxelSize = [...voxelSize];

  // 2. Orient to RAS
  postProgress(0.05, 'Orienting to RAS...');
  postLog('Orienting to RAS...');
  const { perm, flip } = getOrientationTransform(affine);
  const isIdentity = perm[0] === 0 && perm[1] === 1 && perm[2] === 2 && !flip[0] && !flip[1] && !flip[2];

  let currentData, currentDims, currentSpacing;
  if (isIdentity) {
    currentData = imageData;
    currentDims = [...dims];
    currentSpacing = [...voxelSize];
  } else {
    const oriented = orientToRAS(imageData, dims, perm, flip);
    currentData = oriented.data;
    currentDims = oriented.dims;
    // Reorder spacing according to permutation
    currentSpacing = [voxelSize[perm[0]], voxelSize[perm[1]], voxelSize[perm[2]]];
  }
  postLog(`RAS dims: ${currentDims.join('x')}`);

  const rasDims = [...currentDims];
  const rasSpacing = [...currentSpacing];

  // 3. Resample to target spacing
  postProgress(0.08, 'Resampling...');
  const needsResample = Math.abs(currentSpacing[0] - TARGET_SPACING[0]) > 0.01 ||
                         Math.abs(currentSpacing[1] - TARGET_SPACING[1]) > 0.01 ||
                         (TARGET_SPACING[2] > 0 && Math.abs(currentSpacing[2] - TARGET_SPACING[2]) > 0.01);

  let resampledDims;
  if (needsResample) {
    postLog('Resampling to target spacing...');
    const resampled = resampleVolume(currentData, currentDims, currentSpacing, TARGET_SPACING);
    currentData = resampled.data;
    currentDims = resampled.dims;
    currentSpacing = resampled.spacing;
    postLog(`Resampled: ${currentDims.join('x')}`);
  }
  resampledDims = [...currentDims];

  // 4. Normalize
  postProgress(0.10, 'Normalizing...');
  postLog('Z-score normalizing (nonzero voxels)...');
  currentData = zScoreNormalizeNonzero(currentData);

  // 5. Crop foreground
  postProgress(0.12, 'Cropping foreground...');
  const cropped = cropForeground(currentData, currentDims, CROP_MARGIN);
  if (cropped.dims[0] === 0) {
    throw new Error('No foreground voxels found in volume');
  }
  currentData = cropped.data;
  currentDims = cropped.dims;
  const cropOrigin = cropped.origin;
  postLog(`Cropped: ${currentDims.join('x')} (origin: ${cropOrigin.join(',')})`);

  // 6. Download and load model
  const modelUrl = `${modelBaseUrl}/${modelName}`;
  const modelData = await fetchModel(modelUrl, modelName, 0.15, 0.15);

  postProgress(0.30, 'Loading ONNX model...');
  const executionProviders = useWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
  postLog(`Creating ONNX InferenceSession (${executionProviders.join(', ')})...`);
  const session = await ort.InferenceSession.create(modelData, {
    executionProviders,
    graphOptimizationLevel: 'all'
  });
  postLog(`Session created. Input: ${session.inputNames}, Output: ${session.outputNames}`);

  // 7. Precompute Gaussian weight map
  const gaussianWeights = computeGaussianWeightMap(ROI_H, ROI_W);

  // 8. Slice-by-slice inference
  const [cnx, cny, cnz] = currentDims;
  const labelVolume = new Uint8Array(cnx * cny * cnz);
  const sliceSize = cnx * cny;

  const resolvedChunkSize = resolveChunkSize(chunkSizeSetting, NUM_CLASSES, ROI_H, ROI_W);
  postLog(`Starting 2D inference: ${cnz} slices, overlap=${overlap}, chunkSize=${resolvedChunkSize}${chunkSizeSetting === 'auto' ? ' (auto)' : ''}, backend=${useWebGPU ? 'webgpu' : 'wasm'}`);
  postLog(`Postprocessing mode: ${lowRes ? 'low-res (cleanup before inverse transforms)' : 'full-res (cleanup after inverse transforms)'}`);
  const inferenceStartTime = performance.now();

  for (let z = 0; z < cnz; z++) {
    // Extract axial slice
    const slice = currentData.subarray(z * sliceSize, (z + 1) * sliceSize);

    // Check if slice has any data
    let hasData = false;
    for (let i = 0; i < sliceSize; i++) {
      if (slice[i] !== 0) { hasData = true; break; }
    }

    if (!hasData) {
      // Skip empty slices
      if (z % 20 === 0) {
        postProgress(0.32 + 0.50 * (z / cnz), `Slice ${z+1}/${cnz} (empty)`);
      }
      continue;
    }

    // Transpose slice from NIfTI Fortran order to model order (rows=X, cols=Y)
    // NIfTI: slice[x + y*cnx], Model expects: transposed[x*cny + y]
    const transposed = new Float32Array(sliceSize);
    for (let x = 0; x < cnx; x++) {
      for (let y = 0; y < cny; y++) {
        transposed[x * cny + y] = slice[x + y * cnx];
      }
    }

    // Pad transposed slice if smaller than ROI (height=cnx, width=cny after transpose)
    let inferH = cnx, inferW = cny;
    let paddedSlice = transposed;
    let padOffsetX = 0, padOffsetY = 0;

    if (cnx < ROI_H || cny < ROI_W) {
      inferH = Math.max(cnx, ROI_H);
      inferW = Math.max(cny, ROI_W);
      paddedSlice = new Float32Array(inferH * inferW);
      padOffsetY = Math.floor((inferH - cnx) / 2);
      padOffsetX = Math.floor((inferW - cny) / 2);
      for (let r = 0; r < cnx; r++) {
        paddedSlice.set(
          transposed.subarray(r * cny, r * cny + cny),
          (r + padOffsetY) * inferW + padOffsetX
        );
      }
    }

    // Compute tiles
    const tiles = computeTilePositions(inferH, inferW, ROI_H, ROI_W, overlap);

    // Accumulation buffers for this slice
    const accumSize = NUM_CLASSES * inferH * inferW;
    let accum, weightSum;

    if (accumSize <= 100_000_000) {
      // Full accumulation — pixel-major layout: accum[pixel * NUM_CLASSES + class]
      accum = new Float32Array(accumSize);
      weightSum = new Float32Array(inferH * inferW);

      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      const pixelCount = inferH * inferW;
      const patchSize = ROI_H * ROI_W;

      // Process tiles in chunks
      for (let ti = 0; ti < tiles.length; ti += resolvedChunkSize) {
        const chunkTiles = tiles.slice(ti, ti + resolvedChunkSize);
        const N = chunkTiles.length;

        // Build batched input [N, 1, ROI_H, ROI_W]
        const batchInput = new Float32Array(N * patchSize);
        for (let b = 0; b < N; b++) {
          const tile = chunkTiles[b];
          for (let py = 0; py < ROI_H; py++) {
            const srcOff = (tile.y + py) * inferW + tile.x;
            const dstOff = b * patchSize + py * ROI_W;
            batchInput.set(paddedSlice.subarray(srcOff, srcOff + ROI_W), dstOff);
          }
        }

        // Run batched inference
        const inputTensor = new ort.Tensor('float32', batchInput, [N, 1, ROI_H, ROI_W]);
        const results = await session.run({ [inputName]: inputTensor });
        const output = results[outputName].data;  // class-major: [N, C, H, W]
        inputTensor.dispose();

        // Accumulate Gaussian-weighted predictions (pixel-major) + weight sum in one pass
        const outputPerTile = NUM_CLASSES * patchSize;
        for (let b = 0; b < N; b++) {
          const tile = chunkTiles[b];
          const batchOffset = b * outputPerTile;

          for (let py = 0; py < ROI_H; py++) {
            const gwRowOff = py * ROI_W;
            const gyIdx = (tile.y + py) * inferW + tile.x;
            for (let px = 0; px < ROI_W; px++) {
              const gw = gaussianWeights[gwRowOff + px];
              const gIdx = gyIdx + px;
              weightSum[gIdx] += gw;
              const accumBase = gIdx * NUM_CLASSES;
              const outPixel = gwRowOff + px;  // py * ROI_W + px
              for (let c = 0; c < NUM_CLASSES; c++) {
                accum[accumBase + c] += output[batchOffset + c * patchSize + outPixel] * gw;
              }
            }
          }
        }
      }

      // Argmax for this slice — stride-1 access in pixel-major layout
      for (let i = 0; i < pixelCount; i++) {
        if (weightSum[i] === 0) continue;
        const base = i * NUM_CLASSES;
        let bestClass = 0, bestVal = accum[base];
        for (let c = 1; c < NUM_CLASSES; c++) {
          const val = accum[base + c];
          if (val > bestVal) { bestVal = val; bestClass = c; }
        }

        // Map back from padded coords to original volume (Fortran order)
        // After transpose: rows=X, cols=Y
        const pr = Math.floor(i / inferW);
        const pc = i % inferW;
        const ox = pr - padOffsetY;  // row → X spatial
        const oy = pc - padOffsetX;  // col → Y spatial
        if (ox >= 0 && ox < cnx && oy >= 0 && oy < cny) {
          labelVolume[z * sliceSize + oy * cnx + ox] = bestClass;
        }
      }
    } else {
      // Very large slice: single centered patch fallback
      const patch = new Float32Array(ROI_H * ROI_W);
      const cy = Math.max(0, Math.floor((inferH - ROI_H) / 2));
      const cx = Math.max(0, Math.floor((inferW - ROI_W) / 2));
      for (let py = 0; py < ROI_H; py++) {
        const srcOff = (cy + py) * inferW + cx;
        patch.set(paddedSlice.subarray(srcOff, srcOff + ROI_W), py * ROI_W);
      }
      const inputTensor = new ort.Tensor('float32', patch, [1, 1, ROI_H, ROI_W]);
      const results = await session.run({ [session.inputNames[0]]: inputTensor });
      const output = results[session.outputNames[0]].data;
      inputTensor.dispose();

      for (let py = 0; py < ROI_H; py++) {
        for (let px = 0; px < ROI_W; px++) {
          let bestClass = 0, bestVal = -Infinity;
          for (let c = 0; c < NUM_CLASSES; c++) {
            const val = output[c * ROI_H * ROI_W + py * ROI_W + px];
            if (val > bestVal) { bestVal = val; bestClass = c; }
          }
          // After transpose: rows=X, cols=Y
          const ox = (cy + py) - padOffsetY;  // row → X spatial
          const oy = (cx + px) - padOffsetX;  // col → Y spatial
          if (ox >= 0 && ox < cnx && oy >= 0 && oy < cny) {
            labelVolume[z * sliceSize + oy * cnx + ox] = bestClass;
          }
        }
      }
    }

    // Progress reporting
    if (z % 5 === 0 || z === cnz - 1) {
      const elapsed = (performance.now() - inferenceStartTime) / 1000;
      const eta = (elapsed / (z + 1)) * (cnz - z - 1);
      postProgress(0.32 + 0.50 * ((z + 1) / cnz), `Slice ${z+1}/${cnz} (ETA: ${eta.toFixed(0)}s)`);
    }
  }

  const totalTime = ((performance.now() - inferenceStartTime) / 1000).toFixed(1);
  postLog(`Inference complete: ${cnz} slices in ${totalTime}s`);

  // Release session
  await session.release();

  let outputLabels;
  if (lowRes) {
    postProgress(0.83, 'Cleaning labels (low-res)...');
    postLog('Running connected component cleanup in the low-resolution working volume...');
    const cleanedLabels = perLabelLargestComponent(labelVolume, currentDims, NUM_CLASSES - 1, 0.83, 0.12);

    postProgress(0.95, 'Inverse transform...');
    postLog('Applying inverse transforms...');
    outputLabels = applyInverseTransforms(cleanedLabels, currentDims, resampledDims, cropOrigin, needsResample, rasDims, isIdentity, perm, flip, origDims);
  } else {
    postProgress(0.83, 'Inverse transform...');
    postLog('Applying inverse transforms before connected component cleanup...');
    const transformedLabels = applyInverseTransforms(labelVolume, currentDims, resampledDims, cropOrigin, needsResample, rasDims, isIdentity, perm, flip, origDims);

    postProgress(0.90, 'Cleaning labels...');
    postLog('Running connected component cleanup at full output resolution...');
    outputLabels = perLabelLargestComponent(transformedLabels, origDims, NUM_CLASSES - 1, 0.90, 0.08);
  }

  // Count detected labels
  const labelCounts = new Int32Array(NUM_CLASSES);
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0 && outputLabels[i] < NUM_CLASSES) {
      labelCounts[outputLabels[i]]++;
    }
  }
  const detectedIndices = [];
  for (let i = 1; i < NUM_CLASSES; i++) {
    if (labelCounts[i] > 0) detectedIndices.push(i);
  }
  postLog(`Detected ${detectedIndices.length} muscles`);
  postDetectedLabels(detectedIndices);

  if (calculateMetrics || normalizedImfSettings.enabled) {
    const voxelVolMm3 = origVoxelSize[0] * origVoxelSize[1] * origVoxelSize[2];
    const labelVolumes = {};
    let totalVolumeMl = 0;

    for (let i = 0; i < detectedIndices.length; i++) {
      const idx = detectedIndices[i];
      const volMl = labelCounts[idx] * voxelVolMm3 / 1000;
      labelVolumes[idx] = volMl;
      totalVolumeMl += volMl;
    }

    const { labelSliceCounts, sliceAxis, nSlices } = countLabelSlices(
      outputLabels,
      detectedIndices,
      origDims,
      origVoxelSize
    );

    let imf = null;
    if (normalizedImfSettings.enabled) {
      postProgress(0.985, 'Calculating IMF...');
      postLog(`Calculating IMF metrics (${normalizedImfSettings.method}, ${normalizedImfSettings.components} components)...`);
      try {
        imf = calculateImfMetrics(
          imageData,
          outputLabels,
          detectedIndices,
          labelCounts,
          voxelVolMm3,
          normalizedImfSettings
        );
        const processedCount = detectedIndices.length - imf.skippedLabels.length;
        postLog(`IMF metrics complete for ${processedCount}/${detectedIndices.length} labels`);
        if (imf.skippedLabels.length > 0) {
          postLog(`IMF skipped labels with too few or degenerate voxels: ${imf.skippedLabels.join(', ')}`);
        }
        if (imf.skippedNonFinite > 0) {
          postLog(`IMF ignored ${imf.skippedNonFinite} non-finite source voxels`);
        }
      } catch (error) {
        postLog(`Warning: IMF metrics failed: ${error.message}`);
        imf = null;
      }
    }

    const metrics = {
      labelVolumes,
      labelSliceCounts,
      totalVolumeMl,
      voxelSizeMm: origVoxelSize,
      totalSlices: nSlices,
      sliceAxis
    };
    if (imf) metrics.imf = imf;
    postMetrics(metrics);
  }

  // 11. Create output NIfTI (full resolution for download)
  const outputNifti = createOutputNifti(outputLabels, headerBytes, origDims);
  postStageData('segmentation', outputNifti, 'Muscle segmentation');

  // 12. Create downsampled display NIfTI for faster 3D rendering (when z was resampled)
  const zWasResampled = TARGET_SPACING[2] > 0 && Math.abs(rasSpacing[2] - TARGET_SPACING[2]) > 0.01;
  const DISPLAY_MAX_DIM = 128;
  const maxDim = Math.max(...origDims);
  if (zWasResampled && maxDim > DISPLAY_MAX_DIM) {
    const scale = DISPLAY_MAX_DIM / maxDim;
    const displayDims = origDims.map(d => Math.max(1, Math.round(d * scale)));
    const displayLabels = resampleLabelsNearest(outputLabels, origDims, displayDims);
    const displayNifti = createOutputNifti(displayLabels, headerBytes, displayDims);
    // Adjust pixdims and affine for the downsampled resolution
    const dv = new DataView(displayNifti);
    const srcView = new DataView(headerBytes);
    for (let i = 1; i <= 3; i++) {
      const origPixdim = Math.abs(srcView.getFloat32(76 + i * 4, true));
      dv.setFloat32(76 + i * 4, origPixdim * origDims[i-1] / displayDims[i-1], true);
    }
    // Scale sform affine row vectors to match new voxel size
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const offset = 280 + row * 16 + col * 4;
        const val = srcView.getFloat32(offset, true);
        dv.setFloat32(offset, val * origDims[col] / displayDims[col], true);
      }
    }
    postStageData('segmentation_display', displayNifti, 'Muscle segmentation (display)');
  }

  let totalVoxels = 0;
  for (let i = 0; i < outputLabels.length; i++) {
    if (outputLabels[i] > 0) totalVoxels++;
  }
  postLog(`Output: ${totalVoxels} labeled voxels, ${detectedIndices.length} muscles`);

  postProgress(1.0, 'Complete');
  postComplete();
}

// ==================== Message Handler ====================

self.onmessage = async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      try {
        self._appVersion = e.data.version || '';
        ort.env.wasm.numThreads = getOptimalWasmThreads();
        ort.env.wasm.wasmPaths = '../wasm/';

        // Detect WebGPU support
        self._useWebGPU = false;
        if (typeof navigator !== 'undefined' && navigator.gpu) {
          try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
              self._useWebGPU = true;
              postLog('WebGPU available - will use GPU acceleration');
            }
          } catch (e) {
            postLog('WebGPU detection failed, using WASM backend');
          }
        }
        if (!self._useWebGPU) {
          postLog(`Using WASM backend (WebGPU not available, ${ort.env.wasm.numThreads} threads)`);
        }

        localforage.config({
          name: 'MuscleMapModelCache',
          storeName: 'models'
        });

        self.postMessage({ type: 'initialized', webgpuAvailable: self._useWebGPU });
      } catch (error) {
        postError(`Initialization failed: ${error.message}`);
      }
      break;

    case 'run':
      try {
        await runInference(data);
      } catch (error) {
        console.error('Inference error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'metricsOnly':
      try {
        await runMetricExtraction(data);
      } catch (error) {
        console.error('Metrics error:', error);
        postError(error?.message || String(error));
      }
      break;

    case 'consolidateOnly':
      try {
        await runConsolidationOnly(data);
      } catch (error) {
        console.error('Consolidation error:', error);
        postError(error?.message || String(error));
      }
      break;
  }
};
