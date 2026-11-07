// The simulated `relion` tool of the reference compute server. It runs no
// RELION program: it checks that every file the job's input STAR files
// reference exists, then writes the command's outputs as small but valid STAR
// and MRC files that reference earlier jobs by project-relative path, so a
// chain of jobs is checked through real references. The file layout is
// documented in docs/architecture/remote-compute-protocol.md ("The simulated
// `relion` tool") so the Rust server can write the same structure.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RELION_DEFINITION, classRanges, relionNumber, relionOutputs } from '../packages/cryo-em/src/spec.js';
import { isInside, matchPattern } from './data-roots.mjs';

export const STAR_VERSION = '# version 50001';
export const MICROGRAPH_SIZE = 64;
export const BOX = 32;
export const PARTICLE_POSITIONS = [[16, 16], [48, 16], [16, 48], [48, 48]];
export const MRC_HEADER_BYTES = 1024;
const MRC_LABEL = 'SIMULATED by the neurodesk-compute reference server';
const OPTICS_GROUP = RELION_DEFINITION.constants.opticsGroupName;

// STAR columns and key-value labels whose values name files. A value may carry
// an image index (`000003@stack.mrcs`) and a type suffix (`file.ctf:mrc`).
export const REFERENCE_LABELS = new Set([
  'rlnMicrographMovieName',
  'rlnMicrographName',
  'rlnMicrographNameNoDW',
  'rlnMicrographMetadata',
  'rlnMicrographGainName',
  'rlnCtfPowerSpectrum',
  'rlnCtfImage',
  'rlnMicrographCoordinates',
  'rlnImageName',
  'rlnReferenceImage',
  'rlnModelStarFile',
  'rlnExperimentalDataStarFile',
  'rlnUnfilteredMapHalf1',
  'rlnUnfilteredMapHalf2',
  'rlnMaskName',
]);

// ---------------------------------------------------------------------------
// MRC

/**
 * An MRC2014 file: 1024-byte header, mode 2 (float32), little endian, no
 * extended header. `stack` writes an image stack (ISPG 0, MZ 1); otherwise a
 * volume or single image (ISPG 1, MZ = NZ).
 */
export function writeMrc({ nx, ny, nz = 1, data, angpix = 1, stack = false }) {
  if (data.length !== nx * ny * nz) throw new Error('MRC data length does not match its dimensions');
  const header = Buffer.alloc(MRC_HEADER_BYTES);
  const mz = stack ? 1 : nz;
  let minimum = Infinity;
  let maximum = -Infinity;
  let sum = 0;
  for (const value of data) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    sum += value;
  }
  const mean = sum / data.length;
  let squares = 0;
  for (const value of data) squares += (value - mean) ** 2;
  header.writeInt32LE(nx, 0);
  header.writeInt32LE(ny, 4);
  header.writeInt32LE(nz, 8);
  header.writeInt32LE(2, 12);
  header.writeInt32LE(nx, 28);
  header.writeInt32LE(ny, 32);
  header.writeInt32LE(mz, 36);
  header.writeFloatLE(nx * angpix, 40);
  header.writeFloatLE(ny * angpix, 44);
  header.writeFloatLE(mz * angpix, 48);
  header.writeFloatLE(90, 52);
  header.writeFloatLE(90, 56);
  header.writeFloatLE(90, 60);
  header.writeInt32LE(1, 64);
  header.writeInt32LE(2, 68);
  header.writeInt32LE(3, 72);
  header.writeFloatLE(minimum, 76);
  header.writeFloatLE(maximum, 80);
  header.writeFloatLE(mean, 84);
  header.writeInt32LE(stack ? 0 : 1, 88);
  header.writeInt32LE(20140, 108);
  header.write('MAP ', 208, 'latin1');
  header.writeUInt8(0x44, 212);
  header.writeUInt8(0x44, 213);
  header.writeFloatLE(Math.sqrt(squares / data.length), 216);
  header.writeInt32LE(1, 220);
  header.write(MRC_LABEL, 224, 'latin1');
  const body = Buffer.alloc(data.length * 4);
  for (let index = 0; index < data.length; index += 1) body.writeFloatLE(data[index], index * 4);
  return Buffer.concat([header, body]);
}

/** Whether `bytes` carries the MRC map magic `MAP ` at byte 208. */
export function isMrc(bytes) {
  return bytes.length >= 212 && bytes.toString('latin1', 208, 212) === 'MAP ';
}

/** Dimensions and pixel size from an MRC header, or null when it is not one. */
export function readMrcHeader(bytes) {
  if (!isMrc(bytes) || bytes.length < MRC_HEADER_BYTES) return null;
  const nx = bytes.readInt32LE(0);
  const ny = bytes.readInt32LE(4);
  const nz = bytes.readInt32LE(8);
  const mx = bytes.readInt32LE(28);
  const cellX = bytes.readFloatLE(40);
  return { nx, ny, nz, angpix: mx > 0 && cellX > 0 ? cellX / mx : 1 };
}

function readHeaderBytes(path) {
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(MRC_HEADER_BYTES);
    const read = readSync(descriptor, bytes, 0, MRC_HEADER_BYTES, 0);
    return bytes.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

// A disk of radius `radius` centred at (cx, cy) in an n x n image.
function disk(n, cx, cy, radius, value = 1) {
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) data[y * n + x] = value;
    }
  }
  return data;
}

// A sphere of radius `radius` in an n^3 volume with a cosine edge `edge` voxels wide.
function sphere(n, radius, edge = 2, scale = 1) {
  const data = new Float32Array(n * n * n);
  const centre = n / 2;
  for (let z = 0; z < n; z += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const distance = Math.hypot(x - centre, y - centre, z - centre);
        let value = 0;
        if (distance <= radius) value = 1;
        else if (distance < radius + edge) value = 0.5 + 0.5 * Math.cos(Math.PI * (distance - radius) / edge);
        data[(z * n + y) * n + x] = value * scale;
      }
    }
  }
  return data;
}

function micrograph() {
  const data = new Float32Array(MICROGRAPH_SIZE * MICROGRAPH_SIZE);
  for (const [cx, cy] of PARTICLE_POSITIONS) {
    const blob = disk(MICROGRAPH_SIZE, cx, cy, 8, -1);
    for (let index = 0; index < data.length; index += 1) data[index] += blob[index];
  }
  return data;
}

function imageStack(count, radiusOf) {
  const data = new Float32Array(count * BOX * BOX);
  for (let index = 0; index < count; index += 1) data.set(disk(BOX, BOX / 2, BOX / 2, radiusOf(index)), index * BOX * BOX);
  return data;
}

// ---------------------------------------------------------------------------
// STAR

function formatValue(value) {
  const text = typeof value === 'number' ? relionNumber(value) : String(value);
  if (text === '') return '""';
  if (/\s/.test(text)) return `"${text}"`;
  return text;
}

/** A loop block: `columns` are labels without the leading underscore. */
export function loopBlock(name, columns, rows) {
  return { name, columns, rows };
}

/** A key-value block: `pairs` is a list of [label, value]. */
export function pairsBlock(name, pairs) {
  return { name, pairs };
}

/**
 * STAR text as RELION 5 writes it: each block preceded by `# version 50001`,
 * `data_<name>`, then `loop_` with `_label #n` headers and one row per line,
 * or one `_label value` line per pair.
 */
export function formatStar(blocks) {
  let text = '';
  for (const block of blocks) {
    text += `\n${STAR_VERSION}\n\ndata_${block.name}\n\n`;
    if (block.pairs) {
      const width = Math.max(...block.pairs.map(([label]) => label.length)) + 2;
      for (const [label, value] of block.pairs) text += `_${label.padEnd(width)}${formatValue(value)}\n`;
    } else {
      text += 'loop_\n';
      block.columns.forEach((label, index) => {
        text += `_${label} #${index + 1}\n`;
      });
      for (const row of block.rows) text += `${row.map(formatValue).join(' ')}\n`;
    }
    text += '\n';
  }
  return text;
}

function tokens(line) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line)) !== null) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

/**
 * Parse STAR text into blocks `{ name, pairs, columns, rows }`: `pairs` is a
 * Map for key-value blocks, `columns`/`rows` hold a loop. Values stay strings.
 */
export function parseStar(text) {
  const blocks = [];
  let block = null;
  let inLoop = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('data_')) {
      block = { name: line.slice(5), pairs: new Map(), columns: [], rows: [] };
      blocks.push(block);
      inLoop = false;
      continue;
    }
    if (!block) throw new Error('STAR text has content before its first data_ block');
    if (line === 'loop_' || line.startsWith('loop_ ')) {
      inLoop = true;
      continue;
    }
    if (line.startsWith('_')) {
      const [label, value] = tokens(line.slice(1));
      if (inLoop && !block.rows.length) block.columns.push(label);
      else block.pairs.set(label, value ?? '');
      continue;
    }
    if (!inLoop) throw new Error(`unexpected STAR line in data_${block.name}: ${line}`);
    const row = tokens(line);
    if (row.length !== block.columns.length) throw new Error(`a row of data_${block.name} has ${row.length} values for ${block.columns.length} columns`);
    block.rows.push(row);
  }
  return blocks;
}

function findBlock(blocks, name, file) {
  const block = blocks.find(item => item.name === name);
  if (!block) throw new Error(`${file} has no data_${name} block`);
  return block;
}

function cell(block, row, label) {
  const index = block.columns.indexOf(label);
  if (index < 0) throw new Error(`data_${block.name} has no ${label} column`);
  return row[index];
}

// The table with columns set from `entries` ([label, (row, index) => value]),
// replacing existing columns of the same label and appending new ones.
function withColumns(block, entries) {
  const columns = [...block.columns];
  const rows = block.rows.map(row => [...row]);
  for (const [label, valueOf] of entries) {
    let index = columns.indexOf(label);
    if (index < 0) {
      index = columns.length;
      columns.push(label);
    }
    rows.forEach((row, rowIndex) => {
      row[index] = valueOf(block.rows[rowIndex], rowIndex);
    });
  }
  return loopBlock(block.name, columns, rows);
}

function opticsBlock(block, extra) {
  return withColumns({ name: 'optics', columns: block.columns, rows: block.rows }, extra);
}

// ---------------------------------------------------------------------------
// Paths

/** The pieces of a STAR file reference: path, 1-based image index, type suffix stripped. */
export function parseReference(value) {
  const match = /^(?:(\d+)@)?(.*?)(?::mrcs?)?$/.exec(value);
  return { path: match[2], index: match[1] === undefined ? null : Number(match[1]) };
}

function stem(path) {
  return path.split('/').at(-1).replace(/\.[^.]*$/, '');
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/**
 * The canonical host file a job-visible path names: `/data/<root>/…` inside a
 * data root, anything else relative to the project. Returns `{ path }` or
 * `{ problem }`.
 */
export function locate(context, reference) {
  let base;
  let target;
  if (reference.startsWith('/data/')) {
    const [, , root, ...rest] = reference.split('/');
    base = context.dataRoots.get(root);
    if (!base) return { problem: `names data root ${root}, which the server does not have` };
    target = join(base, ...rest);
  } else if (reference.startsWith('/')) {
    return { problem: 'is an absolute path outside /project and /data' };
  } else {
    base = context.projectDir;
    target = join(base, reference);
  }
  let canonical;
  try {
    canonical = realpathSync(target);
  } catch {
    return { problem: 'does not exist' };
  }
  if (!isInside(base, canonical)) return { problem: 'lies outside the project and the data roots' };
  if (!statSync(canonical).isFile()) return { problem: 'is not a regular file' };
  return { path: canonical };
}

function jobFile(context, name) {
  return join(context.projectDir, context.directory, name);
}

function write(context, name, bytes) {
  const path = jobFile(context, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function readStar(context, reference) {
  const located = locate(context, reference);
  if (!located.path) throw new Error(`${reference} ${located.problem}`);
  return parseStar(readFileSync(located.path, 'utf8'));
}

function readMrc(context, reference) {
  const located = locate(context, reference);
  if (!located.path) throw new Error(`${reference} ${located.problem}`);
  const header = readMrcHeader(readHeaderBytes(located.path));
  if (!header) throw new Error(`${reference} is not an MRC file`);
  return header;
}

// ---------------------------------------------------------------------------
// Reference check

/**
 * Throw an Error naming the first file the job needs that is missing: each
 * input, every file its STAR files reference (recursively through referenced
 * STAR files), each referenced image index within its stack, and for
 * postprocess the other half map.
 */
export function checkReferences(context) {
  const { validated, inputPaths } = context;
  const scanned = new Set();
  const headers = new Map();
  const need = (reference, from) => {
    const located = locate(context, reference);
    if (!located.path) throw new Error(`${from} references ${reference}, which ${located.problem}`);
    return located.path;
  };
  const requireMrc = (reference, from) => {
    const path = need(reference, from);
    if (!headers.has(path)) headers.set(path, readMrcHeader(readHeaderBytes(path)));
    const header = headers.get(path);
    if (!header) throw new Error(`${from} references ${reference}, which is not an MRC file`);
    return header;
  };
  const scan = (reference, from) => {
    const path = need(reference, from);
    if (scanned.has(path)) return;
    scanned.add(path);
    let blocks;
    try {
      blocks = parseStar(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`${reference} is not a valid STAR file: ${error.message}`);
    }
    const values = [];
    for (const block of blocks) {
      for (const [label, value] of block.pairs) {
        if (REFERENCE_LABELS.has(label)) values.push(value);
      }
      block.columns.forEach((label, index) => {
        if (REFERENCE_LABELS.has(label)) values.push(...block.rows.map(row => row[index]));
      });
    }
    for (const value of values) {
      const target = parseReference(value);
      if (target.index !== null) {
        const header = requireMrc(target.path, reference);
        if (target.index < 1 || target.index > header.nz) throw new Error(`${reference} references image ${target.index} of ${target.path}, which has ${header.nz}`);
      } else if (target.path.endsWith('.star')) {
        scan(target.path, reference);
      } else {
        need(target.path, reference);
      }
    }
  };
  for (const [name, value] of Object.entries(validated.inputs)) {
    const from = `inputs.${name}`;
    if (typeof value === 'object' && 'pattern' in value) {
      const root = context.dataRoots.get(value.root);
      if (!root) throw new Error(`${from} names data root ${value.root}, which the server does not have`);
      try {
        matchPattern(root, value.path, value.pattern);
      } catch (error) {
        throw new Error(`${from}: ${error.message}`);
      }
      continue;
    }
    const path = inputPaths[name];
    if (path.endsWith('.star')) scan(path, from);
    else if (/\.mrcs?$/.test(path) && !path.startsWith('/data/')) requireMrc(path, from);
    else need(path, from);
  }
  if (validated.command === 'postprocess') {
    const [half1, half2] = halfMaps(inputPaths.halfMap);
    const first = requireMrc(half1, 'inputs.halfMap');
    const second = requireMrc(half2, 'inputs.halfMap');
    const mask = requireMrc(inputPaths.mask, 'inputs.mask');
    if (first.nx !== second.nx || first.nx !== mask.nx) throw new Error('the half maps and the mask differ in size');
  }
}

function halfMaps(path) {
  return [path.replace('half2', 'half1'), path.replace('half1', 'half2')];
}

// ---------------------------------------------------------------------------
// Synthetic log

/** The command lines the job would run, with the MPI launcher. */
export function launchLines(command) {
  const quote = word => {
    if (word === '') return '""';
    if (/[\s"'`$\\]/.test(word)) return `"${word.replace(/(["\\$`])/g, '\\$1')}"`;
    return word;
  };
  const line = step => [step.program, ...step.args].map(quote).join(' ');
  const launcher = command.mpiRanks > 1 ? `mpirun --bind-to none -np ${command.mpiRanks} ` : '';
  return [`${launcher}${line(command)}`, ...command.then.map(line)];
}

const BAR_HEADINGS = {
  motioncorr: ' Correcting beam-induced motions using our own implementation ...',
  ctffind: ' Estimating CTF parameters using Alexis Rohou\'s and Niko Grigorieff\'s CTFFIND4.1 ...',
  autopick: ' Autopicking ...',
  extract: ' Extracting particles from the micrographs ...',
};

function bar(done, total) {
  const elapsed = (done * 0.5).toFixed(2).padStart(6);
  const estimate = (total * 0.5).toFixed(2).padStart(6);
  return `${elapsed}/${estimate} sec ${'.'.repeat(Math.floor((60 * done) / total))}~~(,_,">`;
}

/**
 * Lines in the formats RELION prints, which the server passes through
 * parseRelionLogLine for level and progress.
 */
export function syntheticLog(validated) {
  const { command, options } = validated;
  if (BAR_HEADINGS[command]) {
    return [BAR_HEADINGS[command], '000/??? sec ~~(,_,">', bar(1, 4), bar(2, 4), bar(3, 4), bar(4, 4)];
  }
  if (command === 'class2d' || command === 'initialmodel') {
    const total = command === 'class2d' ? options.nrIterGrad : options.nrIter;
    const iterations = [...new Set([1, Math.round(total / 4), Math.round(total / 2), Math.round((3 * total) / 4), total])].filter(value => value >= 1);
    const lines = iterations.map(iteration => ` Gradient optimisation iteration ${iteration} of ${total} (Step size 0.5)`);
    if (command === 'initialmodel') lines.push(' Aligning the initial model to its symmetry axes ...');
    return lines;
  }
  if (command === 'refine3d') {
    const lines = [];
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      lines.push(` Auto-refine: Iteration= ${iteration}`);
      lines.push(` Auto-refine: Resolution= ${relionNumber(20 / iteration)} (no gain for 0 iter) `);
    }
    lines.push(' Auto-refine: Refinement has converged, entering last iteration where two halves will be combined...');
    return lines;
  }
  const headings = {
    import: ' Importing files ...',
    select: ' Selecting particles ...',
    maskcreate: '== Lowpass filtering initial map ...',
    postprocess: '== Reading input half-reconstructions ...',
  };
  return [headings[command]];
}

// ---------------------------------------------------------------------------
// Outputs per command

function importJob(context) {
  const { options, inputs } = context.validated;
  const { root, path, pattern } = inputs.movies;
  const matched = matchPattern(context.dataRoots.get(root), path, pattern);
  const files = matched.names.map(name => ['/data', root, path, name].filter(part => part !== '').join('/'));
  const opticsColumns = ['rlnOpticsGroupName', 'rlnOpticsGroup', 'rlnMicrographOriginalPixelSize', 'rlnVoltage', 'rlnSphericalAberration', 'rlnAmplitudeContrast'];
  const opticsRow = [OPTICS_GROUP, 1, options.angpix, options.kV, options.Cs, options.Q0];
  if (options.isMultiframe) {
    write(context, 'movies.star', formatStar([
      loopBlock('optics', opticsColumns, [opticsRow]),
      loopBlock('movies', ['rlnMicrographMovieName', 'rlnOpticsGroup'], files.map(file => [file, 1])),
    ]));
    return [` Imported ${files.length} movies`];
  }
  write(context, 'micrographs.star', formatStar([
    loopBlock('optics', [...opticsColumns, 'rlnMicrographPixelSize'], [[...opticsRow, options.angpix]]),
    loopBlock('micrographs', ['rlnMicrographName', 'rlnOpticsGroup'], files.map(file => [file, 1])),
  ]));
  return [` Imported ${files.length} micrographs`];
}

function motioncorrJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  const blocks = readStar(context, context.inputPaths.movies);
  const optics = findBlock(blocks, 'optics', context.inputPaths.movies);
  const movies = findBlock(blocks, 'movies', context.inputPaths.movies);
  const original = Number(cell(optics, optics.rows[0], 'rlnMicrographOriginalPixelSize'));
  const voltage = cell(optics, optics.rows[0], 'rlnVoltage');
  const angpix = original * options.binFactor;
  const gain = context.inputPaths.gain;
  const rows = [];
  for (const row of movies.rows) {
    const movie = cell(movies, row, 'rlnMicrographMovieName');
    const name = stem(movie);
    write(context, `Movies/${name}.mrc`, writeMrc({ nx: MICROGRAPH_SIZE, ny: MICROGRAPH_SIZE, data: micrograph(), angpix }));
    const general = [
      ['rlnImageSizeX', MICROGRAPH_SIZE],
      ['rlnImageSizeY', MICROGRAPH_SIZE],
      ['rlnImageSizeZ', 24],
      ['rlnMicrographMovieName', movie],
    ];
    if (gain) general.push(['rlnMicrographGainName', gain]);
    general.push(
      ['rlnMicrographBinning', options.binFactor],
      ['rlnMicrographOriginalPixelSize', original],
      ['rlnMicrographDoseRate', options.dosePerFrame],
      ['rlnMicrographPreExposure', options.preExposure],
      ['rlnVoltage', voltage],
      ['rlnMicrographStartFrame', options.firstFrameSum],
      ['rlnMotionModelVersion', 0],
    );
    write(context, `Movies/${name}.star`, formatStar([pairsBlock('general', general)]));
    const out = [`${dir}/Movies/${name}.mrc`];
    if (options.doSaveNoDW) {
      write(context, `Movies/${name}_noDW.mrc`, writeMrc({ nx: MICROGRAPH_SIZE, ny: MICROGRAPH_SIZE, data: micrograph(), angpix }));
      out.push(`${dir}/Movies/${name}_noDW.mrc`);
    }
    out.push(`${dir}/Movies/${name}.star`, cell(movies, row, 'rlnOpticsGroup'), 0.5, 0.25, 0.25);
    if (options.doSavePs) {
      write(context, `Movies/${name}_PS.mrc`, writeMrc({ nx: MICROGRAPH_SIZE, ny: MICROGRAPH_SIZE, data: disk(MICROGRAPH_SIZE, 32, 32, 20), angpix }));
      out.push(`${dir}/Movies/${name}_PS.mrc`);
    }
    rows.push(out);
  }
  const columns = ['rlnMicrographName'];
  if (options.doSaveNoDW) columns.push('rlnMicrographNameNoDW');
  columns.push('rlnMicrographMetadata', 'rlnOpticsGroup', 'rlnAccumMotionTotal', 'rlnAccumMotionEarly', 'rlnAccumMotionLate');
  if (options.doSavePs) columns.push('rlnCtfPowerSpectrum');
  write(context, 'corrected_micrographs.star', formatStar([
    opticsBlock(optics, [['rlnMicrographPixelSize', () => angpix]]),
    loopBlock('micrographs', columns, rows),
  ]));
  return [` Motion-corrected ${rows.length} movies`];
}

function ctffindJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  const blocks = readStar(context, context.inputPaths.micrographs);
  const optics = findBlock(blocks, 'optics', context.inputPaths.micrographs);
  const micrographs = findBlock(blocks, 'micrographs', context.inputPaths.micrographs);
  const angpix = Number(cell(optics, optics.rows[0], 'rlnMicrographPixelSize'));
  const entries = [
    ['rlnCtfImage', row => `${dir}/Movies/${stem(cell(micrographs, row, 'rlnMicrographName'))}.ctf:mrc`],
    ['rlnDefocusU', (row, index) => 15000 + 1000 * index],
    ['rlnDefocusV', (row, index) => 14800 + 1000 * index],
    ['rlnCtfAstigmatism', () => 200],
    ['rlnDefocusAngle', () => 30],
    ['rlnCtfFigureOfMerit', () => 0.15],
    ['rlnCtfMaxResolution', () => 4],
  ];
  if (options.doPhaseshift) entries.push(['rlnPhaseShift', () => options.phaseMin]);
  for (const row of micrographs.rows) {
    const name = stem(cell(micrographs, row, 'rlnMicrographName'));
    write(context, `Movies/${name}.ctf`, writeMrc({ nx: MICROGRAPH_SIZE, ny: MICROGRAPH_SIZE, data: disk(MICROGRAPH_SIZE, 32, 32, 24), angpix }));
  }
  write(context, 'micrographs_ctf.star', formatStar([
    loopBlock('optics', optics.columns, optics.rows),
    withColumns(micrographs, entries),
  ]));
  return [` Estimated the CTF of ${micrographs.rows.length} micrographs`];
}

function autopickJob(context) {
  const dir = context.directory;
  const blocks = readStar(context, context.inputPaths.micrographs);
  const micrographs = findBlock(blocks, 'micrographs', context.inputPaths.micrographs);
  const rows = [];
  for (const row of micrographs.rows) {
    const micrographName = cell(micrographs, row, 'rlnMicrographName');
    const coordinates = `Movies/${stem(micrographName)}_autopick.star`;
    const picks = PARTICLE_POSITIONS.map(([x, y], index) => [x, y, 0, 1 - 0.1 * index, -999]);
    write(context, coordinates, formatStar([
      loopBlock('', ['rlnCoordinateX', 'rlnCoordinateY', 'rlnClassNumber', 'rlnAutopickFigureOfMerit', 'rlnAnglePsi'], picks),
    ]));
    rows.push([micrographName, `${dir}/${coordinates}`]);
  }
  write(context, 'autopick.star', formatStar([
    loopBlock('coordinate_files', ['rlnMicrographName', 'rlnMicrographCoordinates'], rows),
  ]));
  return [` Picked ${rows.length * PARTICLE_POSITIONS.length} particles from ${rows.length} micrographs`];
}

function extractJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  const micrographBlocks = readStar(context, context.inputPaths.micrographs);
  const optics = findBlock(micrographBlocks, 'optics', context.inputPaths.micrographs);
  const micrographs = findBlock(micrographBlocks, 'micrographs', context.inputPaths.micrographs);
  const coordinateFiles = findBlock(readStar(context, context.inputPaths.coordinates), 'coordinate_files', context.inputPaths.coordinates);
  const coordinatesOf = new Map(coordinateFiles.rows.map(row => [cell(coordinateFiles, row, 'rlnMicrographName'), cell(coordinateFiles, row, 'rlnMicrographCoordinates')]));
  const micrographAngpix = Number(cell(optics, optics.rows[0], 'rlnMicrographPixelSize'));
  const angpix = options.doRescale ? micrographAngpix * (options.extractSize / options.rescale) : micrographAngpix;
  const ctfColumns = ['rlnCtfMaxResolution', 'rlnCtfFigureOfMerit', 'rlnDefocusU', 'rlnDefocusV', 'rlnDefocusAngle'];
  const rows = [];
  for (const micrographRow of micrographs.rows) {
    const micrographName = cell(micrographs, micrographRow, 'rlnMicrographName');
    const coordinates = coordinatesOf.get(micrographName);
    if (!coordinates) continue;
    const picks = findBlock(readStar(context, coordinates), '', coordinates);
    const stack = `Movies/${stem(micrographName)}.mrcs`;
    write(context, stack, writeMrc({ nx: BOX, ny: BOX, nz: picks.rows.length, data: imageStack(picks.rows.length, index => 6 + (index % 3)), angpix, stack: true }));
    picks.rows.forEach((pick, index) => {
      rows.push([
        cell(picks, pick, 'rlnCoordinateX'),
        cell(picks, pick, 'rlnCoordinateY'),
        cell(picks, pick, 'rlnAutopickFigureOfMerit'),
        0,
        -999,
        `${pad(index + 1, 6)}@${dir}/${stack}`,
        micrographName,
        cell(micrographs, micrographRow, 'rlnOpticsGroup'),
        ...ctfColumns.map(label => cell(micrographs, micrographRow, label)),
        0,
        1,
        0,
      ]);
    });
  }
  write(context, 'particles.star', formatStar([
    opticsBlock(optics, [
      ['rlnImagePixelSize', () => angpix],
      ['rlnImageSize', () => BOX],
      ['rlnImageDimensionality', () => 2],
      ['rlnCtfDataAreCtfPremultiplied', () => 0],
    ]),
    loopBlock('particles', [
      'rlnCoordinateX',
      'rlnCoordinateY',
      'rlnAutopickFigureOfMerit',
      'rlnClassNumber',
      'rlnAnglePsi',
      'rlnImageName',
      'rlnMicrographName',
      'rlnOpticsGroup',
      ...ctfColumns,
      'rlnCtfBfactor',
      'rlnCtfScalefactor',
      'rlnPhaseShift',
    ], rows),
  ]));
  return [` Extracted ${rows.length} particles`];
}

function readParticles(context, reference) {
  const blocks = readStar(context, reference);
  const optics = findBlock(blocks, 'optics', reference);
  const particles = findBlock(blocks, 'particles', reference);
  const angpix = Number(cell(optics, optics.rows[0], 'rlnImagePixelSize'));
  return { optics, particles, angpix };
}

function modelGeneral(dimensionality, classes, angpix, resolution, extra = []) {
  return pairsBlock('model_general', [
    ['rlnReferenceDimensionality', dimensionality],
    ['rlnDataDimensionality', 2],
    ['rlnOriginalImageSize', BOX],
    ['rlnCurrentResolution', resolution],
    ['rlnCurrentImageSize', BOX],
    ['rlnPaddingFactor', 2],
    ['rlnPixelSize', angpix],
    ['rlnNrClasses', classes],
    ['rlnNrBodies', 1],
    ['rlnNrGroups', 1],
    ['rlnNrOpticsGroups', 1],
    ...extra,
  ]);
}

function optimiserGeneral(root, model, data, extra) {
  return pairsBlock('optimiser_general', [
    ['rlnOutputRootName', root],
    ['rlnModelStarFile', model],
    ['rlnExperimentalDataStarFile', data],
    ...extra,
  ]);
}

function classCounts(particles, classes) {
  const counts = new Array(classes).fill(0);
  for (const row of particles.rows) counts[Number(cell(particles, row, 'rlnClassNumber')) - 1] += 1;
  return counts;
}

function class2dJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  const iteration = pad(options.nrIterGrad, 3);
  const root = `${dir}/run_it${iteration}`;
  const classes = options.nrClasses;
  const { optics, particles, angpix } = readParticles(context, context.inputPaths.particles);
  const data = withColumns(particles, [
    ['rlnClassNumber', (row, index) => (index % classes) + 1],
    ['rlnAnglePsi', (row, index) => (index * 37) % 360],
    ['rlnOriginXAngst', () => 0],
    ['rlnOriginYAngst', () => 0],
    ['rlnNormCorrection', () => 1],
    ['rlnLogLikeliContribution', () => 1000],
    ['rlnMaxValueProbDistribution', () => 0.9],
    ['rlnNrOfSignificantSamples', () => 1],
    ['rlnGroupNumber', () => 1],
  ]);
  write(context, `run_it${iteration}_data.star`, formatStar([loopBlock('optics', optics.columns, optics.rows), data]));
  write(context, `run_it${iteration}_classes.mrcs`, writeMrc({ nx: BOX, ny: BOX, nz: classes, data: imageStack(classes, index => 4 + (index % 8)), angpix, stack: true }));
  const counts = classCounts(data, classes);
  const total = Math.max(1, data.rows.length);
  write(context, `run_it${iteration}_model.star`, formatStar([
    modelGeneral(2, classes, angpix, 8, [['rlnTau2FudgeFactor', options.tauFudge]]),
    loopBlock('model_classes', [
      'rlnReferenceImage',
      'rlnClassDistribution',
      'rlnAccuracyRotations',
      'rlnAccuracyTranslationsAngst',
      'rlnEstimatedResolution',
      'rlnOverallFourierCompleteness',
    ], counts.map((count, index) => [`${pad(index + 1, 6)}@${root}_classes.mrcs`, count / total, 2, 1, 8 + index, 1])),
  ]));
  write(context, `run_it${iteration}_optimiser.star`, formatStar([
    optimiserGeneral(`${dir}/run`, `${root}_model.star`, `${root}_data.star`, [
      ['rlnCurrentIteration', options.nrIterGrad],
      ['rlnNumberOfIterations', options.nrIterGrad],
      ['rlnDoSplitRandomHalves', 0],
      ['rlnParticleDiameter', options.particleDiameter],
    ]),
  ]));
  return [` Classified ${data.rows.length} particles into ${classes} classes`];
}

function selectJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  if (options.mode === 'classes') {
    const blocks = readStar(context, context.inputPaths.particles);
    const optics = findBlock(blocks, 'optics', context.inputPaths.particles);
    const particles = findBlock(blocks, 'particles', context.inputPaths.particles);
    const ranges = classRanges(options.classes);
    const runs = ranges.map(([from, to]) => particles.rows.filter(row => {
      const number = Number(cell(particles, row, 'rlnClassNumber'));
      return number >= from && number <= to;
    }));
    if (ranges.length > 1) {
      ranges.forEach(([from, to], index) => {
        write(context, `classes_${pad(from, 3)}_${pad(to, 3)}.star`, formatStar([
          loopBlock('optics', optics.columns, optics.rows),
          loopBlock('particles', particles.columns, runs[index]),
        ]));
      });
    }
    const selected = runs.flat();
    write(context, 'particles.star', formatStar([
      loopBlock('optics', optics.columns, optics.rows),
      loopBlock('particles', particles.columns, selected),
    ]));
    return [` Selected ${selected.length} particles from classes ${options.classes.join(',')}`];
  }
  const optimiser = findBlock(readStar(context, context.inputPaths.optimiser), 'optimiser_general', context.inputPaths.optimiser);
  const modelPath = optimiser.pairs.get('rlnModelStarFile');
  const dataPath = optimiser.pairs.get('rlnExperimentalDataStarFile');
  const model = findBlock(readStar(context, modelPath), 'model_classes', modelPath);
  const dataBlocks = readStar(context, dataPath);
  const optics = findBlock(dataBlocks, 'optics', dataPath);
  const particles = findBlock(dataBlocks, 'particles', dataPath);
  const classes = model.rows.length;
  const counts = classCounts(particles, classes);
  const scored = model.rows.map((row, index) => ({ row, number: index + 1, score: 1 - index / classes, count: counts[index] }));
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const chosen = new Set(ranked.filter(item => item.score >= options.minScore).map(item => item.number));
  for (const item of ranked) {
    const chosenCount = ranked.filter(entry => chosen.has(entry.number)).reduce((sum, entry) => sum + entry.count, 0);
    const enoughClasses = options.minClasses < 0 || chosen.size >= options.minClasses;
    const enoughParticles = options.minParticles < 0 || chosenCount >= options.minParticles;
    if (enoughClasses && enoughParticles) break;
    chosen.add(item.number);
  }
  const selected = particles.rows.filter(row => chosen.has(Number(cell(particles, row, 'rlnClassNumber'))));
  write(context, 'particles.star', formatStar([
    loopBlock('optics', optics.columns, optics.rows),
    loopBlock('particles', particles.columns, selected),
  ]));
  write(context, 'class_averages.star', formatStar([
    loopBlock('', ['rlnReferenceImage', 'rlnClassScore', 'rlnClassDistribution', 'rlnEstimatedResolution'], ranked.map(item => [
      cell(model, item.row, 'rlnReferenceImage'),
      item.score,
      cell(model, item.row, 'rlnClassDistribution'),
      cell(model, item.row, 'rlnEstimatedResolution'),
    ])),
  ]));
  write(context, 'rank_optimiser.star', formatStar([
    optimiserGeneral(`${dir}/rank`, modelPath, `${dir}/particles.star`, [['rlnCurrentIteration', optimiser.pairs.get('rlnCurrentIteration') ?? 0]]),
  ]));
  return [` Selected ${selected.length} particles from ${chosen.size} classes with the class ranker`];
}

function writeVolume(context, name, data, angpix) {
  write(context, name, writeMrc({ nx: BOX, ny: BOX, nz: BOX, data, angpix }));
}

function initialmodelJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  const iteration = pad(options.nrIter, 3);
  const classes = options.nrClasses;
  const { optics, particles, angpix } = readParticles(context, context.inputPaths.particles);
  const data = withColumns(particles, [
    ['rlnClassNumber', (row, index) => (index % classes) + 1],
    ['rlnAngleRot', (row, index) => (index * 53) % 360],
    ['rlnAngleTilt', (row, index) => (index * 29) % 180],
    ['rlnAnglePsi', (row, index) => (index * 37) % 360],
    ['rlnOriginXAngst', () => 0],
    ['rlnOriginYAngst', () => 0],
  ]);
  write(context, `run_it${iteration}_data.star`, formatStar([loopBlock('optics', optics.columns, optics.rows), data]));
  const counts = classCounts(data, classes);
  const total = Math.max(1, data.rows.length);
  const references = [];
  for (let number = 1; number <= classes; number += 1) {
    const name = `run_it${iteration}_class${pad(number, 3)}.mrc`;
    writeVolume(context, name, sphere(BOX, 8 + (number % 4)), angpix);
    references.push(`${dir}/${name}`);
  }
  write(context, `run_it${iteration}_model.star`, formatStar([
    modelGeneral(3, classes, angpix, 12, [['rlnTau2FudgeFactor', options.tauFudge]]),
    loopBlock('model_classes', ['rlnReferenceImage', 'rlnClassDistribution', 'rlnAccuracyRotations', 'rlnAccuracyTranslationsAngst', 'rlnEstimatedResolution'], references.map((reference, index) => [reference, counts[index] / total, 5, 2, 12])),
  ]));
  const largest = counts.indexOf(Math.max(...counts)) + 1;
  writeVolume(context, 'initial_model.mrc', sphere(BOX, 8 + (largest % 4)), angpix);
  return [` Wrote the initial model from class ${largest}`];
}

// The synthetic FSC: 1 / (1 + exp((k - 0.625 h) / (0.09375 h))) at shell k of h = box / 2.
export function syntheticFsc(shell, box = BOX) {
  const half = box / 2;
  return 1 / (1 + Math.exp((shell - 0.625 * half) / (0.09375 * half)));
}

// The resolution (Å) where the synthetic FSC first drops below `threshold`, interpolated between shells.
export function fscResolution(angpix, threshold = 0.143, box = BOX) {
  for (let shell = 1; shell <= box / 2; shell += 1) {
    const value = syntheticFsc(shell, box);
    if (value < threshold) {
      const previous = syntheticFsc(shell - 1, box);
      const crossing = shell - 1 + (previous - threshold) / (previous - value);
      return (box * angpix) / crossing;
    }
  }
  return 2 * angpix;
}

function shellRows(angpix, valuesOf) {
  const rows = [];
  for (let shell = 0; shell <= BOX / 2; shell += 1) {
    const resolution = shell / (BOX * angpix);
    rows.push([shell, resolution, shell === 0 ? 999 : 1 / resolution, ...valuesOf(shell)]);
  }
  return rows;
}

function refine3dJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  const { optics, particles, angpix } = readParticles(context, context.inputPaths.particles);
  const resolution = fscResolution(angpix);
  const data = withColumns(particles, [
    ['rlnAngleRot', (row, index) => (index * 53) % 360],
    ['rlnAngleTilt', (row, index) => (index * 29) % 180],
    ['rlnAnglePsi', (row, index) => (index * 37) % 360],
    ['rlnOriginXAngst', () => 0],
    ['rlnOriginYAngst', () => 0],
    ['rlnClassNumber', () => 1],
    ['rlnRandomSubset', (row, index) => (index % 2) + 1],
    ['rlnNormCorrection', () => 1],
    ['rlnLogLikeliContribution', () => 1000],
    ['rlnMaxValueProbDistribution', () => 0.9],
    ['rlnNrOfSignificantSamples', () => 1],
  ]);
  write(context, 'run_data.star', formatStar([loopBlock('optics', optics.columns, optics.rows), data]));
  writeVolume(context, 'run_class001.mrc', sphere(BOX, 10), angpix);
  writeVolume(context, 'run_half1_class001_unfil.mrc', sphere(BOX, 10, 2, 0.99), angpix);
  writeVolume(context, 'run_half2_class001_unfil.mrc', sphere(BOX, 10, 2, 1.01), angpix);
  write(context, 'run_model.star', formatStar([
    modelGeneral(3, 1, angpix, resolution),
    loopBlock('model_classes', ['rlnReferenceImage', 'rlnClassDistribution', 'rlnAccuracyRotations', 'rlnAccuracyTranslationsAngst', 'rlnEstimatedResolution'], [[`${dir}/run_class001.mrc`, 1, 1, 0.5, resolution]]),
    loopBlock('model_class_1', ['rlnSpectralIndex', 'rlnResolution', 'rlnAngstromResolution', 'rlnGoldStandardFsc'], shellRows(angpix, shell => [syntheticFsc(shell)])),
  ]));
  write(context, 'run_optimiser.star', formatStar([
    optimiserGeneral(`${dir}/run`, `${dir}/run_model.star`, `${dir}/run_data.star`, [
      ['rlnCurrentIteration', 6],
      ['rlnDoSplitRandomHalves', 1],
      ['rlnParticleDiameter', options.particleDiameter],
    ]),
  ]));
  return [` Auto-refine: + Final reconstruction from all particles is saved as: ${dir}/run_class001.mrc`];
}

function maskcreateJob(context) {
  const { options } = context.validated;
  const map = readMrc(context, context.inputPaths.map);
  const angpix = options.angpix > 0 ? options.angpix : map.angpix;
  const radius = Math.min(map.nx / 2 - options.widthMaskEdge - 1, 10 + options.extendInimask);
  write(context, 'mask.mrc', writeMrc({ nx: map.nx, ny: map.nx, nz: map.nx, data: sphere(map.nx, Math.max(1, radius), Math.max(1, options.widthMaskEdge)), angpix }));
  return [` Wrote ${context.directory}/mask.mrc`];
}

function postprocessJob(context) {
  const { options } = context.validated;
  const dir = context.directory;
  const [half1, half2] = halfMaps(context.inputPaths.halfMap);
  const header = readMrc(context, half1);
  const angpix = options.angpix > 0 ? options.angpix : header.angpix;
  const resolution = fscResolution(angpix);
  let bfactor = 0;
  if (options.doAutoBfac) bfactor = -60;
  else if (options.doAdhocBfac) bfactor = options.adhocBfac;
  const unmasked = shell => syntheticFsc(shell) ** 1.2;
  const randomiseFrom = fscResolution(angpix, 0.8);
  const randomiseShell = (BOX * angpix) / randomiseFrom;
  writeVolume(context, 'postprocess.mrc', sphere(BOX, 10), angpix);
  writeVolume(context, 'postprocess_masked.mrc', sphere(BOX, 10, 1), angpix);
  write(context, 'postprocess.star', formatStar([
    pairsBlock('general', [
      ['rlnFinalResolution', resolution],
      ['rlnBfactorUsedForSharpening', bfactor],
      ['rlnUnfilteredMapHalf1', half1],
      ['rlnUnfilteredMapHalf2', half2],
      ['rlnMaskName', context.inputPaths.mask],
      ['rlnRandomiseFrom', randomiseFrom],
    ]),
    loopBlock('fsc', [
      'rlnSpectralIndex',
      'rlnResolution',
      'rlnAngstromResolution',
      'rlnFourierShellCorrelationCorrected',
      'rlnFourierShellCorrelationUnmaskedMaps',
      'rlnFourierShellCorrelationMaskedMaps',
      'rlnCorrectedFourierShellCorrelationPhaseRandomizedMaskedMaps',
    ], shellRows(angpix, shell => [syntheticFsc(shell), unmasked(shell), syntheticFsc(shell), shell < randomiseShell ? syntheticFsc(shell) : 0])),
    loopBlock('guinier', [
      'rlnResolutionSquared',
      'rlnLogAmplitudesOriginal',
      'rlnLogAmplitudesWeighted',
      'rlnLogAmplitudesSharpened',
    ], shellRows(angpix, () => []).slice(1).map(([, frequency]) => {
      const squared = frequency * frequency;
      return [squared, -10 * squared, -10 * squared - 0.1, -10 * squared - (bfactor / 4) * squared];
    })),
  ]));
  return [`  + FINAL RESOLUTION: ${relionNumber(resolution)}`];
}

const WRITERS = {
  import: importJob,
  motioncorr: motioncorrJob,
  ctffind: ctffindJob,
  autopick: autopickJob,
  extract: extractJob,
  class2d: class2dJob,
  select: selectJob,
  initialmodel: initialmodelJob,
  refine3d: refine3dJob,
  maskcreate: maskcreateJob,
  postprocess: postprocessJob,
};

/**
 * Write the command's outputs into the job directory. `context` is
 * `{ projectDir, directory, validated, inputPaths, dataRoots }`: the canonical
 * project directory, `<Type>/jobNNN`, the validated spec, the job-visible input
 * paths (resolveInputPaths) and a Map of data root id to canonical directory.
 * Returns summary lines for the log.
 */
export function writeOutputs(context) {
  return WRITERS[context.validated.command](context);
}

/** Required outputs of the command that the job directory lacks. */
export function missingOutputs(context) {
  return relionOutputs(context.validated)
    .filter(output => output.required)
    .map(output => output.path)
    .filter(path => !locate(context, `${context.directory}/${path}`).path);
}

/** The end-of-job files: `run.out`, `run.err` and the RELION exit marker. */
export function writeJobEnd(context, { out, err, marker }) {
  write(context, 'run.out', out.length ? `${out.join('\n')}\n` : '');
  write(context, 'run.err', err.length ? `${err.join('\n')}\n` : '');
  if (marker) write(context, marker, '');
}
