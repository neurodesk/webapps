// Apps that always pass `assetPath` to MindGrab load its model modules from their own staged copies.
// MindGrab's fallback imports name every model's module for every backend, so without this plugin
// Vite bundles all twelve (about 11 MB) a second time. Use it in the bundle that imports MindGrab.
export function mindgrabFromAssetPath() {
  const prefix = '\0mindgrab-from-asset-path:';
  return {
    name: 'mindgrab-from-asset-path',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.includes('@brainchop/mindgrab') || !/^\.\/brainchop-[\w-]+\.js$/.test(source)) return null;
      return prefix + source;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      return `throw new Error(${JSON.stringify(`${id.slice(prefix.length)} is not bundled; pass assetPath to MindGrab.`)});`;
    },
  };
}
