import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { asBuffer, compatibleMaskGeometry, orthogonalGrid, prepareAdditional, readAdditional, resampleOnto, runSyncro, sameGeometry, thresholdBinary } from '../src/pipeline.js';
import { readVolume, writeVolume } from '../../synthsr/src/index.js';

const affine = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const volume = {
  dims: [5, 5, 5],
  affine,
  data: Float32Array.from({ length: 125 }, (_, index) => index + 1),
};
const lesion = { ...volume, data: new Uint8Array(125) };

test('matching dimensions cannot hide a different physical frame', () => {
  const moved = { ...volume, affine: affine.map((row) => row.slice()) };
  moved.affine[0][3] = 1;
  assert.equal(sameGeometry(volume, moved), false);
});

test('mask geometry accepts a one-voxel border but rejects a different frame', () => {
  const border = { ...lesion, dims: [4, 5, 5], affine: affine.map((row) => row.slice()) };
  border.affine[0][3] = 1;
  assert.equal(compatibleMaskGeometry(volume, border), true);
  border.affine[0][3] = 2;
  assert.equal(compatibleMaskGeometry(volume, border), false);
});

test('empty lesion remains empty after propagation threshold', () => {
  assert.equal(thresholdBinary(lesion).data.some(Boolean), false);
});

test('lesion validation rejects more than two intensity levels', () => {
  const encoded = new ArrayBuffer(352 + 125 * 8);
  new Uint8Array(encoded, 0, 352).set(new Uint8Array(writeVolume(volume), 0, 352));
  const raw = new DataView(encoded);
  raw.setInt16(70, 64, true);
  raw.setInt16(72, 64, true);
  raw.setFloat64(352, 1.000000001, true);
  raw.setFloat64(360, 0.5, true);
  assert.throws(() => readAdditional(encoded, 'binary'), /two discrete values/);
});

test('lesion maps use native SYNcro two-level scaling', () => {
  const encoded = writeVolume({ ...lesion, data: Uint8Array.from(lesion.data, (_, index) => index === 62 ? 255 : 0) });
  const decoded = readAdditional(encoded, 'binary');
  assert.equal(decoded.data[0], 0);
  assert.equal(decoded.data[62], 1);
});

test('constant foreground lesion maps remain foreground', () => {
  const encoded = writeVolume({ ...lesion, data: new Uint8Array(lesion.data.length).fill(1) });
  assert.equal(readAdditional(encoded, 'binary').data.every((value) => value === 1), true);
});

test('primary and pathological scans reject ordinary two-level masks', async () => {
  const source = writeVolume(volume);
  const mask = writeVolume({ ...lesion, data: Uint8Array.from(lesion.data, (_, index) => index === 62 ? 255 : 0) });
  let called = false;
  const common = {
    template: source,
    synthesize() {
      called = true;
    },
  };
  await assert.rejects(runSyncro({ ...common, input: mask, inputName: 'primary.nii' }), /primary scan.*binary mask/i);
  await assert.rejects(runSyncro({ ...common, input: source, inputName: 'primary.nii', pathological: { name: 'trace.nii', buffer: mask } }), /pathological modality.*binary mask/i);
  assert.equal(called, false);
});

test('duplicate native output names fail before inference', async () => {
  let called = false;
  await assert.rejects(runSyncro({
    input: writeVolume(volume),
    inputName: 'primary.nii',
    pathological: { name: 'bt1primary.nii', buffer: writeVolume(volume) },
    synthesize() {
      called = true;
    },
  }), /duplicate output names/);
  assert.equal(called, false);
});

test('lesion geometry errors fail before loading or executing models', async () => {
  const moved = { ...lesion, affine: affine.map((row) => row.slice()) };
  moved.affine[0][3] = 2;
  let called = false;
  await assert.rejects(runSyncro({
    input: writeVolume(volume),
    inputName: 'primary.nii',
    lesion: { name: 'lesion.nii', buffer: writeVolume(moved) },
    template: writeVolume(volume),
    synthesize() {
      called = true;
    },
  }), /must match/);
  assert.equal(called, false);
});

test('default pipeline matches command-line methods and output names', async () => {
  const source = writeVolume(volume);
  let extractor;
  let affineRegistrations = 0;
  const reslices = [];
  const registration = {
    provenance: { engine: 'Greedy' },
    registerAffine() {
      affineRegistrations += 1;
      return 'pathological-affine';
    },
    register({ moving }) {
      return { warped: new Uint8Array(moving), matrix: 'm', warp: Uint8Array.of(1) };
    },
    apply({ moving, fill, interpolation, precedingMatrix }) {
      reslices.push({ fill, interpolation, precedingMatrix });
      return new Uint8Array(moving);
    },
    release() {},
  };
  const imageMath = {
    smoothLesion: ({ buffer }) => new Uint8Array(buffer),
    thresholdLesion: ({ buffer }) => new Uint8Array(buffer),
    mask: ({ image }) => new Uint8Array(image),
  };
  const result = await runSyncro({
    input: source,
    inputName: 'primary.nii',
    pathological: { name: 'trace.nii', buffer: source },
    lesion: { name: 'lesion.nii', buffer: writeVolume(lesion) },
    template: source,
    keepSynth: true,
    synthesize: async () => ({ buffer: source, provenance: {} }),
    extractBrain: async ({ volume: inputVolume }) => {
      extractor = 'mindgrab';
      return { brain: inputVolume, mask: lesion, provenance: {} };
    },
    registration,
    imageMath,
  });
  assert.equal(extractor, 'mindgrab');
  assert.equal(result.provenance.normalization, 'greedy');
  assert.equal(affineRegistrations, 1);
  assert.deepEqual(reslices.map(({ fill }) => fill), [0, 0, 0]);
  assert.equal(reslices[2].interpolation, 'nearest');
  assert.equal(reslices[1].precedingMatrix, 'pathological-affine');
  assert.deepEqual(Object.keys(result.outputs), [
    't1primary.nii',
    'wbt1primary.nii',
    'wprimary.nii',
    'wtrace.nii',
    'wlesion.nii',
    'wbprimary.nii',
  ]);
});

test('CT reslicing uses the lower of zero and the source minimum', async () => {
  const ct = { ...volume, data: Float32Array.from(volume.data, (_, index) => -1024 + index) };
  const source = writeVolume(ct);
  let fill;
  await runSyncro({
    input: source,
    inputName: 'ct.nii',
    template: writeVolume(volume),
    ct: true,
    synthesize: async () => ({ buffer: writeVolume(volume), provenance: {} }),
    extractBrain: async ({ volume: inputVolume }) => ({ brain: inputVolume, provenance: {} }),
    registration: {
      provenance: {},
      register: ({ moving }) => ({ warped: new Uint8Array(moving), matrix: 'm', warp: Uint8Array.of(1) }),
      apply: ({ moving, fill: value }) => {
        fill ??= value;
        return new Uint8Array(moving);
      },
      release() {},
    },
  });
  assert.equal(fill, -1024);
});

test('a gantry-tilted scan and its lesion are desheared onto one orthogonal grid, filled with the darkest voxel', async () => {
  assert.equal(orthogonalGrid(volume), null);
  // 8.5 degree tilt: voxel y also moves world z. Trilinear sampling reproduces a linear field exactly.
  const tilted = [[-1, 0, 0, 5], [0, 1, 0, 0], [0, 0.15, 1, 0], [0, 0, 0, 1]];
  const dims = [6, 8, 5];
  const field = (x, y, z) => 2 * x + 3 * y + 5 * z - 50;
  const data = new Float32Array(240);
  for (let z = 0, i = 0; z < 5; z += 1) for (let y = 0; y < 8; y += 1) for (let x = 0; x < 6; x += 1, i += 1) data[i] = field(5 - x, y, 0.15 * y + z);
  const darkest = Math.min(...data);
  const grid = orthogonalGrid({ dims, affine: tilted });
  const step = Math.hypot(1, 0.15);
  assert.deepEqual(grid.dims, [6, 8, 7]);
  assert.equal(grid.affine[0][0], -1);
  assert.equal(grid.affine[0][3], 5);
  assert.equal(grid.affine[1][1], step);
  assert.equal(grid.affine[2][2], 1);
  assert.ok(Math.abs(grid.affine[2][3] + 0.075) < 1e-6);
  const desheared = resampleOnto({ data, dims, affine: tilted }, grid, darkest);
  const voxel = (x, y, z) => desheared.data[x + dims[0] * (y + grid.dims[1] * z)];
  assert.ok(Math.abs(voxel(2, 3, 2) - field(3, 3 * step, 1.925)) < 1e-3);
  assert.equal(voxel(2, 7, 0), darkest);

  const seen = [];
  const input = writeVolume({ data, dims, affine: tilted });
  const edge = 3 + dims[0] * (7 + dims[1] * 2);
  const mask = writeVolume({ data: Uint8Array.from(data, (_, i) => Number(i === edge)), dims, affine: tilted });
  const result = await runSyncro({
    input,
    inputName: 'ct.nii',
    lesion: { name: 'lesion.nii', buffer: mask },
    template: writeVolume(volume),
    synthesize: async ({ buffer }) => {
      seen.push(readVolume(buffer));
      return { buffer: writeVolume(volume), provenance: {} };
    },
    extractBrain: async ({ volume: inputVolume }) => ({ brain: inputVolume, provenance: {} }),
    registration: {
      provenance: {},
      register: ({ moving }) => ({ warped: new Uint8Array(moving), matrix: 'm', warp: Uint8Array.of(1) }),
      apply: ({ moving }) => {
        seen.push(readVolume(asBuffer(moving)));
        return new Uint8Array(moving);
      },
      release() {},
    },
    imageMath: { smoothLesion: ({ buffer }) => new Uint8Array(buffer), thresholdLesion: ({ buffer }) => new Uint8Array(buffer), mask: ({ image }) => new Uint8Array(image) },
  });
  assert.deepEqual(result.provenance.desheared, { primary: true, pathological: false, lesion: true });
  for (const image of seen.slice(0, 3)) assert.ok(sameGeometry(image, grid));
  assert.equal(seen[2].data.reduce((sum, value) => sum + value, 0), 1);
});

test('a sheared lesion on a compatible orthogonal scan is passed to registration on the scan grid', async () => {
  const shear = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0.005, 1, 0], [0, 0, 0, 1]];
  const mask = writeVolume({ ...lesion, affine: shear, data: Uint8Array.from(lesion.data, (_, i) => Number(i === 62)) });
  const source = writeVolume(volume);
  const result = await runSyncro({
    input: source,
    inputName: 'primary.nii',
    lesion: { name: 'lesion.nii', buffer: mask },
    template: source,
    synthesize: async ({ buffer }) => ({ buffer, provenance: {} }),
    extractBrain: async ({ volume: brain }) => ({ brain, provenance: {} }),
    registration: {
      provenance: {},
      register: ({ moving }) => ({ warped: new Uint8Array(moving) }),
      apply: ({ moving, interpolation }) => {
        if (interpolation === 'nearest') assert.deepEqual(readVolume(asBuffer(moving)).affine, affine);
        return new Uint8Array(moving);
      },
      release() {},
    },
    imageMath: {
      smoothLesion: ({ buffer }) => new Uint8Array(buffer),
      thresholdLesion: ({ buffer }) => new Uint8Array(buffer),
      mask: ({ image }) => image,
    },
  });
  assert.deepEqual(result.provenance.desheared, { primary: false, pathological: false, lesion: true });
  assert.equal(readVolume(asBuffer(result.outputs['wlesion.nii'])).data[62], 1);
});

test('deshearing uses Greedy’s orthonormality tolerance for oblique sforms', () => {
  const oblique = [
    [0.57735026, 0.57735026, 0.57735026, 0],
    [0.70704317, -0.70704317, 0, 0],
    [0.40821156, 0.40821156, -0.81642312, 0],
    [0, 0, 0, 1],
  ];
  assert.ok(orthogonalGrid({ dims: volume.dims, affine: oblique }));
});

test('deshearing rejects oversized output grids before resampling', () => {
  const stretched = [[0.5, 0, 4, 0], [0, 0.5, 0, 0], [0, 0, 8, 0], [0, 0, 0, 1]];
  assert.throws(() => orthogonalGrid({ dims: [512, 512, 256], affine: stretched }), /orthogonal output grid is too large/);
});

const supportTemplate = {
  dims: [25, 25, 20],
  affine,
  data: Float32Array.from({ length: 12500 }, (_, index) => index < 10000 ? 1 : 0),
};

function registrationFixture(warped, template = supportTemplate) {
  const calls = { apply: 0, mask: 0, release: 0, complete: 0 };
  const source = writeVolume(volume);
  const result = { warped };
  return {
    calls,
    run: () => runSyncro({
      input: source,
      inputName: 'primary.nii',
      template: writeVolume(template),
      synthesize: async () => ({ buffer: source, provenance: {} }),
      extractBrain: async () => ({ brain: volume, provenance: {} }),
      registration: {
        register: () => result,
        apply: () => {
          calls.apply += 1;
          return warped;
        },
        release: (released) => {
          assert.equal(released, result);
          calls.release += 1;
        },
      },
      imageMath: {
        mask: ({ image }) => {
          calls.mask += 1;
          return image;
        },
      },
      onProgress: (stage) => {
        if (stage === 'complete') calls.complete += 1;
      },
    }),
  };
}

function supportedBrain(count, offset = 0) {
  const data = new Float32Array(supportTemplate.data.length);
  data.fill(100, offset, offset + count);
  return { ...supportTemplate, data };
}

test('normalization refuses 81 surviving brain voxels on a 10000-voxel template', async () => {
  const fixture = registrationFixture(writeVolume(supportedBrain(81)));
  await assert.rejects(fixture.run(), /Normalization failed.*81.*10000/);
  assert.deepEqual(fixture.calls, { apply: 0, mask: 0, release: 1, complete: 0 });
});

for (const [name, brain, error] of [
  ['empty brain', supportedBrain(0), /too little/],
  ['brain outside template support', supportedBrain(2000, 10000), /too little/],
  ['just below the support floor', supportedBrain(99), /99\/10000/],
  ['wrong dimensions', volume, /template grid/],
  ['wrong physical frame', { ...supportedBrain(10000), affine: affine.map((row, index) => index === 0 ? [1, 0, 0, 1] : row) }, /template grid/],
  ['nonfinite brain', { ...supportTemplate, data: Float32Array.from(supportTemplate.data, (_, index) => index === 0 ? NaN : 1) }, /non-finite/],
]) {
  test(`normalization rejects ${name} and releases registration before resampling`, async () => {
    const fixture = registrationFixture(writeVolume(brain));
    await assert.rejects(fixture.run(), error);
    assert.deepEqual(fixture.calls, { apply: 0, mask: 0, release: 1, complete: 0 });
  });
}

for (const [name, count, compressed] of [
  ['healthy brain', 10000, false],
  ['exactly one percent support', 100, false],
  ['gzip brain', 10000, true],
]) {
  test(`normalization accepts ${name}`, async () => {
    const raw = writeVolume(supportedBrain(count));
    const warped = compressed ? gzipSync(new Uint8Array(raw)) : new Uint8Array(raw);
    const fixture = registrationFixture(warped);
    const result = await fixture.run();
    assert.equal(result.outputs['wbt1primary.nii'], warped);
    assert.deepEqual(fixture.calls, { apply: 1, mask: 1, release: 1, complete: 1 });
  });
}

test('gzip brain with collapsed support is rejected', async () => {
  const fixture = registrationFixture(gzipSync(new Uint8Array(writeVolume(supportedBrain(81)))));
  await assert.rejects(fixture.run(), /81\/10000/);
  assert.deepEqual(fixture.calls, { apply: 0, mask: 0, release: 1, complete: 0 });
});

test('empty template is rejected and registration is released', async () => {
  const fixture = registrationFixture(writeVolume(supportedBrain(10000)), supportedBrain(0));
  await assert.rejects(fixture.run(), /Invalid MNI template/);
  assert.deepEqual(fixture.calls, { apply: 0, mask: 0, release: 1, complete: 0 });
});

test('nonfinite template is rejected before registration', async () => {
  const template = supportedBrain(10000);
  template.data[0] = Infinity;
  const fixture = registrationFixture(writeVolume(supportedBrain(10000)), template);
  await assert.rejects(fixture.run(), /non-finite/);
  assert.deepEqual(fixture.calls, { apply: 0, mask: 0, release: 0, complete: 0 });
});
