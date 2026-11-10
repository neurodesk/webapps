// Read a written OME-Zarr image back with zarrita, an implementation independent of the
// writer, for the checks and the preview.
import * as zarr from "zarrita";

/** A zarrita store over a Map of relative keys. */
export function mapStore(map) {
  return { get: async (key) => map.get(key.replace(/^\//, "")) };
}

/** The image's root attributes (NGFF 0.4 `.zattrs` or 0.5 `zarr.json` attributes). */
export async function openImage(store) {
  const group = await zarr.open(store, { kind: "group" });
  const attributes = group.attrs;
  const multiscales = attributes.ome?.multiscales ?? attributes.multiscales;
  if (!multiscales?.length) throw new Error("The store has no multiscales metadata.");
  return { group, attributes, multiscales: multiscales[0], omero: attributes.ome?.omero ?? attributes.omero };
}

/** One level's array. */
export async function openLevel(image, level) {
  return zarr.open(image.group.resolve(image.multiscales.datasets[level].path), { kind: "array" });
}

/** One (t, c, z) plane of a level as a typed array, row-major. */
export async function readPlane(array, t, c, z) {
  const chunk = await zarr.get(array, [t, c, z, null, null]);
  return chunk.data;
}

/** The Z stack of one channel at t, as one typed array ordered z, y, x. */
export async function readVolume(array, t, c) {
  const chunk = await zarr.get(array, [t, c, null, null, null]);
  return chunk.data;
}
