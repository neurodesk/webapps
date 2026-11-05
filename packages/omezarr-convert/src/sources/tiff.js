// TIFF sources. OME-TIFF goes through fiff, which maps OME-XML's DimensionOrder and TiffData
// to (t, c, z) planes; other TIFFs (plain page stacks, ImageJ hyperstacks, RGB) through the
// shared page reader (openTiffPages) in @neurodesk/webapp-components/file-io/tiff.
import { TiffStore } from "@fideus-labs/fiff";
import * as zarr from "zarrita";
import { decodeXml, omeXml, openTiffPages } from "@neurodesk/webapp-components/file-io/tiff";
import { ngffUnit } from "../units.js";
import { CHANNEL_COLOURS, imageStem, rgbaColour } from "./source.js";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const SAMPLE_COLOURS = { red: CHANNEL_COLOURS.red, green: CHANNEL_COLOURS.green, blue: CHANNEL_COLOURS.blue };

// fiff reads the description from the first directory; give it the canonical OME-XML.
function withDescription(tiff, first, xml) {
  const directory = new Proxy(first.fileDirectory, {
    get(target, key) {
      if (key === "loadValue") return (tag) => (tag === "ImageDescription" ? Promise.resolve(xml) : target.loadValue(tag));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const image = new Proxy(first, {
    get(target, key) {
      if (key === "fileDirectory") return directory;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(tiff, {
    get(target, key) {
      if (key === "getImage") return async (index = 0) => (index === 0 ? image : target.getImage(index));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function omeTiffSource(file, stack) {
  const tiff = stack.tiff;
  const xml = omeXml(stack.description);
  const fileName = file.name ?? "";
  const store = await TiffStore.fromGeoTIFF(withDescription(tiff, await tiff.getImage(0), xml));
  const images = store.ome ?? [];
  if (!images.length) throw new Error("The OME-XML in this TIFF has no Image.");
  const pixels = images[0].pixels;
  const others = new Set(pixels.tiffData.map((entry) => entry.fileName).filter((name) => name && name !== fileName));
  if (others.size) throw new Error(`This OME-TIFF is one file of a multi-file dataset (${[...others][0]} holds other planes); convert a single-file OME-TIFF.`);
  const names = store.dimensionNames;
  const shape0 = store.getShape(0);
  const size = (axis) => (names.includes(axis) ? shape0[names.indexOf(axis)] : 1);
  const shape = { t: size("t"), c: size("c"), z: size("z"), y: size("y"), x: size("x") };
  if (shape.c !== pixels.sizeC || shape.z !== pixels.sizeZ || shape.t !== pixels.sizeT) {
    throw new Error("fiff could not map every OME plane in this file; convert a single-file OME-TIFF.");
  }
  const group = await zarr.open(store, { kind: "group" });
  const array = await zarr.open(group.resolve("0"), { kind: "array" });
  const unit = (symbol) => (symbol === undefined ? "micrometer" : ngffUnit(symbol));
  const physical = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  const notes = [];
  if (images.length > 1) notes.push(`The OME-TIFF holds ${images.length} images; the first, ${images[0].name ?? images[0].id}, is converted.`);
  if (store.levels > 1) notes.push(`The file's own ${store.levels - 1} reduced resolutions are recomputed, not copied.`);
  if (pixels.channels.some((channel) => channel.samplesPerPixel > 1)) throw new Error("OME channels with several samples per pixel (RGB channels) are not supported.");
  const scale = { t: null, z: physical(pixels.physicalSizeZ), y: physical(pixels.physicalSizeY), x: physical(pixels.physicalSizeX) };
  return {
    // fiff returns attribute text as written; names may hold character references.
    name: images[0].name ? decodeXml(images[0].name) : imageStem(fileName),
    format: "OME-TIFF",
    dtype: store.dataType,
    shape,
    scale,
    units: {
      t: null,
      z: scale.z ? unit(pixels.physicalSizeZUnit) : null,
      y: scale.y ? unit(pixels.physicalSizeYUnit) : null,
      x: scale.x ? unit(pixels.physicalSizeXUnit) : null,
    },
    channels: Array.from({ length: shape.c }, (_, index) => ({
      label: pixels.channels[index]?.name ? decodeXml(pixels.channels[index].name) : null,
      color: rgbaColour(pixels.channels[index]?.color),
    })),
    notes,
    async readPlane(t, c, z, { signal: planeSignal } = {}) {
      const index = { t, c, z };
      const selection = names.map((axis) => (axis in index ? index[axis] : null));
      const chunk = await zarr.get(array, selection, { opts: { signal: planeSignal } });
      return chunk.data;
    },
  };
}

// The shared reader gives ImageJ's calibration in micrometres and seconds (null where absent).
function imagejCalibration({ pixelSize, frameInterval }) {
  const unit = (value) => (value ? "micrometer" : null);
  return {
    scale: { t: frameInterval, z: pixelSize.z, y: pixelSize.y, x: pixelSize.x },
    units: { t: frameInterval ? "second" : null, z: unit(pixelSize.z), y: unit(pixelSize.y), x: unit(pixelSize.x) },
  };
}

// A plain TIFF's resolution is pixels per centimetre or inch. Centimetres are a calibration;
// inches are a print density (72 or 300 dpi), so they are not read as a pixel size.
function tiffCalibration(stack, notes) {
  const resolution = stack.resolution;
  if (resolution?.unit === "centimeter") {
    return { scale: { t: null, z: null, y: 1e4 / resolution.y, x: 1e4 / resolution.x }, units: { t: null, z: null, y: "micrometer", x: "micrometer" } };
  }
  if (resolution?.unit === "inch") notes.push(`The TIFF resolution (${resolution.x} dpi) is a print density, not a pixel size; set the pixel size.`);
  return { scale: { t: null, z: null, y: null, x: null }, units: { t: null, z: null, y: null, x: null } };
}

async function stackSource(file, stack) {
  const notes = [];
  const samples = stack.sampleRoles.map((role, sample) => ({ role, sample })).filter(({ role }) => role !== "alpha");
  if (samples.length < stack.sampleRoles.length) notes.push("The alpha sample is transparency, not intensity, and is left out.");
  const ij = stack.metadata?.kind === "imagej" ? stack.metadata : null;
  const hyper = ij && ij.sizeC * ij.sizeZ * ij.sizeT === stack.pageCount ? ij : null;
  if (ij && !hyper) notes.push(`The ImageJ description (${ij.sizeC} channels × ${ij.sizeZ} slices × ${ij.sizeT} frames) does not match the ${stack.pageCount} pages; pages are read as Z.`);
  const pageChannels = hyper?.sizeC ?? 1;
  const slices = hyper?.sizeZ ?? stack.pageCount;
  const frames = hyper?.sizeT ?? 1;
  const { scale, units } = ij ? imagejCalibration(ij) : tiffCalibration(stack, notes);
  const channels = [];
  for (let pageChannel = 0; pageChannel < pageChannels; pageChannel += 1) {
    for (const { role } of samples) {
      const rgb = role !== "value";
      channels.push({ label: rgb ? role[0].toUpperCase() + role.slice(1) : null, color: rgb ? SAMPLE_COLOURS[role] : null });
    }
  }
  let cached = null;
  return {
    name: imageStem(file.name ?? "image"),
    format: hyper ? "ImageJ TIFF" : "TIFF",
    dtype: stack.dtype,
    shape: { t: frames, c: channels.length, z: slices, y: stack.height, x: stack.width },
    scale,
    units,
    channels,
    notes,
    // ImageJ stores pages channel fastest, then slice, then frame.
    async readPlane(t, c, z, { signal } = {}) {
      const pageChannel = Math.floor(c / samples.length);
      const page = (t * slices + z) * pageChannels + pageChannel;
      if (cached?.page !== page) cached = { page, planes: await stack.readPage(page, { signal }) };
      return cached.planes[samples[c % samples.length].sample];
    },
  };
}

/** A TIFF or OME-TIFF file (a File, Blob or ArrayBuffer with a `name`) as a source. */
export async function openTiffSource(file, { signal } = {}) {
  const stack = await openTiffPages(file, { signal });
  return stack.ome ? omeTiffSource(file, stack) : stackSource(file, stack);
}

/** Single-page TIFF files, one per Z plane in natural name order, as one source. */
export async function openTiffSequence(files, { signal } = {}) {
  const ordered = [...files].sort((a, b) => collator.compare(a.name, b.name));
  const stacks = new Map();
  const open = async (index) => {
    if (!stacks.has(index)) stacks.set(index, await openTiffPages(ordered[index], { signal }));
    return stacks.get(index);
  };
  const first = await open(0);
  const source = await stackSource(ordered[0], first);
  if (first.pageCount !== 1 || source.shape.t !== 1) throw new Error(`${ordered[0].name} has ${first.pageCount} pages; a TIFF sequence is one page per file. Convert multi-page TIFFs one at a time.`);
  const samples = first.sampleRoles.map((role, sample) => ({ role, sample })).filter(({ role }) => role !== "alpha");
  let cached = null;
  return {
    ...source,
    name: source.name.replace(/[_\-. ]*\d+$/, "") || source.name,
    format: "TIFF sequence",
    shape: { ...source.shape, z: ordered.length },
    files: ordered.map((file) => file.name),
    async readPlane(_t, c, z, { signal: planeSignal } = {}) {
      if (cached?.z !== z) {
        const stack = z === 0 ? first : await open(z);
        stacks.delete(z);
        for (const key of ["width", "height", "dtype", "samplesPerPixel", "pageCount"]) {
          if (stack[key] !== first[key]) throw new Error(`${ordered[z].name} differs from ${ordered[0].name} in ${key}; a sequence needs equal images.`);
        }
        cached = { z, planes: await stack.readPage(0, { signal: planeSignal }) };
      }
      return cached.planes[samples[c].sample];
    },
  };
}
