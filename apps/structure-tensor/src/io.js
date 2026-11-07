// Reading inputs and writing outputs in the browser. Images become
// { data: Float64Array, dims, spacing, unit, kind, header }; `header` is a NIfTI header for the
// viewer and the NIfTI outputs (the input's own for NIfTI, one built from the TIFF otherwise).
import { createNiftiFromData, createNiftiHeaderFromVolume, createRgb24Nifti, decodeNiftiBuffer, parseNiftiVolume, readNiftiHeader } from "@neurodesk/webapp-components/file-io";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { inspectTiffStack, readTiffStack, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { inputKind, outputPlan, summary, voxelRefusal } from "./config.js";
import { distributionCsv, nonFiniteRefusal } from "./tensor.js";

/**
 * A NIfTI header for a TIFF-ordered grid: row 0 is the top of the image, so world y runs
 * downwards with the row index and NiiVue shows the image the right way up.
 */
function rasterHeader(dims, spacing) {
  const [dx, dy, dz] = spacing;
  return createNiftiHeaderFromVolume({
    hdr: {
      dims: [3, ...dims, 1, 1, 1, 1],
      pixDims: [1, dx, dy, dz, 1, 1, 1, 1],
      affine: [[dx, 0, 0, 0], [0, -dy, 0, (dims[1] - 1) * dy], [0, 0, dz, 0], [0, 0, 0, 1]],
    },
  });
}

/**
 * Voxel size ratios, x = 1, from a pixel size declared in a unit that is not a length (ImageJ's
 * `unit=pixel`, the app's own uncalibrated outputs) or a plain TIFF's resolution tags. A
 * missing axis is as wide as x.
 */
function relativeSpacing(declared) {
  const dx = declared?.x ?? declared?.y ?? declared?.z;
  if (!dx) return [1, 1, 1];
  return [declared.x ?? dx, declared.y ?? dx, declared.z ?? dx].map((size) => size / dx);
}

/**
 * The layout of a TIFF (a File, read range by range, or an ArrayBuffer) from its headers alone:
 * { dims, spacing, unit }. Calibrated sizes are micrometres, named as the file names them
 * (ImageJ's "micron", OME's "µm"); otherwise the unit is "pixel" and the declared sizes keep
 * their ratios. Hyperstacks with several channels or time points and
 * OME-TIFFs whose planes are in other files are refused.
 */
export async function tiffLayout(source) {
  const { width, height, pages, samplesPerPixel, metadata } = await inspectTiffStack(source, { rgb: "mean" });
  const { kind, sizeZ, pixelSize } = metadata;
  // An OME colour image is one channel with several samples per pixel; a plain TIFF's pages are slices.
  const channels = kind === "ome" && metadata.sizeC === samplesPerPixel ? 1 : metadata.sizeC;
  const sizeT = kind === "baseline" ? 1 : metadata.sizeT;
  if (channels > 1 || sizeT > 1) {
    const parts = [channels > 1 ? `${channels} channels` : null, sizeT > 1 ? `${sizeT} time points` : null].filter(Boolean).join(" and ");
    throw new Error(`This TIFF is a hyperstack with ${parts}. In Fiji, use Image › Duplicate with one channel and one time point, save it as TIFF and load that.`);
  }
  if (kind === "ome" && pages < sizeZ) {
    throw new Error(`This OME-TIFF declares ${sizeZ} planes but holds ${pages}; its other planes are in other files. Save the stack as one TIFF.`);
  }
  if (pixelSize.x !== null) {
    const dx = pixelSize.x;
    return { dims: [width, height, pages], spacing: [dx, pixelSize.y ?? dx, pixelSize.z ?? dx], unit: kind === "imagej" ? "micron" : "\u00b5m" };
  }
  return { dims: [width, height, pages], spacing: relativeSpacing(metadata.declaredSpacing), unit: "pixel" };
}

/**
 * One greyscale image or stack from TIFF bytes: { data: Float64Array, dims, spacing, unit }.
 * Colour pages become the mean of their channels (ImageJ's RGB to 8-bit conversion).
 */
export async function readTiff(buffer) {
  const layout = await tiffLayout(buffer);
  const { data } = await readTiffStack(buffer, { rgb: "mean", Type: Float64Array, maxBytes: Infinity });
  return { data, ...layout };
}

/**
 * A little-endian TIFF ArrayBuffer of float32 voxels, or of RGB triplets from a Uint8Array
 * (`rgb: true`), one page per z, with an ImageJ stack description and the voxel size.
 */
export function writeTiff({ data, dims, spacing = [1, 1, 1], unit = "pixel", rgb = false }) {
  const [nx, ny, nz] = dims;
  const description = [
    "ImageJ=1.54f",
    `images=${nz}`,
    ...(nz > 1 ? [`slices=${nz}`, `spacing=${spacing[2]}`] : []),
    `unit=${unit === "pixel" ? "pixel" : "micron"}`,
    "",
  ].join("\n");
  const samples = rgb || data instanceof Float32Array ? data : Float32Array.from(data);
  return writeTiffStack({ width: nx, height: ny, data: samples, description, pixelSize: { x: spacing[0], y: spacing[1] }, rgb }).buffer;
}

const readView = async (file, at, length) => new DataView(await file.slice(at, at + length).arrayBuffer());

/**
 * The marker segments of a JPEG before its scan, read with small slices so large APP segments
 * (ICC profiles, EXIF thumbnails) cost no more than their headers. Yields
 * { at, marker, length, view } with `view` the segment's first 12 bytes; stops at the
 * scan, the end of the file or a byte that is not a marker. Segments after the start of
 * frame are yielded too: an APP1 there still carries an orientation decoders apply.
 */
async function* jpegSegments(file) {
  let at = 2;
  while (at + 4 <= file.size) {
    const view = await readView(file, at, 12);
    if (view.getUint8(0) !== 0xff) return;
    const marker = view.getUint8(1);
    // Fill bytes before a marker, and markers without a length (TEM, RSTn).
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return;
    const length = 2 + view.getUint16(2);
    yield { at, marker, length, view };
    at += length;
  }
}

// Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
const isFrameStart = (marker) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

const isJpeg = async (file) => file.size >= 4 && (await readView(file, 0, 2)).getUint16(0) === 0xffd8;

/** Width and height of a PNG (IHDR) or JPEG (first start-of-frame segment) from its header, or null. */
export async function rasterSize(file) {
  const head = await readView(file, 0, 24);
  if (head.byteLength >= 24 && head.getUint32(0) === 0x89504e47) return [head.getUint32(16), head.getUint32(20)];
  if (!(await isJpeg(file))) return null;
  for await (const { marker, view } of jpegSegments(file)) {
    if (isFrameStart(marker)) return view.byteLength < 9 ? null : [view.getUint16(7), view.getUint16(5)];
  }
  return null;
}

const isPng = async (file) => file.size >= 8 && (await readView(file, 0, 4)).getUint32(0) === 0x89504e47;

/** The PNG without its eXIf chunks, read chunk header by chunk header. */
async function withoutPngExif(file) {
  const parts = [];
  let kept = 0;
  for (let at = 8; at + 12 <= file.size; ) {
    const view = await readView(file, at, 8);
    const length = view.getUint32(0);
    const type = view.getUint32(4);
    if (type === 0x65584966) {
      parts.push(file.slice(kept, at));
      kept = at + 12 + length;
    }
    if (type === 0x49454e44) break;
    at += 12 + length;
  }
  return kept ? new Blob([...parts, file.slice(kept)], { type: file.type }) : file;
}

/** The JPEG or PNG without its EXIF metadata, so no decoder can apply its orientation. */
export async function withoutExif(file) {
  if (await isPng(file)) return withoutPngExif(file);
  if (!(await isJpeg(file))) return file;
  const parts = [];
  let kept = 0;
  for await (const { at, marker, length, view } of jpegSegments(file)) {
    const exif = marker === 0xe1 && view.byteLength >= 10 && view.getUint32(4) === 0x45786966 && view.getUint16(8) === 0;
    if (!exif) continue;
    parts.push(file.slice(kept, at));
    kept = at + length;
  }
  return kept ? new Blob([...parts, file.slice(kept)], { type: file.type }) : file;
}

/**
 * Decodes a PNG or JPEG to greyscale on its stored grid (`dims`, from the header): EXIF
 * orientation is ignored, as ImageJ ignores it. A decoder that rotates anyway is refused.
 */
async function readRaster(file, [nx, ny]) {
  const bitmap = await createImageBitmap(await withoutExif(file));
  const { width, height } = bitmap;
  if (width !== nx || height !== ny) {
    bitmap.close();
    throw new Error(`it decodes to ${width} × ${height}, not the ${nx} × ${ny} its header gives (EXIF rotation?). Save it without rotation.`);
  }
  const canvas = new OffscreenCanvas(nx, ny);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data: rgba } = context.getImageData(0, 0, nx, ny);
  const data = new Float64Array(nx * ny);
  for (let i = 0; i < data.length; i++) data[i] = (rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2]) / 3;
  return { data, dims: [nx, ny, 1], spacing: [1, 1, 1], unit: "pixel" };
}

/**
 * One file's kind and dimensions from its header alone, before any voxel array is allocated.
 * Throws a message for the status bar.
 */
async function probe(file) {
  const kind = inputKind(file.name);
  if (!kind) throw new Error(`${file.name} is not a TIFF, NIfTI, PNG or JPEG image.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  try {
    if (kind === "tiff") {
      const layout = await tiffLayout(file);
      return { file, kind, dims: layout.dims };
    }
    if (kind === "nifti") {
      const { dims } = await readNiftiHeader(file);
      const rank = Math.max(1, Math.min(7, dims[0]));
      return { file, kind, dims: Array.from({ length: rank }, (_, k) => Math.max(1, dims[k + 1])) };
    }
    const size = await rasterSize(file);
    if (!size) throw new Error("its header gives no image size");
    return { file, kind, dims: [...size, 1] };
  } catch (error) {
    throw new Error(`${file.name} could not be read: ${error.message}`);
  }
}

/** Decodes a probed file's voxels. */
async function decode({ file, kind, dims }) {
  if (kind === "nifti") {
    const volume = parseNiftiVolume(await decodeNiftiBuffer(await file.arrayBuffer()), { OutputCtor: Float64Array });
    return { data: volume.imageData, dims: volume.dims, spacing: volume.voxelSize, unit: "mm", kind, header: volume.headerBytes };
  }
  let image;
  try {
    // The probe read only headers; pixels come from one read, not one slice per strip.
    image = kind === "tiff" ? await readTiff(await file.arrayBuffer()) : await readRaster(file, dims);
  } catch (error) {
    throw new Error(`${file.name} could not be read: ${error.message}`);
  }
  return { ...image, kind, header: rasterHeader(image.dims, image.spacing) };
}

function refuseNonFinite(name, image) {
  const refusal = nonFiniteRefusal(image);
  if (refusal) throw new Error(`${name}: ${refusal}`);
  return image;
}

/**
 * Reads the chosen files: one image, or several 2D slices of the same size stacked in name order
 * (ImageJ's image sequence) with cubic voxels of the first slice's pixel size.
 * Every file's dimensions are read from its header, and the total checked against the voxel
 * limit, before any voxels are decoded. Returns { name, image }; throws a message for the
 * status bar when they are not usable.
 */
export async function readImages(files) {
  const sorted = files.length === 1 ? files : [...files].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const probed = [];
  for (const file of sorted) probed.push(await probe(file));
  if (probed.length > 1) {
    for (const slice of probed) {
      if (slice.kind === "nifti" || slice.dims[2] !== 1) throw new Error("Choose one image, or several 2D TIFF, PNG or JPEG slices of one stack.");
      if (slice.dims[0] !== probed[0].dims[0] || slice.dims[1] !== probed[0].dims[1]) {
        throw new Error(`${slice.file.name} is ${slice.dims[0]} × ${slice.dims[1]}; every slice must match ${sorted[0].name}.`);
      }
    }
  }
  const tooLarge = voxelRefusal([...probed[0].dims.slice(0, 2), probed.reduce((count, slice) => count + slice.dims.slice(2).reduce((a, b) => a * b, 1), 0)]);
  if (tooLarge) throw new Error(`${sorted[0].name}: ${tooLarge}`);
  if (probed.length === 1) return { name: sorted[0].name, image: refuseNonFinite(sorted[0].name, await decode(probed[0])) };
  const [nx, ny] = probed[0].dims;
  const data = new Float64Array(nx * ny * probed.length);
  let first;
  for (const [z, slice] of probed.entries()) {
    const image = refuseNonFinite(slice.file.name, await decode(slice));
    first ??= image;
    data.set(image.data, z * nx * ny);
  }
  const dims = [nx, ny, probed.length];
  const spacing = [first.spacing[0], first.spacing[1], first.spacing[0]];
  const image = { data, dims, spacing, unit: first.unit, kind: "tiff" };
  return { name: sorted[0].name, image: { ...image, header: rasterHeader(dims, spacing) } };
}

/** A NIfTI file of float32 voxels on the image's grid, for the viewer. */
export function niftiFile(values, image, name, dims = image.dims) {
  return new File([createNiftiFromData(Float32Array.from(values), image.header, { dims, range: "auto", clampCalMax: false })], name);
}

/** An RGB24 NIfTI file on the image's grid, for the viewer. */
export function rgbNiftiFile(rgb, image, name) {
  return new File([createRgb24Nifti(rgb, image.header, image.dims)], name);
}

async function pngFile(rgb, [nx, ny], name) {
  const canvas = new OffscreenCanvas(nx, ny);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(nx, ny);
  for (let i = 0; i < nx * ny; i++) {
    pixels.data.set(rgb.subarray(3 * i, 3 * i + 3), 4 * i);
    pixels.data[4 * i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return new File([await canvas.convertToBlob({ type: "image/png" })], name, { type: "image/png" });
}

/**
 * The downloads and viewer images of one result. Maps are TIFF for TIFF, PNG and JPEG input
 * and gzipped NIfTI for NIfTI input; the viewer always gets NIfTI.
 */
export async function buildOutputs({ name, image, settings, result, signal }) {
  const mapFormat = image.kind === "nifti" ? "nifti" : "tiff";
  const plan = outputPlan(name, result.dimensions, mapFormat);
  const outputs = {};
  const add = (key, file, view = null) => {
    const [, description] = plan[key];
    outputs[key] = { description, file, view, viewable: Boolean(view) };
  };
  const writeMap = async (key, values) => {
    const [fileName] = plan[key];
    const view = niftiFile(values, image, fileName.replace(/\.(tif|nii\.gz)$/, ".nii"));
    const file = mapFormat === "nifti"
      ? await gzipFile(await view.arrayBuffer(), fileName, signal)
      : new File([writeTiff({ data: values, dims: image.dims, spacing: image.spacing, unit: image.unit })], fileName, { type: "image/tiff" });
    add(key, file, { file: view, ...displayOf(key) });
  };
  for (const key of result.dimensions === 2 ? ["orientation", "coherency", "energy"] : ["azimuth", "elevation", "coherency", "energy"]) {
    await writeMap(key, result.maps[key]);
  }
  if (result.dimensions === 2) {
    const colourView = rgbNiftiFile(result.colour, image, plan.colour[0].replace(/\.png$/, ".nii"));
    add("colour", await pngFile(result.colour, image.dims, plan.colour[0]), { file: colourView, rgb: true });
  } else {
    const [colourName] = plan.colour;
    const colourView = rgbNiftiFile(result.colour, image, colourName.replace(/\.(tif|nii\.gz)$/, ".nii"));
    const colourFile = mapFormat === "nifti"
      ? await gzipFile(await colourView.arrayBuffer(), colourName, signal)
      : new File([writeTiff({ data: result.colour, dims: image.dims, spacing: image.spacing, unit: image.unit, rgb: true })], colourName, { type: "image/tiff" });
    add("colour", colourFile, { file: colourView, rgb: true });
    const vectors = niftiFile(frameMajor(result.maps.vectors), image, "vectors.nii", [...image.dims, 3]);
    add("vectors", await gzipFile(await vectors.arrayBuffer(), plan.vectors[0], signal));
  }
  add("distribution", new File([distributionCsv(result.distributions)], plan.distribution[0], { type: "text/csv" }));
  const report = summary({ input: name, dims: image.dims, spacing: image.spacing, unit: image.unit, settings, dominant: result.dominant, distributions: result.distributions });
  add("summary", new File([`${JSON.stringify(report, null, 2)}\n`], plan.summary[0], { type: "application/json" }));
  return { outputs, report };
}

/** Interleaved x, y, z per voxel to three frames, the NIfTI vector layout. */
function frameMajor(vectors) {
  const n = vectors.length / 3;
  const frames = new Float32Array(vectors.length);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) frames[k * n + i] = vectors[3 * i + k];
  return frames;
}

/** How the viewer shows each map: a circular hue for angles, a sequential map for magnitudes. */
function displayOf(key) {
  if (key === "orientation" || key === "azimuth") return { colormap: "hsv", range: [-90, 90] };
  if (key === "elevation") return { colormap: "hsv", range: [-90, 90] };
  if (key === "coherency") return { colormap: "viridis", range: [0, 1] };
  return { colormap: "inferno" };
}
