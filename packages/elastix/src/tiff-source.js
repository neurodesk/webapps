import { TiffStore } from "@fideus-labs/fiff";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { fromArrayBuffer, fromBlob, fromUrl, GeoTIFFImage } from "geotiff";
import { normalizeSpatialUnits } from "./outputs.js";

const OME_NAMESPACE = "http://www.openmicroscopy.org/Schemas/OME/2016-06";
const AXES = ["X", "Y", "Z"];
const DIMENSION_ORDERS = new Set(["XYZCT", "XYZTC", "XYCTZ", "XYCZT", "XYTCZ", "XYTZC"]);
const TYPES = { uint8: "uint8", int8: "int8", uint16: "uint16", int16: "int16", uint32: "uint32", int32: "int32", float: "float32", double: "float64" };
const TIFF_TYPES = { uint8: [1, 8], int8: [2, 8], uint16: [1, 16], int16: [2, 16], uint32: [1, 32], int32: [2, 32], float32: [3, 32], float64: [3, 64] };
const children = (node, name) => Array.from(node.childNodes).filter((child) => child.namespaceURI === OME_NAMESPACE && child.localName === name);
const number = (text) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim()) ? Number(text) : NaN;
const integer = (node, name, fallback) => node.hasAttribute(name) ? (/^\d+$/.test(node.getAttribute(name)) ? Number(node.getAttribute(name)) : NaN) : fallback;
const refusal = (reason) => ({ issue: `OME-TIFF ${reason}. Use NIfTI or OME-Zarr.` });

function originalMetadata(xml) {
  if (typeof xml !== "string") return null;
  let invalid = false;
  const document = new DOMParser({ errorHandler: () => { invalid = true; } }).parseFromString(xml.replace(/\0+$/, ""), "application/xml");
  const root = document.documentElement;
  if (invalid || root?.namespaceURI !== OME_NAMESPACE || root.localName !== "OME") return null;
  const images = children(root, "Image").map((image) => ({ image, pixels: children(image, "Pixels") }));
  if (!images.length || images.some(({ pixels }) => pixels.length !== 1)) return null;

  // fiff 0.8.2 only understands unprefixed tags and double-quoted attributes.
  // Serialize the same XML values for its decoder; retain the original DOM for validation.
  const canonical = document.implementation.createDocument(OME_NAMESPACE, "OME", null);
  function copy(source, target) {
    for (const attribute of Array.from(source.attributes)) {
      if (!attribute.namespaceURI) target.setAttribute(attribute.name, attribute.value);
    }
    for (const name of ["Image", "Pixels", "Channel", "TiffData", "UUID"]) {
      for (const child of children(source, name)) {
        const element = canonical.createElementNS(OME_NAMESPACE, name);
        copy(child, element);
        if (name === "UUID") element.appendChild(canonical.createTextNode(child.textContent));
        target.appendChild(element);
      }
    }
  }
  copy(root, canonical.documentElement);
  return { images: images.map(({ image, pixels }) => ({ image, pixels: pixels[0] })), xml: new XMLSerializer().serializeToString(canonical) };
}

function withDescription(tiff, first, xml) {
  const directory = new Proxy(first.fileDirectory, {
    get(target, key) {
      if (key === "loadValue") return (tag) => tag === "ImageDescription" ? Promise.resolve(xml) : target.loadValue(tag);
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
      if (key === "getImage") return async (index = 0) => index === 0 ? image : target.getImage(index);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function planeIfds(pixels, imageCount) {
  const depth = integer(pixels, "SizeZ", NaN);
  if (!Number.isSafeInteger(depth) || depth < 1 || integer(pixels, "SizeC", NaN) !== 1 || integer(pixels, "SizeT", NaN) !== 1 || !DIMENSION_ORDERS.has(pixels.getAttribute("DimensionOrder"))) return null;
  const entries = children(pixels, "TiffData");
  if (!entries.length) return null;
  const ifds = Array(depth);
  for (const entry of entries) {
    if (children(entry, "UUID").length || integer(entry, "FirstC", 0) !== 0 || integer(entry, "FirstT", 0) !== 0) return null;
    const start = integer(entry, "IFD", 0);
    const z = integer(entry, "FirstZ", 0);
    const count = integer(entry, "PlaneCount", entry.hasAttribute("IFD") ? 1 : imageCount);
    if (![start, z, count].every(Number.isSafeInteger) || start < 0 || z < 0 || count < 1 || z + count > depth || start + count > imageCount) return null;
    for (let plane = 0; plane < count; plane += 1) {
      if (ifds[z + plane] !== undefined) return null;
      ifds[z + plane] = start + plane;
    }
  }
  return ifds.includes(undefined) ? null : ifds;
}

async function selectedMetadata(tiff, store, original, index) {
  if (!original) return refusal("needs valid original OME XML calibration");
  const firstPixels = original.images[0].pixels;
  const basePlanes = integer(firstPixels, "SizeZ", NaN);
  if (!Number.isSafeInteger(basePlanes) || basePlanes < 1 || integer(firstPixels, "SizeC", NaN) !== 1 || integer(firstPixels, "SizeT", NaN) !== 1 || children(firstPixels, "TiffData").some((entry) => children(entry, "UUID").length)) {
    return refusal("cannot unambiguously associate the selected OME Image");
  }
  const pyramid = store.pyramidInfo;
  const subIfdLevel = pyramid.usesSubIfds ? index : 0;
  // The pinned decoder's flat path offsets each level by the first Image's plane count.
  const ifds = Array.from({ length: basePlanes }, (_, z) => z + (subIfdLevel ? 0 : index * basePlanes));
  const imageCount = await tiff.getImageCount();
  const candidates = original.images.filter(({ pixels }) => {
    const mapped = planeIfds(pixels, imageCount);
    return mapped?.length === ifds.length && mapped.every((ifd, z) => ifd === ifds[z]);
  });
  if (candidates.length !== 1) return refusal("cannot unambiguously associate the selected OME Image");
  const { image, pixels } = candidates[0];
  const dimensions = AXES.map((axis) => integer(pixels, `Size${axis}`, axis === "Z" ? 1 : NaN));
  if (dimensions.some((size) => !Number.isSafeInteger(size) || size < 1) || TYPES[pixels.getAttribute("Type")] !== store.dataType) {
    return refusal("cannot match the OME Image dimensions or pixel type");
  }
  let width, height;
  for (const ifd of ifds) {
    const base = await tiff.getImage(ifd);
    if (base.getWidth() !== dimensions[0] || base.getHeight() !== dimensions[1]) return refusal("cannot match the OME Image to its TIFF directories");
    let selected = base;
    if (subIfdLevel) {
      if (!base.fileDirectory.hasTag("SubIFDs")) return refusal("cannot verify the selected SubIFD");
      const offsets = Array.from(await base.fileDirectory.loadValue("SubIFDs"));
      const offset = offsets[subIfdLevel - 1];
      if (offset === undefined) return refusal("cannot verify the selected SubIFD");
      const directory = await tiff.parser.parseFileDirectoryAt(offset);
      selected = new GeoTIFFImage(directory, tiff.littleEndian, tiff.cache, tiff.source);
      if (!selected.fileDirectory.hasTag("NewSubfileType") || !(Number(await selected.fileDirectory.loadValue("NewSubfileType")) & 1)
        || selected.getWidth() > dimensions[0] || selected.getHeight() > dimensions[1]) return refusal("cannot verify a reduced-resolution SubIFD");
    }
    if (selected.getWidth() !== pyramid.widths[index] || selected.getHeight() !== pyramid.heights[index]) return refusal("cannot match the decoded grid to its TIFF directory");
    const [sampleFormat, bitsPerSample] = TIFF_TYPES[store.dataType];
    if (selected.getSamplesPerPixel() !== 1 || selected.getSampleFormat() !== sampleFormat || selected.getBitsPerSample() !== bitsPerSample) return refusal("cannot match the selected TIFF directory pixel type");
    width = selected.getWidth();
    height = selected.getHeight();
  }
  const physicalSizes = Object.fromEntries(AXES.map((axis) => [axis.toLowerCase(), pixels.hasAttribute(`PhysicalSize${axis}`) ? number(pixels.getAttribute(`PhysicalSize${axis}`)) : NaN]));
  const spatialUnits = normalizeSpatialUnits(Object.fromEntries(AXES.map((axis) => [axis.toLowerCase(), pixels.hasAttribute(`PhysicalSize${axis}Unit`) ? pixels.getAttribute(`PhysicalSize${axis}Unit`) : "µm"])));
  const size = dimensions[2] > 1 ? [width, height, dimensions[2]] : [width, height];
  const spacing = [physicalSizes.x * (dimensions[0] / width), physicalSizes.y * (dimensions[1] / height), physicalSizes.z].slice(0, size.length);
  const hasPlanePositions = children(pixels, "Plane").some((plane) => AXES.some((axis) => plane.hasAttribute(`Position${axis}`)));
  const selectionNote = !pyramid.usesSubIfds && original.images.length > 1 ? ` · OME Image ${original.images.indexOf(candidates[0]) + 1} of ${original.images.length}` : null;
  return { imageId: image.getAttribute("ID"), pixelsId: pixels.getAttribute("ID"), ifds, subIfdLevel, physicalSizes, spatialUnits, spacing, size, hasPlanePositions, selectionNote };
}

async function withProvenance(tiff) {
  const first = await tiff.getImage(0);
  const xml = first.fileDirectory.hasTag("ImageDescription") ? await first.fileDirectory.loadValue("ImageDescription") : null;
  const original = originalMetadata(xml);
  const store = await TiffStore.fromGeoTIFF(original ? withDescription(tiff, first, original.xml) : tiff);
  return {
    get: store.get.bind(store),
    tiffMetadataForLevel: async (index) => {
      try {
        return await selectedMetadata(tiff, store, original, index);
      } catch {
        return refusal("cannot verify the TIFF directory and XML calibration");
      }
    },
  };
}

export const TiffSource = {
  fromArrayBuffer: async (buffer) => withProvenance(await fromArrayBuffer(buffer)),
  fromBlob: async (blob) => withProvenance(await fromBlob(blob)),
  fromUrl: async (url) => withProvenance(await fromUrl(url)),
};
