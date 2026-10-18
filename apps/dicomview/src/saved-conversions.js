// Converted series kept in the browser's origin private file system, so the same folder
// opens without dcm2niix the next time. Keyed by a fingerprint of the series' content.
//
// Layout under the root directory handle:
//   dicomview/<fingerprint>/manifest.json  { version, outputs: [{ name, type, sidecar }] }
//   dicomview/<fingerprint>/<index>         the NIfTI bytes of outputs[index]
// The manifest is written last, so a directory without one is an unfinished save and is
// treated as absent.

export const FORMAT_VERSION = 'dicomview-nifti-2';
export const DIRECTORY = 'dicomview';
const MANIFEST = 'manifest.json';

const encoder = new TextEncoder();
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// SHA-256 over the format version, the series uid and, per file in path order, its path,
// size and the digest of its whole content, pixel data included, so an edited file never
// opens a stale image. Not lastModified: a re-fetched example has a new one.
export async function seriesFingerprint(series, { digest = (bytes) => crypto.subtle.digest('SHA-256', bytes) } = {}) {
  const records = [...series.files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = [`${FORMAT_VERSION}\n${series.uid}\n`];
  for (const record of records) {
    const content = await record.file.arrayBuffer();
    lines.push(`${record.path}\n${record.file.size}\n${hex(await digest(content))}\n`);
  }
  return hex(await digest(encoder.encode(lines.join(''))));
}

const isNotFound = (error) => error?.name === 'NotFoundError';

// The store, or null when this browser offers no origin private file system. Every method
// throws on storage errors; the caller falls back to memory.
export async function openSavedConversions({ root = () => navigator.storage.getDirectory(), persist = () => navigator.storage.persist?.() } = {}) {
  let base;
  try {
    base = await root();
  } catch (error) {
    console.warn(`Converted images are not saved: ${error.message}`);
    return null;
  }
  let persistRequested = false;

  async function directory(create) {
    return base.getDirectoryHandle(DIRECTORY, { create });
  }

  return {
    // The outputs saved under key, or null when there are none.
    async load(key) {
      let dir;
      try {
        dir = await (await directory(false)).getDirectoryHandle(key);
        const manifestFile = await (await dir.getFileHandle(MANIFEST)).getFile();
        const manifest = JSON.parse(await manifestFile.text());
        if (manifest.version !== FORMAT_VERSION) return null;
        return Promise.all(manifest.outputs.map(async ({ name, type, sidecar }, index) => {
          const bytes = await (await dir.getFileHandle(String(index))).getFile();
          return { image: new File([bytes], name, { type }), sidecar };
        }));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    // Replaces whatever is saved under key.
    async save(key, outputs) {
      const parent = await directory(true);
      await parent.removeEntry(key, { recursive: true }).catch((error) => { if (!isNotFound(error)) throw error; });
      const dir = await parent.getDirectoryHandle(key, { create: true });
      const write = async (name, data) => {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        try {
          await writable.write(data);
        } finally {
          await writable.close();
        }
      };
      for (const [index, { image }] of outputs.entries()) await write(String(index), image);
      const manifest = { version: FORMAT_VERSION, outputs: outputs.map(({ image, sidecar }) => ({ name: image.name, type: image.type, sidecar })) };
      await write(MANIFEST, JSON.stringify(manifest));
      if (!persistRequested) {
        persistRequested = true;
        Promise.resolve().then(persist).catch(() => {});
      }
    },

    // Deletes every saved series.
    async forget() {
      await base.removeEntry(DIRECTORY, { recursive: true }).catch((error) => { if (!isNotFound(error)) throw error; });
    },
  };
}
