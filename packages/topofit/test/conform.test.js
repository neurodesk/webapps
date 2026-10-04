import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { conformVolume } from '../src/conform.js';

test('conform matches SciPy cubic interpolation on a centered integer volume', () => {
  const dims = [3, 4, 5];
  const data = Int16Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, index) => index - 20);
  const actual = conformVolume(
    {
      data,
      dims,
      affine: [
        [2, 0, 0, 4],
        [0, 2, 0, 5],
        [0, 0, 2, 6],
        [0, 0, 0, 1],
      ],
      datatypeCode: 4,
    },
    { shape: [5, 6, 7] },
  );

  assert.deepEqual(actual.dims, [5, 6, 7]);
  assert.deepEqual(actual.affine, [
    [1, 0, 0, 4],
    [0, 1, 0, 5],
    [0, 0, 1, 7],
    [0, 0, 0, 1],
  ]);
  assert.deepEqual([...actual.data], [
    -16, -16, -15, -14, -14, -15, -15, -14, -13, -13, -13, -13, -12, -11, -11,
    -11, -11, -10, -10, -9, -10, -10, -9, -8, -8, -8, -8, -7, -6, -6, -8, -8,
    -7, -6, -6, -7, -7, -6, -5, -5, -5, -5, -4, -3, -3, -3, -3, -3, -2, -1,
    -2, -2, -1, 0, 0, 0, 0, 1, 2, 2, -1, -1, 0, 0, 1, 0, 0, 1, 1, 2, 2, 2,
    3, 3, 4, 3, 3, 4, 5, 5, 5, 5, 6, 6, 7, 7, 7, 8, 8, 9, 4, 4, 5, 6, 6,
    5, 5, 6, 7, 7, 7, 7, 8, 9, 9, 9, 9, 10, 10, 11, 10, 10, 11, 12, 12, 12,
    12, 13, 14, 14, 9, 10, 10, 11, 11, 10, 11, 11, 12, 12, 12, 13, 13, 14, 14,
    14, 14, 15, 16, 16, 15, 16, 16, 17, 17, 17, 18, 18, 19, 19, 16, 16, 17, 18,
    18, 17, 17, 18, 19, 19, 19, 19, 20, 21, 21, 21, 21, 22, 22, 23, 22, 22, 23,
    24, 24, 24, 24, 25, 26, 26, 24, 24, 25, 26, 26, 25, 25, 26, 27, 27, 27, 27,
    28, 29, 29, 28, 29, 29, 30, 30, 30, 30, 31, 32, 32, 32, 32, 33, 34, 34,
  ]);
});

test('conform matches nibabel orientation permutations and flips', () => {
  const dims = [3, 4, 5];
  const actual = conformVolume(
    {
      data: Int16Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, index) => index - 20),
      dims,
      affine: [
        [0, 0, -4, 10],
        [2, 0, 0, 20],
        [0, 3, 0, 30],
        [0, 0, 0, 1],
      ],
      datatypeCode: 4,
    },
    { shape: [5, 6, 7] },
  );

  assert.deepEqual(actual.affine, [
    [1, 0, 0, 0],
    [0, 1, 0, 20],
    [0, 0, 1, 30],
    [0, 0, 0, 1],
  ]);
  assert.equal(
    createHash('sha256').update(new Uint8Array(actual.data.buffer)).digest('hex'),
    'f31080e375885ee239f8997a74ccf96b78ba8f88a1bf079505d2b6c7784ed595',
  );
});

test('conform preserves obliquity and world centre while cubic reproduces a linear field', () => {
  // nibabel preserves the 10° rotation while rescaling the anisotropic columns.
  const [c, s] = [Math.cos(Math.PI / 18), Math.sin(Math.PI / 18)];
  const dims = [32, 32, 32];
  const affine = [
    [1.2 * c, -1.5 * s, 0, -20],
    [1.2 * s, 1.5 * c, 0, -25],
    [0, 0, 1.1, -18],
    [0, 0, 0, 1],
  ];
  const field = ([x, y, z]) => 0.5 + x + 2 * y + 3 * z;
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k += 1) for (let j = 0; j < dims[1]; j += 1) for (let i = 0; i < dims[0]; i += 1) {
    const world = affine.slice(0, 3).map((row) => row[0] * i + row[1] * j + row[2] * k + row[3]);
    data[i + dims[0] * (j + dims[1] * k)] = field(world);
  }
  const actual = conformVolume({ data, dims, affine, datatypeCode: 16 }, { shape: [5, 5, 5] });

  const sourceCentre = affine.slice(0, 3).map((row) => row[0] * 15 + row[1] * 15 + row[2] * 15 + row[3]);
  const expectedRotation = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      assert.ok(Math.abs(actual.affine[row][column] - expectedRotation[row][column]) < 1e-12);
    }
    const targetCentre = actual.affine[row][3] + actual.affine[row].slice(0, 3).reduce((sum, value) => sum + 2 * value, 0);
    assert.ok(Math.abs(targetCentre - sourceCentre[row]) < 1e-9);
  }
  // Far from the source edges the prefilter's mirror boundary has decayed, so the spline is exact.
  for (let k = 0; k < 5; k += 1) for (let j = 0; j < 5; j += 1) for (let i = 0; i < 5; i += 1) {
    const world = actual.affine.slice(0, 3).map((row) => row[0] * i + row[1] * j + row[2] * k + row[3]);
    assert.ok(Math.abs(actual.data[i + 5 * (j + 5 * k)] - field(world)) < 1e-4, `voxel ${i},${j},${k}`);
  }
});

// Generated with nibabel 5.3.2 in the pinned TopoFit 0.5.1 reference container.
test('conform matches pinned nibabel for oblique geometry and cubic samples', () => {
  const dims = [5, 6, 7];
  const data = Int16Array.from({ length: 210 }, (_, index) => {
    const x = index % 5;
    const y = Math.floor(index / 5) % 6;
    const z = Math.floor(index / 30);
    return 42 * x + 7 * y + z;
  });
  const affine = [
    [0.9800665974617004, -0.19866932928562164, 0.0, 0.0],
    [0.19866932928562164, 0.9800665974617004, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
  ];
  const actual = conformVolume({ data, dims, affine, datatypeCode: 4 }, { shape: [4, 4, 4] });
  const expectedAffine = [
    [0.9800665789095531, -0.19866932552491529, 0.0, 0.7813972829675198],
    [0.19866932552491529, 0.9800665789095531, 0.0, 1.1787359490601759],
    [0.0, 0.0, 1.0, 2.0],
    [0.0, 0.0, 0.0, 1.0],
  ];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      assert.ok(Math.abs(actual.affine[row][column] - expectedAffine[row][column]) < 1e-12);
    }
  }
  assert.deepEqual([...actual.data], [
    51, 93, 135, 177, 58, 100, 142, 184, 65, 107, 149, 191, 72, 114, 156, 198,
    52, 94, 136, 178, 59, 101, 143, 185, 66, 108, 150, 192, 73, 115, 157, 199,
    53, 95, 137, 179, 60, 102, 144, 186, 67, 109, 151, 193, 74, 116, 158, 200,
    54, 96, 138, 180, 61, 103, 145, 187, 68, 110, 152, 194, 75, 117, 159, 201,
  ]);
});
test('conform matches pinned nibabel for shear geometry and cubic samples', () => {
  const dims = [5, 6, 7];
  const data = Int16Array.from({ length: 210 }, (_, index) => {
    const x = index % 5;
    const y = Math.floor(index / 5) % 6;
    const z = Math.floor(index / 30);
    return x * x + 3 * y + z * z;
  });
  const affine = [
    [1.2000000476837158, 0.4000000059604645, -0.10000000149011612, 2.0],
    [0.20000000298023224, 1.2999999523162842, 0.20000000298023224, 3.0],
    [0.0, 0.10000000149011612, 1.100000023841858, 4.0],
    [0.0, 0.0, 0.0, 1.0],
  ];
  const actual = conformVolume({ data, dims, affine, datatypeCode: 4 }, { shape: [4, 4, 4] });
  const expectedAffine = [
    [0.9863939244942344, 0.29329424378839725, -0.08908708005801011, 3.709399014593391],
    [0.1643989833328129, 0.9532062431450127, 0.17817416011602022, 5.304220532939883],
    [0.0, 0.07332356094709931, 0.9799578872756158, 6.446718626283091],
    [0.0, 0.0, 0.0, 1.0],
  ];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      assert.ok(Math.abs(actual.affine[row][column] - expectedAffine[row][column]) < 1e-12);
    }
  }
  assert.deepEqual([...actual.data], [
    10, 12, 16, 23, 12, 14, 18, 25, 14, 17, 20, 27, 16, 19, 22, 29,
    14, 17, 21, 28, 16, 19, 23, 30, 19, 21, 25, 32, 21, 23, 27, 34,
    21, 23, 27, 34, 23, 25, 29, 36, 25, 27, 31, 38, 27, 30, 33, 40,
    28, 30, 34, 41, 30, 32, 36, 43, 32, 35, 38, 45, 34, 37, 40, 47,
  ]);
});
test('conform matches pinned nibabel for oblique-flip geometry and cubic samples', () => {
  const dims = [5, 6, 7];
  const data = Int16Array.from({ length: 210 }, (_, index) => {
    const x = index % 5;
    const y = Math.floor(index / 5) % 6;
    const z = Math.floor(index / 30);
    return x * x + 3 * y + z * z;
  });
  const affine = [
    [0.0, -0.20000000298023224, -1.2999999523162842, 2.0],
    [-1.2000000476837158, 0.10000000149011612, 0.0, 3.0],
    [0.10000000149011612, 1.399999976158142, 0.20000000298023224, 4.0],
    [0.0, 0.0, 0.0, 1.0],
  ];
  const actual = conformVolume({ data, dims, affine, datatypeCode: 4 }, { shape: [4, 4, 4] });
  const expectedAffine = [
    [0.9883716964718623, 0.0, -0.1410691275641544, -3.1473024318170246],
    [0.0, 0.9965457584155658, 0.0705345637820772, -0.26708041458484244],
    [-0.15205719191584738, -0.0830454778055071, 0.9874838614176742, 6.847618772540893],
    [0.0, 0.0, 0.0, 1.0],
  ];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      assert.ok(Math.abs(actual.affine[row][column] - expectedAffine[row][column]) < 1e-12);
    }
  }
  assert.deepEqual([...actual.data], [
    26, 21, 17, 14, 22, 17, 13, 10, 20, 14, 10, 8, 18, 13, 9, 6,
    28, 23, 19, 16, 24, 19, 15, 12, 22, 16, 12, 10, 20, 15, 11, 8,
    30, 25, 21, 18, 26, 21, 17, 14, 24, 19, 15, 12, 23, 17, 13, 10,
    32, 27, 23, 20, 28, 23, 19, 16, 26, 21, 17, 14, 25, 19, 15, 12,
  ]);
});

test('conform matches pinned nibabel for polar-selected shear geometry and cubic samples', () => {
  const dims = [5, 6, 7];
  const data = Int16Array.from({ length: 210 }, (_, index) => {
    const x = index % 5;
    const y = Math.floor(index / 5) % 6;
    const z = Math.floor(index / 30);
    return x * x + 3 * y + z * z;
  });
  const affine = [
    [-1.4, 1.2, 1.3, -0.3],
    [-1.1, -0.8, -0.8, 5.6],
    [-1.7, 0.0, 0.6, -4.3],
    [0.0, 0.0, 0.0, 1.0],
  ];
  const actual = conformVolume({ data, dims, affine, datatypeCode: 4 }, { shape: [4, 4, 4] });
  const expectedAffine = [
    [0.8320502943378436, 0.5687111245916712, 0.7926239891046002, 1.006614591965885],
    [-0.5547001962252291, 0.44684445503631315, -0.48776860867975397, -0.004375650131330788],
    [0.0, 0.6905777941470294, 0.36582645650981543, -6.956404250656844],
    [0.0, 0.0, 0.0, 1.0],
  ];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      assert.ok(Math.abs(actual.affine[row][column] - expectedAffine[row][column]) < 1e-12);
    }
  }
  assert.deepEqual([...actual.data], [
    15, 17, 19, 21, 14, 16, 18, 20, 12, 14, 16, 18, 11, 13, 15, 17,
    19, 20, 23, 25, 17, 19, 21, 23, 16, 18, 20, 22, 14, 16, 19, 21,
    23, 25, 27, 29, 21, 23, 25, 27, 20, 22, 24, 26, 19, 21, 23, 25,
    27, 29, 31, 33, 26, 28, 30, 32, 24, 26, 28, 30, 23, 25, 27, 29,
  ]);
});
