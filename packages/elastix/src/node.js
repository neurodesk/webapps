// The web app's registration in Node: the same ITK-Wasm pipelines, run by
// itk-wasm's Node runner from the .wasm.zst files inside the installed
// @itk-wasm packages, never from a CDN. Each pipeline runs to completion on
// the main thread, one at a time.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InterfaceTypes, runPipelineNode } from "itk-wasm";
import { readImageNode, writeImageNode } from "@itk-wasm/image-io";
import { writeTransformNode } from "@itk-wasm/transform-io";
import { defaultParameterMapNode, elastixNode, readParameterFilesNode, transformixNode } from "@itk-wasm/elastix";
import { fromOmeZarr } from "@fideus-labs/ngff-zarr";
import { TiffStore } from "@fideus-labs/fiff";
import ZipFileStore from "@zarrita/storage/zip";
import { affineArchive, displacementArchive, ngffImageToItkImage } from "./node-ngff.js";
import { hdf5Writable, outputNames, withTypedParameterArrays } from "./outputs.js";
import { buildParameterObject, presetSettings, sortParameterFiles, stageNames } from "./parameter-maps.js";
import { registrationError, registrationImage, transformParameterFiles } from "./pipeline.js";
import { createSourceReader } from "./source-reader.js";
import { assertCompatiblePair, classifySource } from "./sources.js";
import { estimateTransform } from "./transform-export.js";

export const ENGINE = "elastix 5.2 (@itk-wasm/elastix 2.1.0), ITK-Wasm Node runner, one thread";

const ELASTIX_PIPELINES = fileURLToPath(new URL("pipelines/", import.meta.resolve("@itk-wasm/elastix")));

/**
 * TransformParameters files as text, written in memory as the web app does,
 * so InitialTransformParameterFileName holds the bare file name. The Node
 * wrapper would write them to disk under the path it is given.
 */
async function writeParameterFiles(parameterObject, names) {
  const outputs = names.map((path) => ({ type: InterfaceTypes.TextFile, data: { path, data: "" } }));
  const inputs = [{ type: InterfaceTypes.JsonCompatible, data: parameterObject }];
  const args = ["0", ...names, "--memory-io"];
  const { returnValue, stderr, outputs: written } = await runPipelineNode(join(ELASTIX_PIPELINES, "write-parameter-files"), args, outputs, inputs);
  if (returnValue !== 0) throw new Error(stderr || `write-parameter-files exited with ${returnValue}`);
  return { parameterFiles: written.map((output) => output?.data) };
}

const transformix = (image, options) => transformixNode(image, options);

/** A pair the self-check registers: a smooth 3D blob and the same blob shifted by 2 voxels. */
function blobImage(shift) {
  const size = 24;
  const data = new Float32Array(size ** 3);
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const r2 = (x - 11 - shift) ** 2 + (y - 12) ** 2 + (z - 12) ** 2;
        data[x + size * (y + size * z)] = 100 * Math.exp(-r2 / 18);
      }
    }
  }
  return {
    imageType: { dimension: 3, componentType: "float32", pixelType: "Scalar", components: 1 },
    name: `blob-${shift}`,
    origin: [0, 0, 0],
    spacing: [1, 1, 1],
    direction: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    size: [size, size, size],
    metadata: new Map(),
    data,
  };
}

/**
 * Runs every pipeline the command line uses on a synthetic pair: the rigid
 * preset must recover a 2 mm shift, and its parameter files must be TOML.
 */
export async function checkInstallation() {
  const settings = presetSettings({ method: "rigid", resolutions: 2 });
  const { parameterObject } = await buildParameterObject(settings, { defaultParameterMap: defaultParameterMapNode });
  const { transformParameterObject } = await quietly(() => elastixNode(parameterObject, { fixed: blobImage(0), moving: blobImage(2) }));
  const translation = transformParameterObject.reduce((sum, map) => {
    const values = map.TransformParameters.map(Number);
    return sum + (map.Transform[0] === "EulerTransform" ? values[3] : values[0]);
  }, 0);
  if (Math.abs(translation - 2) > 0.1) throw new Error(`self-check registration found a ${translation.toFixed(3)} mm shift instead of 2 mm`);
  const [file] = await transformParameterFiles(transformParameterObject.slice(0, 1), "self-check", writeParameterFiles);
  if (!/^Transform = "TranslationTransform"$/m.test(file.data)) throw new Error("self-check parameter file is not elastix TOML");
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    engine: ENGINE,
    selfCheckTranslationMm: Number(translation.toFixed(4)),
  };
}

// The elastix module prints its log through console.log; keep it off standard output,
// which lists the written files and nothing else.
async function quietly(run, onLog = () => {}) {
  const { log, info, warn, error } = console;
  console.log = (...values) => onLog(values.join(" "));
  console.info = console.log;
  console.warn = console.log;
  console.error = console.log;
  try {
    return await run();
  } finally {
    Object.assign(console, { log, info, warn, error });
  }
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

/**
 * One input as the scalar float32 image elastix registers. NIfTI and the
 * other ITK formats are read with image-io; TIFF/OME-TIFF with fiff and
 * OME-Zarr .ozx archives with zarrita, both through the web app's reader.
 */
export async function readInput(path, role) {
  if ((await stat(path)).isDirectory()) {
    throw new Error(`The ${role} image ${path} is a folder. Pack an OME-Zarr folder as .ozx, or give a NIfTI, NRRD, MHA or TIFF file.`);
  }
  const name = basename(path);
  const file = new File([await readFile(path)], name);
  const kind = classifySource([file]);
  if (kind === "dicom") {
    throw new Error(`The ${role} image ${name} is not a NIfTI, ITK (NRRD, MHA, ...), TIFF or OME-Zarr .ozx file. Convert DICOM with dcm2niix first.`);
  }
  const prepared = (image, sourceName, sourceKind, _display, detail = "") => {
    const { scalar, image: float } = registrationImage(image);
    return { image: float, name: sourceName, kind: sourceKind, note: `${Array.from(scalar.size).join("x")} ${scalar.imageType.componentType}${detail}` };
  };
  if (kind === "nifti") return prepared(await readImageNode(path), name, kind);
  const readSource = createSourceReader({
    fromOmeZarr,
    ngffImageToItkImage,
    // geotiff reads a Blob with FileReader, which Node lacks.
    TiffStore: { fromBlob: async (blob) => TiffStore.fromArrayBuffer(await blob.arrayBuffer()) },
    ZipFileStore,
    FetchStore: null,
    prepared,
    readNiftiFile: null,
    readItkFile: async () => ({ image: await readImageNode(path) }),
  });
  return readSource([file]);
}

/** Custom elastix parameter files (.txt or .toml), in name order, as a parameter object. */
export async function readParameterFiles(paths) {
  const sorted = sortParameterFiles(paths.map((path) => ({ name: basename(path), path: resolve(path) })));
  const { parameterObject } = await readParameterFilesNode({ parameterFiles: sorted.map((file) => file.path) });
  if (!parameterObject.length) throw new Error("The parameter files hold no parameter maps.");
  return parameterObject;
}

/**
 * Registers `moving` to `fixed` and writes the web app's downloads to
 * `output`: the registered NIfTI, the ITK HDF5 transform, the OME-Zarr RFC-5
 * transform and the chained TransformParameters TOML files.
 */
export async function registerImages({ moving, fixed, output, method = "affine", resolutions = 3, gridSpacing = 10, parameterFiles = [], onLog = () => {} }) {
  if (!moving || !fixed || !output) throw new Error("A moving image, a fixed image and an output directory are required.");
  const settings = parameterFiles.length ? null : presetSettings({ method, resolutions, gridSpacing });
  const destination = resolve(output);
  await assertNewOutput(destination);
  const movingSource = await readInput(moving, "moving");
  const fixedSource = await readInput(fixed, "fixed");
  assertCompatiblePair(fixedSource.image, movingSource.image);
  onLog(`moving image: ${movingSource.name} · ${movingSource.note}`);
  onLog(`fixed image: ${fixedSource.name} · ${fixedSource.note}`);
  const parameterObject = settings
    ? (await buildParameterObject(settings, { defaultParameterMap: defaultParameterMapNode })).parameterObject
    : await readParameterFiles(parameterFiles);
  onLog(`Registering with elastix · ${stageNames(parameterObject).join(" → ")}`);
  const started = performance.now();
  const run = await quietly(() => elastixNode(parameterObject, { fixed: fixedSource.image, moving: movingSource.image }), onLog)
    .catch((error) => { throw registrationError(error); });
  const seconds = (performance.now() - started) / 1000;
  const names = outputNames(movingSource.name);
  const parameters = await transformParameterFiles(run.transformParameterObject, names.stem, writeParameterFiles);
  onLog("Writing the OME-Zarr transform");
  const estimate = await quietly(() => estimateTransform({ ...run, fixed: fixedSource.image, moving: movingSource.image }, { transformix }), onLog);
  const archive = estimate.type === "affine"
    ? await affineArchive(estimate, fixedSource.image, movingSource.image)
    : await displacementArchive(estimate.field, fixedSource.image, movingSource.image);
  await mkdir(destination, { recursive: true });
  const written = [];
  try {
    for (const file of parameters) {
      await writeFile(join(destination, file.name), file.data, { flag: "wx" });
      written.push(file.name);
    }
    await writeFile(join(destination, names.transformOmeZarr), archive, { flag: "wx" });
    written.push(names.transformOmeZarr);
    await writeImageNode(run.result, join(destination, names.nifti));
    written.push(names.nifti);
    if (hdf5Writable(run.transform)) {
      await writeTransformNode(withTypedParameterArrays(run.transform), join(destination, names.transform));
      written.push(names.transform);
    } else {
      onLog(`No ${names.transform}: the ITK HDF5 writer cannot store a B-spline transform; use the TransformParameters files or the OME-Zarr transform.`);
    }
  } catch (error) {
    await Promise.all(written.map((name) => rm(join(destination, name), { force: true })));
    throw error;
  }
  const order = [names.nifti, names.transform, names.transformOmeZarr, ...parameters.map((file) => file.name)].filter((name) => written.includes(name));
  return {
    output: destination,
    files: order,
    seconds,
    stages: stageNames(parameterObject),
    parameterSource: settings ? `${settings.method} preset` : "parameter files",
  };
}

