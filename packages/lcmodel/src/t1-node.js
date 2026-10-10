import { basename } from "node:path";
import { loadMindgrabCpu } from "@neurodesk/node-drivers/mindgrab";
import { convertDicom } from "@neurodesk/node-drivers/dcm2niix";
import { decodeNiftiBuffer, parseNiftiHeader, readNiftiImageData, extractNiftiHeader, createFloat32Nifti, sameVoxelGrid } from "@neurodesk/webapp-components/file-io/nifti";
import { voxelWeights, tissueFractions } from "./voxel.js";
import { correctionFor, tissueTexts } from "./tissue.js";

export async function readT1(files, log = () => {}) {
  const images = files.filter(file => /\.nii(\.gz)?$/i.test(file.name));
  const dicom = files.filter(file => !/\.(nii(\.gz)?|json|bval|bvec)$/i.test(file.name));
  if (dicom.length) {
    const url = new URL("dcm2niix.jpeg.js", import.meta.resolve("@niivue/dcm2niix"));
    const { default: factory } = await import(url.href);
    const converted = await convertDicom(dicom, factory, { onLog: log });
    if (!converted.length) throw new Error("No images produced. Choose NIfTI files or a complete DICOM series.");
    images.push(...converted);
  }
  if (images.length !== 1) throw new Error(images.length ? `These files hold ${images.length} images; choose the one T1 series.` : "No image found among the T1 files.");
  const buffer = await decodeNiftiBuffer(images[0].bytes);
  const header = parseNiftiHeader(buffer);
  if (header.dims.slice(4, header.dims[0] + 1).some(dim => dim > 1)) throw new Error("The T1 image must be a single 3D volume.");
  return { name: basename(images[0].name), buffer, header, dims: [header.nx, header.ny, header.nz], affine: header.affine };
}

export async function segmentT1(t1, log = () => {}) {
  const driver = await loadMindgrabCpu(import.meta.resolve("@brainchop/mindgrab/package.json"));
  const result = await driver.segmentTissues(t1.buffer, { model: "mindmap", backend: "cpu", gzipOutput: false, onLog: log });
  const maps = Object.fromEntries(["gm", "wm", "csf"].map(key => {
    const file = result.tissues[key];
    if (!sameVoxelGrid(parseNiftiHeader(file), t1.header)) throw new Error("The tissue maps do not match the T1 grid.");
    return [key, readNiftiImageData(file).data];
  }));
  return { ...t1, maps, files: result.tissues, version: driver.version, backend: result.backend };
}

export function correctFromT1(segmentation, entry, header, stem, metaboliteRelaxation) {
  if (!header?.voxel) throw new Error("These spectroscopy data do not record the voxel position.");
  const measured = voxelWeights(header.voxel.affine, segmentation);
  const fractions = tissueFractions(measured.weights, segmentation.maps);
  // The app fills the three fraction fields to three decimals before correction.
  const rounded = Object.fromEntries(["gm", "wm", "csf"].map(key => [key, Number(fractions[key].toFixed(3))]));
  const fit = entry.fit;
  const correction = correctionFor(fit.rows, { fractions: rounded, header, waterScaled: fit.water, edited: Boolean(fit.lcm.edited), metaboliteRelaxation });
  if (correction?.reason) throw new Error(correction.reason);
  fit.correction = { ...correction, source: { kind: "segmentation", backend: segmentation.backend, coverage: fractions.coverage } };
  return [
    ...Object.values(tissueTexts(fit.correction, stem, fit.ratioTo, {
      fractionSource: { method: "MindMap partial-volume maps (@brainchop/mindgrab segmentTissues)", version: segmentation.version, backend: segmentation.backend, t1: segmentation.name, coverage: fractions.coverage },
      voxel: header.voxel,
      voxelInT1Mm3: measured.volumeMm3,
    })),
    { name: `${stem}_voxel_mask.nii`, body: new Uint8Array(createFloat32Nifti(measured.weights, extractNiftiHeader(segmentation.buffer))) },
  ];
}

export function tissueMapFiles(segmentation) {
  const stem = segmentation.name.replace(/\.nii(\.gz)?$/i, "");
  return ["gm", "wm", "csf"].map(key => ({ name: `${stem}_${key}.nii`, body: new Uint8Array(segmentation.files[key]) }));
}
