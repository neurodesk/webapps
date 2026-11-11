/** Default maximum streamline length in mm. Longer streamlines loop: no white-matter pathway is longer. */
export const DEFAULT_MAX_LENGTH_MM = 250

/** Length in mm of a voxel-space streamline (x, y, z triplets) under the voxel-to-RAS affine. */
export function streamlineLengthMm(line: Float32Array, voxelToRasmm: number[][]): number {
  const [r0, r1, r2] = voxelToRasmm
  let length = 0
  for (let j = 3; j < line.length; j += 3) {
    const dx = line[j] - line[j - 3]
    const dy = line[j + 1] - line[j - 2]
    const dz = line[j + 2] - line[j - 1]
    length += Math.hypot(
      r0[0] * dx + r0[1] * dy + r0[2] * dz,
      r1[0] * dx + r1[1] * dy + r1[2] * dz,
      r2[0] * dx + r2[1] * dy + r2[2] * dz,
    )
  }
  return length
}

/** Removes streamlines longer than `maxLengthMm` in place, keeping order, and returns how many were removed. */
export function dropLongStreamlines(lines: Float32Array[], voxelToRasmm: number[][], maxLengthMm: number): number {
  let kept = 0
  for (const line of lines) {
    if (streamlineLengthMm(line, voxelToRasmm) <= maxLengthMm) lines[kept++] = line
  }
  const removed = lines.length - kept
  lines.length = kept
  return removed
}
