// A conversion source: the image as the writer sees it, whatever file it came from.
//
// {
//   name: string,                      the image name written to the multiscales metadata
//   format: string,                    what it was read from, for the log
//   dtype: "uint8" | … | "float64",
//   shape: { t, c, z, y, x },          sizes; absent axes are 1
//   scale: { t, z, y, x },             physical size per pixel, null when the file has none
//   units: { t, z, y, x },             NGFF unit names, null when the file has none
//   channels: [{ label, color }],      label and "RRGGBB" colour, null when the file has none
//   notes: string[],                   what the reader assumed or left out
//   readPlane(t, c, z, { signal }) →   Promise of one row-major Y × X plane of `dtype`
// }
import { isSpaceUnit } from "../units.js";

export const CHANNEL_COLOURS = { red: "FF0000", green: "00FF00", blue: "0000FF" };

/** The ImageJ/OME integer colour (signed RGBA) as "RRGGBB". */
export function rgbaColour(value) {
  if (!Number.isFinite(value)) return null;
  return ((value >>> 8) & 0xffffff).toString(16).toUpperCase().padStart(6, "0");
}

/** The stem of a file name, without image and archive extensions. */
export function imageStem(name) {
  return name.replace(/\.(ome\.tiff?|tiff?|nii(\.gz)?|png|jpe?g|btf|tf8|tf2)$/i, "");
}

/**
 * The source with the user's metadata replacing the file's: `scale` ({ x, y, z } in `unit`),
 * `labels` (one per channel; blank keeps the file's) and `name`. Values that are not
 * positive finite numbers are refused rather than dropped.
 */
export function withMetadata(source, { scale, unit, labels, name } = {}) {
  const next = { ...source, scale: { ...source.scale }, units: { ...source.units }, channels: source.channels.map((channel) => ({ ...channel })) };
  if (scale) {
    if (!isSpaceUnit(unit)) throw new Error(`${unit} is not a length unit.`);
    for (const axis of ["x", "y", "z"]) {
      const value = scale[axis];
      if (!(Number.isFinite(value) && value > 0)) throw new Error(`The ${axis.toUpperCase()} pixel size must be a positive number.`);
      next.scale[axis] = value;
      next.units[axis] = unit;
    }
  }
  if (labels) {
    if (labels.length !== source.channels.length) throw new Error(`Give ${source.channels.length} channel names.`);
    labels.forEach((label, index) => {
      if (typeof label === "string" && label.trim()) next.channels[index].label = label.trim();
    });
  }
  if (typeof name === "string" && name.trim()) next.name = name.trim();
  return next;
}
