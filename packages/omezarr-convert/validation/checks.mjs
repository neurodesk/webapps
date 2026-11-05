// Checks of a written OME-Zarr image, shared by the Node tests and the browser tests:
// - the metadata against the vendored OME-NGFF strict image schemas (Ajv, draft 2020-12);
// - every level read back with zarrita, the pixels hashed;
// - the metadata and pixels against the bioformats2raw reference (example-reference.json).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { mapStore, openImage, openLevel } from "../src/readback.js";
import * as zarr from "zarrita";

const schema = (path) => JSON.parse(readFileSync(new URL(`../schemas/${path}`, import.meta.url), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const path of ["0.4/image.schema", "0.4/strict_image.schema", "0.5/_version.schema", "0.5/image.schema", "0.5/strict_image.schema"]) ajv.addSchema(schema(path));

/** Schema errors of the image's root attributes for `version` (empty when valid). */
export function schemaErrors(attributes, version) {
  const validate = ajv.getSchema(`https://ngff.openmicroscopy.org/${version}/schemas/strict_image.schema`);
  return validate(attributes) ? [] : validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`);
}

/** The root attributes of a store held in a Map. */
export function rootAttributes(map, version) {
  const text = new TextDecoder().decode(map.get(version === "0.4" ? ".zattrs" : "zarr.json"));
  return version === "0.4" ? JSON.parse(text) : JSON.parse(text).attributes;
}

export const sha256 = (array) => createHash("sha256").update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest("hex");

/** Every level of a written store, read back by zarrita: shape, chunks, data type, sha256. */
export async function readBackLevels(map) {
  const image = await openImage(mapStore(map));
  const levels = [];
  for (let level = 0; level < image.multiscales.datasets.length; level += 1) {
    const array = await openLevel(image, level);
    const { data } = await zarr.get(array);
    levels.push({ path: image.multiscales.datasets[level].path, shape: array.shape, chunks: array.chunks, dtype: array.dtype, sha256: sha256(data), data });
  }
  return { image, levels };
}

/**
 * The fields where the converter's metadata must equal bioformats2raw's: axes, dataset paths
 * and scales, image name, and per channel the colour, label and window, and rdefs.defaultZ.
 */
export function comparableMetadata({ multiscales, omero }) {
  return {
    name: multiscales.name,
    axes: multiscales.axes.map(({ name, type, unit }) => ({ name, type, ...(unit ? { unit } : {}) })),
    datasets: multiscales.datasets.map(({ path, coordinateTransformations }) => ({ path, coordinateTransformations: coordinateTransformations.map(({ type, scale }) => ({ type, scale })) })),
    channels: omero.channels.map(({ color, label, window }) => ({ color, label, window: { min: window.min, max: window.max, start: window.start, end: window.end } })),
    defaultZ: omero.rdefs.defaultZ,
  };
}

const REFERENCE = JSON.parse(readFileSync(new URL("./example-reference.json", import.meta.url), "utf8"));

/** The entries of an archive (.ozx or .ome.zarr.zip) as a store Map. */
export function archiveStore(entries) {
  return new Map(Object.entries(entries).filter(([key]) => !key.endsWith("/")));
}

/**
 * Check a conversion of the example against example-reference.json: the schema, level 0 equal
 * to the source, the pyramid equal to bioformats2raw's (`nearest`) or numpy's (`mean`), the
 * array layout and the metadata bioformats2raw writes. Returns the problems found.
 */
export async function checkExample(map, version, method) {
  const problems = [];
  const reference = REFERENCE[version];
  const attributes = rootAttributes(map, version);
  for (const error of schemaErrors(attributes, version)) problems.push(`schema: ${error}`);
  const { image, levels } = await readBackLevels(map);
  if (levels[0]?.sha256 !== REFERENCE.source.sha256) problems.push("level 0 differs from the source pixels");
  const expected = REFERENCE[method];
  levels.forEach((level, index) => {
    if (JSON.stringify(level.shape) !== JSON.stringify(expected[index]?.shape)) problems.push(`level ${index} shape ${level.shape} != ${expected[index]?.shape}`);
    if (level.sha256 !== expected[index]?.sha256) problems.push(`level ${index} pixels differ from the ${method} reference`);
    if (JSON.stringify(level.chunks) !== JSON.stringify(reference.levels[index]?.chunks)) problems.push(`level ${index} chunks ${level.chunks} != bioformats2raw ${reference.levels[index]?.chunks}`);
  });
  if (levels.length !== expected.length) problems.push(`${levels.length} levels, reference ${expected.length}`);
  const ours = comparableMetadata(image);
  const theirs = comparableMetadata(reference);
  for (const key of Object.keys(theirs)) {
    if (JSON.stringify(ours[key]) !== JSON.stringify(theirs[key])) problems.push(`metadata ${key}: ${JSON.stringify(ours[key])} != bioformats2raw ${JSON.stringify(theirs[key])}`);
  }
  return problems;
}
