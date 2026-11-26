// Pure DAGMNet DWI (3-channel) and PWI (4-channel) 16-pass strided sliding-window inference.
import {
  voxelCount,
  fToC,
  cToF,
  centerPad,
  uncenterPad,
  percentileClipRescaleInMask,
  zscoreInMask,
  dagmnetPostprocess,
} from './volume.js';

export const PAD_SHAPE = [192, 224, 192];
const DS = 2;
const ZS = 4;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function cleanFinite(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = Number.isFinite(src[i]) ? src[i] : 0;
  }
  return out;
}

function extractDwiWindow(data, dims, xOff, yOff, zOff, winDims) {
  const [nx, ny] = dims;
  const [wx, wy, wz] = winDims;
  const out = new Float32Array(wx * wy * wz);
  for (let z = 0; z < wz; z++) {
    const sz = zOff + z * ZS;
    for (let y = 0; y < wy; y++) {
      const sy = yOff + y * DS;
      for (let x = 0; x < wx; x++) {
        const sx = xOff + x * DS;
        out[x + y * wx + z * wx * wy] = data[sx + sy * nx + sz * nx * ny];
      }
    }
  }
  return out;
}

function scatterDwiWindow(pred, count, dims, xOff, yOff, zOff, winDims, values) {
  const [nx, ny] = dims;
  const [wx, wy, wz] = winDims;
  for (let z = 0; z < wz; z++) {
    const sz = zOff + z * ZS;
    for (let y = 0; y < wy; y++) {
      const sy = yOff + y * DS;
      for (let x = 0; x < wx; x++) {
        const sx = xOff + x * DS;
        const di = sx + sy * nx + sz * nx * ny;
        pred[di] += values[x + y * wx + z * wx * wy];
        count[di] += 1;
      }
    }
  }
}

function extractPwiWindow(data, dims, xOff, yOff, zOff, winDims) {
  const [nx, ny] = dims;
  const [wa0, wa1, wa2] = winDims;
  const out = new Float32Array(wa0 * wa1 * wa2);
  for (let a2 = 0; a2 < wa2; a2++) {
    const s2 = xOff + a2 * DS;
    for (let a1 = 0; a1 < wa1; a1++) {
      const s1 = yOff + a1 * DS;
      for (let a0 = 0; a0 < wa0; a0++) {
        const s0 = zOff + a0 * ZS;
        out[a0 + a1 * wa0 + a2 * wa0 * wa1] = data[s0 + s1 * nx + s2 * nx * ny];
      }
    }
  }
  return out;
}

function scatterPwiWindow(pred, count, dims, xOff, yOff, zOff, winDims, values) {
  const [nx, ny] = dims;
  const [wa0, wa1, wa2] = winDims;
  for (let a2 = 0; a2 < wa2; a2++) {
    const s2 = xOff + a2 * DS;
    for (let a1 = 0; a1 < wa1; a1++) {
      const s1 = yOff + a1 * DS;
      for (let a0 = 0; a0 < wa0; a0++) {
        const s0 = zOff + a0 * ZS;
        const di = s0 + s1 * nx + s2 * nx * ny;
        pred[di] += values[a0 + a1 * wa0 + a2 * wa0 * wa1];
        count[di] += 1;
      }
    }
  }
}

export async function runDagmnetDwi({
  dwi,
  adc,
  dims,
  mask = null,
  threshold = 0.5,
  minSize = 50,
  runPass,
  onPass = () => {},
}) {
  const n = voxelCount(dims);
  const dwiClean = cleanFinite(dwi);
  const adcClean = cleanFinite(adc);

  let dwiZ;
  let adcZ;
  if (mask) {
    dwiZ = zscoreInMask(percentileClipRescaleInMask(dwiClean, mask), mask);
    adcZ = zscoreInMask(percentileClipRescaleInMask(adcClean, mask), mask);
  } else {
    const fallbackMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      fallbackMask[i] = dwiClean[i] !== 0 || adcClean[i] !== 0 ? 1 : 0;
    }
    dwiZ = zscoreInMask(dwiClean, fallbackMask);
    adcZ = zscoreInMask(adcClean, fallbackMask);
  }

  const dwiPad = centerPad(dwiZ, dims, PAD_SHAPE);
  const adcPad = centerPad(adcZ, dims, PAD_SHAPE);
  const zerosPad = new Float32Array(voxelCount(PAD_SHAPE));
  const channels = [dwiPad.data, adcPad.data, zerosPad];

  const winDims = [PAD_SHAPE[0] / DS, PAD_SHAPE[1] / DS, PAD_SHAPE[2] / ZS];
  const winVoxels = voxelCount(winDims);
  const pred = new Float32Array(voxelCount(PAD_SHAPE));
  const count = new Float32Array(voxelCount(PAD_SHAPE));
  const total = DS * DS * ZS;
  let done = 0;

  for (let xOff = 0; xOff < DS; xOff++) {
    for (let yOff = 0; yOff < DS; yOff++) {
      for (let zOff = 0; zOff < ZS; zOff++) {
        const tensor = new Float32Array(3 * winVoxels);
        for (let c = 0; c < 3; c++) {
          const w = extractDwiWindow(channels[c], PAD_SHAPE, xOff, yOff, zOff, winDims);
          tensor.set(fToC(w, winDims), c * winVoxels);
        }
        const outC = await runPass(tensor, [1, 3, ...winDims]);
        const outF = cToF(outC, winDims);
        scatterDwiWindow(pred, count, PAD_SHAPE, xOff, yOff, zOff, winDims, outF);
        done++;
        onPass(done, total);
      }
    }
  }

  const probPad = new Float32Array(pred.length);
  for (let i = 0; i < pred.length; i++) {
    probPad[i] = count[i] > 0 ? pred[i] / count[i] : 0;
  }
  const prob = uncenterPad(probPad, PAD_SHAPE, dims, dwiPad.offsets);
  const rawMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rawMask[i] = prob[i] >= threshold ? 1 : 0;
  }
  const finalMask = dagmnetPostprocess(rawMask, dims, minSize);
  let lesionVoxels = 0;
  for (let i = 0; i < finalMask.length; i++) {
    if (finalMask[i]) lesionVoxels++;
  }
  return { mask: finalMask, prob, dims, lesionVoxels };
}

export async function runDagmnetPwi({
  dwi,
  adc,
  ttp,
  symclassic = null,
  dims,
  threshold = 0.5,
  minSize = 50,
  runPass,
  onPass = () => {},
}) {
  const n = voxelCount(dims);
  const sym = symclassic || new Float32Array(n);
  const dwiClean = cleanFinite(dwi);
  const adcClean = cleanFinite(adc);
  const ttpClean = cleanFinite(ttp);
  const symClean = cleanFinite(sym);

  const brainMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    brainMask[i] = dwiClean[i] !== 0 || adcClean[i] !== 0 || ttpClean[i] !== 0 || symClean[i] !== 0 ? 1 : 0;
  }

  const padded = [dwiClean, adcClean, ttpClean, symClean].map((ch) =>
    centerPad(zscoreInMask(ch, brainMask), dims, PAD_SHAPE),
  );
  const winDims = [PAD_SHAPE[0] / ZS, PAD_SHAPE[1] / DS, PAD_SHAPE[2] / DS];
  const winVoxels = voxelCount(winDims);
  const pred = new Float32Array(voxelCount(PAD_SHAPE));
  const count = new Float32Array(voxelCount(PAD_SHAPE));
  const total = DS * DS * ZS;
  let done = 0;

  for (let xOff = 0; xOff < DS; xOff++) {
    for (let yOff = 0; yOff < DS; yOff++) {
      for (let zOff = 0; zOff < ZS; zOff++) {
        const tensor = new Float32Array(4 * winVoxels);
        for (let c = 0; c < 4; c++) {
          const w = extractPwiWindow(padded[c].data, PAD_SHAPE, xOff, yOff, zOff, winDims);
          tensor.set(fToC(w, winDims), c * winVoxels);
        }
        const logitsC = await runPass(tensor, [1, 4, ...winDims]);
        const logitsF = cToF(logitsC, winDims);
        const probF = new Float32Array(logitsF.length);
        for (let i = 0; i < probF.length; i++) {
          probF[i] = sigmoid(logitsF[i]);
        }
        scatterPwiWindow(pred, count, PAD_SHAPE, xOff, yOff, zOff, winDims, probF);
        done++;
        onPass(done, total);
      }
    }
  }

  const probPad = new Float32Array(pred.length);
  for (let i = 0; i < pred.length; i++) {
    probPad[i] = count[i] > 0 ? pred[i] / count[i] : 0;
  }
  const prob = uncenterPad(probPad, PAD_SHAPE, dims, padded[0].offsets);
  const rawMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rawMask[i] = prob[i] >= threshold ? 1 : 0;
  }
  const finalMask = dagmnetPostprocess(rawMask, dims, minSize);
  let lesionVoxels = 0;
  for (let i = 0; i < finalMask.length; i++) {
    if (finalMask[i]) lesionVoxels++;
  }
  return { mask: finalMask, prob, dims, lesionVoxels };
}
