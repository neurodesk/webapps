/**
 * Typed wrapper around the vendored brainchop tfjs inference engine
 * (src/brainchop/*.js, copied verbatim from brainchop-test for easy upgrades).
 *
 * Runs the "Subcortical + GWM" model (brainchop id 3, model16chan18cls) on a
 * conformed 256³ 1 mm volume and returns the label volume (conformed storage
 * order). We run it in a Web Worker: fast path → sequential-conv retry. Both use
 * the same tfjs/WebGL2 backend; brainchop-test's extra main-thread fallback is
 * omitted — it re-runs the identical backend after the worker already failed (no
 * added recovery) and statically pulls a second ~1.6 MB tfjs copy into the bundle.
 * We also omit the custom-WebGPU path (needs the separate webgpu_runners).
 * Each worker attempt has one generous inactivity watchdog so a stalled model fetch
 * or GPU command cannot permanently wedge the app's single-flight queue.
 *
 * tfjs is large, so this module is dynamically import()ed on first use to keep it
 * (and the worker chunk) out of the initial bundle.
 */

// Vendored engine — untyped JS (allowJs/checkJs:false); treated as `any`.
import { inferenceModelsList, brainChopOpts } from './brainchop-parameters.js'
import BrainchopWorker from './brainchop-webworker.js?worker'

export type PlainHdr = { dims: number[]; datatypeCode: number }
type StatusCb = (message: string, frac?: number) => void

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelEntry = Record<string, any>

const WORKER_STALL_MS = 5 * 60_000

// The default "Subcortical + GWM" model in the vendored parameter list.
function segModel(): ModelEntry {
  const m = (inferenceModelsList as ModelEntry[]).find((e) => e.id === 3)
  if (!m) throw new Error('Subcortical + GWM (id 3) missing from brainchop-parameters')
  return m
}

/** colormap.json path for the current model, resolved against the served base URL. */
export function segColormapUrl(rootURL: string): string {
  // colormapPath is like './models/model16chan18cls/colormap.json'
  const rel = String(segModel().colormapPath).replace(/^\.?\//, '')
  return `${rootURL.replace(/\/$/, '')}/${rel}`
}

const toU8 = (out: ArrayBufferView): Uint8Array =>
  out instanceof Uint8Array ? out : new Uint8Array((out as { buffer: ArrayBuffer }).buffer)

// A brainchop 'ui' message whose modalMessage names a hard failure (vs. a progress
// update). The worker serializes statData to a JSON string, so we match on the text
// only — a structured statData.Status is never available on this path.
function failureText(modalMessage: unknown): string | null {
  const m = String(modalMessage ?? '').toLowerCase()
  if (m && ['fail', 'error', 'compatible', 'texture', 'maximum'].some((k) => m.includes(k)))
    return String(modalMessage)
  return null
}

function runWorker(
  opts: object,
  modelEntry: ModelEntry,
  plainHeader: PlainHdr,
  img: ArrayBufferView,
  onStatus: StatusCb,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new BrainchopWorker()
    let timer = 0
    const stop = (): void => {
      window.clearTimeout(timer)
      worker.terminate()
    }
    const rejectWorker = (err: Error): void => {
      stop()
      reject(err)
    }
    const armWatchdog = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(
        () => rejectWorker(new Error(`Segmentation worker stalled for ${WORKER_STALL_MS / 1000} seconds`)),
        WORKER_STALL_MS,
      )
    }
    worker.onmessage = (e: MessageEvent) => {
      armWatchdog()
      const { cmd, message, progressFrac, modalMessage, img: outImg } = e.data
      if (cmd === 'ui') {
        if (modalMessage) {
          const failure = failureText(modalMessage)
          if (failure) {
            rejectWorker(new Error(failure))
            return
          }
        }
        if (message) onStatus(message, progressFrac >= 0 ? progressFrac : undefined)
      } else if (cmd === 'img') {
        stop()
        resolve(toU8(outImg))
      }
    }
    worker.onerror = (err) => {
      rejectWorker(err instanceof ErrorEvent ? new Error(err.message) : new Error('worker error'))
    }
    armWatchdog()
    try {
      worker.postMessage({ opts, modelEntry, niftiHeader: plainHeader, niftiImage: img })
    } catch (err) {
      rejectWorker(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Segment a conformed 256³ volume. `hdr`/`img` are the conformed volume's header
 * and voxel array; `rootURL` is the served base (so `${rootURL}/models/...` finds
 * the weights). Returns the label volume in conformed storage order.
 */
export async function segment(
  hdr: PlainHdr,
  img: ArrayBufferView,
  rootURL: string,
  onStatus: StatusCb,
): Promise<Uint8Array> {
  const modelEntry = segModel()
  const baseOpts = { ...(brainChopOpts as object), rootURL }
  const plainHeader: PlainHdr = { dims: hdr.dims, datatypeCode: hdr.datatypeCode }

  try {
    return await runWorker(
      { ...baseOpts, enableSeqConv: false },
      { ...modelEntry, enableSeqConv: false, enableTTA: false },
      plainHeader,
      img,
      onStatus,
    )
  } catch {
    onStatus('Retrying segmentation (sequential conv)…')
    return await runWorker(
      { ...baseOpts, enableSeqConv: true },
      { ...modelEntry, enableSeqConv: true, enableTTA: false },
      plainHeader,
      img,
      onStatus,
    )
  }
}
