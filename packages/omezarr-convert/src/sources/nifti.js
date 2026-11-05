// NIfTI-1 sources. The stored voxel values are kept (scl_slope and scl_inter are reported,
// not applied) so the conversion is lossless. NIfTI's i, j, k run along x, y, z, x fastest,
// which is the row-major (z, y, x) order of an OME-Zarr plane stack, so no voxel moves.
import { decodeNiftiBuffer, parseNiftiHeader } from "@neurodesk/webapp-components/file-io/nifti";
import { assertInputSize, MAX_INPUT_BYTES } from "@neurodesk/webapp-components/file-io/input-limits";
import { ARRAY_TYPES } from "../pyramid.js";
import { niftiUnits } from "../units.js";
import { imageStem } from "./source.js";

const TYPES = { 2: "uint8", 4: "int16", 8: "int32", 16: "float32", 64: "float64", 256: "int8", 512: "uint16", 768: "uint32" };

/** The shortest decimal that is the same float32 (0.4, not 0.4000000059604645). */
export function float32Decimal(value) {
  for (let digits = 1; digits <= 9; digits += 1) {
    const decimal = Number(value.toPrecision(digits));
    if (Math.fround(decimal) === value) return decimal;
  }
  return value;
}

/** A .nii or .nii.gz file (Blob or ArrayBuffer with a `name`) as a source. */
export async function openNiftiSource(file, { signal } = {}) {
  // NIfTI is read whole, so its size is checked before it is read and while it is inflated.
  if (file instanceof Blob) assertInputSize([file]);
  const bytes = file instanceof Blob ? await file.arrayBuffer() : file;
  signal?.throwIfAborted();
  const buffer = await decodeNiftiBuffer(bytes, { maxBytes: MAX_INPUT_BYTES });
  signal?.throwIfAborted();
  const header = parseNiftiHeader(buffer);
  const dtype = TYPES[header.datatype];
  if (!dtype) throw new Error(`NIfTI datatype ${header.datatype} is not supported; use an integer or float image with one value per voxel.`);
  const rank = header.dims[0];
  if (rank > 4 && header.dims.slice(5, rank + 1).some((size) => size > 1)) throw new Error("NIfTI images with more than four dimensions are not supported.");
  const shape = { t: rank >= 4 ? Math.max(1, header.dims[4]) : 1, c: 1, z: Math.max(1, header.nz), y: Math.max(1, header.ny), x: Math.max(1, header.nx) };
  const ArrayType = ARRAY_TYPES[dtype];
  const bytesPer = ArrayType.BYTES_PER_ELEMENT;
  const planeVoxels = shape.y * shape.x;
  const start = Math.ceil(header.voxOffset);
  if (start + shape.t * shape.z * planeVoxels * bytesPer > buffer.byteLength) throw new Error("The NIfTI file is shorter than its header says.");
  const units = niftiUnits(header.xyztUnits);
  const spacing = (value) => (Number.isFinite(value) && value !== 0 ? float32Decimal(Math.abs(value)) : null);
  const notes = ["OME-NGFF 0.4 and 0.5 have no orientation: the NIfTI affine is not carried over; voxels keep their stored order."];
  if ((header.sclSlope !== 0 && header.sclSlope !== 1) || header.sclInter !== 0) {
    notes.push(`Stored values are kept; scale them by scl_slope ${header.sclSlope} and scl_inter ${header.sclInter} for physical values.`);
  }
  const scale = { t: shape.t > 1 ? spacing(header.pixDims[4]) : null, z: spacing(header.pixDims[3]), y: spacing(header.pixDims[2]), x: spacing(header.pixDims[1]) };
  const view = new DataView(buffer);
  return {
    name: imageStem(file.name ?? "image"),
    format: "NIfTI",
    dtype,
    shape,
    scale,
    units: {
      t: scale.t ? units.time : null,
      z: scale.z ? units.space : null,
      y: scale.y ? units.space : null,
      x: scale.x ? units.space : null,
    },
    channels: [{ label: null, color: null }],
    notes,
    async readPlane(t, _c, z) {
      const offset = start + (t * shape.z + z) * planeVoxels * bytesPer;
      const plane = new ArrayType(planeVoxels);
      if (header.littleEndian || bytesPer === 1) {
        new Uint8Array(plane.buffer).set(new Uint8Array(buffer, offset, planeVoxels * bytesPer));
        return plane;
      }
      const getter = `get${{ int16: "Int16", uint16: "Uint16", int32: "Int32", uint32: "Uint32", float32: "Float32", float64: "Float64" }[dtype]}`;
      for (let i = 0; i < planeVoxels; i += 1) plane[i] = view[getter](offset + i * bytesPer, false);
      return plane;
    },
  };
}
