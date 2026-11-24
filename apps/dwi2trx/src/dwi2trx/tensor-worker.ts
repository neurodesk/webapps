import { version as mindgrabVersion } from '@brainchop/core/package.json'
import { checkSupport, segment } from '@brainchop/core'
import { MASK_OPTIONS, TENSOR_MAPS, assertMaskOnGrid, extractB0, fitTensor } from '@neurodesk/dwi2trx'
import { runNiimath } from '@neurodesk/dwi2trx/runner'
import { isSoftwareAdapter } from '@neurodesk/runtime-support/mindgrab/backend'
import type { DwiInput } from './state'

const bytes = async (file: File) => new Uint8Array(await file.arrayBuffer())

self.onmessage = async ({ data }: MessageEvent<{ input: DwiInput; mask?: File; assetPath: string }>) => {
  try {
    const dwi = await bytes(data.input.nifti)
    let mask: Uint8Array | undefined
    let maskFailure: string | null = null
    let maskProvenance: Record<string, unknown> | null = null
    if (data.mask) {
      mask = await bytes(data.mask)
      maskProvenance = { source: 'provided', name: data.mask.name }
    } else {
      self.postMessage({ type: 'progress', message: 'Brain extraction (mindgrab)…' })
      try {
        const support = await checkSupport(MASK_OPTIONS.model)
        const adapter = support.supported ? await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) : null
        const software = Boolean(support.software) || isSoftwareAdapter(adapter?.info)
        if (!support.supported || software) {
          maskFailure = software ? 'WebGPU adapter is software-rendered' : (support.reasons.join('; ') || 'WebGPU is unavailable')
        } else {
          const b0 = await extractB0(runNiimath, { dwi, bvalText: await data.input.bval.text() })
          const result = await segment(b0, { ...MASK_OPTIONS, worker: false, backend: 'webgpu', assetPath: data.assetPath })
          maskProvenance = { model: MASK_OPTIONS.model, version: mindgrabVersion, backend: result.backend, elapsedMs: result.elapsedMs }
          if (result.mask) {
            const computed = new Uint8Array(await new Blob([result.mask]).arrayBuffer())
            await assertMaskOnGrid(dwi, computed)
            mask = computed
          } else maskFailure = 'MindGrab returned no brain mask'
        }
      } catch (error) {
        maskFailure = error instanceof Error ? error.message : String(error)
      }
    }
    self.postMessage({ type: 'progress', message: maskFailure ? `Brain mask failed (${maskFailure}) — fitting without a mask.` : 'Fitting the diffusion tensor (niimath dtifit)…' })
    const fitted = await fitTensor(runNiimath, { dwi, bval: await bytes(data.input.bval), bvec: await bytes(data.input.bvec), mask })
    const files = Object.fromEntries(TENSOR_MAPS.map((map) => [map, new File([fitted[map]], `dti_${map}.nii.gz`)]))
    self.postMessage({ type: 'result', result: { maps: { fa: files.FA, v1: files.V1 }, files, masked: Boolean(mask), maskFailure, maskProvenance } })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
