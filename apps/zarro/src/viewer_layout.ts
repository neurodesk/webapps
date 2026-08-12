import {
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'

export const LAYOUT_PRESET = {
  AXIAL_FOCUS: 30,
  EQUAL_SLICES: 31,
  EQUAL_SLICES_RENDER: 32,
  EQUAL_SLICES_VERTICAL: 33,
} as const

export interface ViewerLayoutConfig {
  sliceType: number
  showRender: number
  multiplanarType: number
  isEqualSize: boolean
  customLayout: Array<{
    sliceType: number
    position: [number, number, number, number]
  }> | null
}

export function viewerLayoutConfig(selected: number): ViewerLayoutConfig {
  if (selected === LAYOUT_PRESET.AXIAL_FOCUS) {
    return {
      sliceType: SLICE_TYPE.MULTIPLANAR,
      showRender: SHOW_RENDER.NEVER,
      multiplanarType: MULTIPLANAR_TYPE.AUTO,
      isEqualSize: false,
      customLayout: [
        { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 1, 2 / 3] },
        { sliceType: SLICE_TYPE.SAGITTAL, position: [0, 2 / 3, 0.5, 1 / 3] },
        { sliceType: SLICE_TYPE.CORONAL, position: [0.5, 2 / 3, 0.5, 1 / 3] },
      ],
    }
  }
  if (selected === LAYOUT_PRESET.EQUAL_SLICES) {
    return {
      sliceType: SLICE_TYPE.MULTIPLANAR,
      showRender: SHOW_RENDER.NEVER,
      multiplanarType: MULTIPLANAR_TYPE.ROW,
      isEqualSize: true,
      customLayout: null,
    }
  }
  if (selected === LAYOUT_PRESET.EQUAL_SLICES_VERTICAL) {
    return {
      sliceType: SLICE_TYPE.MULTIPLANAR,
      showRender: SHOW_RENDER.NEVER,
      multiplanarType: MULTIPLANAR_TYPE.COLUMN,
      // Preserve each plane's physical aspect. Equal-size mode pads all three
      // planes to the volume's largest extent, which makes thin volumes render
      // as narrow, centred squares with mostly empty space in a tall column.
      isEqualSize: false,
      customLayout: null,
    }
  }
  if (selected === LAYOUT_PRESET.EQUAL_SLICES_RENDER) {
    return {
      sliceType: SLICE_TYPE.MULTIPLANAR,
      showRender: SHOW_RENDER.ALWAYS,
      multiplanarType: MULTIPLANAR_TYPE.GRID,
      isEqualSize: true,
      customLayout: null,
    }
  }
  return {
    sliceType: selected,
    showRender: SHOW_RENDER.AUTO,
    multiplanarType: MULTIPLANAR_TYPE.AUTO,
    isEqualSize: false,
    customLayout: null,
  }
}
