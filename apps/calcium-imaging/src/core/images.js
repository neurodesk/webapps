// Summary images of a registered movie (frames × height × width, row-major).

/** Mean and maximum over time of every pixel. */
export function meanMaxImages(movie, frames, plane) {
  const mean = new Float32Array(plane);
  const max = new Float32Array(plane).fill(-Infinity);
  const sum = new Float64Array(plane);
  for (let f = 0; f < frames; f++) {
    const offset = f * plane;
    for (let i = 0; i < plane; i++) {
      const value = movie[offset + i];
      sum[i] += value;
      if (value > max[i]) max[i] = value;
    }
  }
  for (let i = 0; i < plane; i++) mean[i] = sum[i] / frames;
  return { mean, max };
}

/**
 * Local correlation image (Smith & Häusser 2010 Nat Neurosci 13:1144): the mean Pearson
 * correlation over time of each pixel with its eight (or four) neighbours, fewer at the
 * border. Pixels whose time series is constant have correlation 0.
 */
export function localCorrelationImage(movie, frames, height, width, { neighbours = 8 } = {}) {
  const plane = height * width;
  const mean = new Float64Array(plane);
  const scale = new Float64Array(plane);
  for (let f = 0; f < frames; f++) {
    const offset = f * plane;
    for (let i = 0; i < plane; i++) mean[i] += movie[offset + i];
  }
  for (let i = 0; i < plane; i++) mean[i] /= frames;
  for (let f = 0; f < frames; f++) {
    const offset = f * plane;
    for (let i = 0; i < plane; i++) {
      const d = movie[offset + i] - mean[i];
      scale[i] += d * d;
    }
  }
  for (let i = 0; i < plane; i++) {
    const sd = Math.sqrt(scale[i] / frames);
    scale[i] = sd > 0 ? 1 / sd : 0;
  }
  // Sum over time of z(p) · z(q) for the four forward neighbours; each pair counts for both.
  const offsets = neighbours === 4 ? [[0, 1], [1, 0]] : [[0, 1], [1, -1], [1, 0], [1, 1]];
  const sums = offsets.map(() => new Float64Array(plane));
  const z = new Float64Array(plane);
  for (let f = 0; f < frames; f++) {
    const offset = f * plane;
    for (let i = 0; i < plane; i++) z[i] = (movie[offset + i] - mean[i]) * scale[i];
    offsets.forEach(([dy, dx], k) => {
      const sum = sums[k];
      for (let y = 0; y + dy < height; y++) {
        for (let x = Math.max(0, -dx); x < width && x + dx < width; x++) {
          const i = y * width + x;
          sum[i] += z[i] * z[i + dy * width + dx];
        }
      }
    });
  }
  const total = new Float64Array(plane);
  const count = new Uint8Array(plane);
  offsets.forEach(([dy, dx], k) => {
    const sum = sums[k];
    for (let y = 0; y + dy < height; y++) {
      for (let x = Math.max(0, -dx); x < width && x + dx < width; x++) {
        const i = y * width + x;
        const j = i + dy * width + dx;
        total[i] += sum[i];
        total[j] += sum[i];
        count[i]++;
        count[j]++;
      }
    }
  });
  const image = new Float32Array(plane);
  for (let i = 0; i < plane; i++) image[i] = count[i] ? total[i] / (count[i] * frames) : 0;
  return image;
}
