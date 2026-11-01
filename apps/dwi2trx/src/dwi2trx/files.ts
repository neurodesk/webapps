/**
 * Generic drag-and-drop file collection — walks a DataTransfer, recursing into
 * dropped folders. Kept instead of @niivue/dcm2niix's walker because it stops
 * at a file limit during the walk, not after collecting every file.
 *
 * Each file is stamped with `_webkitRelativePath` so dcm2niix can group by
 * series. `webkitGetAsEntry` is non-standard (Chromium/WebKit); callers fall
 * back to `DataTransfer.files` when it's absent.
 */

type FileWithRelativePath = File & { _webkitRelativePath?: string }

/** Shared traversal budget. `remaining` is decremented synchronously right
 *  before each push so the cap is hard across the parallel branches, and
 *  `stopped` short-circuits every in-flight branch once the limit is hit. */
interface Budget {
  remaining: number
  limit: number
  stopped: boolean
}

export async function traverseDataTransferItems(
  items: DataTransferItemList,
  limit = Number.POSITIVE_INFINITY,
): Promise<File[]> {
  const files: File[] = []
  const budget: Budget = { remaining: limit, limit, stopped: false }
  const entries: FileSystemEntry[] = []
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry()
    if (entry) entries.push(entry)
  }
  await Promise.all(entries.map((entry) => walkEntry(entry, '', files, budget)))
  return files
}

function walkEntry(
  entry: FileSystemEntry,
  path: string,
  out: File[],
  budget: Budget,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (budget.stopped) {
      resolve() // another branch already hit the cap; unwind quietly
      return
    }
    if (entry.isFile) {
      ;(entry as FileSystemFileEntry).file((file) => {
        // Reserve a slot synchronously: no other callback runs between the check
        // and the decrement, so the cap can't be overshot.
        if (budget.remaining <= 0) {
          budget.stopped = true
          reject(new Error(`Too many files (limit ${budget.limit}).`))
          return
        }
        budget.remaining--
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
        if (budget.stopped) {
          resolve()
          return
        }
        reader.readEntries((batch) => {
          if (batch.length === 0 || budget.stopped) {
            resolve()
            return
          }
          Promise.all(
            batch.map((child) => walkEntry(child, childPath, out, budget)),
          )
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
