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
  NVSLIDE_AXIAL_FOCUS: 34,
} as const

export const DEFAULT_LAYOUT_ID = LAYOUT_PRESET.NVSLIDE_AXIAL_FOCUS

export const LAYOUT_IDS = [
  SLICE_TYPE.AXIAL,
  SLICE_TYPE.CORONAL,
  SLICE_TYPE.SAGITTAL,
  SLICE_TYPE.RENDER,
  ...Object.values(LAYOUT_PRESET),
] as const

export type LayoutId = (typeof LAYOUT_IDS)[number]

export interface NiiVueLayoutConfig {
  sliceType: number
  showRender: number
  multiplanarType: number
  isEqualSize: boolean
  customLayout: Array<{
    sliceType: number
    position: [number, number, number, number]
  }> | null
}

export type ViewerLayoutConfig =
  | {
      kind: 'niivue'
      niivue: NiiVueLayoutConfig
    }
  | {
      kind: 'nvslide'
      arrangement: 'axial-focus'
      niivue: NiiVueLayoutConfig
    }

export function isLayoutId(value: number): value is LayoutId {
  return LAYOUT_IDS.some((candidate) => candidate === value)
}

const NII_SLICE_TYPES: readonly number[] = [
  SLICE_TYPE.AXIAL,
  SLICE_TYPE.CORONAL,
  SLICE_TYPE.SAGITTAL,
  SLICE_TYPE.RENDER,
]

function axialFocusConfig(): NiiVueLayoutConfig {
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

export function viewerLayoutConfig(selected: number): ViewerLayoutConfig {
  if (selected === LAYOUT_PRESET.AXIAL_FOCUS) {
    return {
      kind: 'niivue',
      niivue: axialFocusConfig(),
    }
  }
  if (selected === LAYOUT_PRESET.NVSLIDE_AXIAL_FOCUS) {
    return {
      kind: 'nvslide',
      arrangement: 'axial-focus',
      niivue: {
        sliceType: SLICE_TYPE.AXIAL,
        showRender: SHOW_RENDER.NEVER,
        multiplanarType: MULTIPLANAR_TYPE.AUTO,
        isEqualSize: false,
        customLayout: null,
      },
    }
  }
  if (selected === LAYOUT_PRESET.EQUAL_SLICES) {
    return {
      kind: 'niivue',
      niivue: {
        sliceType: SLICE_TYPE.MULTIPLANAR,
        showRender: SHOW_RENDER.NEVER,
        multiplanarType: MULTIPLANAR_TYPE.ROW,
        isEqualSize: true,
        customLayout: null,
      },
    }
  }
  if (selected === LAYOUT_PRESET.EQUAL_SLICES_VERTICAL) {
    return {
      kind: 'niivue',
      niivue: {
        sliceType: SLICE_TYPE.MULTIPLANAR,
        showRender: SHOW_RENDER.NEVER,
        multiplanarType: MULTIPLANAR_TYPE.COLUMN,
        isEqualSize: true,
        customLayout: null,
      },
    }
  }
  if (selected === LAYOUT_PRESET.EQUAL_SLICES_RENDER) {
    return {
      kind: 'niivue',
      niivue: {
        sliceType: SLICE_TYPE.MULTIPLANAR,
        showRender: SHOW_RENDER.ALWAYS,
        multiplanarType: MULTIPLANAR_TYPE.GRID,
        isEqualSize: true,
        customLayout: null,
      },
    }
  }
  if (!NII_SLICE_TYPES.includes(selected)) {
    return { kind: 'niivue', niivue: axialFocusConfig() }
  }
  const sliceType = selected
  return {
    kind: 'niivue',
    niivue: {
      sliceType,
      showRender: SHOW_RENDER.AUTO,
      multiplanarType: MULTIPLANAR_TYPE.AUTO,
      isEqualSize: false,
      customLayout: null,
    },
  }
}
