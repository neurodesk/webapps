import { createNiftiFromData } from "@neurodesk/webapp-components/file-io/nifti";
import { readSeries } from "@neurodesk/hmc";
import { makeSeries, sphereMask, SIZE } from "../../../packages/hmc/test/synthetic.js";

export async function fixture() {
    const original = await readSeries(makeSeries().nifti);
    const voxels = SIZE ** 3;
    const data = new Float32Array(voxels * 10);
    const bvals = [0, ...Array(8).fill(1000), 0];
    const bvecs = [Array(10).fill(0), Array(10).fill(0), Array(10).fill(0)];
    for (let v = 0; v < 10; v++) {
      const source = v === 0 || v === 9 ? 0 : [1, 2, 4, 5][(v - 1) % 4];
      data.set(original.data.subarray(source * voxels, (source + 1) * voxels), v * voxels);
      if (v > 0 && v < 9) {
        const z = -0.9 + 1.8 * (v - 1) / 7;
        const r = Math.sqrt(1 - z * z);
        bvecs[0][v] = r * Math.cos(2.399963 * v);
        bvecs[1][v] = r * Math.sin(2.399963 * v);
        bvecs[2][v] = z;
      }
    }
    const nifti = new Uint8Array(createNiftiFromData(data, original.headerBytes, { dims: [SIZE, SIZE, SIZE, 10] }));
    const series = await readSeries(nifti);
    const mask = sphereMask();
    const maskNifti = new Uint8Array(createNiftiFromData(Float32Array.from(mask), series.headerBytes, { dims: [SIZE, SIZE, SIZE] }));
    return { nifti, series, bvals, bvecs, mask, maskNifti };
}
