/** A synthetic 8³ DWI with a known prolate tensor, as image, bval and bvec files. */
export function diffusion() {
  const directions = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[Math.SQRT1_2,Math.SQRT1_2,0],[Math.SQRT1_2,0,Math.SQRT1_2],[0,Math.SQRT1_2,Math.SQRT1_2]];
  const buffer = Buffer.alloc(352 + 8 ** 3 * directions.length * 4);
  buffer.writeInt32LE(348, 0);
  [4,8,8,8,directions.length,1,1,1].forEach((value, index) => buffer.writeInt16LE(value, 40 + index * 2));
  buffer.writeInt16LE(16, 70);
  buffer.writeInt16LE(32, 72);
  for (let axis = 0; axis < 8; axis++) buffer.writeFloatLE(1, 76 + axis * 4);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer.writeInt16LE(1, 254);
  [280,300,320].forEach((offset) => buffer.writeFloatLE(1, offset));
  buffer.write('n+1\0', 344);
  directions.forEach(([x,y,z], direction) => {
    const value = 1000 * Math.exp(-1000 * (.0015*x*x + .0005*y*y + .0005*z*z));
    for (let voxel = 0; voxel < 8 ** 3; voxel++) buffer.writeFloatLE(value, 352 + (direction * 8 ** 3 + voxel) * 4);
  });
  return {
    image: { name: 'image.nii', buffer },
    bval: { name: 'values.bval', buffer: Buffer.from('0 1000 1000 1000 1000 1000 1000') },
    bvec: { name: 'directions.bvec', buffer: Buffer.from([0,1,2].map((axis) => directions.map((direction) => direction[axis]).join(' ')).join('\n')) },
  };
}
