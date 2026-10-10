export const MuscleMapSlidingWindowPolicy = (() => {
  function computeGaussianWeightMap(height, width) {
    const sigmaHeight = height * 0.125;
    const sigmaWidth = width * 0.125;
    const centerHeight = (height - 1) / 2;
    const centerWidth = (width - 1) / 2;
    const weights = new Float32Array(height * width);
    for (let y = 0; y < height; y++) {
      const heightWeight = Math.exp(-((y - centerHeight) ** 2) / (2 * sigmaHeight ** 2));
      for (let x = 0; x < width; x++) {
        const widthWeight = Math.exp(-((x - centerWidth) ** 2) / (2 * sigmaWidth ** 2));
        weights[y * width + x] = Math.max(0.001, heightWeight * widthWeight);
      }
    }
    return weights;
  }

  function computeTilePositions(imgH, imgW, patchH, patchW, overlap) {
    const stepH = Math.max(1, Math.floor(patchH * (1 - overlap)));
    const stepW = Math.max(1, Math.floor(patchW * (1 - overlap)));
    const positionsForAxis = (imageSize, patchSize, step) => {
      if (imageSize <= patchSize) return [0];
      const count = Math.ceil((imageSize - patchSize) / step) + 1;
      return Array.from({ length: count }, (_, index) => Math.min(index * step, imageSize - patchSize));
    };
    const positions = [];
    const seen = new Set();
    for (const y of positionsForAxis(imgH, patchH, stepH)) {
      for (const x of positionsForAxis(imgW, patchW, stepW)) {
        const key = `${y},${x}`;
        if (!seen.has(key)) {
          seen.add(key);
          positions.push({ y, x });
        }
      }
    }
    return positions;
  }

  function computeAccumulatorBlocks(height, width, classCount, maxElements = 100_000_000) {
    if (![height, width, classCount, maxElements].every(Number.isInteger) ||
        height <= 0 || width <= 0 || classCount <= 0 || maxElements < classCount) {
      throw new Error('Invalid sliding-window accumulator dimensions');
    }
    const maxPixels = Math.floor(maxElements / classCount);
    const blockWidth = Math.min(width, maxPixels);
    const blockHeight = Math.min(height, Math.max(1, Math.floor(maxPixels / blockWidth)));
    const blocks = [];
    for (let y = 0; y < height; y += blockHeight) {
      for (let x = 0; x < width; x += blockWidth) {
        blocks.push({
          x,
          y,
          width: Math.min(blockWidth, width - x),
          height: Math.min(blockHeight, height - y)
        });
      }
    }
    return blocks;
  }

  function intersects(left, right) {
    return left.x < right.x + right.width &&
      left.x + left.width > right.x &&
      left.y < right.y + right.height &&
      left.y + left.height > right.y;
  }

  function transposeNiftiSliceToModelOrder(slice, sizeX, sizeY) {
    if (slice.length !== sizeX * sizeY) throw new Error('NIfTI slice dimensions do not match its data');
    const output = new Float32Array(slice.length);
    for (let x = 0; x < sizeX; x++) {
      for (let y = 0; y < sizeY; y++) output[x * sizeY + y] = slice[x + y * sizeX];
    }
    return output;
  }

  return {
    computeGaussianWeightMap,
    computeTilePositions,
    computeAccumulatorBlocks,
    intersects,
    transposeNiftiSliceToModelOrder
  };
})();
