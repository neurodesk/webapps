// Field illumination from an image of a uniform fluorescent slide, with MetroloJ_QC's
// definitions (Faklaris et al. 2022; clean implementation):
//
// - Optionally the image is blurred with a Gaussian of σ = 2 px (ImageJ's GaussianBlur, ported
//   below, so integer images are rounded back to integers as ImageJ stores them).
// - Uniformity = 100 · min / max.
// - Field uniformity = 100 − 100 · SD(8 border points) / max, the SD (population) of the four
//   corners and the four edge midpoints.
// - Pixels are binned into iso-intensity zones of floor(I / max · 100 / step) · step percent,
//   for a whole-number step. The reference zone is the top one (≥ 100 − step %, default
//   90–100 %), or the maximum pixel.
// - Centering accuracy = 100 − 200 · d / sqrt(w² + h²), d the distance in pixels from the
//   reference zone's centroid to the image centre (floor(w / 2), floor(h / 2)).
//
// Images are row-major: index = y · width + x.

/**
 * ImageJ 1's normalised one-sided Gaussian kernel and its running tail sum (GaussianBlur
 * makeGaussianKernel, public domain), in float32 as ImageJ stores it.
 */
export function imagejGaussianKernel(sigma, accuracy, maxRadius) {
  let kRadius = Math.ceil(sigma * Math.sqrt(-2 * Math.log(accuracy))) + 1;
  if (maxRadius < 50) maxRadius = 50;
  if (kRadius > maxRadius) kRadius = maxRadius;
  const kernel = new Float32Array(kRadius);
  const tail = new Float32Array(kRadius);
  for (let i = 0; i < kRadius; i++) kernel[i] = Math.exp((-0.5 * i * i) / sigma / sigma);
  if (kRadius < maxRadius && kRadius > 3) {
    let sqrtSlope = Number.MAX_VALUE;
    let r = kRadius;
    while (r > Math.trunc(kRadius / 2)) {
      r--;
      const a = Math.sqrt(kernel[r]) / (kRadius - r);
      if (a < sqrtSlope) sqrtSlope = a;
      else break;
    }
    for (let r1 = r + 2; r1 < kRadius; r1++) kernel[r1] = (kRadius - r1) * (kRadius - r1) * sqrtSlope * sqrtSlope;
  }
  let sum;
  if (kRadius < maxRadius) {
    sum = kernel[0];
    for (let i = 1; i < kRadius; i++) sum += 2 * kernel[i];
  } else sum = sigma * Math.sqrt(2 * Math.PI);
  let rsum = 0.5 + (0.5 * kernel[0]) / sum;
  for (let i = 0; i < kRadius; i++) {
    const v = kernel[i] / sum;
    kernel[i] = v;
    rsum -= v;
    tail[i] = rsum;
  }
  return { kernel, tail };
}

const f = Math.fround;

/** ImageJ's convolveLine: out-of-line pixels take the nearest edge value; float32 arithmetic. */
function convolveLine(input, output, { kernel, tail }) {
  const length = input.length;
  const first = input[0];
  const last = input[length - 1];
  const kRadius = kernel.length;
  for (let i = 0; i < length; i++) {
    let result = f(input[i] * kernel[0]);
    if (i < kRadius) result = f(result + f(tail[i] * first));
    if (i + kRadius >= length) result = f(result + f(tail[length - i - 1] * last));
    for (let k = 1; k < kRadius; k++) {
      let v = 0;
      if (i - k >= 0) v = f(v + input[i - k]);
      if (i + k < length) v = f(v + input[i + k]);
      result = f(result + f(kernel[k] * v));
    }
    output[i] = result;
  }
}

/**
 * ImageJ's blurGaussian(ip, sigma) for one 2D image: x then y, accuracy 0.002 for 8-bit and
 * 0.0002 otherwise, and for integer types the result rounded as ImageJ stores it
 * ((int)(v + 0.5), clamped). σ must stay below 8.5 px, where ImageJ starts downscaling.
 * @param {'uint8' | 'uint16' | 'float32' | string} dtype
 */
export function imagejGaussianBlur(image, width, height, sigma, dtype) {
  if (sigma > 8.5) throw new Error('Gaussian blur is implemented for σ up to 8.5 px.');
  const accuracy = dtype === 'uint8' ? 0.002 : 0.0002;
  const pixels = Float32Array.from(image);
  const lineX = new Float32Array(width);
  const outX = new Float32Array(width);
  const kx = imagejGaussianKernel(sigma, accuracy, width);
  for (let y = 0; y < height; y++) {
    lineX.set(pixels.subarray(y * width, (y + 1) * width));
    convolveLine(lineX, outX, kx);
    pixels.set(outX, y * width);
  }
  const lineY = new Float32Array(height);
  const outY = new Float32Array(height);
  const ky = imagejGaussianKernel(sigma, accuracy, height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) lineY[y] = pixels[y * width + x];
    convolveLine(lineY, outY, ky);
    for (let y = 0; y < height; y++) pixels[y * width + x] = outY[y];
  }
  const ceiling = { uint8: 255, uint16: 65535 }[dtype];
  if (ceiling === undefined) return pixels;
  const out = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) out[i] = Math.min(ceiling, Math.max(0, Math.trunc(f(pixels[i] + 0.5))));
  return out;
}

/** Bilinear sample with ImageJ's getInterpolatedValue edge rule (clamped to the last pixel). */
function interpolate(image, width, height, x, y) {
  if (x < -1 || x >= width || y < -1 || y >= height) return 0;
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.min(Math.floor(cx), width - 2 < 0 ? 0 : width - 2);
  const y0 = Math.min(Math.floor(cy), height - 2 < 0 ? 0 : height - 2);
  const fx = cx - x0;
  const fy = cy - y0;
  const at = (xx, yy) => image[Math.min(yy, height - 1) * width + Math.min(xx, width - 1)];
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Intensities along a line, sampled as ImageJ's getLine: round(length) + 1 points. */
export function lineProfile(image, width, height, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const n = Math.round(Math.sqrt(dx * dx + dy * dy));
  const values = new Float64Array(n + 1);
  const distance = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = n > 0 ? i / n : 0;
    values[i] = interpolate(image, width, height, x1 + dx * t, y1 + dy * t);
    distance[i] = Math.sqrt((dx * t) ** 2 + (dy * t) ** 2);
  }
  return { distance, values };
}

/** Uniformity and field uniformity (%) from the extremes and the eight border intensities. */
export function uniformityMetrics({ min, max, border }) {
  const mean = border.reduce((a, b) => a + b, 0) / border.length;
  const sd = Math.sqrt(border.reduce((a, b) => a + (b - mean) ** 2, 0) / border.length);
  return { uniformity: (100 * min) / max, fieldUniformity: 100 - (100 * sd) / max };
}

/** Centering accuracy (%) of a reference point against the image centre. */
export function centeringAccuracy(reference, centre, width, height) {
  const diagonal = Math.sqrt(width * width + height * height);
  return 100 - (200 * Math.hypot(reference.x - centre.x, reference.y - centre.y)) / diagonal;
}

/**
 * Field illumination metrics.
 * @param {ArrayLike<number>} image
 * @param {{ width: number, height: number, dtype: string }} dims
 * @param {{ blur: boolean, step: number, referenceZone: boolean, saturation: number | null }} options step in percent
 */
export function analyseField(image, { width, height, dtype }, { blur = true, step = 10, referenceZone = true, saturation = null } = {}) {
  if (!(Number.isInteger(step) && step >= 1 && step <= 50)) throw new Error('The iso-intensity step must be a whole number from 1 to 50 %.');
  if (width < 3 || height < 3) throw new Error('A field illumination image needs at least 3 × 3 pixels.');
  let saturated = 0;
  if (saturation !== null) for (let i = 0; i < image.length; i++) if (image[i] >= saturation) saturated++;
  const pixels = blur ? imagejGaussianBlur(image, width, height, 2, dtype) : Float64Array.from(image);
  let min = Infinity;
  let max = -Infinity;
  let minAt = 0;
  let maxAt = 0;
  // Like MetroloJ_QC, the last pixel in raster order holding the extreme value is its position.
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] <= min) {
      min = pixels[i];
      minAt = i;
    }
    if (pixels[i] >= max) {
      max = pixels[i];
      maxAt = i;
    }
  }
  if (!(max > 0)) throw new Error('The image has no positive intensity.');
  const zones = new Uint8Array(pixels.length);
  const threshold = 100 - step;
  let zoneCount = 0;
  let zoneX = 0;
  let zoneY = 0;
  for (let i = 0; i < pixels.length; i++) {
    const zone = Math.trunc((Math.trunc((pixels[i] / max) * 100 / step) * step));
    zones[i] = Math.max(0, Math.min(100, zone));
    // The reference zone is every pixel at or above (100 - step) % of the maximum, whether or
    // not the step divides 100 (with step 7 the top iso zone starts at 98 %, not 93 %).
    // Dividing by the step keeps the comparison identical to the zone labels when it does.
    if ((pixels[i] / max) * 100 / step >= threshold / step) {
      zoneCount++;
      zoneX += (i % width) + 0.5;
      zoneY += Math.floor(i / width) + 0.5;
    }
  }
  const position = (i) => ({ x: i % width, y: Math.floor(i / width) });
  const maxPos = position(maxAt);
  const minPos = position(minAt);
  const centre = { x: Math.trunc(width / 2), y: Math.trunc(height / 2) };
  const reference = referenceZone ? { x: zoneX / zoneCount, y: zoneY / zoneCount } : maxPos;
  // Points are pixel indices, or a centroid of pixel centres (index + 0.5): the pixel holding
  // a point is floor(coordinate), kept inside the image.
  const pixel = (value, size) => Math.min(size - 1, Math.max(0, Math.floor(value)));
  const at = ({ x, y }) => pixels[pixel(y, height) * width + pixel(x, width)];
  const border = [
    ['Top-left corner', { x: 0, y: 0 }],
    ['Top-right corner', { x: width - 1, y: 0 }],
    ['Bottom-left corner', { x: 0, y: height - 1 }],
    ['Bottom-right corner', { x: width - 1, y: height - 1 }],
    ['Top edge, middle', { x: centre.x, y: 0 }],
    ['Bottom edge, middle', { x: centre.x, y: height - 1 }],
    ['Left edge, middle', { x: 0, y: centre.y }],
    ['Right edge, middle', { x: width - 1, y: centre.y }],
  ];
  const borderValues = border.map(([, point]) => at(point));
  const points = [
    ['Maximum', maxPos, max],
    [referenceZone ? `Reference zone (${threshold}–100 %) centroid` : 'Reference (maximum pixel)', reference, at(reference)],
    ['Minimum', minPos, min],
    ...border.map(([name, point], k) => [name, point, borderValues[k]]),
  ].map(([name, point, intensity]) => ({ name, x: point.x, y: point.y, intensity, relative: intensity / max, distanceToCentre: Math.hypot(point.x - centre.x, point.y - centre.y) }));
  const profiles = {
    horizontal: lineProfile(pixels, width, height, [0, centre.y], [width - 1, centre.y]),
    vertical: lineProfile(pixels, width, height, [centre.x, 0], [centre.x, height - 1]),
    diagonalTlBr: lineProfile(pixels, width, height, [0, 0], [width - 1, height - 1]),
    diagonalTrBl: lineProfile(pixels, width, height, [width - 1, 0], [0, height - 1]),
  };
  return {
    ...uniformityMetrics({ min, max, border: borderValues }),
    centeringAccuracy: centeringAccuracy(reference, centre, width, height),
    min,
    max,
    centre,
    reference,
    referencePixels: zoneCount,
    saturatedPixels: saturated,
    points,
    zones,
    profiles,
    smoothed: pixels,
  };
}
