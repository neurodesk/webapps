// A store over a folder the user chose (File System Access API): the converter writes each
// chunk as a file as it goes, and the preview reads them back. The image goes into a new
// subfolder, so nothing already in the chosen folder is overwritten.
export async function directoryStore(parent, name) {
  for await (const entry of parent.keys()) {
    if (entry === name) throw new Error(`${parent.name} already holds ${name}; choose another folder or remove it.`);
  }
  const root = await parent.getDirectoryHandle(name, { create: true });
  const created = new Map();
  const folder = (path, create) => {
    if (path === "") return Promise.resolve(root);
    if (create && created.has(path)) return created.get(path);
    const at = path.lastIndexOf("/");
    const handle = folder(at < 0 ? "" : path.slice(0, at), create).then((up) => up.getDirectoryHandle(path.slice(at + 1), { create }));
    if (create) created.set(path, handle);
    return handle;
  };
  const split = (key) => {
    const clean = key.replace(/^\//, "");
    const at = clean.lastIndexOf("/");
    return [at < 0 ? "" : clean.slice(0, at), clean.slice(at + 1)];
  };
  return {
    name,
    async set(key, bytes) {
      const [path, file] = split(key);
      const handle = await (await folder(path, true)).getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
    async get(key) {
      const [path, file] = split(key);
      try {
        const handle = await (await folder(path, false)).getFileHandle(file);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (error) {
        if (error.name === "NotFoundError" || error.name === "TypeMismatchError") return undefined;
        throw error;
      }
    },
  };
}
