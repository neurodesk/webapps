export interface MeasurementLine {
  startMM: readonly [number, number, number]
  endMM: readonly [number, number, number]
}

export interface MeasurementSlice {
  leftTopWidthHeight?: ArrayLike<number>
  mvpMatrix?: ArrayLike<number>
  planeNormal?: ArrayLike<number>
  planePoint?: ArrayLike<number>
}

function projectPoint(
  point: readonly [number, number, number],
  matrix: ArrayLike<number>,
  viewport: ArrayLike<number>,
): [number, number] | null {
  const [x, y, z] = point
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-8) return null
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
  return [
    viewport[0] + (clipX / w + 1) * 0.5 * viewport[2],
    viewport[1] + (1 - clipY / w) * 0.5 * viewport[3],
  ]
}

function liesOnPlane(
  point: readonly [number, number, number],
  normal: ArrayLike<number>,
  planePoint: ArrayLike<number>,
  tolerance: number,
): boolean {
  const distance = Math.abs(
    (point[0] - planePoint[0]) * normal[0] +
      (point[1] - planePoint[1]) * normal[1] +
      (point[2] - planePoint[2]) * normal[2],
  )
  return distance <= tolerance
}

function distanceToSegment(
  pointX: number,
  pointY: number,
  start: readonly [number, number],
  end: readonly [number, number],
): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(pointX - start[0], pointY - start[1])
  const projection = Math.min(
    1,
    Math.max(
      0,
      ((pointX - start[0]) * dx + (pointY - start[1]) * dy) /
        lengthSquared,
    ),
  )
  return Math.hypot(
    pointX - (start[0] + projection * dx),
    pointY - (start[1] + projection * dy),
  )
}

export function measurementIndexAtCanvasPoint(
  measurements: readonly MeasurementLine[],
  slices: readonly MeasurementSlice[],
  point: readonly [number, number],
  hitRadius: number,
  planeTolerance: number,
): number {
  let closestIndex = -1
  let closestDistance = hitRadius
  for (let index = 0; index < measurements.length; index++) {
    const measurement = measurements[index]
    for (const slice of slices) {
      const viewport = slice.leftTopWidthHeight
      const matrix = slice.mvpMatrix
      const normal = slice.planeNormal
      const planePoint = slice.planePoint
      if (!viewport || !matrix || !normal || !planePoint) continue
      if (
        !liesOnPlane(measurement.startMM, normal, planePoint, planeTolerance) ||
        !liesOnPlane(measurement.endMM, normal, planePoint, planeTolerance)
      ) {
        continue
      }
      const start = projectPoint(measurement.startMM, matrix, viewport)
      const end = projectPoint(measurement.endMM, matrix, viewport)
      if (!start || !end) continue
      const distance = distanceToSegment(point[0], point[1], start, end)
      if (distance <= closestDistance) {
        closestDistance = distance
        closestIndex = index
      }
    }
  }
  return closestIndex
}
