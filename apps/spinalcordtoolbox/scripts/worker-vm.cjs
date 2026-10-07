'use strict';

// Evaluates web/js/inference-worker.js (an ES module worker) inside a Node vm
// context: static imports are replaced by bindings loaded from the shared
// component package and dynamic imports by a loader for the app's own modules.
// Shared by the worker inference, protocol and routing tests.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'web/js/inference-worker.js');

function prepareModuleWorkerSource(source) {
  return source
    .replace(/^\s*import\s+(?:(?:[\s\S]*?)\s+from\s+)?['"][^'"]+['"];\s*$/gm, '')
    .replace(/\bimport\(/g, 'importModule(');
}

async function loadSharedWorkerBindings() {
  const components = path.resolve(ROOT, '../../packages/components/src');
  const [worker, niftiUtils, geometry, layout] = await Promise.all([
    import(pathToFileURL(path.join(components, 'worker/index.js')).href),
    import(pathToFileURL(path.join(components, 'file-io/NiftiUtils.js')).href),
    import(pathToFileURL(path.join(components, 'volume/geometry.js')).href),
    import(pathToFileURL(path.join(components, 'volume/layout.js')).href)
  ]);
  return {
    createWorkerEmitter: worker.createWorkerEmitter,
    fetchModelAsset: worker.fetchModel,
    getOptimalWasmThreads: worker.getOptimalWasmThreads,
    installWorkerRouter: worker.installWorkerRouter,
    localForageCache: worker.localForageCache,
    prepareRasWorkerInput: worker.prepareRasWorkerInput,
    createNiftiFromData: niftiUtils.createNiftiFromData,
    parseNiftiVolume: niftiUtils.parseNiftiVolume,
    getOrientationTransform: geometry.getOrientationTransform,
    inverseOrient: geometry.inverseOrient,
    orientToRAS: geometry.orientToRAS,
    resampleLabelsNearest: geometry.resampleLabelsNearest,
    resampleVolume: geometry.resampleVolume,
    flipVolumeAxes: layout.flipVolumeAxes,
    transposeXYZToZYX: layout.transposeXYZToZYX,
    transposeZYXToXYZ: layout.transposeZYXToXYZ
  };
}

function installModuleLoader(sandbox, selfObj, localforage) {
  sandbox.importModule = async (specifier) => {
    if (specifier.startsWith('https://')) return { default: localforage };
    if (specifier.endsWith('/nifti-js/index.js')) return {};
    const abs = path.resolve(path.dirname(WORKER_PATH), specifier);
    const src = fs.readFileSync(abs, 'utf8');
    vm.runInContext(src, sandbox, { filename: abs });
    for (const name of ['SCTInferencePipeline', 'SCTLesionAnalysis', 'SCTVertebrae', 'TotalSpineSeg']) {
      if (selfObj[name]) sandbox[name] = selfObj[name];
    }
    return {};
  };
}

module.exports = {
  prepareModuleWorkerSource,
  loadSharedWorkerBindings,
  installModuleLoader
};
