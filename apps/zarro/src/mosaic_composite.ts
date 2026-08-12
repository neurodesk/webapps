import type { Shape3 } from './logical_volume'

export interface MosaicSamplingWindow {
  outputLo: Shape3
  outputHi: Shape3
  sourceOrigin: Shape3
  sourceDims: Shape3
}

export interface FetchedMosaicBlock extends MosaicSamplingWindow {
  voxelOrigin: Shape3
  shape: Shape3
  bytes: Uint8Array
}

/**
 * Select the source voxels needed to sample one translated block into an
 * output region. Voxel origins may be fractional and voxel-edge coverage is
 * retained at the source boundary.
 */
export function mosaicSamplingWindow(
  voxelOrigin: Shape3,
  shape: Shape3,
  outputOrigin: Shape3,
  outputDims: Shape3,
): MosaicSamplingWindow | null {
  const outputLo = [0, 1, 2].map((axis) =>
    Math.max(outputOrigin[axis], Math.ceil(voxelOrigin[axis] - 0.5)),
  ) as Shape3
  const outputHi = [0, 1, 2].map((axis) =>
    Math.min(
      outputOrigin[axis] + outputDims[axis],
      Math.floor(voxelOrigin[axis] + shape[axis] - 0.5) + 1,
    ),
  ) as Shape3
  if (outputLo.some((value, axis) => value >= outputHi[axis])) return null

  const sourceOrigin = outputLo.map((value, axis) =>
    Math.max(0, Math.floor(value - voxelOrigin[axis])),
  ) as Shape3
  const sourceHi = outputHi.map((value, axis) =>
    Math.min(
      shape[axis],
      Math.floor(value - 1 - voxelOrigin[axis]) + 2,
    ),
  ) as Shape3
  const sourceDims = sourceHi.map(
    (value, axis) => value - sourceOrigin[axis],
  ) as Shape3
  return { outputLo, outputHi, sourceOrigin, sourceDims }
}

interface AxisSample {
  low: number
  high: number
  fraction: number
}

function axisSamples(
  outputLo: number,
  outputHi: number,
  voxelOrigin: number,
  sourceOrigin: number,
  blockSize: number,
): AxisSample[] {
  const samples: AxisSample[] = []
  for (let output = outputLo; output < outputHi; output++) {
    const local = output - voxelOrigin
    const floor = Math.floor(local)
    if (floor < 0) {
      samples.push({ low: -sourceOrigin, high: -sourceOrigin, fraction: 0 })
      continue
    }
    if (floor >= blockSize - 1) {
      const edge = blockSize - 1 - sourceOrigin
      samples.push({ low: edge, high: edge, fraction: 0 })
      continue
    }
    samples.push({
      low: floor - sourceOrigin,
      high: floor + 1 - sourceOrigin,
      fraction: local - floor,
    })
  }
  return samples
}

function sourceReader(
  block: FetchedMosaicBlock,
  bytesPerVoxel: number,
): (x: number, y: number, z: number) => number {
  const view =
    bytesPerVoxel === 2
      ? new DataView(
          block.bytes.buffer,
          block.bytes.byteOffset,
          block.bytes.byteLength,
        )
      : null
  return (x, y, z) => {
    const index = (z * block.sourceDims[1] + y) * block.sourceDims[0] + x
    return view ? view.getUint16(index * 2, true) : (block.bytes[index] ?? 0)
  }
}

function lerp(left: number, right: number, fraction: number): number {
  return left + (right - left) * fraction
}

function interpolatedValue(
  read: (x: number, y: number, z: number) => number,
  x: AxisSample,
  y: AxisSample,
  z: AxisSample,
): number {
  const atX = (sampleY: number, sampleZ: number): number => {
    const low = read(x.low, sampleY, sampleZ)
    return x.fraction === 0
      ? low
      : lerp(low, read(x.high, sampleY, sampleZ), x.fraction)
  }
  const atY = (sampleZ: number): number => {
    const low = atX(y.low, sampleZ)
    return y.fraction === 0
      ? low
      : lerp(low, atX(y.high, sampleZ), y.fraction)
  }
  const low = atY(z.low)
  return z.fraction === 0 ? low : lerp(low, atY(z.high), z.fraction)
}

/** Resample translated uint8/uint16 blocks and average intentional overlaps. */
export function compositeMosaicBlocks(
  outputOrigin: Shape3,
  outputDims: Shape3,
  bytesPerVoxel: number,
  blocks: FetchedMosaicBlock[],
): Uint8Array {
  if (bytesPerVoxel !== 1 && bytesPerVoxel !== 2) {
    throw new Error(`Mosaic compositing does not support ${bytesPerVoxel}-byte voxels`)
  }
  const voxelCount = outputDims[0] * outputDims[1] * outputDims[2]
  const output = new Uint8Array(voxelCount * bytesPerVoxel)
  const outputView = bytesPerVoxel === 2 ? new DataView(output.buffer) : null
  const contributors = new Uint8Array(voxelCount)
  const maximum = bytesPerVoxel === 1 ? 255 : 65535

  for (const block of blocks) {
    const expectedBytes =
      block.sourceDims[0] *
      block.sourceDims[1] *
      block.sourceDims[2] *
      bytesPerVoxel
    if (block.bytes.byteLength !== expectedBytes) {
      throw new Error(
        `Mosaic block returned ${block.bytes.byteLength}B, expected ${expectedBytes}B`,
      )
    }
    const xs = axisSamples(
      block.outputLo[0],
      block.outputHi[0],
      block.voxelOrigin[0],
      block.sourceOrigin[0],
      block.shape[0],
    )
    const ys = axisSamples(
      block.outputLo[1],
      block.outputHi[1],
      block.voxelOrigin[1],
      block.sourceOrigin[1],
      block.shape[1],
    )
    const zs = axisSamples(
      block.outputLo[2],
      block.outputHi[2],
      block.voxelOrigin[2],
      block.sourceOrigin[2],
      block.shape[2],
    )
    const read = sourceReader(block, bytesPerVoxel)

    for (let z = 0; z < zs.length; z++) {
      const sampleZ = zs[z]!
      const outputZ = block.outputLo[2] + z - outputOrigin[2]
      for (let y = 0; y < ys.length; y++) {
        const sampleY = ys[y]!
        const outputY = block.outputLo[1] + y - outputOrigin[1]
        for (let x = 0; x < xs.length; x++) {
          const sampleX = xs[x]!
          const outputX = block.outputLo[0] + x - outputOrigin[0]
          const value = interpolatedValue(read, sampleX, sampleY, sampleZ)
          const outputIndex =
            (outputZ * outputDims[1] + outputY) * outputDims[0] + outputX
          const count = contributors[outputIndex]
          const current = outputView
            ? outputView.getUint16(outputIndex * 2, true)
            : (output[outputIndex] ?? 0)
          const blended = Math.min(
            maximum,
            Math.max(0, Math.round((current * count + value) / (count + 1))),
          )
          if (outputView) outputView.setUint16(outputIndex * 2, blended, true)
          else output[outputIndex] = blended
          contributors[outputIndex] = Math.min(255, count + 1)
        }
      }
    }
  }

  return output
}
