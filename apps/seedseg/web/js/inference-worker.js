/**
 * SeedSeg Inference Worker
 *
 * Runs ONNX model inference and consensus segmentation in a Web Worker.
 * Pipeline: NIfTI parse → preprocess → run N models → consensus → output
 */

/* global importScripts, ort, localforage, nifti */

// Load dependencies (paths relative to worker location: js/)
importScripts('../wasm/ort.min.js');
importScripts('https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js');
importScripts('../nifti-js/index.js');

// QSM WASM module (for bias field correction)
let qsmWasm = null;

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

// ==================== NIfTI Utilities ====================

function decompressIfNeeded(data) {
  const bytes = new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // gzipped - use pako if available, otherwise use nifti library
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

  // Parse dimensions
  const dims = [];
  for (let i = 0; i < 8; i++) {
    dims.push(view.getInt16(40 + i * 2, true));
  }
  const nx = dims[1], ny = dims[2], nz = dims[3];

  // Parse voxel sizes
  const pixDims = [];
  for (let i = 0; i < 8; i++) {
    pixDims.push(view.getFloat32(76 + i * 4, true));
  }

  // Parse data format
  const datatype = view.getInt16(70, true);
  const voxOffset = view.getFloat32(108, true);
  const sclSlope = view.getFloat32(112, true) || 1;
  const sclInter = view.getFloat32(116, true) || 0;
  const dataStart = Math.ceil(voxOffset);
  const nTotal = nx * ny * nz;

  // Read image data as Float32
  const imageData = new Float32Array(nTotal);
  switch (datatype) {
    case 2: // UINT8
      for (let i = 0; i < nTotal; i++)
        imageData[i] = data[dataStart + i] * sclSlope + sclInter;
      break;
    case 4: // INT16
      for (let i = 0; i < nTotal; i++)
        imageData[i] = view.getInt16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    case 8: // INT32
      for (let i = 0; i < nTotal; i++)
        imageData[i] = view.getInt32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 16: // FLOAT32
      for (let i = 0; i < nTotal; i++)
        imageData[i] = view.getFloat32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 64: // FLOAT64
      for (let i = 0; i < nTotal; i++)
        imageData[i] = view.getFloat64(dataStart + i * 8, true) * sclSlope + sclInter;
      break;
    case 512: // UINT16
      for (let i = 0; i < nTotal; i++)
        imageData[i] = view.getUint16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }

  // Extract header for reuse in outputs
  const headerSize = dataStart;
  const headerBytes = new ArrayBuffer(headerSize);
  new Uint8Array(headerBytes).set(data.slice(0, headerSize));

  return {
    imageData,
    dims: [nx, ny, nz],
    voxelSize: [pixDims[1] || 1, pixDims[2] || 1, pixDims[3] || 1],
    headerBytes
  };
}

function createOutputNifti(float32Data, sourceHeader) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const dataSize = float32Data.length * 4;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  // Copy header
  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Set datatype to FLOAT32
  destView.setInt16(70, 16, true);
  destView.setInt16(72, 32, true);

  // Make it 3D
  destView.setInt16(40, 3, true);
  destView.setInt16(48, 1, true);

  // Reset scaling
  destView.setFloat32(112, 1, true);
  destView.setFloat32(116, 0, true);

  // Copy data
  new Float32Array(buffer, headerSize).set(float32Data);

  return buffer;
}

// ==================== Preprocessing ====================

function findPaddedDims(dims, factor) {
  return dims.map(d => Math.ceil(d / factor) * factor);
}

function padVolume(data, srcDims, tgtDims) {
  const [sx, sy, sz] = srcDims;
  const [tx, ty, tz] = tgtDims;
  const result = new Float32Array(tx * ty * tz);

  const ox = Math.floor((tx - sx) / 2);
  const oy = Math.floor((ty - sy) / 2);
  const oz = Math.floor((tz - sz) / 2);

  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      const srcOffset = z * sy * sx + y * sx;
      const tgtOffset = (z + oz) * ty * tx + (y + oy) * tx + ox;
      result.set(data.subarray(srcOffset, srcOffset + sx), tgtOffset);
    }
  }
  return result;
}

function cropVolume(data, paddedDims, origDims) {
  const [px, py, pz] = paddedDims;
  const [ox, oy, oz] = origDims;
  const result = new Float32Array(ox * oy * oz);

  const offX = Math.floor((px - ox) / 2);
  const offY = Math.floor((py - oy) / 2);
  const offZ = Math.floor((pz - oz) / 2);

  for (let z = 0; z < oz; z++) {
    for (let y = 0; y < oy; y++) {
      const srcOffset = (z + offZ) * py * px + (y + offY) * px + offX;
      const tgtOffset = z * oy * ox + y * ox;
      result.set(data.subarray(srcOffset, srcOffset + ox), tgtOffset);
    }
  }
  return result;
}

function zScoreNormalize(data) {
  const n = data.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - mean;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / n) || 1;

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = (data[i] - mean) / std;
  }
  return result;
}

// ==================== Axis Transposition ====================
// NIfTI stores data in Fortran order (x varies fastest): index = x + y*nx + z*nx*ny
// ONNX Runtime expects C-contiguous (last dim varies fastest): index = x*ny*nz + y*nz + z
// These functions convert between the two layouts for shape [nx, ny, nz].

function niftiToC(data, nx, ny, nz) {
  const result = new Float32Array(nx * ny * nz);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        result[x * ny * nz + y * nz + z] = data[x + y * nx + z * nx * ny];
      }
    }
  }
  return result;
}

function cToNifti(data, nx, ny, nz) {
  const result = new Float32Array(nx * ny * nz);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        result[x + y * nx + z * nx * ny] = data[x * ny * nz + y * nz + z];
      }
    }
  }
  return result;
}

// ==================== Post-processing ====================

function softmaxExtractClass1(rawOutput, voxelCount, numClasses) {
  const result = new Float32Array(voxelCount);

  for (let v = 0; v < voxelCount; v++) {
    let maxLogit = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const logit = rawOutput[c * voxelCount + v];
      if (logit > maxLogit) maxLogit = logit;
    }

    let sumExp = 0;
    for (let c = 0; c < numClasses; c++) {
      sumExp += Math.exp(rawOutput[c * voxelCount + v] - maxLogit);
    }

    result[v] = Math.exp(rawOutput[1 * voxelCount + v] - maxLogit) / sumExp;
  }

  return result;
}

function connectedComponents3D(binaryMask, dims) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const labels = new Int32Array(n);
  let nextLabel = 1;

  const parent = [0];
  const rank = [0];

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a, b) {
    a = find(a); b = find(b);
    if (a === b) return;
    if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
    parent[b] = a;
    if (rank[a] === rank[b]) rank[a]++;
  }

  // 13 backward neighbors for 26-connectivity
  const neighborOffsets = [];
  for (let dz = -1; dz <= 0; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dz === 0 && dy === 0 && dx >= 0) continue;
        neighborOffsets.push([dx, dy, dz]);
      }
    }
  }

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = z * ny * nx + y * nx + x;
        if (!binaryMask[idx]) continue;

        const neighborLabels = [];
        for (let i = 0; i < neighborOffsets.length; i++) {
          const nx2 = x + neighborOffsets[i][0];
          const ny2 = y + neighborOffsets[i][1];
          const nz2 = z + neighborOffsets[i][2];
          if (nx2 < 0 || nx2 >= nx || ny2 < 0 || ny2 >= ny || nz2 < 0 || nz2 >= nz) continue;
          const nIdx = nz2 * ny * nx + ny2 * nx + nx2;
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
          for (let i = 0; i < neighborLabels.length; i++) {
            union(minLabel, neighborLabels[i]);
          }
        }
      }
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

function selectTopNMarkers(probabilityMap, dims, nMarkers, threshold) {
  const n = probabilityMap.length;

  const binaryMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    binaryMask[i] = probabilityMap[i] > threshold ? 1 : 0;
  }

  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);

  if (numComponents === 0) return new Float32Array(n);

  if (numComponents <= nMarkers) {
    const result = new Float32Array(n);
    for (let i = 0; i < n; i++) result[i] = labels[i] > 0 ? 1.0 : 0.0;
    return result;
  }

  const componentSum = new Float64Array(numComponents + 1);
  const componentCount = new Int32Array(numComponents + 1);

  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) {
      componentSum[labels[i]] += probabilityMap[i];
      componentCount[labels[i]]++;
    }
  }

  const scores = [];
  for (let c = 1; c <= numComponents; c++) {
    scores.push({ label: c, meanProb: componentSum[c] / componentCount[c] });
  }
  scores.sort((a, b) => b.meanProb - a.meanProb);

  const keepLabels = new Set();
  for (let i = 0; i < Math.min(nMarkers, scores.length); i++) {
    keepLabels.add(scores[i].label);
  }

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = keepLabels.has(labels[i]) ? 1.0 : 0.0;
  }
  return result;
}

function averageProbabilityMaps(maps) {
  const n = maps[0].length;
  const result = new Float32Array(n);
  for (let m = 0; m < maps.length; m++) {
    const map = maps[m];
    for (let i = 0; i < n; i++) result[i] += map[i];
  }
  const count = maps.length;
  for (let i = 0; i < n; i++) result[i] /= count;
  return result;
}

// ==================== Model Loading ====================

async function fetchModel(url, modelName, progressBase, progressSpan) {
  const displayName = modelName || url.split('/').pop();

  // Check cache first
  try {
    const cached = await localforage.getItem(url);
    if (cached && cached.byteLength > 1000000) {
      postLog(`Model loaded from cache: ${displayName}`);
      postProgress(progressBase + progressSpan, `Cached: ${displayName}`);
      return cached;
    }
  } catch (e) {
    // Cache miss, continue to fetch
  }

  // Stream download with progress
  postLog(`Downloading: ${displayName}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
  }

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

  // Combine chunks
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  // Cache for next time
  try {
    await localforage.setItem(url, data.buffer);
  } catch (e) {
    postLog('Warning: Could not cache model (storage full?)');
  }

  postLog(`Downloaded: ${displayName} (${(received / 1048576).toFixed(1)} MB)`);
  return data.buffer;
}

// ==================== Main Inference Pipeline ====================

async function runInference(config) {
  const { inputData, settings } = config;
  const {
    selectedModels,
    threshold = 0.1,
    nMarkers = 3,
    modelBaseUrl
  } = settings;

  // 1. Parse NIfTI input
  postLog('Parsing input volume...');
  postProgress(0.02, 'Reading NIfTI...');
  const { imageData, dims, voxelSize, headerBytes } = parseNiftiInput(inputData);
  const [nx, ny, nz] = dims;
  const [vx, vy, vz] = voxelSize;
  postLog(`Volume dimensions: ${nx} x ${ny} x ${nz}, voxel: ${vx.toFixed(2)} x ${vy.toFixed(2)} x ${vz.toFixed(2)}mm`);

  // 2. Bias field correction (makehomogeneous)
  postProgress(0.05, 'Bias field correction...');
  postLog('Running bias field correction...');
  const mag64 = new Float64Array(imageData);
  const corrected64 = qsmWasm.makehomogeneous_wasm(mag64, nx, ny, nz, vx, vy, vz, 7.0, 15);
  const correctedData = new Float32Array(corrected64);
  postLog('Bias field correction complete');

  // 3. Pad, normalize, and transpose to C-contiguous for ONNX
  postProgress(0.10, 'Normalizing...');
  const paddedDims = findPaddedDims(dims, 32);
  const paddedData = padVolume(correctedData, dims, paddedDims);
  const normalizedData = zScoreNormalize(paddedData);
  const [pnx, pny, pnz] = paddedDims;
  const tensorData = niftiToC(normalizedData, pnx, pny, pnz);
  postLog(`Padded to: ${pnx} x ${pny} x ${pnz}`);

  // 4. Run each model
  const allProbMaps = [];
  const totalModels = selectedModels.length;

  for (let i = 0; i < totalModels; i++) {
    const modelName = selectedModels[i];
    const modelUrl = `${modelBaseUrl}/${modelName}`;
    const perModelSpan = 0.65 / totalModels;
    const progressBase = 0.15 + i * perModelSpan;
    const dlSpan = perModelSpan * 0.6;   // 60% of per-model span for download
    const runBase = progressBase + dlSpan; // remaining 40% for inference

    // Fetch model (with download progress)
    const modelData = await fetchModel(modelUrl, modelName, progressBase, dlSpan);

    // Create ONNX session
    postProgress(runBase, `Loading model ${i + 1}/${totalModels}...`);
    postLog('Creating ONNX InferenceSession...');
    let session;
    try {
      session = await ort.InferenceSession.create(modelData, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    } catch (e) {
      postLog(`Session creation failed: ${e?.message || String(e)}`);
      throw e;
    }
    postLog(`Session created. Inputs: ${session.inputNames}, Outputs: ${session.outputNames}`);

    // Create input tensor [1, 1, nx, ny, nz] — C-contiguous
    postProgress(runBase + perModelSpan * 0.2, `Running model ${i + 1}/${totalModels}...`);
    const inputTensor = new ort.Tensor(
      'float32',
      tensorData,
      [1, 1, pnx, pny, pnz]
    );

    // Run inference
    postLog('Running inference...');
    const inputName = session.inputNames[0];
    let results;
    try {
      results = await session.run({ [inputName]: inputTensor });
    } catch (e) {
      postLog(`Inference run failed: ${e?.message || String(e)}`);
      throw e;
    }
    const outputName = session.outputNames[0];
    const rawOutput = results[outputName].data;

    // Softmax and extract class 1 probability (output is C-contiguous)
    const voxelCount = pnx * pny * pnz;
    const probMapC = softmaxExtractClass1(rawOutput, voxelCount, 3);

    // Transpose output back to NIfTI order, then crop
    const probMapNifti = cToNifti(probMapC, pnx, pny, pnz);
    const croppedProb = cropVolume(probMapNifti, paddedDims, dims);
    allProbMaps.push(croppedProb);

    // Send individual model result as NIfTI
    const modelNifti = createOutputNifti(croppedProb, headerBytes);
    postStageData(`model${i + 1}`, modelNifti, `Model ${i + 1} seed probability`);

    // Cleanup
    inputTensor.dispose();
    await session.release();

    postLog(`Model ${i + 1}/${totalModels} complete`);
  }

  // 5. Average probability maps
  postProgress(0.85, 'Computing consensus...');
  const avgProb = averageProbabilityMaps(allProbMaps);
  const avgNifti = createOutputNifti(avgProb, headerBytes);
  postStageData('avgProb', avgNifti, 'Average probability');

  // 6. Connected component labeling + top-N selection
  postProgress(0.92, 'Selecting markers...');
  const consensusMask = selectTopNMarkers(avgProb, dims, nMarkers, threshold);
  const consensusNifti = createOutputNifti(consensusMask, headerBytes);
  postStageData('consensus', consensusNifti, 'Consensus segmentation');

  // Count marker voxels
  let markerVoxels = 0;
  for (let i = 0; i < consensusMask.length; i++) {
    if (consensusMask[i] > 0) markerVoxels++;
  }
  postLog(`Consensus: ${markerVoxels} voxels in final segmentation`);

  postProgress(1.0, 'Complete');
  postComplete();
}

// ==================== Message Handler ====================

self.onmessage = async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case 'init':
      try {
        ort.env.wasm.numThreads = navigator.hardwareConcurrency > 1 ? 2 : 1;
        ort.env.wasm.wasmPaths = '../wasm/';

        localforage.config({
          name: 'SeedSegModelCache',
          storeName: 'models'
        });

        // Initialize QSM WASM (for bias field correction)
        const baseUrl = self.location.href.replace(/\/js\/.*$/, '');
        const wasmJsUrl = `${baseUrl}/wasm/qsm_wasm.js`;
        const wasmBinaryUrl = `${baseUrl}/wasm/qsm_wasm_bg.wasm`;
        qsmWasm = await import(wasmJsUrl);
        await qsmWasm.default(wasmBinaryUrl);

        self.postMessage({ type: 'initialized' });
      } catch (error) {
        postError(`Initialization failed: ${error.message}`);
      }
      break;

    case 'run':
      try {
        await runInference(data);
      } catch (error) {
        console.error('Inference error:', error);
        const msg = error?.message || String(error);
        postError(msg);
      }
      break;
  }
};
