// One-channel TIFF stack (one page per z plane) read with geotiff, plus the voxel
// size in nanometres when ImageJ or OME metadata records it.
import { fromArrayBuffer } from "geotiff";
import { checkSize } from "./config.js";

const UNIT_NM = { nm: 1, nanometer: 1, nanometre: 1, µm: 1000, um: 1000, micron: 1000, microns: 1000, micrometer: 1000, micrometre: 1000, mm: 1e6, millimeter: 1e6 };
const TYPES = { "1:8": "uint8", "1:16": "uint16", "3:32": "float32", "3:64": "float64" };

function unitScale(unit) {
  if (!unit) return null;
  return UNIT_NM[unit.trim().toLowerCase().replace("\\u00b5", "µ").replace("μ", "µ")] ?? null;
}

// ImageJ: "spacing=0.3 unit=micron" in the description, x/y from the resolution tags.
function imagejVoxelSize(description, resolution) {
  const field = (name) => description.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  if (Number(field("channels") ?? 1) > 1 || Number(field("frames") ?? 1) > 1) {
    throw new Error("This TIFF holds several channels or time points; save one channel as its own stack.");
  }
  const scale = unitScale(field("unit"));
  if (!scale) return null;
  const spacing = Number(field("spacing"));
  const [x, y] = resolution.map((r) => (r ? 1 / r : NaN));
  return { z: Number.isFinite(spacing) ? spacing * scale : null, y: Number.isFinite(y) ? y * scale : null, x: Number.isFinite(x) ? x * scale : null };
}

// OME elements may carry any namespace prefix (<OME>, <ome:OME>, <ome:Pixels>).
const OME_ROOT = /<(?:[\w.-]+:)?OME[\s>/]/;

function omeVoxelSize(description) {
  const pixels = description.match(/<(?:[\w.-]+:)?Pixels\b[^>]*>/)?.[0];
  if (!pixels) return null;
  const attribute = (name) => pixels.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  if (Number(attribute("SizeC") ?? 1) > 1 || Number(attribute("SizeT") ?? 1) > 1) {
    throw new Error("This OME-TIFF holds several channels or time points; save one channel as its own stack.");
  }
  const size = (axis) => {
    const value = Number(attribute(`PhysicalSize${axis}`));
    const scale = unitScale(attribute(`PhysicalSize${axis}Unit`) ?? "µm");
    return Number.isFinite(value) && scale ? value * scale : null;
  };
  return { z: size("Z"), y: size("Y"), x: size("X") };
}

export async function readTiffStack(buffer, { signal } = {}) {
  const tiff = await fromArrayBuffer(buffer);
  const count = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const width = first.getWidth();
  const height = first.getHeight();
  if (first.getSamplesPerPixel() !== 1) throw new Error("Spot detection needs a one-channel greyscale TIFF, not RGB or multi-sample.");
  const dtype = TYPES[`${first.getSampleFormat()}:${first.getBitsPerSample()}`];
  if (!dtype) throw new Error(`TIFF sample type ${first.getSampleFormat()}:${first.getBitsPerSample()} is not uint8, uint16, float32 or float64.`);
  const description = String((await first.fileDirectory.loadValue("ImageDescription")) ?? "");
  const resolution = [first.fileDirectory.getValue("XResolution"), first.fileDirectory.getValue("YResolution")].map((r) => (Array.isArray(r) || ArrayBuffer.isView(r) ? r[0] / r[1] : r));
  const voxelSize = OME_ROOT.test(description) ? omeVoxelSize(description) : description.startsWith("ImageJ=") ? imagejVoxelSize(description, resolution) : null;
  const shape = count > 1 ? [count, height, width] : [height, width];
  checkSize(shape, dtype);
  const Data = { uint8: Uint8Array, uint16: Uint16Array, float32: Float32Array, float64: Float64Array }[dtype];
  const data = new Data(count * width * height);
  for (let page = 0; page < count; page++) {
    signal?.throwIfAborted();
    const image = page === 0 ? first : await tiff.getImage(page);
    if (image.getWidth() !== width || image.getHeight() !== height || image.getSamplesPerPixel() !== 1) {
      throw new Error("Every TIFF page must be one plane of the same size.");
    }
    const [plane] = await image.readRasters({ signal });
    data.set(plane, page * width * height);
  }
  return { data, shape, dtype, voxelSize };
}
