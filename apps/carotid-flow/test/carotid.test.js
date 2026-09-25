// DOM-independent unit tests (Node, no browser). Browser behaviour is covered in e2e/.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeNiftiBuffer, readNiftiFrames } from '@neurodesk/webapp-components/file-io';
import { curveMetrics, curvesCsv, detectCarotids, inPlaneAxes, isSignedPhase, percentile, splitSeries, velocityScale } from '../src/carotid.js';
import { flowChartSvg, tickStep } from '../src/chart.js';
import { APP, assignSeries, stem } from '../src/config.js';

test('app id is lowercase kebab-case and the config is frozen', () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test('percentile reproduces MATLAB prctile', () => {
  // Values from MATLAB: prctile([1 2 3 4], 50|20|0|100) and prctile(1:10, 99.9|35).
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 20) - 1.3) < 1e-12);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  assert.equal(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 99.9), 10);
  assert.ok(Math.abs(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 35) - 4) < 1e-12);
});

// A 64 × 64 neck: an elliptical head, two carotids level with each other either side of the
// midline, and on the midline a vessel pulsing harder than either (vertebral) that only the
// excluded band keeps out. The background phase is constant, so every pulsing pixel is a
// candidate at the test's percentile. Each vessel peaks at frame 10.
const NX = 64;
const NY = 64;
const PHASES = 24;
function phantom({ vessels = [[21, 32], [43, 32]], flipAnterior = false } = {}) {
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
  const amplitude = new Float32Array(NX * NY * PHASES);
  const phase = new Float32Array(NX * NY * PHASES);
  const inside = (x, y, [cx, cy], r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  const pulse = (t, height) => 100 + height * Math.exp(-(((t - 10) / 2) ** 2));
  for (let t = 0; t < PHASES; t++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const v = x + y * NX + t * NX * NY;
        const head = ((x - 32) / 26) ** 2 + ((y - 32) / 28) ** 2 <= 1;
        if (!head) continue;
        amplitude[v] = 300;
        phase[v] = 20;
        const yy = flipAnterior ? NY - 1 - y : y;
        for (const [centre, height] of [...vessels.map((centre) => [centre, 150]), [[32, 34], 300]]) {
          if (inside(x, yy, centre, 2)) { phase[v] = pulse(t, height) + noise(); amplitude[v] = 600; }
        }
      }
    }
  }
  // Radiological, as the scanner writes it: world x falls along i.
  const affine = [[-1, 0, 0, 30], [0, flipAnterior ? -1 : 1, 0, -30], [0, 0, 2, 0], [0, 0, 0, 1]];
  return { amplitude, phase, nx: NX, ny: NY, phases: PHASES, affine, voxelSize: [0.5, 0.5, 2] };
}

test('finds both carotids in the phantom and names them from the patient orientation', () => {
  const found = detectCarotids(phantom(), { candidatePercentile: 97 });
  // Radiological grid: the vessel at small i is the patient's right.
  assert.deepEqual(found.right.centroid.map(Math.round), [22, 33]);
  assert.deepEqual(found.left.centroid.map(Math.round), [44, 33]);
  assert.equal(found.left.pixels.length, 13);
  assert.equal(found.left.areaMm2, 13 * 0.25);
  assert.equal(found.left.peakFrame, 10);
  assert.ok(found.right.pulsatility > 1);
  // The midline vessel pulses as strongly but sits inside the excluded band.
  assert.equal(found.mask.filter((label) => label).length, 26);
  assert.ok(found.mask.every((label, v) => !label || Math.abs((v % NX) - 32) > 5));
});

test('a neurological grid swaps the labels, a flipped anterior axis does not', () => {
  const series = phantom();
  series.affine = [[1, 0, 0, -30], ...series.affine.slice(1)];
  const found = detectCarotids(series, { candidatePercentile: 97 });
  assert.deepEqual(found.left.centroid.map(Math.round), [22, 33]);
  const flipped = detectCarotids(phantom({ flipAnterior: true }), { candidatePercentile: 97 });
  assert.equal(flipped.axes.anterior, -1);
  assert.deepEqual(flipped.right.centroid.map(Math.round), [22, 32]);
});

// Signed velocity (cm/s) in the same neck: a carotid and a smaller artery each side, flowing
// up and pulsing, and a jugular on the right flowing down, steadily and with more flow than
// either carotid, which only its direction and weak pulse rule out.
function velocityPhantom({ reverse = false, scale = 1 } = {}) {
  const series = phantom({ vessels: [] });
  const vessels = [
    { centre: [18, 30], radius: 3, peak: 60, base: 20 },
    { centre: [46, 30], radius: 3, peak: 60, base: 20 },
    { centre: [24, 22], radius: 2, peak: 40, base: 12 },
    { centre: [40, 22], radius: 2, peak: 40, base: 12 },
    { centre: [12, 36], radius: 4, peak: -32, base: -28 },
  ];
  for (let t = 0; t < PHASES; t++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const v = x + y * NX + t * NX * NY;
        if (!series.amplitude[v]) continue;
        let value = 0;
        for (const { centre, radius, peak, base } of vessels) {
          if ((x - centre[0]) ** 2 + (y - centre[1]) ** 2 <= radius * radius) {
            value = base + (peak - base) * Math.exp(-(((t - 5) / 2) ** 2));
          }
        }
        series.phase[v] = (reverse ? -value : value) * scale;
      }
    }
  }
  return series;
}

test('signed velocity finds the carotids by direction, pulse and flow', () => {
  const found = detectCarotids(velocityPhantom());
  assert.equal(found.method, 'velocity');
  assert.equal(found.arterialSign, 1);
  // Radiological grid again: the vessel at small i is the patient's right.
  assert.deepEqual(found.right.centroid, [19, 31]);
  assert.deepEqual(found.left.centroid, [47, 31]);
  assert.equal(found.left.pixels.length, 29);
  // Flow is velocity times area: 20 cm/s through 29 × 0.25 mm² is 87 ml/min at diastole.
  assert.ok(Math.abs(found.left.curve[20] - 20 * 29 * 0.25 * 0.6) < 1e-9);
  assert.ok(Math.abs(found.left.velocity[5] - 60) < 1e-9);
  assert.equal(found.left.peakFrame, 5);
  const reversed = detectCarotids(velocityPhantom({ reverse: true }));
  assert.equal(reversed.arterialSign, -1);
  assert.deepEqual(reversed.right.centroid, [19, 31]);
  assert.ok(Math.abs(reversed.right.mean - found.right.mean) < 1e-9);
});

test('raw phase needs the VENC and is scaled by it', () => {
  // ±4096 raw phase at VENC 100 cm/s: 60 cm/s is stored as 2457.6.
  const raw = velocityPhantom({ scale: 4096 / 100 });
  assert.throws(() => detectCarotids(raw), /VENC/);
  const found = detectCarotids(raw, { venc: 100 });
  // The phantom stores float32, as NIfTI does, so the round trip is exact to float precision.
  assert.ok(Math.abs(found.left.velocity[5] - 60) < 1e-4);
  assert.equal(velocityScale([-50, 80], undefined), 1);
  assert.equal(isSignedPhase([0, 3, 900]), false);
  assert.equal(isSignedPhase([-40, 3, 90]), true);
});

test('reads the in-plane axes from the affine', () => {
  assert.deepEqual(inPlaneAxes([[-0.96, 0, 0.18, 0], [0, 0.96, 0.05, 0], [0.07, -0.02, 2.4, 0]]), { lr: 0, ap: 1, leftward: 1, anterior: 1 });
  assert.deepEqual(inPlaneAxes([[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 1, 0]]), { lr: 1, ap: 0, leftward: -1, anterior: -1 });
});

test('fails with a reason when fewer than two vessels are found', () => {
  assert.throws(() => detectCarotids(phantom({ vessels: [[21, 32]] }), { candidatePercentile: 97 }), /need two/);
  assert.throws(() => splitSeries(new Float32Array(9), 1, 9), /9 frames/);
  const blank = { ...phantom(), amplitude: new Float32Array(NX * NY * PHASES) };
  assert.throws(() => detectCarotids(blank), /No head/);
});

test('splits the amplitude frames from the phase frames', () => {
  const { phases, amplitude, phase } = splitSeries(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 2, 4);
  assert.equal(phases, 2);
  assert.deepEqual(Array.from(amplitude), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(phase), [5, 6, 7, 8]);
});

test('assigns one combined series or an amplitude and _ph pair', () => {
  const file = (name) => ({ name });
  assert.equal(assignSeries([file('pc.nii.gz')]).combined.name, 'pc.nii.gz');
  const pair = assignSeries([file('pc_ph.nii'), file('pc.nii')]);
  assert.equal(pair.amplitude.name, 'pc.nii');
  assert.equal(pair.phase.name, 'pc_ph.nii');
  assert.match(assignSeries([file('a.nii'), file('b.nii')]).error, /phase/);
  const philips = assignSeries([file('PCMTest_mag.nii'), file('PCMTest_mod.nii'), file('PCMTest_ph.nii')]);
  assert.equal(philips.amplitude.name, 'PCMTest_mod.nii');
  assert.match(assignSeries([file('a_mag.nii'), file('b.nii'), file('c_ph.nii')]).error, /_mod/);
  assert.match(assignSeries([]).error, /No NIfTI/);
  assert.equal(stem('DICOMS_vz_s1.nii.gz'), 'DICOMS_vz_s1');
});

test('summarises and exports the curves', () => {
  const metrics = curveMetrics([1, 3, 2]);
  assert.deepEqual({ ...metrics, pulsatility: Number(metrics.pulsatility.toFixed(6)) }, { peak: 3, trough: 1, mean: 2, peakFrame: 1, pulsatility: 1 });
  const csv = curvesCsv({ left: { curve: [1, 2] }, right: { curve: [3, 4.5] } });
  assert.equal(csv, 'frame,left_carotid,right_carotid\n1,1.0000,3.0000\n2,2.0000,4.5000\n');
  const flow = curvesCsv({ method: 'velocity', left: { curve: [30], velocity: [20] }, right: { curve: [60], velocity: [40] } });
  assert.equal(flow, 'frame,left_velocity_cm_s,left_flow_ml_min,right_velocity_cm_s,right_flow_ml_min\n1,20.0000,30.0000,40.0000,60.0000\n');
});

test('draws one polyline per carotid on round axes', () => {
  assert.equal(tickStep(776), 200);
  assert.equal(tickStep(31), 10);
  const svg = flowChartSvg([
    { values: [100, 250, 120], color: 'rgb(0 196 255)', label: 'Left carotid' },
    { values: [90, 240, 110], color: 'rgb(255 196 0)', label: 'Right carotid' },
  ], { xLabel: 'Cardiac frame', yLabel: 'Phase signal (a.u.)' });
  assert.equal(svg.match(/<polyline/g).length, 2);
  assert.equal(svg.match(/<polyline[^>]*points="([^"]*)"/)[1].split(' ').length, 3);
  assert.match(svg, />250</);
});

// The open example (PCMCalculator's test data), when it is on disk: PCMCalculator's manual
// measurement of the right carotid, from its Test/Output/PCMTest_ph_Flow_data.csv (ml/min).
const PCM_RIGHT_FLOW = [131.1, 135.5, 360.0, 367.5, 343.2, 334.9, 294.8, 302.8, 281.5, 281.8, 216.4, 218.0, 235.7, 236.8, 235.6, 239.6, 212.1, 215.0, 190.9, 201.9, 178.7, 180.2, 166.3, 160.5, 149.7, 145.7, 144.4, 144.0];
const OPEN = process.env.CAROTID_FLOW_OPEN_EXAMPLE;
test('matches PCMCalculator on the right carotid of the open example', { skip: !OPEN || !existsSync(`${OPEN}/carotid_pc_ph.nii.gz`) }, async () => {
  const read = async (name) => readNiftiFrames(await decodeNiftiBuffer(readFileSync(`${OPEN}/${name}`)));
  const modulus = await read('carotid_pc_mod.nii.gz');
  const velocity = await read('carotid_pc_ph.nii.gz');
  const found = detectCarotids({ amplitude: modulus.data, phase: velocity.data, phases: modulus.frames, nx: modulus.dims[0], ny: modulus.dims[1], affine: modulus.header.affine, voxelSize: modulus.header.voxelSize });
  assert.equal(found.method, 'velocity');
  const reference = PCM_RIGHT_FLOW.reduce((sum, value) => sum + value, 0) / PCM_RIGHT_FLOW.length;
  assert.ok(Math.abs(found.right.mean / reference - 1) < 0.1, `right carotid ${found.right.mean} ml/min against ${reference}`);
  const correlation = (a, b) => {
    const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
    const [ma, mb] = [mean(a), mean(b)];
    let ab = 0;
    let aa = 0;
    let bb = 0;
    a.forEach((value, t) => { ab += (value - ma) * (b[t] - mb); aa += (value - ma) ** 2; bb += (b[t] - mb) ** 2; });
    return ab / Math.sqrt(aa * bb);
  };
  assert.ok(correlation(Array.from(found.right.curve), PCM_RIGHT_FLOW) > 0.99);
  assert.equal(Math.round(found.left.mean), 231);
  assert.equal(found.right.peakFrame, 3);
});

// The hospital example, when it is on disk: the carotids the MATLAB script picks.
const EXAMPLE = process.env.CAROTID_FLOW_EXAMPLE;
test('selects the same vessels as the MATLAB script on the example', { skip: !EXAMPLE || !existsSync(EXAMPLE) }, async () => {
  const { data, header, dims, frames } = readNiftiFrames(await decodeNiftiBuffer(readFileSync(EXAMPLE)));
  const series = splitSeries(data, dims[0] * dims[1], frames);
  const found = detectCarotids({ ...series, nx: dims[0], ny: dims[1], affine: header.affine, voxelSize: header.voxelSize });
  assert.equal(found.blobs, 3);
  assert.equal(found.right.pixels.length, 12);
  assert.deepEqual(found.right.centroid.map((value) => Number(value.toFixed(2))), [92.25, 117.42]);
  assert.equal(found.left.pixels.length, 4);
  assert.deepEqual(found.left.centroid, [148.75, 121]);
  assert.equal(found.right.peakFrame, 19);
});
