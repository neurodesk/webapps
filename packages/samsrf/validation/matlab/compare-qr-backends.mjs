// Compare MATLAB least-squares recordings made under different MKL requests on
// one host. These are source-to-source comparisons, not port parity: they show
// which coefficient bits depend on the BLAS backend MATLAB selected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED = ['compatible', 'compatible-repeat', 'auto', 'sse4_2', 'avx2', 'avx512', 'enable-sse4_2'];
const COMPARED = ['beta', 'c', 'r', 'pivot', 'rWithoutRhs', 'pivotWithoutRhs'];

export function readRecording(root) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'qr.json'), 'utf8'));
  assert.ok(metadata.cases?.length, `${root}: no cases`);
  assert.equal(new Set(metadata.cases.map(item => item.id)).size, metadata.cases.length, `${root}: duplicate case IDs`);
  return metadata;
}

export function readArray(root, descriptor) {
  const parts = [descriptor.file, descriptor.imaginary].filter(Boolean).map(name => {
    assert.equal(path.basename(name), name, 'Array names must stay inside the recording');
    const bytes = fs.readFileSync(path.join(root, name));
    const count = descriptor.shape.reduce((a, b) => a * b, 1);
    assert.equal(bytes.length, count * 8, `${name}: size disagrees with its shape`);
    return new Float64Array(bytes.buffer, bytes.byteOffset, count);
  });
  return { re: parts[0], im: parts[1] ?? null, class: descriptor.class };
}

// Distance in units in the last place of the recorded class. Both values are
// stored as float64, so single values convert exactly to float32.
export function ulps(a, b, single) {
  if (Object.is(a, b) || a === b) return 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  const ordered = value => {
    if (single) {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, value);
      const bits = view.getInt32(0);
      return bits < 0 ? -(bits & 0x7fffffff) : bits;
    }
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigInt64(0);
    return Number(bits < 0n ? -(bits & 0x7fffffffffffffffn) : bits);
  };
  return Math.abs(ordered(a) - ordered(b));
}

function arrayDistance(first, second, single) {
  if (first.re.length !== second.re.length || !first.im !== !second.im) return Infinity;
  let worst = 0;
  for (const part of ['re', 'im']) {
    if (!first[part]) continue;
    for (let i = 0; i < first[part].length; i++) worst = Math.max(worst, ulps(first[part][i], second[part][i], single));
  }
  return worst;
}

export function compareBackends(root, { smoke = false } = {}) {
  const labels = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'qr.json')))
    .map(entry => entry.name)
    .sort();
  if (!smoke) assert.deepEqual([...labels].sort(), [...REQUIRED].sort(), 'Every MKL request must be recorded');
  assert.ok(labels.length, 'No recordings');
  const recordings = Object.fromEntries(labels.map(label => [label, readRecording(path.join(root, label))]));
  for (const [label, recording] of Object.entries(recordings)) {
    if (!smoke) assert.equal(recording.environment.interpreter, 'MATLAB', `${label}: Octave is not a numerical reference`);
    assert.equal(recording.environment.label, label, `${label}: recorded under another label`);
  }
  const base = labels.includes('compatible') ? 'compatible' : labels[0];
  const ids = recordings[base].cases.map(item => item.id);
  const report = { base, settings: {}, cases: ids.length };
  for (const label of labels) {
    const recording = recordings[label];
    assert.deepEqual(recording.cases.map(item => item.id), ids, `${label}: case inventory differs`);
    const differing = [];
    let inputsDiffer = 0;
    const maxUlps = Object.fromEntries(COMPARED.map(key => [key, 0]));
    recording.cases.forEach((item, index) => {
      const reference = recordings[base].cases[index];
      const single = item.precision === 'single';
      for (const key of ['x', 'y']) {
        if (arrayDistance(readArray(path.join(root, label), item[key]), readArray(path.join(root, base), reference[key]), false) !== 0) inputsDiffer++;
      }
      const distances = {};
      for (const key of COMPARED) {
        const distance = arrayDistance(readArray(path.join(root, label), item[key]), readArray(path.join(root, base), reference[key]), single && key !== 'pivot' && key !== 'pivotWithoutRhs');
        distances[key] = distance;
        maxUlps[key] = Math.max(maxUlps[key], distance);
      }
      if (Object.values(distances).some(distance => distance !== 0) || item.warning !== reference.warning) {
        differing.push({ id: item.id, ulps: distances, warning: item.warning, baseWarning: reference.warning });
      }
    });
    report.settings[label] = {
      blas: recording.environment.blas,
      cpu: recording.environment.cpu?.match(/Model name:\s*(.*)/)?.[1]?.trim() ?? null,
      processEnvironment: recording.environment.processEnvironment,
      uniformMatchesMixed: recording.cases.every(item => item.uniformMatches),
      inputsDiffer,
      differingCases: differing.length,
      maxUlps,
      differing,
    };
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const [root, reportFile] = args.filter(arg => arg !== '--smoke');
  assert.ok(root && reportFile, 'Usage: compare-qr-backends.mjs ROOT REPORT_JSON [--smoke]');
  const report = compareBackends(root, { smoke });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  const repeat = report.settings['compatible-repeat'];
  if (repeat) assert.equal(repeat.differingCases, 0, 'A fresh process with the same request changed results');
  for (const [label, setting] of Object.entries(report.settings)) {
    console.log(`${label}: ${setting.blas}; ${setting.differingCases}/${report.cases} cases differ from ${report.base}; max ULP ${JSON.stringify(setting.maxUlps)}`);
  }
}
