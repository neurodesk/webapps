// The web app's create-mesh operation without its viewer: the same pipeline and the same browser
// runtimes (MindGrab's published wrapper in a module worker, niimath's WebAssembly worker), with
// MindGrab held to its CPU backend so the result does not depend on the machine's GPU.
import { createMesh } from '../../src/pipeline.js';
import { createNiimathMesher, mindgrab } from '../../src/browser.js';

const niimath = createNiimathMesher();

globalThis.runCase = async ({ id, input, settings }) => {
  const bytes = new Uint8Array(await (await fetch(`/input/${input}`)).arrayBuffer());
  const result = await createMesh({
    input: bytes,
    settings,
    mindgrab,
    mesher: (segmentation, options) => niimath.mesh(segmentation, options),
    mindgrabOptions: { worker: true, backend: 'cpu', assetPath: '/brainchop/' },
  });
  for (const file of result.files) {
    const response = await fetch(`/result/${id}/${file.name}`, { method: 'POST', body: file.bytes });
    if (!response.ok) throw new Error(`Could not post ${file.name}`);
  }
  return { files: result.files.map(({ name }) => name), measurements: result.measurements, provenance: result.provenance };
};
