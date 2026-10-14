// OME-Zarr and TIFF in Node, for the command line. ngff-zarr 0.38 encodes and
// decodes every array on Web Workers it starts from a blob: URL, which Node's
// worker_threads refuse, so its array readers and writers fail in Node.
// Metadata goes through ngff-zarr as in the web app; array data is read and
// written with zarrita on the main thread instead.
import * as zarr from "zarrita";
import {
  anatomicalOrientationToItkDirection,
  convertItkFieldBlock,
  createNgffImage,
  defaultCodecs,
  itkDirectionToAnatomicalOrientation,
  itkLpsToAnatomicalOrientation,
  itkTransformToNgffTransform,
  memoryStoreToZip,
  toOmeZarrOzxData,
} from "@fideus-labs/ngff-zarr";
import { affineTransform, namedTransformation, spatialDims } from "./transform-export.js";

const COMPONENT_TYPES = new Set(["uint8", "int8", "uint16", "int16", "uint32", "int32", "uint64", "int64", "float32", "float64"]);

/**
 * An NgffImage level as an ITK-Wasm image, like ngff-zarr's
 * ngffImageToItkImage with `{ tIndex, cIndex }`: the first time point and
 * channel, spatial axes in ITK (x, y, z) order, direction from the RFC-4
 * orientation when every spatial axis has an LPS-compatible one.
 */
export async function ngffImageToItkImage(ngffImage, { tIndex = 0, cIndex = 0 } = {}) {
  const { dims, data } = ngffImage;
  const spatial = dims.filter((dim) => dim !== "t" && dim !== "c");
  const order = ["z", "y", "x"].slice(3 - spatial.length);
  if (spatial.length < 2 || spatial.join() !== order.join()) {
    throw new Error(`${ngffImage.name || "The image"} has axes ${dims.join(", ")}; elastix reads 2D (y, x) or 3D (z, y, x) images.`);
  }
  if (!COMPONENT_TYPES.has(data.dtype)) throw new Error(`Unsupported OME-Zarr data type: ${data.dtype}`);
  const selection = dims.map((dim) => (dim === "t" ? tIndex : dim === "c" ? cIndex : null));
  const chunk = await zarr.get(data, selection);
  const itkDims = [...spatial].reverse();
  const dimension = itkDims.length;
  const direction = new Float64Array(dimension * dimension).map((_, index) => (index % (dimension + 1) === 0 ? 1 : 0));
  const columns = itkDims.map((dim) => {
    const orientation = ngffImage.axesOrientations?.[dim];
    return orientation ? anatomicalOrientationToItkDirection(orientation.value) : undefined;
  });
  if (columns.every(Boolean)) {
    columns.forEach((column, axis) => {
      for (let row = 0; row < dimension; row += 1) direction[row * dimension + axis] = column[row];
    });
  }
  return {
    imageType: { dimension, componentType: data.dtype, pixelType: "Scalar", components: 1 },
    name: ngffImage.name || "image",
    origin: itkDims.map((dim) => ngffImage.translation[dim] || 0),
    spacing: itkDims.map((dim) => ngffImage.scale[dim] || 1),
    direction,
    size: itkDims.map((dim) => data.shape[dims.indexOf(dim)]),
    metadata: new Map(),
    data: chunk.data,
  };
}

/**
 * The RFC-5 frame of an ITK image: an NgffImage with its scale, translation
 * and RFC-4 orientation, as ngff-zarr's itkImageToNgffImage gives the web app,
 * but without pixel data.
 */
export async function frameImage(image) {
  const dimension = image.imageType.dimension;
  const dims = spatialDims(dimension);
  const identity = Array.from(image.direction).every((value, index) => Number(value) === (index % (dimension + 1) === 0 ? 1 : 0));
  const scale = {};
  const translation = {};
  const axesOrientations = {};
  dims.forEach((dim, index) => {
    const axis = dimension - 1 - index;
    scale[dim] = image.spacing[axis];
    translation[dim] = image.origin[axis];
    const column = Array.from({ length: dimension }, (_, row) => Number(image.direction[row * dimension + axis]));
    axesOrientations[dim] = identity ? itkLpsToAnatomicalOrientation(dim) : itkDirectionToAnatomicalOrientation(column);
  });
  const frame = await createNgffImage(new ArrayBuffer(0), Array(dimension).fill(1), "float32", dims, scale, translation, "image");
  frame.axesOrientations = axesOrientations;
  return frame;
}

/** An affine estimate as the web app's RFC-5 OME-Zarr archive (.ozx bytes). */
export async function affineArchive({ matrix, offset }, fixed, moving) {
  const dims = spatialDims(fixed.imageType.dimension);
  const frames = { fixed: await frameImage(fixed), moving: await frameImage(moving) };
  const affine = itkTransformToNgffTransform([affineTransform(matrix, offset)], dims, true, frames);
  return toOmeZarrOzxData(namedTransformation(affine));
}

const json = (value) => new TextEncoder().encode(JSON.stringify(value, null, 2));

// The scale-0 field array's zarr.json, as ngff-zarr writes it.
function arrayMetadata(shape) {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "float32",
    chunk_grid: { name: "regular", configuration: { chunk_shape: shape.map((size) => Math.min(size, 256)) } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    codecs: defaultCodecs("float32"),
    fill_value: 0,
    attributes: {},
  };
}

/**
 * A displacement field estimate as the web app's RFC-5 OME-Zarr archive. The
 * vectors are converted to the images' intrinsic frames by ngff-zarr's own
 * convertItkFieldBlock, which is what its itkDisplacementFieldToNgffTransform
 * applies in the web app. The store layout and metadata reproduce what the web
 * app's toOmeZarr writes; validation/cli-check.mjs compares the two.
 */
export async function displacementArchive(field, fixed, moving) {
  const dimension = fixed.imageType.dimension;
  const dims = spatialDims(dimension);
  const frames = { fixed: await frameImage(fixed), moving: await frameImage(moving) };
  const voxels = Array.from(field.size).reduce((a, b) => a * b, 1);
  // ITK interleaves the components per voxel, x fastest: channel-first in
  // ITK component order with the voxels in (z, y, x) C order.
  const channels = new Float32Array(voxels * dimension);
  for (let voxel = 0; voxel < voxels; voxel += 1) {
    for (let axis = 0; axis < dimension; axis += 1) channels[axis * voxels + voxel] = field.data[voxel * dimension + axis];
  }
  // The field lies on the fixed grid, so its RFC-5 translation is the fixed frame's.
  const scale = Object.fromEntries(dims.map((dim, index) => [dim, field.spacing[dimension - 1 - index]]));
  const translation = Object.fromEntries(dims.map((dim, index) => [dim, field.origin[dimension - 1 - index]]));
  const shape = [dimension, ...dims.map((_, index) => field.size[dimension - 1 - index])];
  const values = convertItkFieldBlock(channels, shape, dims, translation, scale, frames);

  const store = new Map();
  const array = await zarr.create(zarr.root(store).resolve("displacements/scale0"), {
    shape,
    chunkShape: shape.map((size) => Math.min(size, 256)),
    dtype: "float32",
    fillValue: 0,
    codecs: defaultCodecs("float32"),
  });
  await zarr.set(array, null, { data: values, shape, stride: shape.map((_, axis) => shape.slice(axis + 1).reduce((a, b) => a * b, 1)) });

  const orientation = (dim) => frames.fixed.axesOrientations?.[dim];
  const group = {
    ome: {
      version: "0.6",
      multiscales: [{
        name: "displacements",
        coordinateSystems: [{
          name: "intrinsic",
          axes: [
            { name: "c", type: "displacement", discrete: true },
            ...dims.map((dim) => ({ name: dim, type: "space", ...(orientation(dim) ? { orientation: orientation(dim) } : {}) })),
          ],
        }],
        datasets: [{
          path: "scale0",
          coordinateTransformations: [{
            type: "sequence",
            name: "scale0_to_intrinsic",
            input: { path: "scale0" },
            output: { name: "intrinsic" },
            transformations: [
              { type: "scale", scale: [1, ...dims.map((dim) => scale[dim])] },
              { type: "translation", translation: [0, ...dims.map((dim) => translation[dim])] },
            ],
          }],
        }],
      }],
    },
  };
  const consolidated = (metadata) => ({ kind: "inline", must_understand: false, metadata });
  const array0 = arrayMetadata(shape);
  const listed = { ...array0, storage_transformers: [] };
  const transformation = { type: "displacements", name: "fixed_to_moving", input: { name: "fixed" }, output: { name: "moving" }, path: "displacements", interpolation: "linear" };
  store.set("/displacements/scale0/zarr.json", json(array0));
  store.set("/displacements/zarr.json", json({ zarr_format: 3, node_type: "group", attributes: group, consolidated_metadata: consolidated({ scale0: listed }) }));
  store.set("/zarr.json", json({
    zarr_format: 3,
    node_type: "group",
    attributes: { ome: { version: "0.6", coordinateTransformations: [transformation] } },
    consolidated_metadata: consolidated({
      displacements: { zarr_format: 3, node_type: "group", attributes: group, consolidated_metadata: consolidated({}) },
      "displacements/scale0": listed,
    }),
  }));
  return memoryStoreToZip(store, { version: "0.6" });
}
