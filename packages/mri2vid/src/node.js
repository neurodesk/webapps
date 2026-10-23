// The mri2vid command line: the web app's readers, series selection and frame pipeline,
// with frames drawn into buffers (raster.js) and encoded by libvpx (encoder.js) instead of
// a canvas and WebCodecs.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { convertDicom as runDcm2niix } from '@neurodesk/node-drivers/dcm2niix';
import packageJson from '../package.json' with { type: 'json' };
import { encodeVp9 } from './encoder.js';
import { decodeVideo, inspectVideo } from './inspect.js';
import {
  INTERPOLATIONS, defaultNorm, orientationGeometry, renderFrame, resolveSliceIndices,
} from './pipeline.js';
import { drawLabel, rasterize, rgbToI420, sliceLabel } from './raster.js';
import { VOLUME_REDUCTIONS } from './readers/nifti.js';
import { discoverSources, loadSource, outputFileName } from './sources.js';
import { CONTAINERS, evenDim } from './video.js';
import { ORIENTATIONS, makeVolume } from './volume.js';

// The web app's encode-volume and encode-dicom automation parameters, as options.
export const OPTIONS = {
  orientation: { type: 'string', enum: ORIENTATIONS, default: 'sagittal', description: 'Slice orientation.' },
  fps: { type: 'number', minimum: 1, maximum: 120, default: 20, description: 'Frames per second.' },
  start: { type: 'integer', minimum: 0, description: 'First slice index (zero-based).' },
  end: { type: 'integer', minimum: 0, description: 'Exclusive end slice index (zero-based).' },
  step: { type: 'integer', minimum: 1, default: 1, description: 'Slice step.' },
  annotate: { type: 'boolean', default: false, description: 'Add slice position labels.' },
  format: { type: 'string', enum: CONTAINERS, default: 'webm', description: 'Output video container.' },
  colorNormalize: { type: 'boolean', default: false, description: 'Normalize RGB channels.' },
  upscale: { type: 'number', minimum: 1, maximum: 8, default: 1, description: 'Output spatial scale.' },
  interpolation: { type: 'string', enum: INTERPOLATIONS, default: 'bilinear', description: 'Resampling interpolation.' },
  seriesUid: { type: 'string', description: 'SeriesInstanceUID to encode when the input holds several series.' },
  mosaicReduce: { type: 'string', enum: VOLUME_REDUCTIONS, default: 'first', description: 'Collapse a 4D DICOM series, such as a Siemens mosaic run.' },
};

/** `colorNormalize` is `--color-normalize` on the command line. */
export const optionName = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** Settings from command-line strings (booleans as true), checked and with their defaults filled in. */
export function parseOptions(values = {}) {
  const settings = {};
  for (const [key, option] of Object.entries(OPTIONS)) {
    const flag = `--${optionName(key)}`;
    const value = values[key];
    if (value === undefined) {
      if (option.default !== undefined) settings[key] = option.default;
      continue;
    }
    if (option.type === 'boolean') {
      settings[key] = value === true || value === 'true';
      continue;
    }
    if (option.type === 'string') {
      if (option.enum && !option.enum.includes(value)) throw new Error(`${flag} must be one of ${option.enum.join(', ')}, not "${value}".`);
      settings[key] = value;
      continue;
    }
    const number = typeof value === 'number' ? value : Number(String(value).trim() || NaN);
    if (!Number.isFinite(number)) throw new Error(`${flag} must be a number, not "${value}".`);
    if (option.type === 'integer' && !Number.isInteger(number)) throw new Error(`${flag} must be a whole number, not "${value}".`);
    if (option.minimum !== undefined && number < option.minimum) throw new Error(`${flag} must be at least ${option.minimum}.`);
    if (option.maximum !== undefined && number > option.maximum) throw new Error(`${flag} must be at most ${option.maximum}.`);
    settings[key] = number;
  }
  return settings;
}

// Every file under the given files and directories, as { name, path } in a stable order.
// A file in a directory is named by its path from the directory's parent, as a browser
// folder upload names it.
async function inputRecords(paths) {
  const records = [];
  const walk = async (directory, root) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, root);
      else if (entry.isFile()) records.push({ name: relative(root, path).split('\\').join('/'), path });
    }
  };
  for (const input of paths) {
    const path = resolve(input);
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error(`${input} does not exist.`);
    if (info.isDirectory()) await walk(path, resolve(path, '..'));
    else records.push({ name: basename(path), path });
  }
  return records;
}

const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function readPrefix(record, bytes) {
  const file = await open(record.path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return arrayBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

const readBytes = async (record) => arrayBuffer(await readFile(record.path));

// The JPEG build of dcm2niix, which also decodes JPEG 2000 and JPEG-LS.
export async function convertDicom(files) {
  const { default: factory } = await import(new URL('dcm2niix.jpeg.js', import.meta.resolve('@niivue/dcm2niix')).href);
  return runDcm2niix(files, factory);
}

function describe(source) {
  const id = source.seriesUid ?? source.label;
  const slices = source.sliceCount ? `, ${source.sliceCount} slices` : '';
  return `  ${id}  ${source.label} (${source.classification?.label ?? source.kind}${slices})`;
}

// The one series or volume to encode, as the automation operation picks it: the input must
// hold exactly one, or --series-uid must name one.
function chooseSource(sources, seriesUid) {
  if (!sources.length) throw new Error('No readable DICOM, NIfTI, or MGZ files found.');
  const candidates = seriesUid ? sources.filter((s) => s.seriesUid === seriesUid) : sources;
  if (candidates.length === 1) return candidates[0];
  if (seriesUid) throw new Error(`No DICOM series has SeriesInstanceUID ${seriesUid}. Found:\n${sources.map(describe).join('\n')}`);
  throw new Error(`The input holds ${sources.length} series or volumes. Give one file, or choose a DICOM series with --series-uid:\n${sources.map(describe).join('\n')}`);
}

async function assertNewOutput(directory) {
  const entries = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

async function writeAtomically(path, bytes) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * Encodes a volume's slices into a VP9 video. Returns the file's bytes with what the web
 * app reports for the same run: codec, container, frame count, coded size and frame rate.
 */
export async function encodeVolume(vol, settings, { onProgress = () => {} } = {}) {
  const geo = orientationGeometry(vol.dims, settings.orientation);
  const sliceIndices = resolveSliceIndices(geo.nFrames, settings);
  const norm = defaultNorm(vol, settings);
  const render = (i) => renderFrame(vol, settings.orientation, sliceIndices[i], norm, settings);
  const first = render(0);
  const width = evenDim(first.fW);
  const height = evenDim(first.fH);
  const bytes = await encodeVp9({
    nFrames: sliceIndices.length,
    fps: settings.fps,
    width,
    height,
    container: settings.format,
    frameAt: (i) => {
      const { frame, fW, fH, channels, sliceIndex } = i === 0 ? first : render(i);
      const rgb = rasterize(frame, fW, fH, channels, width, height);
      if (settings.annotate) drawLabel(rgb, width, height, sliceLabel(sliceIndex, geo.nFrames), fH);
      return rgbToI420(rgb, width, height);
    },
    onProgress,
  });
  return {
    bytes,
    summary: { codec: 'VP9', container: settings.format, frames: sliceIndices.length, width, height, fps: settings.fps },
    sliceIndices,
  };
}

/**
 * Reads the inputs (files and directories), picks the series or volume, and writes its video
 * into `output`, a new or empty directory, under the name the web app downloads it as.
 */
export async function encode({ inputs, output, parameters = {}, onProgress = () => {} } = {}) {
  if (!Array.isArray(inputs) || !inputs.length || !output) throw new Error('Give the input files or directories and a new output directory.');
  const settings = parseOptions(parameters);
  const destination = resolve(output);
  await assertNewOutput(destination);
  onProgress('Reading files');
  const records = await inputRecords(inputs);
  const { sources, unreadable } = await discoverSources(records, {
    readPrefix,
    onSkip: (record, error) => onProgress(`Skipped ${record.name}: ${error.message}`),
  });
  if (unreadable) onProgress(`${unreadable} file(s) could not be read and were skipped`);
  const source = chooseSource(sources, settings.seriesUid);
  onProgress(`Loading ${source.label}`);
  const vol = await loadSource(source, { readBytes, convertDicom, mosaicReduce: settings.mosaicReduce });
  if (vol.meta?.note) onProgress(vol.meta.note);
  onProgress(`Loaded ${vol.dims.join('x')}${vol.channels === 3 ? ' RGB' : ''}; encoding ${settings.orientation} at ${settings.fps} fps`);
  let reported = 0;
  const result = await encodeVolume(vol, settings, {
    onProgress: (fraction) => {
      const percent = Math.floor(fraction * 10) * 10;
      if (percent > reported) onProgress(`Encoded ${percent} %`);
      reported = Math.max(reported, percent);
    },
  });
  const name = outputFileName(source.label, settings.orientation, settings.format);
  await mkdir(destination, { recursive: true });
  await writeAtomically(join(destination, name), result.bytes);
  return {
    output: join(destination, name),
    summary: result.summary,
    source: { kind: source.kind, label: source.label, seriesUid: source.seriesUid ?? null },
    sliceIndices: result.sliceIndices,
  };
}

const psnr = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum ? 10 * Math.log10((255 * 255 * a.length) / sum) : Infinity;
};

/** Encodes and decodes a small gradient phantom in both containers inside this runtime. */
export async function checkInstallation() {
  const dims = [24, 32, 6];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  data.forEach((_, i) => { data[i] = (i % 97) * 3 + Math.floor(i / 768) * 40; });
  const vol = makeVolume({ dims, data });
  const settings = parseOptions({ orientation: 'axial', fps: 5 });
  const results = {};
  for (const format of CONTAINERS) {
    const { bytes, summary } = await encodeVolume(vol, { ...settings, format });
    const facts = await inspectVideo(bytes);
    const frames = await decodeVideo(bytes);
    const quality = Math.min(...frames.map((f, k) => {
      const source = renderFrame(vol, 'axial', k, defaultNorm(vol), {});
      return psnr(f.y, source.frame);
    }));
    if (facts.codec !== 'vp9' || facts.frames !== dims[0] || frames.length !== dims[0] || quality < 30) {
      throw new Error(`The ${format} encoder failed its phantom check (${facts.codec}, ${frames.length} frames, ${quality.toFixed(1)} dB).`);
    }
    results[format] = { frames: summary.frames, width: summary.width, height: summary.height, minimumPsnrDb: Number(quality.toFixed(1)) };
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    mri2vid: packageJson.version,
    phantom: results,
  };
}
