// Plane-by-plane readers for microscopy volumes: TIFF stacks (one multi-page file or one file per
// plane) and OME-Zarr folders. Each opens the metadata only and returns
//   { kind, name, shape: [z, y, x], dtype, voxelSizeUm: { z, y, x } (entries may be null),
//     readPlane(z) -> Promise<TypedArray of y*x, row-major> }
// so a caller can stream a whole-brain stack without holding it in memory. OME-Zarr sources also
// list their resolution `levels` and take `readPlane(z, level)`.
//
// TIFF stacks are read through the shared greyscale stack reader (`openTiffStackPages`), which
// owns the page, sample, OME TiffData and ImageJ rules; OME-Zarr is zarrita (MIT), loaded on
// first use.
import { isOmeDescription, micrometresPerUnit, openTiffStackPages, readTiffDescription } from './tiff.js';

const PLANE_LIMIT_BYTES = 1024 * 1024 * 1024;
const SLAB_LIMIT_BYTES = 512 * 1024 * 1024;

const naturalOrder = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const fileName = (file) => file.webkitRelativePath || file._webkitRelativePath || file.name || '';

/** Opens one file with the shared reader, naming the file in a refusal. */
async function openNamed(file) {
  try {
    return await openTiffStackPages(file);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new Error(`${file.name}: ${error.message}`, { cause: error });
  }
}

/**
 * Open a TIFF stack: one multi-page file, or one single-page file per plane (sorted by name).
 * A single file's planes are its full-resolution pages, or the pages its OME TiffData maps.
 * Refuses OME-TIFF folders, OME metadata without Pixels, several channels or time points, an
 * OME-TIFF whose page count is not its SizeZ when no TiffData maps them, and planes larger than
 * `maxPlaneBytes`, before any pixel is decoded; the shared reader refuses palette, RGB and
 * multi-channel pages and plane mappings it cannot follow.
 */
export async function openTiffStack(files, { maxPlaneBytes = PLANE_LIMIT_BYTES } = {}) {
  const list = [...files].filter((file) => /\.tiff?$/i.test(file.name ?? ''));
  if (list.length === 0) throw new Error('Choose a .tif or .tiff file, or a folder of them.');
  list.sort((a, b) => naturalOrder(fileName(a), fileName(b)));
  if (list.length > 1) {
    // Filename order would silently override an OME plane mapping; the description can be in any file.
    for (const file of list) {
      if (isOmeDescription(await readTiffDescription(file))) {
        throw new Error('OME-TIFF folders are not supported; export one multi-page OME-TIFF or plain TIFF planes.');
      }
    }
  }
  const first = await openNamed(list[0]);
  const name = list[0].name;
  if (first.width * first.height * first.bytesPerSample > maxPlaneBytes) {
    throw new Error(`A ${first.width} × ${first.height} ${first.dtype} plane needs more than ${Math.round(maxPlaneBytes / 2 ** 20)} MB; choose a coarser level.`);
  }
  const { metadata } = first;
  if (metadata.sizeC > 1 || metadata.sizeT > 1) {
    const time = metadata.kind === 'ome' ? 'time points' : 'frames';
    throw new Error(`${name} holds ${metadata.sizeC} channels and ${metadata.sizeT} ${time}; export the channel to analyse as its own stack.`);
  }
  if (list.length > 1 && first.pages > 1) throw new Error('Choose either one multi-page TIFF or one single-page TIFF per plane, not several multi-page files.');
  if (isOmeDescription(metadata.description) && metadata.kind !== 'ome') {
    throw new Error('OME-TIFF metadata without Pixels is not supported; export a self-contained OME-TIFF.');
  }
  // Without TiffData an OME-TIFF's pages are its z planes in order, so the counts must agree.
  if (metadata.kind === 'ome' && !metadata.tiffData.length && first.pages !== metadata.sizeZ) {
    const sizeZ = metadata.sizeZ;
    throw new Error(`${name} declares ${sizeZ} z plane${sizeZ === 1 ? '' : 's'} but holds ${first.pages} pages; save it again as an OME-TIFF.`);
  }

  // A plain TIFF's resolution tags are often a nominal 72 dpi, never a calibration.
  const size = metadata.pixelSize;
  const voxelSizeUm = { z: size.z ?? null, y: size.y ?? null, x: size.x ?? null };
  const depth = list.length > 1 ? list.length : first.pages;
  let opened = { z: 0, stack: first };
  return {
    kind: 'tiff',
    name: list.length > 1 ? `${name} … (${list.length} files)` : name,
    shape: [depth, first.height, first.width],
    dtype: first.dtype,
    voxelSizeUm,
    async readPlane(z) {
      if (z < 0 || z >= depth || !Number.isInteger(z)) throw new RangeError(`Plane ${z} is outside 0-${depth - 1}.`);
      if (list.length === 1) return first.readPage(z);
      if (opened.z !== z) {
        const stack = await openNamed(list[z]);
        if (stack.pages !== 1) throw new Error(`${list[z].name} has multiple pages; choose one single-page TIFF per plane.`);
        if (stack.width !== first.width || stack.height !== first.height || stack.dtype !== first.dtype) {
          throw new Error(`${list[z].name} plane ${z} is ${stack.width} × ${stack.height} ${stack.dtype}; the stack is ${first.width} × ${first.height} ${first.dtype}.`);
        }
        opened = { z, stack };
      }
      return opened.stack.readPage(0);
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

/**
 * Each dataset's declared [z, y, x] scale (in the axes' units, null when the dataset declares no
 * scale transform) and its voxel size in µm when the axes name a unit.
 */
export function ngffLevels(multiscale) {
  const axes = (multiscale.axes ?? []).map((axis) => (typeof axis === 'string' ? { name: axis } : axis));
  const spatial = ['z', 'y', 'x'].map((name) => axes.findIndex((axis) => axis.name === name));
  if (spatial.some((index) => index < 0)) throw new Error('The OME-Zarr image needs z, y and x axes.');
  const units = spatial.map((index) => micrometresPerUnit(axes[index].unit));
  const top = multiscale.coordinateTransformations ?? [];
  const topScale = top.find((t) => t.type === 'scale')?.scale;
  return multiscale.datasets.map((dataset) => {
    const declaredScale = (dataset.coordinateTransformations ?? []).find((t) => t.type === 'scale')?.scale;
    const scale = declaredScale ?? axes.map(() => 1);
    // The declared scale in the axes' own units (unit-less when an axis names none): its ratio
    // between levels holds even when the size in µm is unknown.
    const declared = Object.fromEntries(['z', 'y', 'x'].map((name, i) => [name, declaredScale ? scale[spatial[i]] * (topScale ? topScale[spatial[i]] : 1) : null]));
    return {
      path: dataset.path,
      axes: axes.map((axis) => axis.name),
      scale: declared,
      voxelSizeUm: Object.fromEntries(['z', 'y', 'x'].map((name, i) => [name, units[i] === null || declared[name] === null ? null : declared[name] * units[i]])),
    };
  });
}

/**
 * Open an OME-Zarr image from the files of its folder (picked or dropped, with relative paths).
 * Non-spatial axes (t, c) must have length 1, or `channel` picks one channel.
 */
export async function openOmeZarrStack(files, { channel, maxPlaneBytes = PLANE_LIMIT_BYTES, maxSlabBytes = SLAB_LIMIT_BYTES } = {}) {
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
    if (name === 'c' && length > 1 && channel === undefined) throw new Error(`The OME-Zarr image has ${length} channels; select a channel explicitly or export one.`);
    if (name === 'c' && channel !== undefined && (!Number.isInteger(channel) || channel < 0 || channel >= length)) throw new Error(`Channel ${channel} is outside 0-${length - 1}.`);
  }
  channel ??= 0;
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
