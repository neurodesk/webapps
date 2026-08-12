import assert from 'node:assert/strict'
import test from 'node:test'
import {
  anchoredSlicePan,
  pointOnSlicePlane,
} from '../src/cursor_zoom.ts'

test('unprojects a cursor position onto the hovered slice plane', () => {
  assert.deepEqual(
    pointOnSlicePlane(
      0.75,
      0.25,
      [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
      [0, 0, 1],
      [0, 0, 0],
    ),
    [0.5, 0.5, 0],
  )
})

test('adjusts only the hovered plane axes to keep the cursor point fixed', () => {
  const pan = anchoredSlicePan(
    [10, -20, 7, 2],
    {
      axCorSag: 0,
      screen: {
        mnMM: [-100, -80, -10],
        mxMM: [100, 80, 10],
      },
    },
    [40, -10, 3],
    4,
  )

  assert.deepEqual(pan, [-15, -5, 7, 4])
})

test('uses the displayed axes for coronal and sagittal tiles', () => {
  const screen = {
    mnMM: [-100, -80, -10],
    mxMM: [100, 80, 10],
  }
  assert.deepEqual(
    anchoredSlicePan([10, -20, 7, 2], { axCorSag: 1, screen }, [40, 3, -10], 4),
    [-15, -20, 8.5, 4],
  )
  assert.deepEqual(
    anchoredSlicePan([10, -20, 7, 2], { axCorSag: 2, screen }, [3, 40, -10], 4),
    [10, -30, 8.5, 4],
  )
})

test('keeps the overview centred instead of panning into empty space', () => {
  assert.deepEqual(
    anchoredSlicePan(
      [10, -20, 7, 2],
      {
        axCorSag: 0,
        screen: {
          mnMM: [-100, -80, -10],
          mxMM: [100, 80, 10],
        },
      },
      [40, -10, 3],
      1,
    ),
    [0, 0, 0, 1],
  )
})
