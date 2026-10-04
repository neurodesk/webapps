import { gaussian, readVolume, writeVolume } from '../../synthsr/src/index.js';
import * as nifti from 'nifti-reader-js';
import packageJson from '../package.json' with { type: 'json' };

export function asBuffer(bytes) {
  return bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function readAdditional(buffer, type = 'image') {
  if (!['image', 'binary'].includes(type)) throw new Error('Accompanying input type must be image or binary.');
  buffer = asBuffer(buffer);
  if (type === 'image') return readVolume(buffer);
  if (nifti.isCompressed(buffer)) buffer = nifti.decompress(buffer);
  const volume = readVolume(buffer);
  const header = nifti.readHeader(buffer);
  const formats = {
    2: ['getUint8', 1],
    4: ['getInt16', 2],
    8: ['getInt32', 4],
    16: ['getFloat32', 4],
    64: ['getFloat64', 8],
    256: ['getInt8', 1],
    512: ['getUint16', 2],
    768: ['getUint32', 4],
  };
  const format = formats[header.datatypeCode];
  if (!format) throw new Error(`Unsupported NIfTI datatype ${header.datatypeCode}.`);
  const [method, stride] = format;
  const raw = new DataView(nifti.readImage(header, buffer));
  const slope = header.scl_slope || 1;
  const intercept = header.scl_slope ? header.scl_inter : 0;
  let firstValue;
  let secondValue;
  for (let index = 0; index < volume.data.length; index += 1) {
    const value = raw[method](index * stride, header.littleEndian) * slope + intercept;
    if (!Number.isFinite(value)) throw new Error('Lesion maps must contain finite values.');
    if (index === 0) firstValue = value;
    else if (value !== firstValue && secondValue === undefined) secondValue = value;
    else if (value !== firstValue && value !== secondValue) throw new Error('Lesion maps must contain no more than two discrete values.');
  }
  const foreground = secondValue === undefined ? firstValue : Math.max(firstValue, secondValue);
  volume.data = Uint8Array.from(volume.data, (_, index) => {
    const value = raw[method](index * stride, header.littleEndian) * slope + intercept;
    return secondValue === undefined ? Number(value !== 0) : Number(value === foreground);
  });
  return volume;
}

export function sameGeometry(a, b) {
  return a.dims.every((dimension, index) => dimension === b.dims[index])
    && a.affine.every((row, index) => row.every((value, column) => Math.abs(value - b.affine[index][column]) <= 0.01));
}

export function compatibleMaskGeometry(reference, mask) {
  if (reference.dims.some((dimension, index) => Math.abs(dimension - mask.dims[index]) > 1)) return false;
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (Math.abs(reference.affine[row][column] - mask.affine[row][column]) > 0.01) return false;
    }
    const tolerance = Math.max(
      reference.affine[row].slice(0, 3).reduce((sum, value) => sum + Math.abs(value), 0),
      mask.affine[row].slice(0, 3).reduce((sum, value) => sum + Math.abs(value), 0),
    ) + 0.01;
    if (Math.abs(reference.affine[row][3] - mask.affine[row][3]) > tolerance) return false;
  }
  return true;
}

export function prepareAdditional(volume, type) {
  if (!['image', 'binary'].includes(type)) throw new Error('Accompanying input type must be image or binary.');
  if (type !== 'binary') return volume;
  if (volume.data.some((value) => value !== 0 && value !== 1)) throw new Error('Lesion maps must contain only 0 and 1.');
  const sigma = 3 / (2 * Math.sqrt(2 * Math.log(2)));
  const sigmas = [0, 1, 2].map((axis) => sigma / Math.hypot(...volume.affine.slice(0, 3).map((row) => row[axis])));
  return { ...volume, data: gaussian(volume.data, volume.dims, sigmas) };
}

export function thresholdBinary(volume) {
  return { ...volume, data: Uint8Array.from(volume.data, (value) => value >= 0.5 ? 1 : 0) };
}

function hasTwoValues(volume) {
  const first = volume.data[0];
  let second;
  for (const value of volume.data) {
    if (value === first || value === second) continue;
    if (second === undefined) second = value;
    else return false;
  }
  return second !== undefined;
}

function splitNiftiName(name) {
  const basename = String(name || 'input.nii.gz').split(/[\\/]/).at(-1);
  const match = basename.match(/^(.*?)(\.nii(?:\.gz)?)$/i);
  if (!match) throw new Error('SYNcro inputs must be NIfTI images (.nii or .nii.gz).');
  return { stem: match[1], extension: match[2].toLowerCase() };
}

function named(prefix, name) {
  const { stem, extension } = splitNiftiName(name);
  return `${prefix}${stem}${extension}`;
}

function background(volume, ct) {
  return ct ? volume.data.reduce((result, item) => Math.min(result, item), 0) : 0;
}

function validateRegisteredBrain(bytes, template) {
  const brain = readVolume(asBuffer(bytes));
  if (!sameGeometry(brain, template)) throw new Error('Normalization failed: registered brain does not match the MNI template grid.');
  let templateSupport = 0;
  let overlap = 0;
  for (let index = 0; index < template.data.length; index += 1) {
    if (template.data[index] <= 0) continue;
    templateSupport += 1;
    if (brain.data[index] > 0) overlap += 1;
  }
  if (templateSupport === 0) throw new Error('Invalid MNI template: no positive brain voxels.');
  if (overlap / templateSupport < 0.01) {
    throw new Error(`Normalization failed: registered brain covers too little of the MNI template (${overlap}/${templateSupport} positive voxels, ${(100 * overlap / templateSupport).toFixed(2)}%; minimum 1%). Check that the scan contains the brain and has the correct orientation, and inspect the registration.`);
  }
}

function defaultImageMath() {
  return {
    async smoothLesion({ buffer }) {
      const volume = prepareAdditional(readAdditional(buffer, 'binary'), 'binary');
      return new Uint8Array(writeVolume(volume, 'Smoothed lesion map'));
    },
    async thresholdLesion({ buffer }) {
      return new Uint8Array(writeVolume(thresholdBinary(readVolume(asBuffer(buffer))), 'Normalized lesion map'));
    },
    async mask({ image, mask }) {
      const source = readVolume(asBuffer(image));
      const brain = readVolume(asBuffer(mask));
      if (!sameGeometry(source, brain)) throw new Error('Normalized brain and primary image grids differ.');
      return new Uint8Array(writeVolume({ ...source, data: source.data.map((value, index) => brain.data[index] ? value : 0) }, 'Normalized brain-extracted primary image'));
    },
  };
}

// Inference, image maths and registration runtime ownership stay in injected adapters.
export async function runSyncro({
  input,
  inputName = 'input.nii.gz',
  lesion = null,
  pathological = null,
  template,
  synthesize,
  extractBrain,
  registration,
  imageMath = defaultImageMath(),
  represent = async ({ buffer }) => new Uint8Array(buffer),
  brainExtractor = 'mindgrab',
  normalization = 'greedy',
  keepSynth = false,
  ct = false,
  onProgress = () => {},
  onStage = () => {},
}) {
  if (!['mindgrab', 'synthstrip'].includes(brainExtractor)) throw new Error('Brain extractor must be mindgrab or synthstrip.');
  if (!['greedy', 'ants'].includes(normalization)) throw new Error('Normalization must be greedy or ants.');
  const names = {
    nativeSynthetic: keepSynth ? named('t1', inputName) : null,
    syntheticBrain: named('wbt1', inputName),
    normalizedPrimary: named('w', inputName),
    primaryBrain: named('wb', inputName),
    pathological: pathological ? named('w', pathological.name) : null,
    lesion: lesion ? named('w', lesion.name) : null,
  };
  const plannedNames = Object.values(names).filter(Boolean);
  if (new Set(plannedNames).size !== plannedNames.length) throw new Error('Input basenames would create duplicate output names. Rename one input and try again.');
  const start = performance.now();
  const timings = {};
  const outputs = {};
  const provenance = { version: packageJson.version, ct, keepSynth, brainExtractor, normalization, stages: {} };
  const inputBuffer = asBuffer(input);
  const volume = readVolume(inputBuffer);
  const fixed = readVolume(asBuffer(template));
  const outputSpace = { dims: fixed.dims, affine: fixed.affine };
  if (hasTwoValues(volume)) throw new Error('The primary scan must be a scalar image, not a binary mask.');
  const pathologicalVolume = pathological ? readAdditional(pathological.buffer, 'image') : null;
  if (pathologicalVolume && hasTwoValues(pathologicalVolume)) throw new Error('The pathological modality scan must be a scalar image, not a binary mask.');
  const lesionVolume = lesion ? readAdditional(lesion.buffer, 'binary') : null;
  const lesionReference = pathologicalVolume || volume;
  if (lesionVolume && !compatibleMaskGeometry(lesionReference, lesionVolume)) {
    throw new Error(`The lesion map must match the ${pathologicalVolume ? 'pathological modality' : 'primary'} scan grid.`);
  }
  const compressed = splitNiftiName(inputName).extension.endsWith('.gz');
  async function stage(name, task) {
    onProgress(name, 0);
    const stageStart = performance.now();
    const result = await task();
    timings[name] = (performance.now() - stageStart) / 1000;
    await onStage(name, result);
    return result;
  }
  let pathologicalAffine = null;
  if (pathological) {
    pathologicalAffine = await stage('pathological-registration', () => registration.registerAffine({
      fixed: writeVolume(volume, 'Primary scan'),
      moving: writeVolume(pathologicalVolume, 'Pathological modality scan'),
    }));
  }
  const synthetic = await stage('synthsr', () => synthesize({
    buffer: inputBuffer,
    ct,
    onProgress: (value, message) => onProgress('synthsr', value, message),
  }));
  provenance.stages.synthsr = synthetic.provenance;
  if (keepSynth) {
    outputs[names.nativeSynthetic] = await represent({ buffer: synthetic.buffer, compressed });
  }
  const extractorName = brainExtractor === 'mindgrab' ? 'MindGrab' : 'SynthStrip';
  const extraction = await stage(brainExtractor, () => extractBrain({
    volume: readVolume(synthetic.buffer),
    onProgress: (value, message) => onProgress(brainExtractor, value, message),
  }));
  provenance.stages[brainExtractor] = extraction.provenance;
  const syntheticBrain = writeVolume(extraction.brain, `${extractorName} synthetic brain`);
  const registrationResult = await stage('registration', () => registration.register({
    fixed: writeVolume(fixed, 'MNI template'),
    moving: syntheticBrain,
    compressed,
  }));
  try {
    validateRegisteredBrain(registrationResult.warped, fixed);
    outputs[names.syntheticBrain] = registrationResult.warped;
    const apply = async (moving, options = {}) => registration.apply({
      registration: registrationResult,
      moving,
      compressed: options.compressed ?? compressed,
      interpolation: options.interpolation || 'linear',
      fill: options.fill ?? 0,
      precedingMatrix: options.precedingMatrix || null,
      precedingFixed: options.precedingFixed || null,
    });
    outputs[names.normalizedPrimary] = await stage('resampling', () => apply(
      writeVolume(volume, 'Primary scan'),
      { fill: background(volume, ct) },
    ));
    if (pathological) {
      outputs[names.pathological] = await apply(writeVolume(pathologicalVolume, 'Pathological modality scan'), {
        compressed: splitNiftiName(pathological.name).extension.endsWith('.gz'),
        fill: 0,
        precedingMatrix: pathologicalAffine,
        precedingFixed: writeVolume(volume, 'Primary scan'),
      });
    }
    if (lesion) {
      const prepared = await imageMath.smoothLesion({
        buffer: writeVolume(lesionVolume, 'Lesion map'),
        name: lesion.name,
      });
      const warped = await apply(prepared, {
        compressed: splitNiftiName(lesion.name).extension.endsWith('.gz'),
        interpolation: 'nearest',
        precedingMatrix: pathologicalAffine,
        precedingFixed: pathologicalAffine ? writeVolume(volume, 'Primary scan') : null,
      });
      outputs[names.lesion] = await represent({
        buffer: await imageMath.thresholdLesion({ buffer: warped, name: names.lesion }),
        compressed: splitNiftiName(names.lesion).extension.endsWith('.gz'),
      });
    }
    outputs[names.primaryBrain] = await represent({
      buffer: await imageMath.mask({
        image: outputs[names.normalizedPrimary],
        mask: outputs[names.syntheticBrain],
        name: names.primaryBrain,
      }),
      compressed,
    });
    provenance.stages.registration = registration.provenance;
    provenance.inputs = {
      primary: inputName,
      pathological: pathological?.name || null,
      lesion: lesion?.name || null,
      lesionSpace: pathological ? 'pathological' : 'primary',
    };
    provenance.timings = timings;
    provenance.totalSeconds = (performance.now() - start) / 1000;
    provenance.outputSpace = outputSpace;
    provenance.resamplingDatatype = 'float32';
    provenance.synthetic = true;
    onProgress('complete', 1, 'Normalization complete');
    return { outputs, provenance };
  } finally {
    registration.release(registrationResult);
  }
}
