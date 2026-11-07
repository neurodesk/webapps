// micro-sam's image preprocessing for the SAM encoder, DOM-free so Node tests run it.
//
// micro_sam.util._to_image maps the image to three channels and scales each channel to 0..255
// (float32 arithmetic, truncated to uint8). SamPredictor.set_image then resizes the longest side
// to 1024 with torchvision's resize, which is Pillow's bilinear resample with 8-bit fixed-point
// coefficients (Pillow src/libImaging/Resample.c, ported in resizeChannel below; NOTICE), and
// Sam.preprocess normalises with SAM's pixel mean and standard deviation and pads to 1024 x 1024
// with zeros at the bottom and right.

export const TARGET = 1024;
const PIXEL_MEAN = [123.675, 116.28, 103.53];
const PIXEL_STD = [58.395, 57.12, 57.375];
const PRECISION_BITS = 32 - 8 - 2;
const EPSILON = Math.fround(1e-7);

/** SAM's ResizeLongestSide.get_preprocess_shape: the image's size with its longest side at 1024. */
export function resizedShape(height, width, target = TARGET) {
  const scale = target / Math.max(height, width);
  return { height: Math.trunc(height * scale + 0.5), width: Math.trunc(width * scale + 0.5) };
}

/**
 * The three channels micro-sam builds from the planes it is given: one plane is replicated, two
 * get a zero third channel, three are used as they are and further planes are left out.
 */
export function threeChannels(planes) {
  if (!planes.length) throw new Error("The image has no channels.");
  if (planes.length === 1) return [planes[0], planes[0], planes[0]];
  if (planes.length === 2) return [planes[0], planes[1], new Float32Array(planes[0].length)];
  return planes.slice(0, 3);
}

/**
 * micro_sam.util._to_image's normalisation of one channel: subtract the minimum, divide by the
 * new maximum plus 1e-7, multiply by 255 and truncate, all in float32 as numpy does.
 */
export function channelToUint8(data) {
  let min = Infinity;
  for (let i = 0; i < data.length; i++) {
    const value = Math.fround(data[i]);
    if (!Number.isFinite(value)) throw new Error("The image has NaN or infinite pixels; replace them before segmenting.");
    if (value < min) min = value;
  }
  const shifted = new Float32Array(data.length);
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    shifted[i] = Math.fround(data[i]) - min;
    if (shifted[i] > max) max = shifted[i];
  }
  const denominator = Math.fround(max + EPSILON);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.trunc(Math.fround(Math.fround(shifted[i] / denominator) * 255));
  }
  return out;
}

// Pillow's precompute_coeffs for the bilinear (triangle) filter, support 1, and the 8-bit
// normalisation to PRECISION_BITS fixed point.
function coefficients(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const weights = new Int32Array(outSize * ksize);
  const raw = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    let sum = 0;
    for (let x = 0; x < xmax; x++) {
      const distance = Math.abs((x + xmin - center + 0.5) / filterScale);
      raw[x] = distance < 1 ? 1 - distance : 0;
      sum += raw[x];
    }
    for (let x = 0; x < xmax; x++) {
      const weight = sum !== 0 ? raw[x] / sum : raw[x];
      weights[xx * ksize + x] = Math.trunc((weight < 0 ? -0.5 : 0.5) + weight * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, weights };
}

function clip8(value) {
  const shifted = value >> PRECISION_BITS;
  return shifted < 0 ? 0 : shifted > 255 ? 255 : shifted;
}

function horizontal(input, inWidth, rows, firstRow, outWidth, kernel) {
  const out = new Uint8Array(outWidth * rows);
  const { ksize, bounds, weights } = kernel;
  for (let y = 0; y < rows; y++) {
    const row = (y + firstRow) * inWidth;
    for (let xx = 0; xx < outWidth; xx++) {
      const xmin = bounds[xx * 2];
      const xmax = bounds[xx * 2 + 1];
      let sum = 1 << (PRECISION_BITS - 1);
      for (let x = 0; x < xmax; x++) sum += input[row + xmin + x] * weights[xx * ksize + x];
      out[y * outWidth + xx] = clip8(sum);
    }
  }
  return out;
}

function vertical(input, width, outHeight, kernel, offset = 0) {
  const out = new Uint8Array(width * outHeight);
  const { ksize, bounds, weights } = kernel;
  for (let yy = 0; yy < outHeight; yy++) {
    const ymin = bounds[yy * 2] - offset;
    const ymax = bounds[yy * 2 + 1];
    for (let x = 0; x < width; x++) {
      let sum = 1 << (PRECISION_BITS - 1);
      for (let y = 0; y < ymax; y++) sum += input[(y + ymin) * width + x] * weights[yy * ksize + y];
      out[yy * width + x] = clip8(sum);
    }
  }
  return out;
}

/** Pillow's `Image.resize(size, BILINEAR)` of one 8-bit channel (ImagingResampleInner). */
export function resizeChannel(input, width, height, outWidth, outHeight) {
  const needHorizontal = outWidth !== width;
  const needVertical = outHeight !== height;
  if (!needHorizontal && !needVertical) return Uint8Array.from(input);
  const horizontalFirst = !(height - outHeight > 0 && height - outHeight > (width - outWidth) * 2);
  const verticalKernel = coefficients(height, outHeight);
  const horizontalKernel = needHorizontal ? coefficients(width, outWidth) : null;
  if (horizontalFirst) {
    if (!needHorizontal) return vertical(input, width, outHeight, verticalKernel);
    // Only the rows the vertical pass reads are resampled horizontally.
    const first = verticalKernel.bounds[0];
    const last = verticalKernel.bounds[outHeight * 2 - 2] + verticalKernel.bounds[outHeight * 2 - 1];
    const rows = horizontal(input, width, last - first, first, outWidth, horizontalKernel);
    return needVertical ? vertical(rows, outWidth, outHeight, verticalKernel, first) : rows;
  }
  const columns = vertical(input, width, outHeight, verticalKernel);
  return needHorizontal ? horizontal(columns, width, outHeight, 0, outWidth, horizontalKernel) : columns;
}

/**
 * The 8-bit, resized channels SamPredictor.set_image builds from micro-sam's image, row-major,
 * one Uint8Array per channel.
 */
export function resizedChannels(planes, width, height) {
  const size = resizedShape(height, width);
  const channels = threeChannels(planes).map((plane) => resizeChannel(channelToUint8(plane), width, height, size.width, size.height));
  return { channels, ...size };
}

/** The encoder input: 1 x 3 x 1024 x 1024, normalised by SAM's mean and std, zero-padded. */
export function encoderTensor({ channels, width, height }) {
  const plane = TARGET * TARGET;
  const tensor = new Float32Array(3 * plane);
  channels.forEach((channel, c) => {
    // Sam's pixel_mean and pixel_std are float32 buffers, so the arithmetic is float32.
    const mean = Math.fround(PIXEL_MEAN[c]);
    const std = Math.fround(PIXEL_STD[c]);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        tensor[c * plane + y * TARGET + x] = Math.fround(channel[y * width + x] - mean) / std;
      }
    }
  });
  return tensor;
}

/**
 * SAM's ResizeLongestSide.apply_coords: a point in original pixel coordinates (x right, y down,
 * integers at pixel centres as in napari) in the resized frame the decoder takes.
 */
export function toModelCoordinates([x, y], height, width) {
  const size = resizedShape(height, width);
  return [x * (size.width / width), y * (size.height / height)];
}
