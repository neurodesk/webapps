// A 32³ NIfTI-1 mask with a straight 12×12×26 voxel tunnel along z.
export function fixtureMask() {
  const buffer = Buffer.alloc(352 + 32 ** 3);
  buffer.writeInt32LE(348, 0);
  [3, 32, 32, 32, 1, 1, 1, 1].forEach((v, i) =>
    buffer.writeInt16LE(v, 40 + i * 2),
  );
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  for (let i = 0; i < 4; i++) buffer.writeFloatLE(1, 76 + i * 4);
  buffer.writeFloatLE(352, 108);
  buffer.write("n+1\0", 344);
  for (let z = 3; z < 29; z++)
    for (let y = 10; y < 22; y++)
      for (let x = 10; x < 22; x++) buffer[352 + x + 32 * (y + 32 * z)] = 1;
  return buffer;
}
