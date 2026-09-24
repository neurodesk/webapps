import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import {
  DEFAULT_LAYOUT_ID,
  LAYOUT_PRESET,
  viewerLayoutConfig,
} from '../src/viewer_layout.ts'

test('NVSlide axial focus is the startup layout', () => {
  assert.equal(DEFAULT_LAYOUT_ID, LAYOUT_PRESET.NVSLIDE_AXIAL_FOCUS)
})

test('equal slices uses three horizontal thirds without a render tile', () => {
  const layout = viewerLayoutConfig(LAYOUT_PRESET.EQUAL_SLICES)

  assert.equal(layout.kind, 'niivue')
  assert.equal(layout.niivue.sliceType, SLICE_TYPE.MULTIPLANAR)
  assert.equal(layout.niivue.showRender, SHOW_RENDER.NEVER)
  assert.equal(layout.niivue.multiplanarType, MULTIPLANAR_TYPE.ROW)
  assert.equal(layout.niivue.isEqualSize, true)
  assert.equal(layout.niivue.customLayout, null)
})

test('vertical equal slices use the stock equal-size column layout', () => {
  const layout = viewerLayoutConfig(LAYOUT_PRESET.EQUAL_SLICES_VERTICAL)

  assert.deepEqual(layout, {
    kind: 'niivue',
    niivue: {
      sliceType: SLICE_TYPE.MULTIPLANAR,
      showRender: SHOW_RENDER.NEVER,
      multiplanarType: MULTIPLANAR_TYPE.COLUMN,
      isEqualSize: true,
      customLayout: null,
    },
  })
})

test('NVSlide axial focus is a renderer layout with a valid NiiVue standby', () => {
  const layout = viewerLayoutConfig(LAYOUT_PRESET.NVSLIDE_AXIAL_FOCUS)

  assert.equal(layout.kind, 'nvslide')
  assert.equal(layout.arrangement, 'axial-focus')
  assert.equal(layout.niivue.sliceType, SLICE_TYPE.AXIAL)
  assert.equal(layout.niivue.showRender, SHOW_RENDER.NEVER)
})

test('unknown layouts cannot become NiiVue slice types', () => {
  const layout = viewerLayoutConfig(999)

  assert.equal(layout.kind, 'niivue')
  assert.equal(layout.niivue.sliceType, SLICE_TYPE.MULTIPLANAR)
})
