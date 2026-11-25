// The JavaScript host a Rust pipeline core (exes/pipeline-host's `web` feature) runs on in the browser.

/** The JS side of exes/pipeline-host's Host trait: `files` holds every file; `tools` maps a tool name to its driver
 * `(argv, {files, fslOut, env}) -> {code, stdout, stderr}`, run one at a time. */
export function createHost(files, tools, { onLog = () => {}, onStep = () => {} } = {}) {
  return {
    async run(argv, fslOut, gpu, env = []) {
      const tool = tools[argv[0]];
      if (!tool) return { code: 127, stdout: '', stderr: `${argv[0]} is not available in the browser` };
      onStep(argv);
      try {
        return await tool(argv, { files, fslOut, env: Object.fromEntries(env) });
      } catch (e) {
        return { code: 1, stdout: '', stderr: e?.message ?? String(e) };
      }
    },
    readRange: (path, offset, len) => files.range(path, offset, len),
    async readText(path, limit) {
      if (files.size(path) > limit) throw new Error(`${path}: larger than ${limit} bytes`);
      return files.text(path);
    },
    async write(path, bytes) {
      files.put(path, bytes.slice());
    },
    async append(path, bytes) {
      const old = files.has(path) ? await files.bytes(path) : new Uint8Array();
      const next = new Uint8Array(old.length + bytes.length);
      next.set(old);
      next.set(bytes, old.length);
      files.put(path, next);
    },
    exists: (path) => files.has(path),
    stat: (path) => files.stat(path),
    list: (dir) => files.list(dir),
    mkdirs() {},
    remove: (path) => files.remove(path),
    rename: (from, to) => files.rename(from, to),
    copy: (from, to) => files.copy(from, to),
    now: () => Date.now() / 1000,
    localTime() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    log: onLog,
  };
}
