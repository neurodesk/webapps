// Pure source handling: which reader a dropped file, folder or URL needs, which
// pyramid level fits the voxel budget, and the scalar 2D/3D shape elastix takes.
// No DOM or ITK-Wasm imports, so Node tests exercise it directly.

// Elastix runs single-threaded on float copies of both images; 2^24 voxels is
// about 64 MB per image, room for the 7.2 M voxel MNI template.
export const VOXEL_BUDGET = 2 ** 24;

// Self-contained formats @itk-wasm/image-io reads (NIfTI goes through dcm2niix's pass-through).
const ITK_EXTENSIONS = /\.(nrrd|mha|mgh|mgz|mnc|mnc2|gipl|gipl\.gz|vtk|hdf5|h5|mrc|rec|png|jpe?g|bmp|lsm|pic|isq|aim|fdf|iwi\.cbor|iwi\.cbor\.zst)$/i;
const DETACHED_HEADER = /\.(mhd|nhdr)$/i;
const NIFTI = /\.(nii|nii\.gz)$/i;
const TIFF = /\.tiff?$/i;
const OZX = /\.ozx$/i;
const ZARR_SEGMENT = /(^|\/)[^/]+\.zarr\//i;

function relativePath(file) {
  return file.webkitRelativePath || file._webkitRelativePath || "";
}

function rejectDetachedHeader(name) {
  if (DETACHED_HEADER.test(name)) {
    throw new Error(`${name} is a detached header whose external pixel file cannot be loaded here. Save a self-contained .mha or .nrrd image, or convert it to NIfTI.`);
  }
}

/** The `.zarr` folder prefix of a dropped file, or "" when it is not inside one. */
export function zarrRoot(file) {
  if (!file) throw new Error("Choose a folder whose name ends in .zarr.");
  const match = ZARR_SEGMENT.exec(relativePath(file));
  return match ? relativePath(file).slice(0, match.index + match[0].length) : "";
}

/** A dropped .zarr folder: its root prefix and its files keyed by path below that root. */
export function zarrFolderEntries(files) {
  const root = zarrRoot(Array.from(files).find(zarrRoot));
  const entries = new Map();
  for (const file of files) {
    const path = relativePath(file);
    if (path.startsWith(root)) entries.set(path.slice(root.length), file);
  }
  return { root, entries };
}

/**
 * Reader for a local selection (an array of Files) or a URL string:
 * nifti, dicom, itk, tiff, ozx, zarr-folder, or for URLs tiff-url, ozx-url,
 * file-url (fetched whole, then read as a file) and zarr-url.
 */
export function classifySource(source) {
  if (typeof source === "string") {
    const path = new URL(source).pathname.replace(/\/+$/, "");
    rejectDetachedHeader(path);
    if (TIFF.test(path)) return "tiff-url";
    if (OZX.test(path)) return "ozx-url";
    if (NIFTI.test(path) || ITK_EXTENSIONS.test(path)) return "file-url";
    return "zarr-url";
  }
  const files = Array.from(source);
  if (!files.length) throw new Error("Choose an image file or folder.");
  if (files.some(zarrRoot)) return "zarr-folder";
  for (const file of files) rejectDetachedHeader(file.name);
  if (files.length === 1) {
    const [{ name }] = files;
    if (OZX.test(name)) return "ozx";
    if (TIFF.test(name)) return "tiff";
    if (ITK_EXTENSIONS.test(name)) return "itk";
    if (NIFTI.test(name)) return "nifti";
  }
  return "dicom";
}

/** File name shown for a URL: its .zarr segment when it has one, else its last segment. */
export function urlName(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return segments.findLast((segment) => /\.zarr$/i.test(segment)) ?? segments.at(-1) ?? "remote image";
}

/** Spatial voxels of an NgffImage (its x, y and z axes). */
export function spatialVoxels(ngffImage) {
  return ngffImage.dims.reduce((count, dim, index) => (
    ["x", "y", "z"].includes(dim) ? count * ngffImage.data.shape[index] : count
  ), 1);
}

/** The finest pyramid level within the budget, else the coarsest. Images run finest first. */
export function chooseLevel(images, budget = VOXEL_BUDGET) {
  const index = images.findIndex((image) => spatialVoxels(image) <= budget);
  const level = index === -1 ? images.length - 1 : index;
  return { image: images[level], level };
}

/** Voxels of an ITK-Wasm image. */
export function voxelCount(image) {
  return Array.from(image.size).reduce((count, size) => count * size, 1);
}

/**
 * The scalar 2D or 3D image elastix registers. An XY single-slice volume
 * becomes 2D; other planes cannot lose their third physical coordinate.
 */
export function squeezeSingletons(image) {
  if (image.imageType.components !== 1) {
    throw new Error(`${image.name || "The image"} has ${image.imageType.components} components; elastix registers scalar (grayscale) images.`);
  }
  const { dimension } = image.imageType;
  if (dimension === 3 && image.size[2] === 1) {
    const direction = image.direction;
    if (Math.abs(direction[6]) > 1e-6 || Math.abs(direction[7]) > 1e-6) {
      throw new Error(`${image.name || "The image"} is a single-slice 3D image with an oblique or non-axial plane; choose a native 2D image or a 3D image with multiple slices.`);
    }
    return {
      ...image,
      imageType: { ...image.imageType, dimension: 2 },
      size: [image.size[0], image.size[1]],
      spacing: [image.spacing[0], image.spacing[1]],
      origin: [image.origin[0], image.origin[1]],
      direction: new Float64Array([direction[0], direction[1], direction[3], direction[4]]),
    };
  }
  if (dimension !== 2 && dimension !== 3) {
    throw new Error(`The image has ${dimension} dimensions; choose a 2D or 3D image.`);
  }
  return image;
}

/** Elastix registers images of one dimension. */
export function assertCompatiblePair(fixed, moving) {
  const fixedDimension = fixed.imageType.dimension;
  const movingDimension = moving.imageType.dimension;
  if (fixedDimension !== movingDimension) {
    throw new Error(`The moving image is ${movingDimension}D and the stationary image is ${fixedDimension}D; choose two 2D or two 3D images.`);
  }
}
