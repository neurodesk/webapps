import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import {
  LAYOUT_PRESET,
  viewerLayoutConfig,
} from '../src/viewer_layout.ts'

test('equal slices uses three horizontal thirds without a render tile', () => {
  const layout = viewerLayoutConfig(LAYOUT_PRESET.EQUAL_SLICES)

  assert.equal(layout.sliceType, SLICE_TYPE.MULTIPLANAR)
  assert.equal(layout.showRender, SHOW_RENDER.NEVER)
  assert.equal(layout.multiplanarType, MULTIPLANAR_TYPE.ROW)
  assert.equal(layout.isEqualSize, true)
  assert.equal(layout.customLayout, null)
})

test('vertical equal slices uses real plane aspects to fill the available width', () => {
  const layout = viewerLayoutConfig(LAYOUT_PRESET.EQUAL_SLICES_VERTICAL)

  assert.equal(layout.sliceType, SLICE_TYPE.MULTIPLANAR)
  assert.equal(layout.showRender, SHOW_RENDER.NEVER)
  assert.equal(layout.multiplanarType, MULTIPLANAR_TYPE.COLUMN)
  assert.equal(layout.isEqualSize, false)
  assert.equal(layout.customLayout, null)
})
