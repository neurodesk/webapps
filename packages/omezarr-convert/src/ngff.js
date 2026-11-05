// OME-NGFF image metadata for a 5D (t, c, z, y, x) multiscale image: version 0.4 in Zarr v2
// (.zgroup, .zattrs, .zarray) or version 0.5 in Zarr v3 (zarr.json), as the specifications at
// https://ngff.openmicroscopy.org/0.4/ and /0.5/ define them. The vendored schemas in
// schemas/ check the output (test/schemas.test.js).
import { isSpaceUnit, isTimeUnit } from "./units.js";

export const VERSIONS = ["0.4", "0.5"];
export const AXES = ["t", "c", "z", "y", "x"];

const ZARR_V2_TYPES = { uint8: "|u1", int8: "|i1", uint16: "<u2", int16: "<i2", uint32: "<u4", int32: "<i4", float32: "<f4", float64: "<f8" };

/** One axis entry; a unit is written only when the source states one. */
function axis(name, unit) {
  const type = name === "t" ? "time" : name === "c" ? "channel" : "space";
  const valid = type === "time" ? isTimeUnit(unit ?? "") : type === "space" ? isSpaceUnit(unit ?? "") : false;
  return valid ? { name, type, unit } : { name, type };
}

/** The physical scale of level `level`: Y and X double per level, the other axes stay. */
export function levelScale(scale, level) {
  const factor = 2 ** level;
  return [scale.t ?? 1, 1, scale.z ?? 1, (scale.y ?? 1) * factor, (scale.x ?? 1) * factor];
}

const DEFAULT_COLOURS = ["FF0000", "00FF00", "0000FF", "FF00FF", "00FFFF", "FFFF00", "FFFFFF"];

/** The omero rendering block: one entry per channel, its window the channel's level-0 range. */
export function omeroMetadata(channels, windows, depth) {
  return {
    channels: channels.map((channel, index) => {
      const [min, max] = windows[index] ?? [0, 0];
      return {
        active: true,
        coefficient: 1,
        color: channel.color ?? (channels.length === 1 ? "FFFFFF" : DEFAULT_COLOURS[index % DEFAULT_COLOURS.length]),
        family: "linear",
        inverted: false,
        label: channel.label ?? `Channel ${index}`,
        window: { min, max, start: min, end: max },
      };
    }),
    rdefs: { defaultT: 0, defaultZ: Math.floor(depth / 2), model: channels.length > 1 ? "color" : "greyscale" },
  };
}

/** The multiscales entry shared by both versions (0.4 adds its own `version`). */
export function multiscalesEntry({ name, scale, units, levels, method, generator }) {
  return {
    name,
    axes: AXES.map((key) => axis(key, units[key])),
    datasets: Array.from({ length: levels }, (_, level) => ({
      path: String(level),
      coordinateTransformations: [{ type: "scale", scale: levelScale(scale, level) }],
    })),
    type: method,
    metadata: { method: `${generator.name}: ${method === "mean" ? "2 x 2 block mean" : "nearest neighbour (every second pixel)"} in Y and X`, version: generator.version },
  };
}

const json = (value) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/** The group metadata files and their contents for `version`. */
export function groupDocuments(version, multiscales, omero) {
  if (version === "0.4") {
    return {
      ".zgroup": json({ zarr_format: 2 }),
      ".zattrs": json({ multiscales: [{ version: "0.4", ...multiscales }], omero }),
    };
  }
  if (version === "0.5") {
    return { "zarr.json": json({ zarr_format: 3, node_type: "group", attributes: { ome: { version: "0.5", multiscales: [multiscales], omero } } }) };
  }
  throw new Error(`OME-NGFF ${version} is not supported; choose 0.4 or 0.5.`);
}

/** The array metadata file of one level: Zarr v2 with zlib, or Zarr v3 with gzip. */
export function arrayDocument(version, { shape, chunks, dtype, level: compressionLevel }) {
  if (version === "0.4") {
    return [".zarray", json({
      chunks,
      compressor: { id: "zlib", level: compressionLevel },
      dimension_separator: "/",
      dtype: ZARR_V2_TYPES[dtype],
      fill_value: 0,
      filters: null,
      order: "C",
      shape,
      zarr_format: 2,
    })];
  }
  return ["zarr.json", json({
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dtype,
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunks } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: 0,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }, { name: "gzip", configuration: { level: compressionLevel } }],
    dimension_names: AXES,
    attributes: {},
  })];
}

/** The store key of one chunk: `0/t/c/z/y/x` in Zarr v2, `0/c/t/c/z/y/x` in Zarr v3. */
export function chunkKey(version, level, indices) {
  return `${level}/${version === "0.4" ? "" : "c/"}${indices.join("/")}`;
}
