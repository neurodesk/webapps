// Reads the app's OME-Zarr transform archive and applies it, independently of
// the app: the store is read with zarrita, and the frames follow RFC-5 and
// ngff-zarr's convention for ITK images, where an image's intrinsic point p
// (origin + index × spacing, axis by axis) sits at the physical point
// D (p − origin) + origin. Volumes are { data, dims, affine } from readVolume.
import ZipFileStore from "@zarrita/storage/zip";
import * as zarr from "zarrita";

/** The archive's transformation and, for a displacements transform, its field. */
export async function readTransformArchive(bytes) {
  const store = ZipFileStore.fromBlob(new Blob([bytes]));
  const root = JSON.parse(new TextDecoder().decode(await store.get("/zarr.json")));
  const [transformation] = root.attributes.ome.coordinateTransformations;
  if (transformation.type !== "displacements") return { transformation };
  const group = await zarr.open(zarr.root(store).resolve(transformation.path), { kind: "group" });
  const [dataset] = group.attrs.ome.multiscales[0].datasets;
  const { data, shape } = await zarr.get(await zarr.open(group.resolve(dataset.path), { kind: "array" }));
  return { transformation, multiscales: group.attrs.ome.multiscales[0], field: { data, shape } };
}

// ITK's origin and spacing for an axis-aligned NIfTI (RAS) affine, x, y, z.
function itkGrid({ affine }) {
  affine.slice(0, 3).forEach((row, i) => row.slice(0, 3).forEach((value, j) => {
    if (i !== j && value !== 0) throw new Error("the test frames assume an axis-aligned affine");
  }));
  return {
    origin: [-affine[0][3], -affine[1][3], affine[2][3]],
    spacing: [0, 1, 2].map((axis) => Math.abs(affine[axis][axis])),
  };
}

function trilinear({ data, dims }, [x, y, z]) {
  if ([x, y, z].some((value, axis) => value < 0 || value > dims[axis] - 1)) return 0;
  const base = [Math.floor(x), Math.floor(y), Math.floor(z)].map((value, axis) => Math.min(value, dims[axis] - 2));
  const [fx, fy, fz] = [x - base[0], y - base[1], z - base[2]];
  let sum = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const [dx, dy, dz] = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    if (weight) sum += weight * data[(base[0] + dx) + dims[0] * ((base[1] + dy) + dims[1] * (base[2] + dz))];
  }
  return sum;
}

/** The moving volume resampled onto the fixed grid through the archive's transform. */
export function resampleThroughArchive(archive, moving, fixed) {
  const fixedGrid = itkGrid(fixed);
  const movingGrid = itkGrid(moving);
  const [nx, ny, nz] = fixed.dims;
  const { transformation, field } = archive;
  const out = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const voxel = i + nx * (j + ny * k);
        // Intrinsic point in RFC-5 (z, y, x) order.
        const p = [k, j, i].map((index, axis) => fixedGrid.origin[2 - axis] + index * fixedGrid.spacing[2 - axis]);
        let q;
        if (transformation.type === "affine") {
          q = transformation.affine.map((row) => row.slice(0, 3).reduce((sum, value, column) => sum + value * p[column], row[3]));
        } else {
          const count = nx * ny * nz;
          q = p.map((value, component) => value + field.data[component * count + voxel]);
        }
        const index = [2, 1, 0].map((axis) => (q[axis] - movingGrid.origin[2 - axis]) / movingGrid.spacing[2 - axis]);
        out[voxel] = trilinear(moving, index);
      }
    }
  }
  return out;
}
