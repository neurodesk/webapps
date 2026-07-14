/**
 * Web Worker for the mindgrab `conform` transform — the 256³ FreeSurfer-canonical
 * resample the brain-extraction model expects as input.
 *
 * Speaks only primitives — no NIFTI header objects cross the boundary.
 *   Request:  { _wbId, name, img, datatypeCode, sclSlope, sclInter, ...options }
 *   Response: { _wbId, img, datatypeCode, bitsPerVoxel, sclSlope, sclInter, calMin, calMax }
 *   Error:    { _wbId, _wbError: string }
 */

import { computeConform } from './conform'

const post = (
  self as unknown as {
    postMessage: (msg: unknown, transfer?: Transferable[]) => void
  }
).postMessage.bind(self)

interface WorkerResult {
  img: ArrayBufferView
  datatypeCode: number
  bitsPerVoxel: number
  sclSlope: number
  sclInter: number
  calMin: number
  calMax: number
}

type Handler = (
  img: ArrayLike<number>,
  datatypeCode: number,
  sclSlope: number,
  sclInter: number,
  options: Record<string, unknown>,
) => WorkerResult

const handlers: Record<string, Handler> = {
  conform(img, datatypeCode, sclSlope, sclInter, options) {
    const result = computeConform({
      img,
      datatypeCode,
      dims: options.dims as number[],
      pixDims: options.pixDims as number[],
      affine: options.affine as number[],
      sclSlope: sclSlope || 1,
      sclInter: sclInter || 0,
      toRAS: (options.toRAS as boolean) ?? false,
      isLinear: (options.isLinear as boolean) ?? true,
      asFloat32: (options.asFloat32 as boolean) ?? false,
      isRobustMinMax: (options.isRobustMinMax as boolean) ?? false,
    })
    return {
      img: result.img,
      datatypeCode: result.datatypeCode,
      bitsPerVoxel: result.bitsPerVoxel,
      sclSlope: result.sclSlope,
      sclInter: result.sclInter,
      calMin: result.calMin,
      calMax: result.calMax,
      // Extra fields for conform (new header geometry)
      dims: result.dims,
      pixDims: result.pixDims,
      affine: result.affine,
    }
  },
}

self.onmessage = (e: MessageEvent) => {
  const {
    _wbId: id,
    name,
    img,
    datatypeCode,
    sclSlope,
    sclInter,
    options,
  } = e.data
  const handler = handlers[name]
  if (!handler) {
    post({ _wbId: id, _wbError: `Unknown transform: ${name}` })
    return
  }
  try {
    const result = handler(img, datatypeCode, sclSlope, sclInter, options ?? {})
    post({ _wbId: id, ...result }, [result.img.buffer as ArrayBuffer])
  } catch (err: unknown) {
    post({
      _wbId: id,
      _wbError: err instanceof Error ? err.message : String(err),
    })
  }
}
