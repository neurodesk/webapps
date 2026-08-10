import type { Shape3 } from './logical_volume'

export interface CoordinateTransform {
  type: string
  scale?: number[]
  translation?: number[]
}
export interface MosaicBlockInput {
  id: string
  shape: Shape3
  spacing: Shape3
  translation: Shape3
}

export interface MosaicBlockLayout extends MosaicBlockInput {
  voxelOrigin: Shape3
}

export interface MosaicLayout {
  shape: Shape3
  spacing: Shape3
  worldOrigin: Shape3
  blocks: MosaicBlockLayout[]
}

/**
 * Return a collision-free identity for the exact ordered set of mosaic stores.
 * Length prefixes avoid ambiguous joins while retaining the full store URLs.
 */
export function translatedMosaicId(storeIds: readonly string[]): string {
  return `translated-mosaic:${storeIds
    .map((storeId) => `${storeId.length}:${storeId}`)
    .join('|')}`
}

/** NiiVue's streamed-brick cache must not share bricks between pyramid levels. */
export function translatedMosaicVolumeId(
  sourceId: string,
  level: number,
): string {
  return `${sourceId}:L${level}`
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-6)
}

/** Compose NGFF transforms in application order and return trailing X/Y/Z in mm. */
export function spatialTransformMm(
  transformSequences: Array<CoordinateTransform[] | undefined>,
  axisUnits: number[],
): { spacing: Shape3; translation: Shape3 } {
  const transforms = transformSequences.flatMap((sequence) => sequence ?? [])
  const dimensions = Math.max(
    3,
    axisUnits.length,
    ...transforms.flatMap((transform) => [
      transform.scale?.length ?? 0,
      transform.translation?.length ?? 0,
    ]),
  )
  const scale = Array.from({ length: dimensions }, () => 1)
  const translation = Array.from({ length: dimensions }, () => 0)
  for (const transform of transforms) {
    if (transform.type === 'scale') {
      for (let axis = 0; axis < dimensions; axis++) {
        const factor = transform.scale?.[axis] ?? 1
        scale[axis] *= factor
        translation[axis] *= factor
      }
    } else if (transform.type === 'translation') {
      for (let axis = 0; axis < dimensions; axis++) {
        translation[axis] += transform.translation?.[axis] ?? 0
      }
    }
  }
  const units = Array.from(
    { length: dimensions },
    (_, axis) => axisUnits[axis] ?? 1,
  )
  const spatialScale = scale.slice(-3).map((value, axis) => {
    return value * (units.slice(-3)[axis] ?? 1)
  })
  const spatialTranslation = translation.slice(-3).map((value, axis) => {
    return value * (units.slice(-3)[axis] ?? 1)
  })
  return {
    spacing: [spatialScale[2], spatialScale[1], spatialScale[0]],
    translation: [
      spatialTranslation[2],
      spatialTranslation[1],
      spatialTranslation[0],
    ],
  }
}

export function layoutTranslatedBlocks(
  inputs: MosaicBlockInput[],
): MosaicLayout {
  if (inputs.length < 2) {
    throw new Error('A translated mosaic needs at least two OME-Zarr stores')
  }
  const spacing = inputs[0]?.spacing
  if (!spacing) throw new Error('The translated mosaic has no blocks')
  for (const block of inputs) {
    for (let axis = 0; axis < 3; axis++) {
      if (!close(block.spacing[axis], spacing[axis])) {
        throw new Error(
          `Store ${block.id} has spacing ${block.spacing.join(' x ')} mm; all translated stores must use ${spacing.join(' x ')} mm at the selected level`,
        )
      }
    }
  }
  const worldOrigin = [0, 1, 2].map((axis) =>
    Math.min(...inputs.map((block) => block.translation[axis])),
  ) as Shape3
  const blocks = inputs.map((block): MosaicBlockLayout => {
    const voxelOrigin = block.translation.map(
      (translation, axis) => (translation - worldOrigin[axis]) / spacing[axis],
    ) as Shape3
    return { ...block, voxelOrigin }
  })
  const shape = [0, 1, 2].map((axis) =>
    Math.ceil(
      Math.max(
        ...blocks.map((block) => block.voxelOrigin[axis] + block.shape[axis]),
      ),
    ),
  ) as Shape3
  return { shape, spacing: [...spacing], worldOrigin, blocks }
}
