import { toOmeTiff } from "@fideus-labs/fiff";
import { createNgffImage, toMultiscales } from "@fideus-labs/ngff-zarr";
import { omeTiffIssue } from "./outputs.js";

/** Scalar result at the selected registration pyramid level, with stationary calibration. */
export async function writeOmeTiff(image, spatialUnits, { signal, tiffMetadata } = {}) {
  signal?.throwIfAborted();
  const issue = omeTiffIssue(image, spatialUnits, tiffMetadata);
  if (issue) throw new Error(issue);
  const { dimension } = image.imageType;
  if (![2, 3].includes(dimension) || image.imageType.components !== 1 || !(image.data instanceof Float32Array)) {
    throw new Error("OME-TIFF export requires a scalar float32 2D or 3D registration result.");
  }
  const dims = dimension === 3 ? ["z", "y", "x"] : ["y", "x"];
  const scale = Object.fromEntries(dims.map((axis, index) => [axis, image.spacing[dimension - 1 - index]]));
  const translation = Object.fromEntries(dims.map((axis) => [axis, 0]));
  // getPlane supplies the ITK pixels without ngff-zarr's worker-backed array IO.
  const level = await createNgffImage(new ArrayBuffer(0), Array.from(image.size).reverse(), "float32", dims, scale, translation, image.name || "registered");
  level.axesUnits = spatialUnits;
  const multiscales = await toMultiscales(level, { scaleFactors: [] });
  const planeSize = image.size[0] * image.size[1];
  const bytes = await toOmeTiff(multiscales, {
    compression: "deflate",
    getPlane: async (_data, selection) => {
      signal?.throwIfAborted();
      const offset = (dimension === 3 ? selection[0] : 0) * planeSize;
      // CompressionStream rejects the SharedArrayBuffer returned by ITK-Wasm.
      return { data: new Float32Array(image.data.subarray(offset, offset + planeSize)) };
    },
  });
  signal?.throwIfAborted();
  return new Uint8Array(bytes);
}
