import { chooseLevel, classifySource, urlName, zarrFolderEntries } from "./sources.js";

// The readers without a signal option can finish decoding after cancellation.
// Guard their store calls and every async stage before preparing the display copy.
export function cancellableStore(store, signal) {
  if (!signal) return store;
  const wrapped = {};
  for (const method of ["get", "getRange", "has"]) {
    if (typeof store[method] !== "function") continue;
    wrapped[method] = async (...args) => {
      signal?.throwIfAborted();
      const optionsIndex = method === "getRange" ? 2 : 1;
      args[optionsIndex] = { ...args[optionsIndex], signal };
      const value = await store[method](...args);
      signal?.throwIfAborted();
      return value;
    };
  }
  return wrapped;
}

/** Browser dependencies are injected so deferred readers exercise the production IO path in Node. */
export function createSourceReader({ fromOmeZarr, ngffImageToItkImage, TiffStore, ZipFileStore, FetchStore,
  prepared, readNiftiFile, readItkFile }) {
  // Zip archives may wrap the OME-Zarr root in a folder; read below it.
  function stripZarrPrefix(entries) {
    const root = Object.keys(entries)
      .filter((key) => /(^|\/)(zarr\.json|\.zattrs)$/.test(key))
      .sort((a, b) => a.length - b.length)[0];
    const prefix = root ? root.slice(0, root.lastIndexOf("/") + 1) : "";
    if (!prefix) return entries;
    return Object.fromEntries(Object.entries(entries)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => [key.slice(prefix.length), entry]));
  }

  function folderStore(entries) {
    return {
      async get(key) {
        const file = entries.get(key.replace(/^\//, ""));
        return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
      },
    };
  }

  // bioformats2raw layouts hold the image one group below the root.
  async function readMultiscales(store, options = {}, signal) {
    try {
      return await fromOmeZarr(store, options);
    } catch (error) {
      signal?.throwIfAborted();
      try {
        return await fromOmeZarr(store, { ...options, path: "0" });
      } catch {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }

  async function readOmeZarr(store, name, kind, options, signal) {
    signal?.throwIfAborted();
    store = cancellableStore(store, signal);
    const multiscales = await readMultiscales(store, options, signal);
    signal?.throwIfAborted();
    const { image: level, level: index } = chooseLevel(multiscales.images);
    const image = await ngffImageToItkImage(level, { tIndex: 0, cIndex: 0 });
    signal?.throwIfAborted();
    const count = multiscales.images.length;
    return prepared(image, name, kind, null, ` · pyramid level ${index + 1} of ${count}`, signal);
  }

  async function fetchFile(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`${urlName(url)} returned HTTP ${response.status}.`);
    const blob = await response.blob();
    signal?.throwIfAborted();
    return new File([blob], urlName(url));
  }

  /** Read any source except NIfTI/DICOM files: ITK formats, OME-Zarr or TIFF, local or by URL. */
  async function readSource(source, { signal } = {}) {
    signal?.throwIfAborted();
    const kind = classifySource(source);
    const name = typeof source === "string" ? urlName(source) : source[0].name;
    switch (kind) {
      case "file-url": {
        const file = await fetchFile(source, signal);
        return /\.nii(\.gz)?$/i.test(file.name) ? readNiftiFile(file, { signal }) : readSource([file], { signal });
      }
      case "itk": {
        const { image } = await readItkFile(source[0], signal);
        signal?.throwIfAborted();
        return prepared(image, name, kind, null, "", signal);
      }
      case "tiff":
        return readOmeZarr(await TiffStore.fromBlob(source[0]), name, kind, { version: "0.5" }, signal);
      case "tiff-url":
        return readOmeZarr(await TiffStore.fromUrl(source), name, kind, { version: "0.5" }, signal);
      case "ozx":
        return readOmeZarr(ZipFileStore.fromBlob(source[0], { transformEntries: stripZarrPrefix }), name, kind, undefined, signal);
      case "ozx-url":
        return readOmeZarr(ZipFileStore.fromUrl(source, { transformEntries: stripZarrPrefix, overrides: { signal } }), name, kind, undefined, signal);
      case "zarr-folder": {
        const { root, entries } = zarrFolderEntries(source);
        return readOmeZarr(folderStore(entries), root.split("/").filter(Boolean).pop(), kind, undefined, signal);
      }
      case "zarr-url":
        return readOmeZarr(new FetchStore(source, { overrides: { signal } }), name, kind, undefined, signal);
      default:
        throw new Error("Read NIfTI and DICOM files with readNiftiFile.");
    }
  }
  return readSource;
}
