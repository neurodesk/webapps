/**
 * Mixed NIfTI/DICOM input for Neurodesk apps, on top of `@niivue/dcm2niix`.
 *
 * `@niivue/dcm2niix` converts and pairs dcm2niix's outputs; this module adds what
 * it leaves to applications: NIfTI passed through beside DICOM, sidecars and
 * gradients supplied with those volumes, output names without the input folder,
 * and the empty-output error.
 */

import { convert, runDcm2niix as convertFiles, type ConvertOptions } from '@niivue/dcm2niix'

export { traverseDataTransferItems } from '@niivue/dcm2niix'

// dcm2niix's default name starts with the input folder (%f), which can hold a patient name;
// downloads derive from these names. Callers' own `-f` comes later and wins.
const NAMING = ['-f', '%p_%t_%s']
// Upstream has no default deadline; a stalled WASM fetch would hold its worker forever.
const TIMEOUT_MS = 120_000

/** `runDcm2niix` from @niivue/dcm2niix, naming outputs without the input folder, with a deadline. */
export const runDcm2niix: typeof convertFiles = (files, options = {}) => convertFiles(files, withDefaults(options))

function withDefaults<T extends ConvertOptions>({ timeoutMs = TIMEOUT_MS, args = [], ...options }: T) {
  return { ...options, timeoutMs, args: [...NAMING, ...args] }
}

export interface ReadImageFilesOptions {
  signal?: AbortSignal
  /** Maximum conversion time. Large scanner exports can opt into a longer run. */
  timeoutMs?: number
  /** Files that skip dcm2niix. Default: NIfTI. */
  directVolume?: RegExp
}

export interface ReadSeriesOptions extends ReadImageFilesOptions {
  /**
   * `false` (the default) passes `-ba n`: converted sidecars keep identifying fields
   * (patient name, birth date, acquisition time). Keep them in memory; never persist
   * them. Pass `true` for sidecars a user can save.
   */
  anonymizeSidecar?: boolean
}

/** One image and its parsed BIDS sidecar (`null` when absent or unparsable). */
export interface ImageSeries {
  image: File
  sidecar: Record<string, unknown> | null
}

/** One image with its FSL gradient files and parsed sidecar; each is `null` when absent. */
export interface DiffusionSeries extends ImageSeries {
  bval: File | null
  bvec: File | null
}

/** Keep direct volumes and convert all other files together, including extensionless DICOM. */
export async function readImageFiles(
  files: FileList | File[],
  { niftiOnly = true, ...options }: ReadImageFilesOptions & { niftiOnly?: boolean } = {},
): Promise<File[]> {
  const { direct, dicom } = splitInputs(files, options.directVolume)
  if (!dicom.length) return direct
  const { series, files: outputs } = await convertDicom(dicom, { anonymizeSidecar: true, ...options })
  return [...direct, ...(niftiOnly ? series.map((entry) => entry.image) : outputs)]
}

/** Like {@link readImageFiles}, but pairs each image with its BIDS sidecar. */
export async function readImageSeries(
  files: FileList | File[],
  options: ReadSeriesOptions = {},
): Promise<ImageSeries[]> {
  return (await readDiffusionSeries(files, options)).map(({ image, sidecar }) => ({ image, sidecar }))
}

/**
 * Like {@link readImageSeries}, but also pairs each image with its `.bval` and `.bvec`:
 * those dcm2niix writes, or those of the same stem supplied with a direct volume. When the
 * selection holds one image, each sole gradient file pairs whatever its name (FSL
 * `data.nii.gz` with `bvals`, `bvecs`); with several, an unmatched gradient file stays unpaired.
 */
export async function readDiffusionSeries(
  files: FileList | File[],
  options: ReadSeriesOptions = {},
): Promise<DiffusionSeries[]> {
  const list = Array.from(files)
  const { direct, sidecars, dicom } = splitInputs(list, options.directVolume)
  const converted = dicom.length ? (await convertDicom(dicom, options)).series : []
  const jsons = byStem(sidecars)
  const series = [
    ...await Promise.all(direct.map(async (image) => {
      const sidecar = jsons.get(stem(image.name))
      return { image, sidecar: sidecar ? asObject(await parseJson(sidecar)) : null, bval: null, bvec: null }
    })),
    ...converted.map((entry) => ({
      image: entry.image,
      sidecar: asObject(entry.json),
      bval: entry.bval ?? null,
      bvec: entry.bvec ?? null,
    })),
  ]
  const bvals = byStem(list.filter((file) => BVAL_FILE.test(file.name)))
  const bvecs = byStem(list.filter((file) => BVEC_FILE.test(file.name)))
  const sole = (files: Map<string, File>) => series.length === 1 && files.size === 1 ? [...files.values()][0] : null
  return series.map((entry) => ({
    ...entry,
    bval: entry.bval ?? bvals.get(stem(entry.image.name)) ?? sole(bvals),
    bvec: entry.bvec ?? bvecs.get(stem(entry.image.name)) ?? sole(bvecs),
  }))
}

// Partial output is accepted, as dcm2niix's own exit codes allow (e.g. someOkSomeBad):
// only a conversion that yields no image is an error.
async function convertDicom(
  files: File[],
  { signal, timeoutMs, anonymizeSidecar = false }: ReadSeriesOptions,
) {
  const result = await convert(files, withDefaults({ signal, timeoutMs, args: anonymizeSidecar ? [] : ['-ba', 'n'] }))
  if (!result.series.length) {
    const detail = result.log.at(-1)
    throw new Error(`No images produced. Choose NIfTI files or a complete DICOM series.${detail ? ` (dcm2niix: ${detail})` : ''}`)
  }
  return result
}

// FSL gradient files: dwi.bval and dwi.bvec as dcm2niix writes them, or FSL's bvals and bvecs.
const BVAL_FILE = /(^|\.)bvals?$/i
const BVEC_FILE = /(^|\.)bvecs?$/i

function splitInputs(files: FileList | File[], directVolume = /\.nii(\.gz)?$/i) {
  const direct: File[] = []
  const sidecars: File[] = []
  const dicom: File[] = []
  for (const file of Array.from(files)) {
    if (directVolume.test(file.name)) direct.push(file)
    else if (/\.json$/i.test(file.name)) sidecars.push(file)
    else if (!BVAL_FILE.test(file.name) && !BVEC_FILE.test(file.name)) dicom.push(file)
  }
  return { direct, sidecars, dicom }
}

function stem(name: string): string {
  return name.replace(/\.(nii\.gz|[^.]*)$/i, '')
}

function byStem(files: File[]): Map<string, File> {
  return new Map(files.map((file) => [stem(file.name), file]))
}

async function parseJson(file: File): Promise<unknown> {
  try {
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
