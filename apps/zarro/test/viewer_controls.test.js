import assert from 'node:assert/strict'
import test from 'node:test'
import {
  axialSliceFraction,
  axialSliceIndex,
  crosshairAppearanceForSpacing,
  detailLevelForZoom,
  fineLodRadiusForShape,
  lodDeliveryDisplay,
  loadingTileCount,
  rangeBoundsForWindow,
  visibleFovBounds,
  wheelZoomValue,
  windowFromLevelWidth,
  windowLevelWidth,
  zoomForDetailLevel,
  zoomLevelControlDisplay,
} from '../src/viewer_controls.ts'

test('maps axial slice positions to stable voxel indices', () => {
  assert.equal(axialSliceIndex(0, 2048), 0)
  assert.equal(axialSliceIndex(0.5, 2048), 1024)
  assert.equal(axialSliceIndex(1, 2048), 2047)
  assert.equal(axialSliceFraction(1024, 2048), 1024 / 2047)
  assert.equal(axialSliceFraction(-10, 20), 0)
  assert.equal(axialSliceFraction(100, 20), 1)
})

test('counts queued and in-flight tiles as current loading work', () => {
  assert.equal(loadingTileCount(7, 3), 10)
  assert.equal(loadingTileCount(undefined, 2), 2)
  assert.equal(loadingTileCount(-1, Number.NaN), 0)
})

test('describes multiplanar FOV as three visible slice slabs', () => {
  const bounds = visibleFovBounds(
    [100, 80, 60],
    [0.5, 0.25, 0.75],
    2,
    [0, 1, 2],
  )

  assert.equal(bounds.length, 3)
  assert.deepEqual(bounds[2].min.slice(0, 2), [25, 0])
  assert.deepEqual(bounds[2].max.slice(0, 2), [75, 40])
  assert.equal(bounds[2].min[2], 45)
  assert.ok(bounds[2].max[2] > 45)
  assert.ok(bounds[2].max[2] < 45.01)
})

test('compensates 3D crosshair geometry for camera zoom', () => {
  assert.deepEqual(crosshairAppearanceForSpacing([0.02, 0.02, 0.04]), {
    width: 0.03,
    gap: 0.2,
  })
  assert.deepEqual(crosshairAppearanceForSpacing([0.02, 0.02, 0.04], 20), {
    width: 0.0015,
    gap: 0.01,
  })
  const finest = crosshairAppearanceForSpacing([0.002564], 64)
  assert.ok(Math.abs(finest.width - 0.00006009375) < 1e-12)
  assert.ok(Math.abs(finest.gap - 0.000400625) < 1e-12)
})

test('distinguishes requested and delivered adaptive detail', () => {
  assert.deepEqual(lodDeliveryDisplay(0, [1, 2], [3, 4]), {
    label: 'Requested L0 · FOV L1 · L2 · context L3 · L4',
    deliveredLevel: 1,
    visibleLabel: 'L1 · requested L0',
  })
  assert.deepEqual(lodDeliveryDisplay(0, [0], [1, 2]), {
    label: 'Requested L0 · FOV L0 · context L1 · L2',
    deliveredLevel: 0,
    visibleLabel: 'L0',
  })
})

test('scales the fine LOD radius down for thin volumes', () => {
  assert.equal(fineLodRadiusForShape([41839, 18558, 2048], 64), 64)
  assert.equal(fineLodRadiusForShape([30, 16, 16], 64), 2)
  assert.equal(fineLodRadiusForShape([4, 4, 4], 64), 1)
})

test('min and max round-trip through window level and width', () => {
  const levelWidth = windowLevelWidth({ min: 40, max: 100 })
  assert.deepEqual(levelWidth, { level: 70, width: 60 })
  assert.deepEqual(windowFromLevelWidth(levelWidth.level, levelWidth.width), {
    min: 40,
    max: 100,
  })
})

test('scroll zoom speed scales a wheel gesture', () => {
  const normal = wheelZoomValue(1, -100, 0, 800, 1)
  const faster = wheelZoomValue(1, -100, 0, 800, 2)
  const fastest = wheelZoomValue(1, -100, 0, 800, 10)
  assert.ok(normal > 1)
  assert.ok(faster > normal)
  assert.ok(fastest > faster)
  assert.equal(fastest, wheelZoomValue(1, -100, 0, 800, 20))
})

test('scroll zoom can cross 10x to reach finer Zarr levels', () => {
  assert.ok(wheelZoomValue(10, -120, 0, 800, 4) > 10)
  assert.equal(wheelZoomValue(0.11, 120, 0, 800, 4), 0.1)
  assert.equal(detailLevelForZoom(6, 16, 7), 2)
  assert.equal(detailLevelForZoom(6, 32, 7), 1)
  assert.equal(detailLevelForZoom(6, 64, 7), 0)
})

test('zoom controls round-trip directly through OME-Zarr levels', () => {
  for (let level = 0; level <= 6; level++) {
    const zoom = zoomForDetailLevel(level, 7)
    assert.equal(detailLevelForZoom(6, zoom, 7), level)
  }
  assert.equal(zoomForDetailLevel(6, 7), 1)
  assert.equal(zoomForDetailLevel(1, 7), 32)
  assert.equal(zoomForDetailLevel(0, 7), 64)
  assert.deepEqual(zoomLevelControlDisplay(1, null, 7), {
    value: 1,
    label: 'L1',
    canApply: false,
  })
  assert.deepEqual(zoomLevelControlDisplay(1, 0, 7), {
    value: 0,
    label: 'L0 · finest · pending',
    canApply: true,
  })
})

test('range bounds expand to preserve the exact level and width window', () => {
  assert.deepEqual(rangeBoundsForWindow({ min: -40, max: 60 }, 0, 255), {
    min: -40,
    max: 255,
  })
})
