// Simplify and smooth cortical surfaces with niimath, then write printable STL.
// ponytail: two quirks of @niivue/niimath 1.4.20260909 shape this, both fixed upstream for the next
// release. run() always appends "-odt <type>" while mesh mode reads the LAST argument as the output
// name, so this worker loads the same WebAssembly module directly and passes niimath's documented
// mesh argv; and that build compiles mesh support without HAVE_FORMATS, so it can only write mz3 —
// hence readMz3 + writeStl here. Once the published build writes STL, ask niimath for out.stl and
// drop both serializers.
import createNiimath from '@niivue/niimath/niimath.js';
import { readMz3, writeMz3, writeStl } from '@neurodesk/topofit/results';

const output = [];

self.onmessage = async ({ data }) => {
  try {
    // One worker per export, terminated afterwards, so the module is not worth caching.
    const niimath = await createNiimath({ print: (line) => output.push(line), printErr: (line) => output.push(line) });
    const files = [];
    for (const surface of data.surfaces) {
      output.length = 0;
      niimath.FS_createDataFile('/', 'in.mz3', new Uint8Array(writeMz3(surface.vertices, surface.faces)), true, true);
      try {
        const code = niimath.callMain(['in.mz3', '-r', String(data.reduce), '-s', String(data.smooth), '-v', '0', 'out.mz3']);
        if (code !== 0) throw new Error(`niimath exited with ${code}. ${output.join(' ')}`.trim());
        const mesh = await readMz3(niimath.FS_readFile('out.mz3'));
        if (!mesh.faces.length) throw new Error(`Simplifying ${surface.name} left no triangles. Keep a larger fraction.`);
        files.push({ name: surface.name, bytes: writeStl(mesh.vertices, mesh.faces), triangles: mesh.faces.length / 3 });
      } finally {
        for (const name of ['in.mz3', 'out.mz3']) {
          try { niimath.FS_unlink(name); } catch { /* a failed run may not have written it */ }
        }
      }
      self.postMessage({ type: 'progress', done: files.length, total: data.surfaces.length });
    }
    self.postMessage({ type: 'result', files }, files.map((file) => file.bytes));
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
