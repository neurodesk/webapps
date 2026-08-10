export type IntensityDtype = 'uint8' | 'uint16'

export interface IntensityWindow {
  min: number
  max: number
}

const MAX_SAMPLES_PER_CHUNK = 65_536
const MIN_SIGNAL_SAMPLES = 64
const UPPER_PERCENTILE = 0.995

function dtypeMaximum(dtype: IntensityDtype): number {
  return dtype === 'uint8' ? 255 : 65_535
}

export function isGenericDtypeWindow(
  dtype: IntensityDtype,
  window: IntensityWindow,
): boolean {
  const maximum = dtypeMaximum(dtype)
  return Math.abs(window.min) <= 1 && Math.abs(window.max - maximum) <= 1
}

export class IntensityWindowEstimator {
  private readonly histogram: Uint32Array
  private readonly dtype: IntensityDtype
  private positiveSamples = 0

  constructor(dtype: IntensityDtype) {
    this.dtype = dtype
    this.histogram = new Uint32Array(dtypeMaximum(dtype) + 1)
  }

  observe(bytes: Uint8Array): IntensityWindow | null {
    const bytesPerValue = this.dtype === 'uint8' ? 1 : 2
    const valueCount = Math.floor(bytes.byteLength / bytesPerValue)
    const stride = Math.max(1, Math.ceil(valueCount / MAX_SAMPLES_PER_CHUNK))

    if (this.dtype === 'uint8') {
      for (let index = 0; index < valueCount; index += stride) {
        this.add(bytes[index] ?? 0)
      }
    } else if (bytes.byteOffset % 2 === 0) {
      const values = new Uint16Array(bytes.buffer, bytes.byteOffset, valueCount)
      for (let index = 0; index < valueCount; index += stride) {
        this.add(values[index] ?? 0)
      }
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < valueCount; index += stride) {
        this.add(view.getUint16(index * 2, true))
      }
    }

    return this.estimate()
  }

  private add(value: number): void {
    if (value <= 0) return
    this.histogram[value]++
    this.positiveSamples++
  }

  private estimate(): IntensityWindow | null {
    if (this.positiveSamples < MIN_SIGNAL_SAMPLES) return null
    const target = Math.ceil(this.positiveSamples * UPPER_PERCENTILE)
    let cumulative = 0
    for (let value = 1; value < this.histogram.length; value++) {
      cumulative += this.histogram[value] ?? 0
      if (cumulative >= target) return { min: 0, max: value }
    }
    return null
  }
}
