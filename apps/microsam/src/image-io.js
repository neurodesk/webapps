// 2D images and 3D Z-stacks (TIFF, OME-TIFF, ImageJ TIFF, PNG) and the channels the model sees.
// DOM-free so Node tests can use it.
import { omePageChannels, openTiffPlanes, parseImagejDescription, parseOmeDescription } from "@neurodesk/webapp-components/file-io/tiff";
import { convertIndexedToRgb, decode as decodePng } from "fast-png";

/**
 * The largest 2D plane the app segments: 4096 × 4096 pixels (16 megapixels) per plane. The display
 * keeps two canvases of that size, inside Safari's canvas area limit, and the planes, labels and
 * overlays stay within a tab's memory.
 */
export const MAX_SIDE = 4096;
export const MAX_PIXELS = MAX_SIDE * MAX_SIDE;
/** The most decoded sample bytes a file may hold across the planes it keeps, checked before decoding. */
export const MAX_DECODED_BYTES = 2 ** 30;
const MIN_SIZE = 8;
const MAX_PLANES = 512;
const RGB = ["red", "green", "blue"];

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isTiff(bytes) {
  return (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
}

function checkSize(name, width, height) {
  if (!width || !height) throw new Error(`${name} has no pixels.`);
  if (width < MIN_SIZE || height < MIN_SIZE) throw new Error(`${name} is ${width} × ${height}; segment images of at least ${MIN_SIZE} × ${MIN_SIZE} pixels.`);
  if (width * height > MAX_PIXELS) throw new Error(`${name} is ${width} × ${height}; split images over ${MAX_PIXELS / 2 ** 20} megapixels (${MAX_SIDE} × ${MAX_SIDE}) into tiles first.`);
}

function omeChannelLabels(ome, count) {
  return Array.from({ length: count }, (_, c) => ome.channels?.[c]?.name || `Channel ${c + 1}`);
}

/**
 * Maps pages of an OME-TIFF Z-stack (`sizeZ > 1`, `sizeT === 1`) to `(c, z)` indices in
 * `pageMap[z][c]`. Follows `DimensionOrder` and any explicit `TiffData` mapping.
 */
function omeStackLayout(name, ome, ifds) {
  const pages = ifds.length;
  const sizeZ = ome.sizeZ;
  const sizeC = Math.max(1, ome.sizeC || 1);
  if (pages !== sizeZ * sizeC && pages !== sizeZ) {
    throw new Error(`${name} declares ${sizeZ} Z-slices × ${sizeC} channels but holds ${pages} pages.`);
  }
  const effectiveC = pages === sizeZ ? 1 : sizeC;
  const order = String(ome.dimensionOrder || "XYZCT").slice(2);
  const byIfd = new Map(ifds.map((ifd, pageIndex) => [ifd, pageIndex]));
  const pageMap = Array.from({ length: sizeZ }, () => new Array(effectiveC).fill(-1));
  if (ome.tiffData?.length) {
    const fileUuid = ome.uuid ?? ome.tiffData[0].uuid;
    for (const block of ome.tiffData) {
      if (block.uuid && block.uuid !== fileUuid) throw new Error(`${name} keeps planes in another file.`);
      const firstC = block.FirstC == null ? 0 : Number(block.FirstC);
      const firstZ = block.FirstZ == null ? 0 : Number(block.FirstZ);
      const firstT = block.FirstT == null ? 0 : Number(block.FirstT);
      if (firstT > 0) throw new Error(`${name} maps planes beyond time point 0.`);
      const startIfd = block.IFD == null ? 0 : Number(block.IFD);
      const count = block.PlaneCount == null ? (block.IFD == null ? pages : 1) : Number(block.PlaneCount);
      for (let k = 0; k < count; k++) {
        const pageIndex = byIfd.get(startIfd + k);
        if (pageIndex === undefined) throw new Error(`${name} references missing IFD ${startIfd + k}.`);
        let z = firstZ;
        let c = firstC;
        if (k > 0) {
          if (order.startsWith("ZC")) {
            const lin = firstC * sizeZ + firstZ + k;
            z = lin % sizeZ;
            c = Math.floor(lin / sizeZ);
          } else {
            const lin = firstZ * effectiveC + firstC + k;
            c = lin % effectiveC;
            z = Math.floor(lin / effectiveC);
          }
        }
        if (z < 0 || z >= sizeZ || c < 0 || c >= effectiveC) throw new Error(`${name} maps an out-of-range (C=${c}, Z=${z}) plane.`);
        pageMap[z][c] = pageIndex;
      }
    }
    if (pageMap.some((row) => row.some((idx) => idx < 0))) {
      throw new Error(`${name} has unmapped planes in its OME-XML TiffData.`);
    }
  } else {
    const zFastest = order.startsWith("Z");
    for (let z = 0; z < sizeZ; z++) {
      for (let c = 0; c < effectiveC; c++) {
        pageMap[z][c] = zFastest ? c * sizeZ + z : z * effectiveC + c;
      }
    }
  }
  return {
    format: "OME-TIFF",
    depth: sizeZ,
    sizeC: effectiveC,
    names: effectiveC > 1 ? omeChannelLabels(ome, effectiveC) : null,
    pageMap,
  };
}

/**
 * The plane layout OME-XML or an ImageJ description declares: channel names for 2D images or
 * `(z, c)` page mappings for 3D Z-stacks. Time series (`sizeT > 1`), multiple OME images and
 * TiffData layouts it cannot follow are refused.
 */
export function describedLayout(name, description, ifds) {
  const pages = ifds.length;
  if (!description) return null;
  const ome = parseOmeDescription(description);
  if (ome) {
    if (ome.images > 1) throw new Error(`${name} holds ${ome.images} OME images; save the image to segment on its own.`);
    if (ome.sizeT > 1) {
      throw new Error(`${name} is a time series (${ome.sizeZ} slices, ${ome.sizeT} time points); save one 2D image or 3D Z-stack to segment.`);
    }
    if (ome.sizeZ > 1) return omeStackLayout(name, ome, ifds);
    return { format: "OME-TIFF", depth: 1, names: omePageChannels(name, ome, ifds) };
  }
  const imagej = parseImagejDescription(description);
  if (imagej) {
    if (imagej.sizeT > 1) {
      throw new Error(`${name} is an ImageJ time series; save one 2D image or 3D Z-stack to segment.`);
    }
    if (imagej.sizeZ > 1) {
      const sizeZ = imagej.sizeZ;
      const sizeC = imagej.sizeC && imagej.sizeC * sizeZ === pages ? imagej.sizeC : (pages === sizeZ ? 1 : null);
      if (!sizeC) throw new Error(`${name} declares ${sizeZ} ImageJ Z-slices but holds ${pages} pages.`);
      // ImageJ hyperstacks vary channels fastest, then Z slices.
      const pageMap = Array.from({ length: sizeZ }, (_, z) => Array.from({ length: sizeC }, (_, c) => z * sizeC + c));
      return {
        format: "ImageJ TIFF",
        depth: sizeZ,
        sizeC,
        names: sizeC > 1 ? Array.from({ length: sizeC }, (_, i) => `Channel ${i + 1}`) : null,
        pageMap,
      };
    }
    return { format: "ImageJ TIFF", depth: 1, names: imagej.sizeC === pages && pages > 1 ? Array.from({ length: pages }, (_, i) => `Channel ${i + 1}`) : null };
  }
  return null;
}

async function readTiff(name, buffer) {
  const tiff = await openTiffPlanes(buffer, { pageLimit: MAX_PLANES + 1 });
  const { pages } = tiff;
  if (pages.length > MAX_PLANES) throw new Error(`${name} has more than ${MAX_PLANES} planes; crop the stack to at most ${MAX_PLANES} planes first.`);
  if (!pages.length) throw new Error(`${name} has no image pages.`);
  const { width, height } = pages[0];
  checkSize(name, width, height);
  const layout = describedLayout(name, tiff.description, pages.map((page) => page.ifd));
  if (pages.some((page) => page.width !== width || page.height !== height)) {
    throw new Error(`${name} has pages of different sizes; save the image to segment on its own.`);
  }
  const bytes = tiff.decodedBytes();
  if (bytes > MAX_DECODED_BYTES) {
    throw new Error(`${name} holds ${(bytes / 2 ** 30).toFixed(1)} GB of pixels in ${pages.length} pages; crop or save fewer planes first.`);
  }
  const decodedPages = await tiff.readPlanes();
  if (layout?.depth > 1) {
    const slices = layout.pageMap.map((channelPages) => {
      const slicePlanes = [];
      channelPages.forEach((pageIndex, c) => {
        const samples = decodedPages[pageIndex];
        for (const { kind, data } of samples) {
          const page = layout.names?.[c] ?? "";
          const part = samples.length > 1 ? kind : "";
          slicePlanes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", kind, data });
        }
      });
      return slicePlanes;
    });
    return { width, height, depth: layout.depth, format: layout.format, planes: slices[0], slices };
  }
  const planes = [];
  for (const [index, samples] of decodedPages.entries()) {
    for (const { kind, data } of samples) {
      const page = layout?.names?.[index] ?? (pages.length > 1 ? `Page ${index + 1}` : "");
      const part = samples.length > 1 ? kind : "";
      planes.push({ label: [page, part].filter(Boolean).join(" · ") || "Intensity", kind, data });
    }
  }
  return { width, height, depth: 1, format: layout?.format ?? "TIFF", planes, slices: [planes] };
}

/** PNG samples below 8 bits, packed from the high bit and padded to a byte per row, as bytes. */
function unpackBits(png) {
  const { width, height, depth, data } = png;
  const rowBytes = Math.ceil((width * depth) / 8);
  const mask = (1 << depth) - 1;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = x * depth;
      out[y * width + x] = (data[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
    }
  }
  return out;
}

function readPng(name, buffer) {
  const png = decodePng(new Uint8Array(buffer));
  checkSize(name, png.width, png.height);
  let { data, channels } = png;
  if (png.palette) {
    data = convertIndexedToRgb(png);
    channels = png.palette[0].length;
  } else if (png.depth < 8) {
    data = unpackBits(png);
  }
  const colour = channels >= 3;
  const kept = colour ? 3 : 1;
  const planes = [];
  for (let c = 0; c < kept; c++) {
    const plane = new data.constructor(png.width * png.height);
    for (let i = 0; i < plane.length; i++) plane[i] = data[i * channels + c];
    planes.push({ label: colour ? RGB[c] : "Intensity", kind: colour ? RGB[c] : "sample 1", data: plane });
  }
  return { width: png.width, height: png.height, depth: 1, format: "PNG", planes, slices: [planes] };
}

/**
 * Reads a 2D image or 3D Z-stack into its planes: TIFF pages and samples, OME-TIFF or ImageJ
 * channels/slices, or PNG channels (alpha left out). Every plane is width × height values of the
 * file's type. `depth` is 1 for 2D images and `sizeZ` for 3D Z-stacks; `slices[z]` holds slice `z`.
 */
export async function readImage(name, buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (isPng(bytes)) return readPng(name, buffer);
  if (isTiff(bytes)) return readTiff(name, buffer);
  throw new Error(`${name} is not a TIFF, OME-TIFF or PNG image.`);
}

/**
 * What the model sees for a choice of channel: one plane (replicated to three channels, as
 * micro-sam does for greyscale), or the image's red, green and blue planes together.
 * `planesAt(z)` returns the selected planes for Z-slice `z`.
 */
export function channelChoices(image) {
  const slices = image.slices ?? [image.planes];
  const choices = image.planes.map((plane, index) => ({
    id: String(index),
    label: plane.label,
    planes: [plane],
    planesAt: (z = 0) => [slices[z][index]],
  }));
  const rgbIndices = RGB.map((kind) => image.planes.findIndex((plane) => plane.kind === kind));
  if (rgbIndices.every((index) => index >= 0)) {
    choices.unshift({
      id: "rgb",
      label: "Colour (RGB)",
      planes: rgbIndices.map((index) => image.planes[index]),
      planesAt: (z = 0) => rgbIndices.map((index) => slices[z][index]),
    });
  }
  return choices;
}
