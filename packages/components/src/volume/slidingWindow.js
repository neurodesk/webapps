export function computeGaussianWeightMap2D(height, width, sigma = Math.min(height, width) / 8) {
  const weights = new Float32Array(height * width);
  const cy = (height - 1) / 2;
  const cx = (width - 1) / 2;
  const denom = 2 * sigma * sigma;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      weights[y * width + x] = Math.exp(-((y - cy) ** 2 + (x - cx) ** 2) / denom);
    }
  }
  return weights;
}

export function computeGaussianWeightMap3D(d0, d1, d2, sigma = Math.min(d0, d1, d2) / 8) {
  const weights = new Float32Array(d0 * d1 * d2);
  const c0 = (d0 - 1) / 2;
  const c1 = (d1 - 1) / 2;
  const c2 = (d2 - 1) / 2;
  const denom = 2 * sigma * sigma;
  for (let z = 0; z < d2; z++) {
    for (let y = 0; y < d1; y++) {
      for (let x = 0; x < d0; x++) {
        weights[x + y * d0 + z * d0 * d1] = Math.exp(-((x - c0) ** 2 + (y - c1) ** 2 + (z - c2) ** 2) / denom);
      }
    }
  }
  return weights;
}

export function computeTilePositions2D(height, width, patchHeight, patchWidth, overlap = 0) {
  const stepY = Math.max(1, Math.round(patchHeight * (1 - overlap)));
  const stepX = Math.max(1, Math.round(patchWidth * (1 - overlap)));
  const positions = [];
  const seen = new Set();
  const countY = Math.max(1, Math.ceil((height - patchHeight) / stepY) + 1);
  const countX = Math.max(1, Math.ceil((width - patchWidth) / stepX) + 1);
  for (let iy = 0; iy < countY; iy++) {
    const y = Math.max(0, Math.min(iy * stepY, height - patchHeight));
    for (let ix = 0; ix < countX; ix++) {
      const x = Math.max(0, Math.min(ix * stepX, width - patchWidth));
      const key = `${x},${y}`;
      if (!seen.has(key)) {
        seen.add(key);
        positions.push({ x, y });
      }
    }
  }
  return positions;
}

export function computePatchPositions3D(volumeDims, patchDims, overlap = 0) {
  const steps = patchDims.map(size => Math.max(1, Math.round(size * (1 - overlap))));
  const counts = volumeDims.map((size, axis) => Math.max(1, Math.ceil((size - patchDims[axis]) / steps[axis]) + 1));
  const positions = [];
  const seen = new Set();
  for (let iz = 0; iz < counts[2]; iz++) {
    const z = Math.max(0, Math.min(iz * steps[2], volumeDims[2] - patchDims[2]));
    for (let iy = 0; iy < counts[1]; iy++) {
      const y = Math.max(0, Math.min(iy * steps[1], volumeDims[1] - patchDims[1]));
      for (let ix = 0; ix < counts[0]; ix++) {
        const x = Math.max(0, Math.min(ix * steps[0], volumeDims[0] - patchDims[0]));
        const key = `${x},${y},${z}`;
        if (!seen.has(key)) {
          seen.add(key);
          positions.push([x, y, z]);
        }
      }
    }
  }
  return positions;
}

export function extractPatch3D(volume, volumeDims, position, patchDims) {
  const [px, py, pz] = patchDims;
  const [ox, oy, oz] = position;
  const [vx, vy] = volumeDims;
  const patch = new Float32Array(px * py * pz);
  for (let z = 0; z < pz; z++) {
    for (let y = 0; y < py; y++) {
      const source = (oz + z) * vx * vy + (oy + y) * vx + ox;
      const target = z * px * py + y * px;
      patch.set(volume.subarray(source, source + px), target);
    }
  }
  return patch;
}

export function accumulatePatch3D(accum, weightsAccum, volumeDims, position, output, weights, patchDims) {
  const [px, py, pz] = patchDims;
  const [ox, oy, oz] = position;
  const [vx, vy] = volumeDims;
  for (let z = 0; z < pz; z++) {
    for (let y = 0; y < py; y++) {
      for (let x = 0; x < px; x++) {
        const patchIndex = x + y * px + z * px * py;
        const volumeIndex = (ox + x) + (oy + y) * vx + (oz + z) * vx * vy;
        const weight = weights[patchIndex];
        accum[volumeIndex] += output[patchIndex] * weight;
        weightsAccum[volumeIndex] += weight;
      }
    }
  }
}
