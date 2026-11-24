// DOM-independent format, calibration, TIFF/NIfTI encoding, and provenance helpers
// shared between the Denoise web app and the @neurodesk/denoise command line.
import { createFloat32Nifti, createNiftiFromVolume } from "@neurodesk/webapp-components/file-io";
import { imagejDescription, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { METHODS, effectiveSettings } from "./core/denoise.js";

/** Maximum axis length representable in a signed 16-bit NIfTI-1 dim field. */
export const MAX_NIFTI_DIM = 32767;

/** Name stem without .tif/.tiff/.ome.tif/.nii/.nii.gz. */
export function stem(name) {
  return name.replace(/(\.ome)?\.tiff?$/i, "").replace(/\.nii(\.gz)?$/i, "");
}

export function outputNames(inputName) {
  const base = stem(inputName);
  return {
    tiff: `${base}_denoised.tif`,
    nifti: `${base}_denoised.nii.gz`,
    residualTiff: `${base}_residual.tif`,
    residualNifti: `${base}_residual.nii.gz`,
    previewNifti: `${base}.nii.gz`,
    provenance: `${base}_provenance.json`,
  };
}

/** Micrometres per unit of NIfTI xyzt_units (bits 0-2): unknown/mm -> 1000, m -> 1e6, um -> 1. */
const NIFTI_UNIT_UM = Object.freeze({ 0: 1000, 1: 1e6, 2: 1000, 3: 1 });

/** Voxel spacing `{ x, y, z }` in micrometres from a parsed NIfTI header. */
export function niftiSpacingUm(header) {
  const factor = NIFTI_UNIT_UM[header.xyztUnits & 7] ?? 1000;
  const [x, y, z] = header.voxelSize.map((value) => Math.abs(value) * factor);
  return { x, y, z };
}

/** Ensures positive fallback spacing (1 um) for uncalibrated TIFF files when creating NIfTI views. */
export function resolvedSpacingUm(spacingUm) {
  return {
    x: spacingUm?.x > 0 ? spacingUm.x : 1,
    y: spacingUm?.y > 0 ? spacingUm.y : 1,
    z: spacingUm?.z > 0 ? spacingUm.z : 1,
  };
}

/**
 * Validates that every dimension fits NIfTI-1's signed 16-bit header fields (`1..32767`).
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 */
export function assertValidDims(dims) {
  const [nz, ny, nx] = dims;
  for (const [axis, value] of [["X", nx], ["Y", ny], ["Z/T", nz]]) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_NIFTI_DIM) {
      throw new Error(`Image ${axis} dimension (${value}) exceeds the supported NIfTI-1 limit (${MAX_NIFTI_DIM}).`);
    }
  }
}

/** Explicit NIfTI dimensions preserving 2D+T time axis (`[nx, ny, 1, nt]`) when exporting NIfTI. */
export function niftiExportDims(volume) {
  const [nz, ny, nx] = volume.dims;
  return volume.axisKind === "t" && nz > 1 ? [nx, ny, 1, nz] : [nx, ny, nz];
}

/**
 * NIfTI-1 geometry for a `[nz, ny, nx]` stack calibrated in micrometres (y-flipped to match ImageJ).
 * When `axisKind === "t"` and `nz > 1`, stores frames along `dim[4]` with temporal spacing in seconds
 * and `xyzt_units = mm | sec` (`2 | 8 = 10`) instead of overloading spatial Z.
 */
export function niftiGeometry(dims, spacingUm, { axisKind = "z", frameInterval = null } = {}) {
  assertValidDims(dims);
  const [nz, ny, nx] = dims;
  const s = resolvedSpacingUm(spacingUm);
  const mm = { x: s.x / 1000, y: s.y / 1000, z: s.z / 1000 };
  const isMovie = axisKind === "t" && nz > 1;
  const dt = frameInterval > 0 ? frameInterval : 1;
  return {
    dims: isMovie ? [4, nx, ny, 1, nz, 1, 1, 1] : [3, nx, ny, nz, 1, 1, 1, 1],
    pixDims: isMovie ? [-1, mm.x, mm.y, 1, dt, 0, 0, 0] : [-1, mm.x, mm.y, mm.z, 0, 0, 0, 0],
    xyztUnits: isMovie ? (2 | 8) : 2,
    quatern: [1, 0, 0],
    qoffset: [0, (ny - 1) * mm.y, 0],
    affine: [
      [mm.x, 0, 0, 0],
      [0, -mm.y, 0, (ny - 1) * mm.y],
      [0, 0, isMovie ? 1 : mm.z, 0],
      [0, 0, 0, 1],
    ],
  };
}

const DIM_OFFSET = 40;
const PIXDIM_OFFSET = 76;
const XYZT_UNITS = 123;
const QUATERN = 256;
const QOFFSET = 268;

/** Encodes a float32 `[nz, ny, nx]` volume as an uncompressed NIfTI-1 ArrayBuffer. */
export function stackNifti(data, dims, spacingUm, options = {}) {
  const geometry = niftiGeometry(dims, spacingUm, options);
  const buffer = createNiftiFromVolume({
    hdr: geometry,
    img: data instanceof Float32Array ? data : Float32Array.from(data),
  });
  const view = new DataView(buffer);
  geometry.dims.forEach((value, i) => view.setInt16(DIM_OFFSET + 2 * i, value, true));
  geometry.pixDims.forEach((value, i) => view.setFloat32(PIXDIM_OFFSET + 4 * i, value, true));
  view.setUint8(XYZT_UNITS, geometry.xyztUnits);
  geometry.quatern.forEach((value, i) => view.setFloat32(QUATERN + 4 * i, value, true));
  geometry.qoffset.forEach((value, i) => view.setFloat32(QOFFSET + 4 * i, value, true));
  return buffer;
}

/** Encodes a float32 volume preserving the source NIfTI header when input came from NIfTI. */
export function exportNiftiBuffer(data, sourceVolume) {
  if (sourceVolume.format === "nifti" && sourceVolume.niftiHeader) {
    return createFloat32Nifti(data, sourceVolume.niftiHeader, niftiExportDims(sourceVolume));
  }
  return stackNifti(data, sourceVolume.dims, sourceVolume.spacingUm, {
    axisKind: sourceVolume.axisKind,
    frameInterval: sourceVolume.frameInterval,
  });
}

function omeDescription({ nx, ny, nz, axisKind, spacingUm, frameInterval }) {
  const isMovie = axisKind === "t" && nz > 1;
  const attrs = [
    'ID="Pixels:0"',
    'DimensionOrder="XYZCT"',
    'Type="float"',
    `SizeX="${nx}"`,
    `SizeY="${ny}"`,
    `SizeZ="${isMovie ? 1 : nz}"`,
    'SizeC="1"',
    `SizeT="${isMovie ? nz : 1}"`,
  ];
  if (spacingUm?.x > 0) attrs.push(`PhysicalSizeX="${spacingUm.x}"`, 'PhysicalSizeXUnit="µm"');
  if (spacingUm?.y > 0) attrs.push(`PhysicalSizeY="${spacingUm.y}"`, 'PhysicalSizeYUnit="µm"');
  if (!isMovie && spacingUm?.z > 0) attrs.push(`PhysicalSizeZ="${spacingUm.z}"`, 'PhysicalSizeZUnit="µm"');
  if (isMovie && frameInterval > 0) attrs.push(`TimeIncrement="${frameInterval}"`, 'TimeIncrementUnit="s"');
  return `<?xml version="1.0" encoding="UTF-8"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels ${attrs.join(" ")}/></Image></OME>`;
}

/**
 * Encodes a float32 `[nz, ny, nx]` volume as an ImageJ-compatible TIFF stack (or OME-XML TIFF
 * when only one of X/Y is calibrated, so single-axis calibration is preserved without fabricating
 * spacing on the unspecified axis), preserving micrometre calibration, Z spacing, and temporal
 * `frameInterval` on 2D+T movies.
 */
export function stackTiff(data, dims, spacingUm, { axisKind = "z", frameInterval = null } = {}) {
  const [nz, ny, nx] = dims;
  const hasX = spacingUm?.x > 0;
  const hasY = spacingUm?.y > 0;
  if (hasX !== hasY) {
    return writeTiffStack({
      width: nx,
      height: ny,
      data,
      description: omeDescription({ nx, ny, nz, axisKind, spacingUm, frameInterval }),
    });
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const hasXY = hasX && hasY;
  const descOpts = {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
  };
  if (hasXY) descOpts.unit = "micron";
  if (axisKind === "t" && nz > 1) {
    descOpts.frames = nz;
    if (frameInterval > 0) descOpts.frameInterval = frameInterval;
  } else {
    descOpts.slices = nz;
    if (spacingUm?.z > 0) {
      descOpts.spacing = spacingUm.z;
      descOpts.unit = "micron";
    }
  }
  const description = imagejDescription(descOpts);
  return writeTiffStack({
    width: nx,
    height: ny,
    data,
    description,
    ...(hasXY ? { pixelSize: { x: spacingUm.x, y: spacingUm.y } } : {}),
  });
}

/** Builds a structured, replayable provenance summary for one denoising run. */
export function provenance({ app = "denoise", input, dims, axisKind, settings, details, diagnostics, seconds }) {
  return {
    app,
    input,
    dimensions: { x: dims[2], y: dims[1], [axisKind === "t" ? "t" : "z"]: dims[0] },
    method: METHODS[settings.method]?.label ?? settings.method,
    methodId: settings.method,
    settings: effectiveSettings(settings),
    details,
    diagnostics: {
      inputNoiseSigma: Number(diagnostics.inputNoiseSigma.toPrecision(4)),
      denoisedNoiseSigma: Number(diagnostics.denoisedNoiseSigma.toPrecision(4)),
      residualMean: Number(diagnostics.residualMean.toPrecision(4)),
      residualStd: Number(diagnostics.residualStd.toPrecision(4)),
      residualAutocorrX: Number(diagnostics.residualAutocorrX.toFixed(4)),
      residualAutocorrY: Number(diagnostics.residualAutocorrY.toFixed(4)),
      ...(diagnostics.residualAutocorrZ === null ? {} : { residualAutocorrZ: Number(diagnostics.residualAutocorrZ.toFixed(4)) }),
      residualMaxAbsAutocorr: Number(diagnostics.residualMaxAbsAutocorr.toFixed(4)),
      noiseFloorDropDb: Number(diagnostics.noiseFloorDropDb.toFixed(2)),
      structureWarning: diagnostics.structureWarning,
    },
    ...(seconds === undefined ? {} : { seconds }),
  };
}
