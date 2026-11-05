// Plane-by-plane readers for microscopy volumes: TIFF stacks (one multi-page file or one file per
// plane) and OME-Zarr folders. Each opens the metadata only and returns
//   { kind, name, shape: [z, y, x], dtype, voxelSizeUm: { z, y, x } (entries may be null),
//     readPlane(z) -> Promise<TypedArray of y*x, row-major> }
// so a caller can stream a whole-brain stack without holding it in memory. OME-Zarr sources also
// list their resolution `levels` and take `readPlane(z, level)`.
//
// TIFF decoding is geotiff (MIT); OME-Zarr is zarrita (MIT). Both load on first use.

const PLANE_LIMIT_BYTES = 1024 * 1024 * 1024;
const SLAB_LIMIT_BYTES = 512 * 1024 * 1024;

const DTYPES = {
  '1:8': 'uint8', '1:16': 'uint16', '1:32': 'uint32',
  '2:8': 'int8', '2:16': 'int16', '2:32': 'int32',
  '3:32': 'float32', '3:64': 'float64',
};

const UNIT_TO_UM = new Map([
  ['µm', 1], ['μm', 1], ['um', 1], ['micron', 1], ['microns', 1], ['micrometer', 1], ['micrometre', 1],
  ['nm', 1e-3], ['nanometer', 1e-3], ['nanometre', 1e-3],
  ['mm', 1e3], ['millimeter', 1e3], ['millimetre', 1e3],
  ['cm', 1e4], ['m', 1e6], ['meter', 1e6], ['metre', 1e6],
]);

/**
 * Microns per `unit` (OME, ImageJ and NGFF spellings), or null for an unknown or missing unit:
 * a size without a unit is not assumed to be in microns.
 */
export function micronsPerUnit(unit) {
  if (unit === undefined || unit === null || unit === '') return null;
  const key = String(unit).trim().toLowerCase().replace('\\u00b5', 'µ');
  return UNIT_TO_UM.get(key) ?? UNIT_TO_UM.get(String(unit).trim()) ?? null;
}

const naturalOrder = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const fileName = (file) => file.webkitRelativePath || file._webkitRelativePath || file.name || '';

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? match[1] : undefined;
}

/**
 * Pixel sizes and dimensions from an OME-XML ImageDescription (namespace prefixes allowed), or
 * null when the description is not OME-XML. Sizes are in µm; an absent size is null.
 */
export function parseOmeXml(description) {
  if (typeof description !== 'string' || !/<(?:[\w.-]+:)?OME[\s>]/.test(description)) return null;
  const pixels = /<(?:[\w.-]+:)?Pixels\b[^>]*>/.exec(description);
  if (!pixels) return null;
  const tag = pixels[0];
  const size = (axis) => {
    const value = attribute(tag, `PhysicalSize${axis}`);
    if (value === undefined) return null;
    // The OME schema's default unit is the micrometre.
    const scale = micronsPerUnit(attribute(tag, `PhysicalSize${axis}Unit`) ?? 'µm');
    const number = Number(value);
    return scale === null || !(number > 0) ? null : number * scale;
  };
  const count = (axis) => Number(attribute(tag, `Size${axis}`) ?? 1);
  return {
    voxelSizeUm: { z: size('Z'), y: size('Y'), x: size('X') },
    sizes: { x: count('X'), y: count('Y'), z: count('Z'), c: count('C'), t: count('T') },
    dimensionOrder: attribute(tag, 'DimensionOrder') ?? 'XYZCT',
  };
}

/** ImageJ's `spacing=` and `unit=` (z spacing and unit) from its ImageDescription, else null. */
export function parseImageJDescription(description) {
  if (typeof description !== 'string' || !description.startsWith('ImageJ=')) return null;
  const values = Object.fromEntries(description.split(/\r?\n/).map((line) => line.split('=')).filter((p) => p.length === 2));
  return { spacing: values.spacing === undefined ? null : Number(values.spacing), unit: values.unit ?? null, channels: Number(values.channels ?? 1), frames: Number(values.frames ?? 1) };
}

function rational(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value.length >= 2 && value[1] ? value[0] / value[1] : null;
  return typeof value === 'number' ? value : null;
}

// geotiff's fromBlob needs FileReader, which workers have but Node does not; Blob.slice works in both.
function blobSource(blob) {
  return {
    fileSize: blob.size,
    async fetch(slices) {
      return Promise.all(slices.map(({ offset, length }) => blob.slice(offset, offset + length).arrayBuffer()));
    },
    async close() {},
  };
}

async function tag(image, name) {
  const directory = image.getFileDirectory();
  if (!directory.hasTag(name)) return undefined;
  return directory.loadValue(name);
}

// ExtraSamples values 1 (associated) and 2 (unassociated) are alpha; 0 is an unspecified channel.
const isAlpha = (value) => value === 1 || value === 2;

async function describePage(image, name) {
  const samples = image.getSamplesPerPixel();
  const extra = (await tag(image, 'ExtraSamples')) ?? [];
  const alphaCount = (Array.isArray(extra) || ArrayBuffer.isView(extra) ? [...extra] : [extra]).filter(isAlpha).length;
  const photometric = await tag(image, 'PhotometricInterpretation');
  if (photometric === 3) throw new Error(`${name} is a palette (indexed colour) TIFF; save the channel as greyscale.`);
  if (samples - alphaCount !== 1) {
    throw new Error(`${name} has ${samples} samples per pixel (${photometric === 2 ? 'RGB' : 'several channels'}); save one greyscale channel per stack.`);
  }
  const bits = image.getBitsPerSample(0);
  const format = image.getSampleFormat(0) ?? 1;
  const dtype = DTYPES[`${format}:${bits}`];
  if (!dtype) throw new Error(`${name} uses ${bits}-bit samples of format ${format}, which this reader does not decode.`);
  return { width: image.getWidth(), height: image.getHeight(), dtype, bytes: bits / 8, whiteIsZero: photometric === 0 };
}

function invertWhiteIsZero(data, dtype) {
  const max = { uint8: 255, uint16: 65535, uint32: 4294967295 }[dtype];
  if (max === undefined) throw new Error('A WhiteIsZero TIFF must have unsigned integer samples.');
  for (let i = 0; i < data.length; i++) data[i] = max - data[i];
  return data;
}

/**
 * Open a TIFF stack: one multi-page file, or one single-page file per plane (sorted by name).
 * Refuses palette, RGB and multi-channel pages, OME-TIFF with several channels or time points,
 * and planes larger than `maxPlaneBytes`.
 */
export async function openTiffStack(files, { maxPlaneBytes = PLANE_LIMIT_BYTES } = {}) {
  const list = [...files].filter((file) => /\.tiff?$/i.test(file.name ?? ''));
  if (list.length === 0) throw new Error('Choose a .tif or .tiff file, or a folder of them.');
  list.sort((a, b) => naturalOrder(fileName(a), fileName(b)));
  const { default: GeoTIFF } = await import('geotiff');
  const fromBlob = (blob) => GeoTIFF.fromSource(blobSource(blob));
  const first = await fromBlob(list[0]);
  const firstImage = await first.getImage(0);
  const page = await describePage(firstImage, list[0].name);
  if (page.width * page.height * page.bytes > maxPlaneBytes) {
    throw new Error(`A ${page.width} × ${page.height} ${page.dtype} plane needs more than ${Math.round(maxPlaneBytes / 2 ** 20)} MB; choose a coarser level.`);
  }
  const pageCount = await first.getImageCount();
  const description = await tag(firstImage, 'ImageDescription');
  const ome = parseOmeXml(description);
  const imagej = parseImageJDescription(description);
  if (ome && (ome.sizes.c > 1 || ome.sizes.t > 1)) {
    throw new Error(`${list[0].name} holds ${ome.sizes.c} channels and ${ome.sizes.t} time points; export the channel to analyse as its own stack.`);
  }
  if (imagej && (imagej.channels > 1 || imagej.frames > 1)) {
    throw new Error(`${list[0].name} holds ${imagej.channels} channels and ${imagej.frames} frames; export the channel to analyse as its own stack.`);
  }
  if (list.length > 1 && pageCount > 1) throw new Error('Choose either one multi-page TIFF or one single-page TIFF per plane, not several multi-page files.');

  let voxelSizeUm = { z: null, y: null, x: null };
  if (ome) {
    voxelSizeUm = ome.voxelSizeUm;
  } else {
    const unitScale = imagej ? micronsPerUnit(imagej.unit) : null;
    const xRes = rational(await tag(firstImage, 'XResolution'));
    const yRes = rational(await tag(firstImage, 'YResolution'));
    if (imagej && unitScale !== null) {
      voxelSizeUm = {
        z: imagej.spacing > 0 ? imagej.spacing * unitScale : null,
        y: yRes > 0 ? unitScale / yRes : null,
        x: xRes > 0 ? unitScale / xRes : null,
      };
    }
  }

  const depth = list.length > 1 ? list.length : pageCount;
  const opened = new Map([[0, first]]);
  async function imageAt(z) {
    if (z < 0 || z >= depth || !Number.isInteger(z)) throw new RangeError(`Plane ${z} is outside 0-${depth - 1}.`);
    if (list.length === 1) return { image: await first.getImage(z), name: list[0].name };
    let tiff = opened.get(z);
    if (!tiff) {
      tiff = await fromBlob(list[z]);
      opened.clear();
      opened.set(z, tiff);
    }
    return { image: await tiff.getImage(0), name: list[z].name };
  }
  return {
    kind: 'tiff',
    name: list.length > 1 ? `${list[0].name} … (${list.length} files)` : list[0].name,
    shape: [depth, page.height, page.width],
    dtype: page.dtype,
    voxelSizeUm,
    async readPlane(z) {
      const { image, name } = await imageAt(z);
      const current = await describePage(image, name);
      if (current.width !== page.width || current.height !== page.height || current.dtype !== page.dtype) {
        throw new Error(`${name} plane ${z} is ${current.width} × ${current.height} ${current.dtype}; the stack is ${page.width} × ${page.height} ${page.dtype}.`);
      }
      const [data] = await image.readRasters({ samples: [0] });
      return current.whiteIsZero ? invertWhiteIsZero(data, current.dtype) : data;
    },
  };
}

// --- OME-Zarr -------------------------------------------------------------------------------

class FileMapStore {
  constructor(entries) {
    this.entries = entries;
  }

  async get(key) {
    const file = this.entries.get(key.replace(/^\//, ''));
    return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
  }
}

/** The OME-NGFF multiscales entry from .zattrs (0.4) or zarr.json attributes (0.5). */
export function ngffMultiscales(attributes) {
  const multiscales = attributes?.ome?.multiscales ?? attributes?.multiscales;
  if (!Array.isArray(multiscales) || multiscales.length === 0) throw new Error('The folder is not an OME-Zarr image: its attributes have no multiscales.');
  return multiscales[0];
}

/** The [z, y, x] scale of each dataset, in µm, from NGFF coordinate transformations. */
export function ngffLevels(multiscale) {
  const axes = (multiscale.axes ?? []).map((axis) => (typeof axis === 'string' ? { name: axis } : axis));
  const spatial = ['z', 'y', 'x'].map((name) => axes.findIndex((axis) => axis.name === name));
  if (spatial.some((index) => index < 0)) throw new Error('The OME-Zarr image needs z, y and x axes.');
  const units = spatial.map((index) => micronsPerUnit(axes[index].unit));
  const top = multiscale.coordinateTransformations ?? [];
  const topScale = top.find((t) => t.type === 'scale')?.scale;
  return multiscale.datasets.map((dataset) => {
    const scale = (dataset.coordinateTransformations ?? []).find((t) => t.type === 'scale')?.scale ?? axes.map(() => 1);
    return {
      path: dataset.path,
      axes: axes.map((axis) => axis.name),
      voxelSizeUm: Object.fromEntries(['z', 'y', 'x'].map((name, i) => {
        const value = scale[spatial[i]] * (topScale ? topScale[spatial[i]] : 1);
        return [name, units[i] === null ? null : value * units[i]];
      })),
    };
  });
}

/**
 * Open an OME-Zarr image from the files of its folder (picked or dropped, with relative paths).
 * Non-spatial axes (t, c) must have length 1, or `channel` picks one channel.
 */
export async function openOmeZarrStack(files, { channel = 0, maxPlaneBytes = PLANE_LIMIT_BYTES, maxSlabBytes = SLAB_LIMIT_BYTES } = {}) {
  const list = [...files];
  const paths = list.map(fileName);
  const marker = paths.map((path) => /(^|\/)(\.zattrs|zarr\.json)$/.exec(path) && path).filter(Boolean)
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!marker) throw new Error('Choose the OME-Zarr folder (it holds .zattrs or zarr.json).');
  const root = marker.slice(0, marker.lastIndexOf('/') + 1);
  const entries = new Map();
  list.forEach((file, i) => {
    if (paths[i].startsWith(root)) entries.set(paths[i].slice(root.length), file);
  });
  const zarr = await import('zarrita');
  const store = new FileMapStore(entries);
  const group = await zarr.open(zarr.root(store), { kind: 'group' });
  const multiscale = ngffMultiscales(group.attrs);
  const levels = ngffLevels(multiscale);
  const arrays = await Promise.all(levels.map((level) => zarr.open(group.resolve(level.path), { kind: 'array' })));
  const axes = levels[0].axes;
  const index = (name) => axes.indexOf(name);
  const described = levels.map((level, i) => {
    const shape = arrays[i].shape;
    return { ...level, shape: ['z', 'y', 'x'].map((name) => shape[index(name)]) };
  });
  for (const name of axes.filter((a) => !['z', 'y', 'x'].includes(a))) {
    const length = arrays[0].shape[index(name)];
    if (name !== 'c' && length !== 1) throw new Error(`The OME-Zarr image has ${length} ${name} points; export one.`);
    if (name === 'c' && (channel < 0 || channel >= length)) throw new Error(`Channel ${channel} is outside 0-${length - 1}.`);
  }
  const dtype = String(arrays[0].dtype);
  const [, height, width] = described[0].shape;
  const bytes = arrays[0].dtype === 'float64' ? 8 : arrays[0].dtype.endsWith('32') ? 4 : arrays[0].dtype.endsWith('16') ? 2 : 1;
  if (height * width * bytes > maxPlaneBytes) throw new Error(`A ${width} × ${height} plane needs more than ${Math.round(maxPlaneBytes / 2 ** 20)} MB.`);
  let slab = null;
  return {
    kind: 'ome-zarr',
    name: root.replace(/\/$/, '') || list[0]?.name || 'OME-Zarr',
    shape: described[0].shape,
    dtype,
    voxelSizeUm: described[0].voxelSizeUm,
    levels: described,
    // Planes are read from the z-chunk slab that holds them, and the last slab is kept, so a
    // chunk several planes deep is decoded once rather than once per plane.
    async readPlane(z, level = 0) {
      const [depth, lh, lw] = described[level].shape;
      if (!Number.isInteger(z) || z < 0 || z >= depth) throw new RangeError(`Plane ${z} is outside 0-${depth - 1}.`);
      const chunkDepth = arrays[level].chunks[index('z')];
      const z0 = Math.floor(z / chunkDepth) * chunkDepth;
      const z1 = Math.min(depth, z0 + chunkDepth);
      const cached = slab && slab.level === level && z >= slab.z0 && z < slab.z1;
      if (!cached) {
        const fits = (z1 - z0) * lh * lw * bytes <= maxSlabBytes;
        const [from, to] = fits ? [z0, z1] : [z, z + 1];
        const selection = axes.map((name) => (name === 'z' ? zarr.slice(from, to) : name === 'c' ? channel : ['y', 'x'].includes(name) ? null : 0));
        slab = { level, z0: from, z1: to, chunk: await zarr.get(arrays[level], selection) };
      }
      const { chunk } = slab;
      const kept = axes.filter((name) => ['z', 'y', 'x'].includes(name));
      const stride = Object.fromEntries(kept.map((name, i) => [name, chunk.stride[i]]));
      const base = (z - slab.z0) * stride.z;
      const out = new chunk.data.constructor(lh * lw);
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) out[y * lw + x] = chunk.data[base + y * stride.y + x * stride.x];
      return out;
    },
  };
}

/** Open a TIFF stack or an OME-Zarr folder from picked or dropped files. */
export async function openMicroscopyStack(files, options = {}) {
  const list = [...files];
  if (list.some((file) => /(^|\/)(\.zattrs|zarr\.json|\.zgroup)$/.test(fileName(file)))) return openOmeZarrStack(list, options);
  return openTiffStack(list, options);
}
