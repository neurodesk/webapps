/**
 * @niivue/nv-ext-dcm2niix
 *
 * Browser-side DICOM-to-NIfTI conversion for NiiVue, wrapping the
 * `@niivue/dcm2niix` WebAssembly build of Chris Rorden's dcm2niix.
 *
 * Two pieces of glue cover the common integration paths:
 *
 *   - {@link runDcm2niix}              — `<input webkitdirectory>` → File[]
 *   - {@link traverseDataTransferItems} — drop-event folders → File[]
 *
 * The underlying `Dcm2niix` class is re-exported for callers that need
 * full control over the command-line flags exposed by dcm2niix.
 *
 * Usage:
 * ```ts
 * import NiiVueGPU from '@niivue/niivue'
 * import { runDcm2niix } from '@niivue/nv-ext-dcm2niix'
 *
 * const nv = new NiiVueGPU()
 * await nv.attachTo('gl1')
 *
 * input.addEventListener('change', async () => {
 *   const niftiFiles = await runDcm2niix(input.files)
 *   await nv.loadVolumes([{ url: niftiFiles[0] }])
 * })
 * ```
 */

import { Dcm2niix } from '@niivue/dcm2niix'

// Re-export so callers can drop down to the raw API when they need flags
// like compression level, BIDS sidecars, etc.
export { Dcm2niix }

/**
 * Drop items expose a non-standard `_webkitRelativePath` that dcm2niix
 * uses to group images by series. Standard `webkitRelativePath` is
 * read-only on `File`, so we attach our own and dcm2niix reads either.
 */
type FileWithRelativePath = File & { _webkitRelativePath?: string }

/** Options for {@link runDcm2niix}. */
export interface RunDcm2niixOptions {
  /**
   * Filter the result list down to NIfTI outputs (`.nii` and `.nii.gz`).
   * BIDS sidecars and other dcm2niix outputs are dropped. Default: `true`.
   */
  niftiOnly?: boolean
}

/**
 * Convert DICOM files to NIfTI by spinning up a fresh dcm2niix worker,
 * feeding it the files, waiting for the result, then terminating the
 * worker so the WASM heap is released.
 *
 * Each call boots its own worker — fine for one-off conversions; for
 * batch workflows, instantiate `Dcm2niix` once and reuse it (and call
 * `worker?.terminate()` yourself when finished).
 *
 * @param files       FileList from `<input webkitdirectory>` or File[]
 *                    from a drop event (see {@link traverseDataTransferItems}).
 * @param options     See {@link RunDcm2niixOptions}.
 * @returns           Converted output files (NIfTI by default).
 */
export async function runDcm2niix(
  files: FileList | File[] | null | undefined,
  options: RunDcm2niixOptions = {},
): Promise<File[]> {
  const { niftiOnly = true } = options
  if (!files || files.length === 0) return []

  const dcm2niix = new Dcm2niix()
  try {
    // Bound init + run as one operation. @niivue/dcm2niix's init() only settles on a
    // {type:'ready'} message, so a failed WASM fetch/instantiate leaves it pending
    // forever; and a worker crash during run() never settles run() (onerror stays
    // bound to the settled init()). Either way the caller's queue would wedge — on
    // expiry we reject and the finally terminates the worker (init() creates it
    // synchronously, so `dcm2niix.worker` is set even if init never resolves).
    const result = (await withTimeout(
      (async () => {
        await dcm2niix.init()
        return dcm2niix.input(files).run() as Promise<File[]>
      })(),
      RUN_TIMEOUT_MS,
      'dcm2niix',
    )) as File[]
    return niftiOnly
      ? result.filter((f) => /\.nii(\.gz)?$/i.test(f.name))
      : result
  } finally {
    dcm2niix.worker?.terminate()
  }
}

const RUN_TIMEOUT_MS = 120_000
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Walk a drop event's `DataTransferItemList`, recurse into directories,
 * and stamp `_webkitRelativePath` on each file so dcm2niix can group by
 * series.
 *
 * The browser exposes folder structure on drop only via the
 * `webkitGetAsEntry()` API; this helper runs that traversal for you.
 *
 * @example
 * ```ts
 * dropTarget.addEventListener('drop', async (e) => {
 *   e.preventDefault()
 *   const files = await traverseDataTransferItems(e.dataTransfer!.items)
 *   const niftiFiles = await runDcm2niix(files)
 * })
 * ```
 */
export async function traverseDataTransferItems(
  items: DataTransferItemList,
): Promise<File[]> {
  const files: File[] = []
  const entries: FileSystemEntry[] = []
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry()
    if (entry) entries.push(entry)
  }
  await Promise.all(entries.map((entry) => walkEntry(entry, '', files)))
  return files
}

function walkEntry(
  entry: FileSystemEntry,
  path: string,
  out: File[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      ;(entry as FileSystemFileEntry).file((file) => {
        const tagged = file as FileWithRelativePath
        tagged._webkitRelativePath = path + file.name
        out.push(tagged)
        resolve()
      }, reject)
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      const childPath = `${path}${entry.name}/`
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve()
            return
          }
          Promise.all(batch.map((child) => walkEntry(child, childPath, out)))
            .then(readBatch)
            .catch(reject)
        }, reject)
      }
      readBatch()
      return
    }
    resolve()
  })
}
