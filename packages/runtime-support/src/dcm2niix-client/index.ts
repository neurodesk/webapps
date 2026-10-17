/// <reference path="./dcm2niix.d.ts" />

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

import { Dcm2niix, type Dcm2niixProcessor } from '@niivue/dcm2niix'

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
  signal?: AbortSignal
  /**
   * Filter the result list down to NIfTI outputs (`.nii` and `.nii.gz`).
   * BIDS sidecars and other dcm2niix outputs are dropped. Default: `true`.
   */
  niftiOnly?: boolean
  /**
   * Use dcm2niix's default BIDS anonymisation. Set `false` to use `-b y -ba n`:
   * sidecars then retain identifying fields. Keep them in memory; never persist them.
   * Default: `true`.
   */
  anonymizeSidecar?: boolean
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
  return convertDicom(files, options, (processor) => options.anonymizeSidecar === false
    ? processor.bids('y').bidsAnonymize('n')
    : processor)
}

async function convertDicom(
  files: FileList | File[] | null | undefined,
  options: RunDcm2niixOptions,
  configure: (processor: Dcm2niixProcessor) => Dcm2niixProcessor,
): Promise<File[]> {
  const { niftiOnly = true, signal } = options
  signal?.throwIfAborted()
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
        return configure(dcm2niix.input(files)).run()
      })(),
      RUN_TIMEOUT_MS,
      'dcm2niix',
      signal,
    )) as File[]
    return niftiOnly
      ? result.filter(isNifti)
      : result
  } finally {
    dcm2niix.worker?.terminate()
  }
}

const RUN_TIMEOUT_MS = 120_000
function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timed out after ${ms} ms`)) }, ms)
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    signal?.addEventListener('abort', abort, { once: true })
    p.then(
      (v) => { cleanup(); resolve(v) },
      (e) => { cleanup(); reject(e) },
    )
  })
}

/** Options for {@link readImageFiles}: `directVolume` names the files that skip dcm2niix. */
export type ReadImageFilesOptions = Omit<RunDcm2niixOptions, 'anonymizeSidecar'> & { directVolume?: RegExp }

/** One image and its parsed BIDS sidecar (`null` when absent or unparsable). */
export interface ImageSeries {
  image: File
  sidecar: Record<string, unknown> | null
}

/** Keep direct volumes and convert all DICOM slices together, including extensionless files. */
export async function readImageFiles(
  files: FileList | File[],
  options: ReadImageFilesOptions = {},
): Promise<File[]> {
  const { direct, dicom } = splitInputs(files, options.directVolume)
  if (!dicom.length) return direct
  const converted = await convertDicom(dicom, options, (processor) => processor)
  return [...direct, ...requireImages(converted)]
}

/**
 * Like {@link readImageFiles}, but pairs each image with its BIDS sidecar by file stem.
 * dcm2niix runs with `-b y -ba n` unless `anonymizeSidecar` is `true`, so converted
 * sidecars keep identifying fields (patient name, birth date, acquisition time). Keep
 * those in memory; never persist them. Pass `anonymizeSidecar: true` for sidecars a
 * user can save. A direct volume pairs with a supplied `.json` of the same stem.
 */
export async function readImageSeries(
  files: FileList | File[],
  options: Omit<ReadImageFilesOptions, 'niftiOnly'> & { anonymizeSidecar?: boolean } = {},
): Promise<ImageSeries[]> {
  const { direct, sidecars, dicom } = splitInputs(files, options.directVolume)
  const directSeries = await pairSidecars(direct, sidecars)
  if (!dicom.length) return directSeries
  const outputs = await convertDicom(
    dicom,
    { ...options, niftiOnly: false },
    (processor) => options.anonymizeSidecar ? processor : processor.bids('y').bidsAnonymize('n'),
  )
  const images = requireImages(outputs.filter(isNifti))
  return [...directSeries, ...(await pairSidecars(images, outputs))]
}

function splitInputs(files: FileList | File[], directVolume = /\.nii(\.gz)?$/i) {
  const direct: File[] = []
  const sidecars: File[] = []
  const dicom: File[] = []
  for (const file of Array.from(files)) {
    if (directVolume.test(file.name)) direct.push(file)
    else if (/\.json$/i.test(file.name)) sidecars.push(file)
    else if (!/\.(bval|bvec)$/i.test(file.name)) dicom.push(file)
  }
  return { direct, sidecars, dicom }
}

function requireImages(images: File[]): File[] {
  if (!images.length) throw new Error('No images produced. Choose NIfTI files or a complete DICOM series.')
  return images
}

function isNifti(file: File): boolean {
  return /\.nii(\.gz)?$/i.test(file.name)
}

function stem(name: string): string {
  return name.replace(/\.(nii\.gz|[^.]*)$/i, '')
}

async function pairSidecars(images: File[], candidates: File[]): Promise<ImageSeries[]> {
  const sidecars = new Map(
    candidates
      .filter((file) => /\.json$/i.test(file.name))
      .map((file) => [stem(file.name), file]),
  )
  return Promise.all(images.map(async (image) => {
    const sidecar = sidecars.get(stem(image.name))
    return { image, sidecar: sidecar ? await parseSidecar(sidecar) : null }
  }))
}

async function parseSidecar(file: File): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await file.text())
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
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
